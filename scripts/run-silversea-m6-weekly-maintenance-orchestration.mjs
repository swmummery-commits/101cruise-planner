#!/usr/bin/env node
/**
 * Silversea M6 — full weekly maintenance read-only orchestration.
 *
 *   npm run silversea:m6-weekly-maintenance
 *   node scripts/run-silversea-m6-weekly-maintenance-orchestration.mjs
 *
 * NO production writes. NO observation RPC mutations. Apply mode blocked.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const root = path.join(path.dirname(__filename), "..");
const require = createRequire(import.meta.url);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
  require("dotenv").config({ path: path.join(root, ".env.local") });
} catch {}

const REPORT_DIR = path.join(root, "reports");
export const M6_RUNNER_PATH = "scripts/run-silversea-m6-weekly-maintenance-orchestration.mjs";

const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const { indexExistingSilverseaRecords } = require(path.join(root, "netlify/functions/lib/silversea-discovery-writes"));
const {
  loadAllSilverseaObservationStates,
  observationStatesByOfficialId,
  productionInventoryBreakdown,
  buildM6OrchestrationReport,
  M2_CANARY_ID,
  M3_CANARY_ID,
  SOURCE_ABSENCE_FIXTURE_ID
} = require(path.join(root, "netlify/functions/lib/silversea-m6-weekly-maintenance-orchestration"));
const {
  loadAllSilverseaObservationEvents,
  loadObservationEventsForState
} = require(path.join(root, "netlify/functions/lib/silversea-source-absence-observation-events"));
const {
  snapshotProtectionRows,
  verifyProtectionSnapshots
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-itinerary-ports-backfill"));
const { perthCalendarDate } = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const { loadClassificationDestinations } = require(path.join(root, "netlify/functions/lib/destination-queries"));
const { createMaintenanceSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

function parseWeeklyMaintenanceArgs(argv = process.argv) {
  const args = argv.slice(2);
  let today = null;
  let apply = false;
  for (const arg of args) {
    if (arg === "--apply" || arg.startsWith("--apply=")) apply = true;
    if (arg.startsWith("--today=")) today = String(arg.slice("--today=".length)).trim();
  }
  return { apply, dryRun: !apply, today };
}

function assertM1MutationBlocked({ apply }) {
  if (!apply) return { blocked: false, reason: "dry_run_default" };
  return {
    blocked: true,
    reason: "m6_mutation_not_implemented",
    detail: "M6 supports dry-run only. Apply requires future authorised phase with global lock + confirmation."
  };
}

function git(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

function auditWeeklyCron() {
  const netlifyToml = path.join(root, "netlify.toml");
  const content = fs.existsSync(netlifyToml) ? fs.readFileSync(netlifyToml, "utf8") : "";
  const silverseaCron =
    /silversea.*weekly|weekly.*silversea|silversea-weekly-maintenance/i.test(content) &&
    /schedule|cron/i.test(content);
  return { silversea_weekly_schedule_exists: silverseaCron, netlify_toml_scanned: true };
}

export async function runSilverseaM6WeeklyMaintenanceOrchestration(options = {}) {
  const startedAt = new Date().toISOString();
  const today = options.today || perthCalendarDate();
  const runId = options.runId || `silversea-m6-weekly-maintenance-${startedAt.replace(/[:.]/g, "-")}`;
  const startingSha = options.startingSha || git("git rev-parse HEAD");

  const sb = createMaintenanceSupabase(root);
  const line = (await sb(`ci_cruise_lines?slug=eq.${adapter.LINE_SLUG}&select=id,name,slug&limit=1`))?.[0];
  if (!line) throw new Error("Silversea line not found");

  const productionIndex = await indexExistingSilverseaRecords(sb, line.id);
  const productionBefore = productionInventoryBreakdown(productionIndex.rows);
  const observationStatesBefore = await loadAllSilverseaObservationStates(sb, line.id);
  const obsByIdBefore = observationStatesByOfficialId(observationStatesBefore);
  const allEvents = await loadAllSilverseaObservationEvents(sb, line.id);
  const eventHistoryTableAvailable = allEvents !== null;
  const observationEventsByStateId = new Map();
  if (eventHistoryTableAvailable) {
    for (const state of observationStatesBefore) {
      const events =
        allEvents.filter((e) => e.state_id === state.id) ||
        (await loadObservationEventsForState(sb, state.id)) ||
        [];
      observationEventsByStateId.set(state.id, events);
    }
  }

  const canaryRowsBefore = [
    productionIndex.byOfficialId.get(M2_CANARY_ID),
    productionIndex.byOfficialId.get(M3_CANARY_ID),
    productionIndex.byOfficialId.get(SOURCE_ABSENCE_FIXTURE_ID)
  ].filter(Boolean);
  const canarySnapshotsBefore = snapshotProtectionRows(canaryRowsBefore, new Set());

  const destinations = adapter.catalogueDestinations(await loadClassificationDestinations(async (q) => sb(q)));
  const ships = await sb(
    `ci_cruise_ships?cruise_line_id=eq.${line.id}&select=id,name,cruise_line_id,official_line_ship_id`
  );

  const simulation = await adapter.simulateSilverseaInventory({
    cruiseLine: line,
    ships,
    destinations,
    existingRows: productionIndex.rows,
    today,
    concurrency: 6
  });

  const orchestration = buildM6OrchestrationReport({
    simulation,
    productionIndex,
    cruiseLine: line,
    today,
    observationStates: observationStatesBefore,
    observationStatesById: obsByIdBefore,
    observationEventsByStateId,
    eventHistoryTableAvailable,
    startingProductionInventory: productionBefore,
    canarySnapshotsBefore,
    baselineSourceSummary: options.baselineSourceSummary || null
  });

  const observationStatesAfter = await loadAllSilverseaObservationStates(sb, line.id);
  const productionIndexAfter = await indexExistingSilverseaRecords(sb, line.id);
  const productionAfter = productionInventoryBreakdown(productionIndexAfter.rows);

  const canaryRowsAfter = [
    productionIndexAfter.byOfficialId.get(M2_CANARY_ID),
    productionIndexAfter.byOfficialId.get(M3_CANARY_ID),
    productionIndexAfter.byOfficialId.get(SOURCE_ABSENCE_FIXTURE_ID)
  ].filter(Boolean);
  const canaryProtection = verifyProtectionSnapshots(canarySnapshotsBefore, canaryRowsAfter, new Set(), {
    perthToday: today
  });

  const observationDelta =
    JSON.stringify(
      observationStatesBefore.map((r) => ({
        id: r.id,
        official_sailing_id: r.official_sailing_id,
        count: r.consecutive_healthy_absence_count,
        status: r.status,
        period: r.last_observation_period_key
      }))
    ) ===
    JSON.stringify(
      observationStatesAfter.map((r) => ({
        id: r.id,
        official_sailing_id: r.official_sailing_id,
        count: r.consecutive_healthy_absence_count,
        status: r.status,
        period: r.last_observation_period_key
      }))
    );

  const productionDelta =
    productionBefore.total === productionAfter.total &&
    productionBefore.official_total === productionAfter.official_total &&
    productionBefore.legacy === productionAfter.legacy &&
    productionBefore.duplicate_official_ids === productionAfter.duplicate_official_ids;

  const cronAudit = auditWeeklyCron();

  const report = {
    run_id: runId,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    git: {
      starting_sha: startingSha,
      ending_sha: git("git rev-parse HEAD"),
      branch: git("git branch --show-current")
    },
    orchestrator_path: M6_RUNNER_PATH,
    ...orchestration,
    verification: {
      observation_state_before: observationStatesBefore,
      observation_state_after: observationStatesAfter,
      observation_state_delta: observationDelta ? 0 : 1,
      production_before: productionBefore,
      production_after: productionAfter,
      production_row_delta: productionDelta ? 0 : 1,
      canary_protection: canaryProtection,
      production_rpc_mutation_calls: 0,
      cruise_mutation_calls: 0,
      cron_audit: cronAudit
    },
    write_summary: {
      source_absence_observation_state_writes: 0,
      source_absence_observation_resolve_writes: 0,
      production_silversea_cruise_inserts: 0,
      production_silversea_cruise_updates: 0,
      production_silversea_cruise_deletes: 0,
      production_silversea_cruise_hides_quarantines: 0,
      production_silversea_reference_writes: 0,
      production_silversea_row_delta: productionDelta ? 0 : 1
    },
    m6_status: {
      pass:
        orchestration.ok &&
        observationDelta &&
        productionDelta &&
        canaryProtection.ok &&
        !cronAudit.silversea_weekly_schedule_exists,
      decision: orchestration.ok ? "PASS" : "FAIL",
      next_phase: orchestration.ok
        ? "A. SILVERSEA M7 — APPEND-ONLY SOURCE-OBSERVATION EVENT HISTORY AUTHORISED"
        : "B. SILVERSEA M6 REMEDIATION REQUIRED"
    },
    forensic_blocker:
      "REAL SOURCE-ABSENCE QUARANTINE/HIDE MUTATION BLOCKED UNTIL APPEND-ONLY OBSERVATION EVENT HISTORY = IMPLEMENTED AND PROVEN",
    weekly_maintenance: "NOT ENABLED",
    supabase_cli_migration_history_reconciliation_deferred: "YES"
  };

  if (!options.skipReportWrite) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const reportPath = path.join(REPORT_DIR, `${runId}.json`);
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    report.report_path = reportPath;
  }

  return report;
}

async function main() {
  const args = parseWeeklyMaintenanceArgs();
  const mutationGate = assertM1MutationBlocked(args);
  if (mutationGate.blocked && args.apply) {
    console.error(JSON.stringify({ ok: false, phase: "M6", ...mutationGate }, null, 2));
    process.exit(1);
  }

  const startingSha = git("git rev-parse HEAD");
  const report = await runSilverseaM6WeeklyMaintenanceOrchestration({ startingSha, today: args.today || undefined });

  console.log(
    JSON.stringify(
      {
        ok: report.m6_status.pass,
        m6_status: report.m6_status.decision,
        source_health: report.source.health,
        action_summary: report.action_summary,
        semantic_checksum: report.semantic_checksum,
        observation_state_delta: report.verification.observation_state_delta,
        production_row_delta: report.verification.production_row_delta,
        next_phase: report.m6_status.next_phase,
        report: report.report_path
      },
      null,
      2
    )
  );

  if (!report.m6_status.pass) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
