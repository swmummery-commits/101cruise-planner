#!/usr/bin/env node
/**
 * Princess Incident P2 — ONE controlled batch of maximum 30 INSERTS.
 *
 *   node scripts/princess-incident-p2-forensics.mjs --write-freeze
 *   PRINCESS_DISCOVERY_WRITE_ENABLED=true node scripts/run-princess-incident-p2-controlled-batch.mjs \
 *     --apply --confirm=PRINCESS-INCIDENT-P2-CONTROLLED-BATCH
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
  require("dotenv").config({ path: path.join(root, ".env.local") });
} catch {
  /* optional */
}

const CONFIRM_TOKEN = "PRINCESS-INCIDENT-P2-CONTROLLED-BATCH";
const INCIDENT_MAX_WRITES = 30;
const INCIDENT_MAX_BATCHES = 1;
const FREEZE_PATH = path.join(root, "reports/princess-incident-p2-batch-1-freeze.json");
const PRINCESS_LINE_ID = "c19f40a7-c160-4035-a845-14dada550e1f";

const { createMaintenanceSupabase, exactCountSupabase } = require(path.join(
  root,
  "scripts/lib/supabase-rest.cjs"
));
const { runPrincessWeeklyMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-runner"
));
const {
  createMaintenanceRun,
  finalizeMaintenanceRun,
  buildMaintenanceRunStats,
  resolveMaintenanceRunStatus
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-tracking"));
const { PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance"
));
const postWriteVerification = require(path.join(
  root,
  "netlify/functions/lib/princess-post-write-verification"
));
const batchLib = require(path.join(root, "scripts/lib/princess-controlled-catch-up-batch.cjs"));

function parseArgs(argv) {
  const args = { apply: false, confirm: null, dryRun: true };
  for (const arg of argv.slice(2)) {
    if (arg === "--apply") {
      args.apply = true;
      args.dryRun = false;
    }
    if (arg.startsWith("--confirm=")) args.confirm = arg.split("=")[1];
  }
  return args;
}

function hashFreezePayload(candidates) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(candidates.map((c) => c.write_payload)))
    .digest("hex");
}

function loadFreeze() {
  if (!fs.existsSync(FREEZE_PATH)) {
    throw new Error(`Missing freeze file: ${FREEZE_PATH}`);
  }
  const freeze = JSON.parse(fs.readFileSync(FREEZE_PATH, "utf8"));
  if (freeze.batch_size !== 30 || freeze.max_batches !== 1) {
    throw new Error("Invalid freeze: must be exactly 30 inserts, 1 batch");
  }
  const recomputed = hashFreezePayload(freeze.candidates);
  if (recomputed !== freeze.freeze_hash) {
    throw new Error("Freeze hash mismatch — manifest altered");
  }
  return freeze;
}

