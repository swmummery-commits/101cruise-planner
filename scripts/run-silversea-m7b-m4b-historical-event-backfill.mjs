#!/usr/bin/env node
/**
 * Silversea M7B — backfill exactly one M4B historical observation event.
 *   node scripts/run-silversea-m7b-m4b-historical-event-backfill.mjs --dry-run
 *   node scripts/run-silversea-m7b-m4b-historical-event-backfill.mjs --apply --confirm=SILVERSEA-M7B-M4B-HISTORICAL-EVENT
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
} catch {}

const REPORT_DIR = path.join(root, "reports");
const FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(root, "scripts/fixtures/silversea/m7b-m4b-historical-event-backfill-SN280222C25.json"),
    "utf8"
  )
);
const CONFIRM = "SILVERSEA-M7B-M4B-HISTORICAL-EVENT";
const RPC = "insert_m4b_historical_source_absence_observation_event";

const { createMaintenanceSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { loadAllSilverseaObservationStates } = require(path.join(
  root,
  "netlify/functions/lib/silversea-m6-weekly-maintenance-orchestration"
));
const { loadObservationEventsForState, RECORD_ORIGIN_HISTORICAL_BACKFILL } = require(path.join(
  root,
  "netlify/functions/lib/silversea-source-absence-observation-events"
));
const { evaluateObservationForensicChain, FORENSIC_RESULT } = require(path.join(
  root,
  "netlify/functions/lib/silversea-source-absence-observation-forensic"
));
const obs = require(path.join(root, "netlify/functions/lib/silversea-source-absence-observation"));

function parseArgs(argv) {
  const args = { apply: false, confirm: null, dryRun: true };
  for (const arg of argv.slice(2)) {
    if (arg === "--apply") args.apply = true;
    if (arg.startsWith("--confirm=")) args.confirm = arg.slice("--confirm=".length);
    if (arg === "--dry-run") args.dryRun = true;
  }
  if (args.apply) args.dryRun = false;
  return args;
}

async function observationRpc(sb, rpcName, body) {
  return sb(`rpc/${rpcName}`, { method: "POST", body });
}

function qualifyingEventExists(events) {
  const period = FIXTURE.proposed_event.observation_period_key;
  const hash = FIXTURE.proposed_event.source_snapshot_hash;
  return (events || []).some(
    (e) =>
      e.event_type === FIXTURE.proposed_event.event_type &&
      (e.observation_period_key === period || e.source_snapshot_hash === hash)
  );
}

async function insertHistoricalEventDirect(sb, snBefore) {
  const payload = {
    state_id: FIXTURE.state_id,
    cruise_line_id: FIXTURE.cruise_line_id,
    official_sailing_id: FIXTURE.official_sailing_id,
    production_cruise_uuid: FIXTURE.production_uuid,
    observation_type: FIXTURE.observation_type,
    event_type: FIXTURE.proposed_event.event_type,
    record_origin: RECORD_ORIGIN_HISTORICAL_BACKFILL,
    observed_at: FIXTURE.proposed_event.observed_at,
    observation_period_key: FIXTURE.proposed_event.observation_period_key,
    source_snapshot_hash: FIXTURE.proposed_event.source_snapshot_hash,
    source_health: FIXTURE.proposed_event.source_health,
    source_present: FIXTURE.proposed_event.source_present,
    run_id: FIXTURE.proposed_event.run_id,
    previous_count: FIXTURE.proposed_event.previous_count,
    new_count: FIXTURE.proposed_event.new_count,
    reason_code: FIXTURE.proposed_event.reason_code,
    metadata: FIXTURE.proposed_event.metadata
  };
  const inserted = await sb("cruise_source_observation_events", {
    method: "POST",
    body: payload,
    prefer: "return=representation"
  });
  const row = Array.isArray(inserted) ? inserted[0] : inserted;
  return { ok: Boolean(row?.id), action: "inserted", event_id: row?.id, row };
}

export async function runM7bHistoricalBackfill(options = {}) {
  const startedAt = new Date().toISOString();
  const runId = options.runId || `silversea-m7b-m4b-historical-event-${startedAt.replace(/[:.]/g, "-")}`;
  const sb = createMaintenanceSupabase(root);
  const line = (await sb(`ci_cruise_lines?slug=eq.silversea-cruises&select=id&limit=1`))?.[0];

  const statesBefore = await loadAllSilverseaObservationStates(sb, line.id);
  const snBefore = statesBefore.find((r) => r.official_sailing_id === FIXTURE.official_sailing_id);
  const eventsBefore = snBefore ? (await loadObservationEventsForState(sb, snBefore.id)) || [] : [];

  const evidence = {
    state_id: FIXTURE.state_id,
    official_sailing_id: FIXTURE.official_sailing_id,
    production_uuid: FIXTURE.production_uuid,
    event_type: FIXTURE.proposed_event.event_type,
    record_origin: FIXTURE.proposed_event.record_origin,
    previous_count: FIXTURE.proposed_event.previous_count,
    new_count: FIXTURE.proposed_event.new_count,
    period: FIXTURE.proposed_event.observation_period_key,
    snapshot: FIXTURE.proposed_event.source_snapshot_hash,
    run_id: FIXTURE.proposed_event.run_id,
    observed_at: FIXTURE.proposed_event.observed_at
  };

  const report = {
    phase: "M7B",
    run_id: runId,
    started_at: startedAt,
    mode: options.dryRun ? "dry-run" : "apply",
    evidence,
    state_before: snBefore,
    events_before: eventsBefore,
    event_writes: 0,
    observation_state_writes: 0,
    ok: false
  };

  if (!snBefore) {
    report.error = "state_not_found";
    return report;
  }

  if (options.dryRun) {
    const rpcProbe = await observationRpc(sb, "advance_cruise_source_absence_observation", {
      p_cruise_line_id: "00000000-0000-0000-0000-000000000000",
      p_official_sailing_id: "__probe__",
      p_source_health: "unhealthy"
    });
    report.rpc_schema_probe = rpcProbe;
    report.would_insert = !qualifyingEventExists(eventsBefore);
    report.ok = true;
    report.action = qualifyingEventExists(eventsBefore) ? "blocked_existing_event" : "dry_run_only";
    report.ended_at = new Date().toISOString();
    return report;
  }

  if (qualifyingEventExists(eventsBefore)) {
    report.rpc_result = { ok: true, action: "idempotent_noop", reason: "historical_event_already_present" };
    report.event_writes = 0;
    report.ok = true;
    report.action = "blocked_existing_event";
    report.ended_at = new Date().toISOString();
    if (!options.skipReportWrite) {
      fs.mkdirSync(REPORT_DIR, { recursive: true });
      const reportPath = path.join(REPORT_DIR, `${runId}.json`);
      fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      report.report_path = reportPath;
    }
    return report;
  }

  let result;
  try {
    result = await observationRpc(sb, RPC, { p_confirm_token: options.confirm || CONFIRM });
  } catch (err) {
    if (err?.statusCode !== 404 && err?.body?.code !== "PGRST202") throw err;
    report.rpc_fallback = "direct_service_role_insert";
    result = await insertHistoricalEventDirect(sb, snBefore);
  }
  report.rpc_result = result;
  report.event_writes = result?.action === "inserted" ? 1 : 0;

  const statesAfter = await loadAllSilverseaObservationStates(sb, line.id);
  const snAfter = statesAfter.find((r) => r.official_sailing_id === FIXTURE.official_sailing_id);
  const eventsAfter = snAfter ? (await loadObservationEventsForState(sb, snAfter.id)) || [] : [];
  report.state_after = snAfter;
  report.events_after = eventsAfter;

  const stateUnchanged =
    JSON.stringify({
      count: snBefore.consecutive_healthy_absence_count,
      status: snBefore.status,
      period: snBefore.last_observation_period_key,
      hash: snBefore.last_counted_snapshot_hash
    }) ===
    JSON.stringify({
      count: snAfter.consecutive_healthy_absence_count,
      status: snAfter.status,
      period: snAfter.last_observation_period_key,
      hash: snAfter.last_counted_snapshot_hash
    });

  const forensic = evaluateObservationForensicChain({ stateRow: snAfter, events: eventsAfter });
  report.forensic = forensic;
  report.observation_state_writes = 0;
  report.ok =
    stateUnchanged &&
    (result?.ok === true) &&
    (eventsAfter.length >= 1) &&
    forensic.result === FORENSIC_RESULT.FORENSIC_CHAIN_COMPLETE;
  report.ended_at = new Date().toISOString();

  if (!options.skipReportWrite) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const reportPath = path.join(REPORT_DIR, `${runId}.json`);
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    report.report_path = reportPath;
  }

  return report;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.apply && args.confirm !== CONFIRM) {
    console.error(JSON.stringify({ ok: false, error: "confirm_token_required" }, null, 2));
    process.exit(1);
  }
  const report = await runM7bHistoricalBackfill({ dryRun: args.dryRun, confirm: args.confirm });
  console.log(JSON.stringify({ ok: report.ok, event_writes: report.event_writes, forensic: report.forensic?.result, report: report.report_path }, null, 2));
  if (!report.ok && !args.dryRun) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
