#!/usr/bin/env node
/**
 * P3B Princess single unique official-id remap. Preserves UUID. No inserts/deletes.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
try {
  require("dotenv").config({ path: path.join(root, ".env") });
} catch {}

const PRINCESS_LINE_ID = "c19f40a7-c160-4035-a845-14dada550e1f";
const EXISTING_UUID = "c641baee-5df6-4b61-915e-ac78b7bcf264";
const FROM_ID = "LLV05A|XP|2027-05-01";
const TO_ID = "LLV05D|XP|2027-05-01";

const { createMaintenanceSupabase, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const remap = require(path.join(root, "netlify/functions/lib/princess-official-id-remap"));
const { classifyPrincessP3bCandidate } = require(
  path.join(root, "netlify/functions/lib/princess-voyage-identity-classifier")
);
const { runGlobalProtectedMaintenanceWrites } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-global-write-lock")
);
const { persistMaintenanceRollbackManifest } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-manifests")
);
const {
  createMaintenanceRun,
  finalizeMaintenanceRun
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-tracking"));
const { PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance")
);

async function loadRow(sb, id) {
  const rows = await sb(
    `discovered_cruises?id=eq.${encodeURIComponent(id)}&select=id,cruise_line_id,status,official_sailing_id,external_key,identity_key,ship_id,destination_id,departure_date,return_date,nights,departure_port,itinerary,official_url,source_url,raw_extract`
  );
  return rows?.[0] || null;
}

async function loadLineRows(sb) {
  const rows = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const batch = await sb(
      `discovered_cruises?cruise_line_id=eq.${PRINCESS_LINE_ID}&select=id,status,official_sailing_id,external_key,identity_key,ship_id,destination_id,departure_date,return_date,nights,departure_port&order=id.asc&limit=${pageSize}&offset=${offset}`
    );
    if (!batch?.length) break;
    rows.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const existing = await loadRow(sb, EXISTING_UUID);
  if (!existing) throw new Error("existing row missing");
  if (existing.official_sailing_id !== FROM_ID) {
    throw new Error(`expected ${FROM_ID}, found ${existing.official_sailing_id}`);
  }
  const insert = {
    official_sailing_id: TO_ID,
    ship_id: existing.ship_id,
    departure_date: existing.departure_date,
    return_date: existing.return_date,
    nights: existing.nights,
    departure_port: existing.departure_port,
    destination_id: existing.destination_id,
    official_url: existing.official_url,
    itinerary: existing.itinerary
  };
  const productionRows = await loadLineRows(sb);
  const classified = classifyPrincessP3bCandidate(insert, productionRows);
  if (classified.classification !== "UNIQUE_OFFICIAL_ID_REMAP") {
    throw new Error(`not unique remap: ${classified.classification} ${classified.reason}`);
  }
  if (classified.existing_uuid !== EXISTING_UUID) throw new Error("uuid mismatch");
  const freeze = {
    existing_uuid: EXISTING_UUID,
    from: FROM_ID,
    to: TO_ID,
    ship_id: existing.ship_id,
    departure_date: existing.departure_date,
    return_date: existing.return_date,
    nights: existing.nights,
    departure_port: existing.departure_port,
    destination_id: existing.destination_id
  };
  const manifestHash = crypto.createHash("sha256").update(JSON.stringify(freeze)).digest("hex");
  const runId = `princess-p3b-unique-remap-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const dbRun = await createMaintenanceRun(sb, {
    cruiseLineId: PRINCESS_LINE_ID,
    runId,
    runType: PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
    triggerType: "p3b_unique_official_id_remap",
    stats: { dry_run: false, manifest_hash: manifestHash, frozen: freeze }
  });

  const protectedWrite = await runGlobalProtectedMaintenanceWrites(sb, {
    runId,
    runRecordId: dbRun?.id || null,
    lineSlug: "princess-cruises",
    operation: "princess_p3b_unique_official_id_remap",
    underLockRecheck: async () => {
      const live = await loadRow(sb, EXISTING_UUID);
      const liveRows = await loadLineRows(sb);
      const liveClassified = classifyPrincessP3bCandidate(
        { ...insert, official_sailing_id: TO_ID },
        liveRows
      );
      if (live?.official_sailing_id !== FROM_ID) return { ok: false, reason: "under_lock_source_id_changed" };
      if (liveClassified.classification !== "UNIQUE_OFFICIAL_ID_REMAP") {
        return { ok: false, reason: `under_lock_${liveClassified.classification}` };
      }
      if (liveClassified.existing_uuid !== EXISTING_UUID) return { ok: false, reason: "under_lock_uuid_changed" };
      return { ok: true };
    },
    writeFn: async () => {
      const live = await loadRow(sb, EXISTING_UUID);
      const liveRows = await loadLineRows(sb);
      const result = await remap.applyPrincessOfficialIdRemap(sb, {
        existingRow: live,
        insert,
        cruiseLineId: PRINCESS_LINE_ID,
        runId,
        productionRows: liveRows
      });
      if (!result.ok) return { stats: { inserted: 0, updated: 0, failed: 1, write_details: [result] }, aborted: true, reason: result.reason };
      return { stats: { inserted: 0, updated: 1, failed: 0, write_details: [result] }, aborted: false };
    }
  });

  if (protectedWrite.blocked || protectedWrite.writeResult?.aborted) {
    await finalizeMaintenanceRun(sb, dbRun?.id, {
      status: "failed",
      stats: { run_id: runId, failed_writes: 1, manifest_hash: manifestHash },
      errorMessage: protectedWrite.reason || protectedWrite.writeResult?.reason || "remap_failed"
    });
    throw new Error(protectedWrite.reason || protectedWrite.writeResult?.reason || "remap_failed");
  }

  const stats = protectedWrite.writeResult.stats;
  const rollback = await persistMaintenanceRollbackManifest(sb, {
    runId,
    runRecordId: dbRun?.id || null,
    cruiseLineId: PRINCESS_LINE_ID,
    lineSlug: "princess-cruises",
    triggerType: "p3b_unique_official_id_remap",
    writeResult: { stats, write_details: stats.write_details }
  });
  const after = await loadRow(sb, EXISTING_UUID);
  const verified =
    after?.id === EXISTING_UUID &&
    after?.official_sailing_id === TO_ID &&
    after?.ship_id === existing.ship_id &&
    after?.departure_date === existing.departure_date &&
    after?.return_date === existing.return_date &&
    String(after?.nights) === String(existing.nights) &&
    after?.departure_port === existing.departure_port &&
    after?.destination_id === existing.destination_id;
  await finalizeMaintenanceRun(sb, dbRun?.id, {
    status: verified ? "completed" : "failed",
    stats: {
      run_id: runId,
      dry_run: false,
      inserts: 0,
      updates: verified ? 1 : 0,
      failed_writes: verified ? 0 : 1,
      manifest_hash: manifestHash,
      rollback_manifest_id: rollback?.manifest_record_id || rollback?.id || null,
      verification: verified
    },
    errorMessage: verified ? null : "post_write_verification_failed"
  });

  const out = {
    ok: verified,
    run_id: runId,
    run_record_id: dbRun?.id || null,
    target_uuid: EXISTING_UUID,
    action: "unique_official_id_remap",
    manifest_hash: manifestHash,
    rollback_manifest_id: rollback?.manifest_record_id || rollback?.id || null,
    before: { official_sailing_id: FROM_ID },
    after: { official_sailing_id: after?.official_sailing_id, uuid: after?.id },
    verification: verified,
    writes: verified ? 1 : 0
  };
  const file = path.join(root, "reports/princess-p3b-unique-remap-LLV05D-2026-09-09.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  if (!verified) process.exit(1);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
