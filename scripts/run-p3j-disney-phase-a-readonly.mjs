#!/usr/bin/env node
/**
 * P3J Disney Phase A READ ONLY. Unique preflight ID. Does not claim W38 scheduled lease.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createMaintenanceSupabase, getSupabaseConfig } = require(
  path.join(root, "scripts/lib/supabase-rest.cjs")
);
const { scheduledWeeklyDispatchKey, perthIsoWeek } = require(
  path.join(root, "netlify/functions/lib/weekly-maintenance-schedule-control")
);
const { loadMaintenanceLockStatus } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks")
);
const { runDisneyWeeklyMaintenance } = require(
  path.join(root, "netlify/functions/lib/disney-weekly-maintenance")
);

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const periodKey = scheduledWeeklyDispatchKey("disney-cruise-line");
  const before = await loadMaintenanceLockStatus(sb, periodKey);
  const freeze = JSON.parse(
    fs.readFileSync(path.join(root, "reports/disney-p3j-partial-write-30-freeze-2026-09-17.json"), "utf8")
  );
  const freezeIds = new Set(freeze.official_sailing_ids || []);
  const runId = `disney-cruise-line:p3j-phase-a-${perthIsoWeek()}-${Date.now()}`;
  const result = await runDisneyWeeklyMaintenance({
    supabase: sb,
    dryRun: true,
    performWrites: false,
    maxWrites: 30,
    triggerType: "preflight",
    runId,
    deadlineMs: 20 * 60 * 1000
  });
  const after = await loadMaintenanceLockStatus(sb, periodKey);
  const inserts = result.manifest?.inserts || [];
  const classified = (freeze.rows || []).map((row) => {
    const hit = inserts.find((e) => e.official_sailing_id === row.official_sailing_id)
      || (result.simulation?.products || []).find((p) => p.official_sailing_id === row.official_sailing_id);
    const product = hit?.normalised || hit || null;
    if (!product && !(result.simulation?.products || []).some((p) => p.official_sailing_id === row.official_sailing_id)) {
      return { uuid: row.uuid, official_sailing_id: row.official_sailing_id, classification: "SOURCE_MISSING" };
    }
    const src = product.raw || product.candidate || product;
    const shipOk = row.ship_id && (product.ship_resolution?.ship?.id === row.ship_id || product.ship_id === row.ship_id);
    const dep = String(product.candidate?.departure_date || src.sailDateFrom || src.departure_date || "").slice(0, 10);
    const ret = String(product.candidate?.return_date || src.sailDateTo || src.return_date || "").slice(0, 10);
    const nights = product.candidate?.nights ?? src.nights ?? src.duration;
    const port = product.candidate?.departure_port_meta?.canonicalPortName || product.departure_port;
    const destOk = product.destination_resolution?.status === "resolved" || Boolean(row.destination_id);
    const same =
      dep === row.departure_date &&
      ret === row.return_date &&
      Number(nights) === Number(row.nights) &&
      String(port || "").toLowerCase() === String(row.departure_port || "").toLowerCase();
    let classification = "VALID_INSERT";
    if (!same) classification = "SOURCE_CHANGED_AFTER_INSERT";
    if (product.destination_resolution && product.destination_resolution.status !== "resolved") classification = "AMBIGUOUS";
    if (product.ship_resolution && product.ship_resolution.resolved === false) classification = "IDENTITY_MISMATCH";
    return {
      uuid: row.uuid,
      official_sailing_id: row.official_sailing_id,
      classification,
      source_present: true,
      ship_match: shipOk || Boolean(product.ship_resolution?.resolved),
      dest_ok: destOk,
      same_voyage: same
    };
  });
  const proposedIds = inserts.map((e) => e.official_sailing_id);
  const reinsert = proposedIds.filter((id) => freezeIds.has(id));
  const report = {
    generated_at: new Date().toISOString(),
    run_id: runId,
    scheduled_lease_created: before.held !== true && after.held === true,
    scheduled_lease_before_held: before.held === true,
    scheduled_lease_after_owner: after.owner_id || null,
    terminal_status: result.terminal_status || result.summary?.terminal_status,
    source_quality_gate: result.summary?.source_quality_gate || result.source_quality_gate,
    stage_timings: result.simulation?.snapshot?.stage_timings || result.simulation?.stage_timings || null,
    api_calls: result.simulation?.snapshot?.api_calls || result.simulation?.api_calls || null,
    eligible_total: result.summary?.eligible_total ?? result.summary?.production_eligible_total,
    proposed_inserts: proposedIds.length,
    proposed_updates: result.summary?.proposed_updates,
    reviews: result.summary?.proposed_updates_identity_review,
    freeze_30_classifications: classified,
    freeze_30_valid: classified.filter((r) => r.classification === "VALID_INSERT").length,
    freeze_30_reproposed: reinsert,
    writes: 0
  };
  const file = path.join(root, "reports", `disney-p3j-phase-a-readonly-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        report_file: file,
        lease_created: report.scheduled_lease_created,
        eligible: report.eligible_total,
        proposed_inserts: report.proposed_inserts,
        freeze_valid: report.freeze_30_valid,
        reproposed: reinsert.length,
        timings: report.stage_timings,
        terminal: report.terminal_status
      },
      null,
      2
    )
  );
  if (report.scheduled_lease_created) process.exit(2);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