async function collisionAudit(sb, candidates) {
  const productionKeys = new Set();
  const extKeys = new Set();
  const idKeys = new Set();
  let offset = 0;
  while (true) {
    const batch = await sb(
      `discovered_cruises?cruise_line_id=eq.${PRINCESS_LINE_ID}&select=official_sailing_id,external_key,identity_key&limit=1000&offset=${offset}`
    );
    if (!batch?.length) break;
    for (const r of batch) {
      if (r.official_sailing_id) productionKeys.add(r.official_sailing_id);
      if (r.external_key) extKeys.add(r.external_key);
      if (r.identity_key) idKeys.add(r.identity_key);
    }
    if (batch.length < 1000) break;
    offset += 1000;
  }

  let officialCollisions = 0;
  let externalCollisions = 0;
  let identityCollisions = 0;
  for (const c of candidates) {
    if (productionKeys.has(c.official_sailing_id)) officialCollisions += 1;
    const wp = c.write_payload || {};
    if (wp.external_key && extKeys.has(wp.external_key)) externalCollisions += 1;
    if (wp.identity_key && idKeys.has(wp.identity_key)) identityCollisions += 1;
  }
  return {
    official_collisions: officialCollisions,
    external_collisions: externalCollisions,
    identity_collisions: identityCollisions,
    pass: officialCollisions + externalCollisions + identityCollisions === 0
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const freeze = loadFreeze();
  const frozenIds = freeze.candidates.map((c) => c.official_sailing_id);

  if (args.apply) {
    if (args.confirm !== CONFIRM_TOKEN) {
      throw new Error(`--apply requires --confirm=${CONFIRM_TOKEN}`);
    }
    if (String(process.env.PRINCESS_DISCOVERY_WRITE_ENABLED || "").toLowerCase() !== "true") {
      throw new Error("PRINCESS_DISCOVERY_WRITE_ENABLED=true required");
    }
  }

  const sb = createMaintenanceSupabase(root);
  const countsBefore = await batchLib.baselineCounts(root);

  if (args.apply) {
    const collisions = await collisionAudit(sb, freeze.candidates);
    if (!collisions.pass) {
      console.error(JSON.stringify({ phase: "pre_write_collision_abort", collisions }, null, 2));
      process.exit(3);
    }
  }

  const runId = `princess-incident-p2-batch1-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  let dbRun = null;

  if (args.apply) {
    dbRun = await createMaintenanceRun(sb, {
      cruiseLineId: PRINCESS_LINE_ID,
      runId,
      runType: PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
      triggerType: "incident_p2_controlled_batch",
      stats: {
        line_slug: "princess-cruises",
        incident_p2: true,
        max_writes: INCIDENT_MAX_WRITES,
        max_batches: INCIDENT_MAX_BATCHES,
        freeze_hash: freeze.freeze_hash
      }
    });
  }

  const result = await runPrincessWeeklyMaintenance({
    dryRun: args.dryRun,
    performWrites: args.apply,
    writeMode: args.apply ? "incident_p2_controlled_batch" : "production_read_only",
    incidentP2ControlledBatch: true,
    insertOnly: true,
    frozenOfficialSailingIds: frozenIds,
    maxWrites: INCIDENT_MAX_WRITES,
    runId,
    runRecordId: dbRun?.id || null,
    supabase: sb,
    triggerType: "incident_p2_controlled_batch",
    collectSourceDiagnostics: true
  });

  const summary = result.summary || {};
  const writeStats = result.write_result?.stats || {};
  const countsAfter = await batchLib.baselineCounts(root);

  let verification = { ok: true, skipped: true };
  if (args.apply && writeStats.inserted > 0) {
    const insertedIds = (result.write_result?.write_details || [])
      .filter((d) => d.discovered_cruise_id)
      .map((d) => d.discovered_cruise_id);
    const rows = await postWriteVerification.fetchPrincessActiveRows(sb, insertedIds);
    verification = postWriteVerification.verifyInsertedRows(rows);
    verification.verified_count = rows.length;
  }

  if (dbRun?.id) {
    await finalizeMaintenanceRun(sb, dbRun.id, {
      status: resolveMaintenanceRunStatus({ ok: result.ok, summary }),
      stats: buildMaintenanceRunStats(summary, {
        incident_p2: true,
        freeze_hash: freeze.freeze_hash,
        rollback_manifest_id: summary.rollback_manifest_id || null
      }),
      errorMessage: result.ok ? null : result.reason || "incident_p2_failed"
    });
  }

  const report = {
    phase: args.apply ? "p2_controlled_apply" : "p2_controlled_dry_run",
    generated_at: new Date().toISOString(),
    repository_sha: require("child_process").execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim(),
    freeze_hash: freeze.freeze_hash,
    frozen_count: frozenIds.length,
    counts_before: countsBefore,
    counts_after: countsAfter,
    princess_active_delta: countsAfter.princess_active - countsBefore.princess_active,
    write_result: {
      attempted: writeStats.inserted + writeStats.updated + writeStats.failed || 0,
      inserted: writeStats.inserted || 0,
      updated: writeStats.updated || 0,
      failed: writeStats.failed || 0,
      deactivated: writeStats.deactivated || 0
    },
    rollback_manifest_id: summary.rollback_manifest_id || null,
    global_lock: summary.global_lock || null,
    post_write_verification: verification,
    reconciliation: {
      outstanding_eligible_inserts: summary.outstanding_eligible_inserts ?? null,
      proposed_updates: summary.proposed_updates ?? null
    },
    ok: result.ok,
    reason: result.reason || null
  };

  const out = path.join(
    root,
    `reports/princess-weekly-incident-p2-first-remediation-batch${args.apply ? "" : "-dry-run"}.json`
  );
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  if (args.apply) {
    const pass =
      result.ok &&
      writeStats.inserted === INCIDENT_MAX_WRITES &&
      writeStats.updated === 0 &&
      writeStats.failed === 0 &&
      verification.ok &&
      countsAfter.princess_active - countsBefore.princess_active === INCIDENT_MAX_WRITES;
    process.exit(pass ? 0 : 4);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
