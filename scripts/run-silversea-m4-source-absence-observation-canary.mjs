#!/usr/bin/env node
/**
 * Silversea M4 — source-absence observation canary (exactly SN280222C25).
 *
 *   node scripts/run-silversea-m4-source-absence-observation-canary.mjs --preflight
 *   node scripts/run-silversea-m4-source-absence-observation-canary.mjs --write-fixture
 *   SILVERSEA_OBSERVATION_WRITE_ENABLED=true node scripts/run-silversea-m4-source-absence-observation-canary.mjs \
 *     --apply --confirm=SILVERSEA-M4-SOURCE-ABSENCE-OBSERVATION-CANARY
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { execSync } from "child_process";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
  require("dotenv").config({ path: path.join(root, ".env.local") });
} catch {}

const REPORT_DIR = path.join(root, "reports");
const FIXTURE_PATH = path.join(
  root,
  "scripts/fixtures/silversea/m4-source-absence-observation-canary-SN280222C25.json"
);

const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const { indexExistingSilverseaRecords } = require(path.join(root, "netlify/functions/lib/silversea-discovery-writes"));
const { classifySilverseaOfficialInventory } = require(path.join(
  root,
  "netlify/functions/lib/silversea-classic-itinerary-ports-backfill"
));
const {
  verifyObservationSchemaReady,
  loadObservationState,
  OBSERVATION_TABLE
} = require(path.join(root, "netlify/functions/lib/silversea-source-absence-observation"));
const {
  CANARY_OFFICIAL_ID,
  OTHER_SOURCE_ABSENCE_ID,
  M3_UPDATE_CANARY_ID,
  M2_INSERT_CANARY_ID,
  M4_FIXTURE_REL,
  M4_OPERATION,
  M4_APPLY_CONFIRMATION_TOKEN,
  validateM4Preflight,
  buildM4CanaryFixture,
  applyM4ObservationOnly,
  compareObservationToFixture,
  verifyCruiseRowUnchanged,
  snapshotCruiseRow,
  proveReplayIdempotent
} = require(path.join(root, "netlify/functions/lib/silversea-m4-source-absence-observation-canary"));
const {
  snapshotProtectionRows,
  verifyProtectionSnapshots
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-itinerary-ports-backfill"));
const { perthCalendarDate } = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const { loadClassificationDestinations } = require(path.join(root, "netlify/functions/lib/destination-queries"));
const { createMaintenanceSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

export const M4_RUNNER_PATH = "scripts/run-silversea-m4-source-absence-observation-canary.mjs";

function git(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

export function parseM4Args(argv = process.argv) {
  const args = { preflight: false, writeFixture: false, apply: false, confirm: null, today: null };
  for (const arg of argv.slice(2)) {
    if (arg === "--preflight") args.preflight = true;
    if (arg === "--write-fixture") args.writeFixture = true;
    if (arg === "--apply") args.apply = true;
    if (arg.startsWith("--confirm=")) args.confirm = String(arg.split("=")[1]).trim();
    if (arg.startsWith("--today=")) args.today = String(arg.split("=")[1]).trim();
  }
  if (args.apply) args.preflight = true;
  if (!args.preflight && !args.writeFixture && !args.apply) args.preflight = true;
  return args;
}

export function assertM4ApplyAllowed(args) {
  if (!args.apply) return;
  if (args.confirm !== M4_APPLY_CONFIRMATION_TOKEN) {
    throw new Error("m4_apply_confirmation_required");
  }
  if (String(process.env.SILVERSEA_OBSERVATION_WRITE_ENABLED || "").toLowerCase() !== "true") {
    throw new Error("SILVERSEA_OBSERVATION_WRITE_ENABLED must be true for apply");
  }
}

async function loadContext(today) {
  const sb = createMaintenanceSupabase(root);
  const line = (await sb(`ci_cruise_lines?slug=eq.${adapter.LINE_SLUG}&select=id,name,slug&limit=1`))?.[0];
  if (!line) throw new Error("Silversea line not found");

  const productionIndex = await indexExistingSilverseaRecords(sb, line.id);
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

  const existingState = await loadObservationState(sb, {
    cruiseLineId: line.id,
    officialSailingId: CANARY_OFFICIAL_ID
  });

  return { sb, line, productionIndex, simulation, existingState, today };
}

export async function runSilverseaM4SourceAbsenceObservationCanary(options = {}) {
  const startedAt = new Date().toISOString();
  const args = options.args || parseM4Args();
  const today = options.today || args.today || perthCalendarDate();
  const runId =
    options.runId ||
    `silversea-m4-source-absence-${CANARY_OFFICIAL_ID}-${startedAt.replace(/[:.]/g, "-")}`;

  assertM4ApplyAllowed(args);

  const { sb, line, productionIndex, simulation, existingState } = await loadContext(today);
  const schemaReady = await verifyObservationSchemaReady(sb);
  const inventory = classifySilverseaOfficialInventory(productionIndex.rows);

  const productionBefore = {
    total: inventory.total,
    classic_stored_official: inventory.classic_stored_official_total,
    expedition_stored_official: inventory.expedition_stored_official_total,
    legacy: inventory.legacy
  };

  let fixture = fs.existsSync(FIXTURE_PATH) ? JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) : null;

  const preflight = await validateM4Preflight({
    simulation,
    productionIndex,
    cruiseLine: line,
    today,
    fixture,
    existingState
  });

  const sourceHealth = preflight.sourceHealthy && preflight.populationGuard.ok ? "PASS" : "FAIL";

  if (!schemaReady.ok && args.apply) {
    return {
      ok: false,
      phase: "M4",
      run_id: runId,
      stopped: true,
      reason: "observation_schema_not_ready",
      schema: schemaReady,
      weekly_maintenance_enabled: false
    };
  }

  if (preflight.failures.includes("source_present_not_absent")) {
    return {
      ok: false,
      phase: "M4",
      run_id: runId,
      stopped: true,
      reason: "m4_canary_no_longer_source_absent",
      recommendation: "Fresh M4 candidate/design decision required",
      weekly_maintenance_enabled: false
    };
  }

  if (!preflight.ok) {
    return {
      ok: false,
      phase: "M4",
      run_id: runId,
      stopped: true,
      reason: "preflight_failed",
      failures: preflight.failures,
      source_health: sourceHealth,
      durable_prior_count: existingState?.consecutive_healthy_absence_count || 0,
      weekly_maintenance_enabled: false,
      git_sha: git("git rev-parse HEAD")
    };
  }

  if (args.writeFixture || !fixture) {
    fixture = buildM4CanaryFixture({
      runId,
      simulation,
      productionRow: preflight.productionRow,
      preflight,
      cruiseLine: line,
      productionBefore,
      existingState
    });
    if (args.writeFixture) {
      fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
      fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
    }
  }

  const targetBeforeSnapshot = snapshotCruiseRow(preflight.productionRow);
  const allCruiseSnapshotsBefore = productionIndex.rows.map(snapshotCruiseRow);

  const report = {
    phase: "M4",
    run_id: runId,
    started_at: startedAt,
    mode: args.apply ? "apply" : "preflight",
    official_sailing_id: CANARY_OFFICIAL_ID,
    production_uuid: fixture.production_uuid,
    fixture_path: M4_FIXTURE_REL,
    fixture_count: 1,
    fixture_hash: fixture.fixture_hash,
    source_health: sourceHealth,
    source_presence: "ABSENT",
    classification: preflight.candidate?.classification,
    cutoff: preflight.candidate?.cutoff,
    durable_prior_count: preflight.advancement.prior_count,
    expected_new_count: preflight.advancement.new_count,
    observation_period_key: preflight.observationPeriodKey,
    source_snapshot_fingerprint: preflight.sourceSnapshotHash,
    quarantine_eligible: preflight.advancement.quarantine_eligible === true,
    planned_observation_writes: preflight.advancement.write_action === "insert" ? 1 : preflight.advancement.write_action === "update" ? 1 : 0,
    planned_cruise_inserts: 0,
    planned_cruise_updates: 0,
    planned_cruise_deletes: 0,
    planned_cruise_hides: 0,
    planned_reference_writes: 0,
    production_before: productionBefore,
    schema_ready: schemaReady.ok,
    runner: M4_RUNNER_PATH,
    weekly_maintenance_enabled: false,
    git_sha: git("git rev-parse HEAD")
  };

  if (!args.apply) {
    report.ended_at = new Date().toISOString();
    report.ok = preflight.ok && !preflight.failures.includes("source_present_not_absent");
    report.schema_ready = schemaReady.ok;
    if (!schemaReady.ok) {
      report.schema_warning = "observation_table_not_migrated";
      report.migration_path = "supabase/migrations/20260823_cruise_source_observation_state.sql";
    }
    return report;
  }

  const preparedPath = path.join(REPORT_DIR, `${runId}-prepared.json`);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(
    preparedPath,
    `${JSON.stringify({ ...report, status: "PREPARED", prepared_at: new Date().toISOString() }, null, 2)}\n`
  );

  const writeResult = await applyM4ObservationOnly(sb, { fixture, runId, cruiseLineId: line.id });

  const observationAfter = await loadObservationState(sb, {
    cruiseLineId: line.id,
    officialSailingId: CANARY_OFFICIAL_ID
  });

  const indexedAfter = await indexExistingSilverseaRecords(sb, line.id);
  const targetAfter = indexedAfter.byOfficialId.get(CANARY_OFFICIAL_ID);
  const targetProtection = verifyCruiseRowUnchanged(preflight.productionRow, targetAfter);

  const m2Row = indexedAfter.byOfficialId.get(M2_INSERT_CANARY_ID);
  const m3Row = indexedAfter.byOfficialId.get(M3_UPDATE_CANARY_ID);
  const otherAbsence = await loadObservationState(sb, {
    cruiseLineId: line.id,
    officialSailingId: OTHER_SOURCE_ABSENCE_ID
  });

  const m2Protected = m2Row
    ? verifyProtectionSnapshots(snapshotProtectionRows([productionIndex.byOfficialId.get(M2_INSERT_CANARY_ID)], new Set()), [m2Row], new Set()).ok
    : false;
  const m3Protected = m3Row
    ? verifyProtectionSnapshots(snapshotProtectionRows([productionIndex.byOfficialId.get(M3_UPDATE_CANARY_ID)], new Set()), [m3Row], new Set()).ok
    : false;

  const inventoryAfter = classifySilverseaOfficialInventory(indexedAfter.rows);
  const rowDeltaOk =
    inventoryAfter.total === productionBefore.total &&
    inventoryAfter.classic_stored_official_total === productionBefore.classic_stored_official &&
    inventoryAfter.expedition_stored_official_total === productionBefore.expedition_stored_official &&
    inventoryAfter.legacy === productionBefore.legacy;

  const observationMatch = compareObservationToFixture(observationAfter, fixture);
  const replayDryRun = await validateM4Preflight({
    simulation,
    productionIndex: indexedAfter,
    cruiseLine: line,
    today,
    fixture,
    existingState: observationAfter
  });
  const replayBlock = proveReplayIdempotent(replayDryRun);

  const finalReport = {
    ...report,
    ok:
      writeResult.ok &&
      observationMatch.ok &&
      targetProtection.ok &&
      m2Protected &&
      m3Protected &&
      rowDeltaOk &&
      replayBlock.ok,
    ended_at: new Date().toISOString(),
    prepared_report_path: preparedPath,
    write_result: writeResult,
    observation_verification: observationMatch,
    observation_state: observationAfter,
    target_protection: targetProtection,
    m2_canary_protected: m2Protected,
    m3_canary_protected: m3Protected,
    other_absence_state_touched:
      otherAbsence?.last_run_id === runId && otherAbsence?.official_sailing_id === OTHER_SOURCE_ABSENCE_ID,
    row_delta_ok: rowDeltaOk,
    replay_idempotency: replayBlock,
    production_summary: {
      cruise_inserts: 0,
      cruise_updates: 0,
      cruise_deletes: 0,
      cruise_hides: 0,
      reference_writes: 0,
      observation_state_writes: writeResult.stats.observation_writes
    },
    quarantine_executed: false,
    quarantine_proposal: fixture.quarantine_eligible ? "QUARANTINE_REVIEW_REQUIRED" : null
  };

  const outPath = path.join(REPORT_DIR, `${runId}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(finalReport, null, 2)}\n`);
  return finalReport;
}

async function main() {
  const result = await runSilverseaM4SourceAbsenceObservationCanary({ args: parseM4Args() });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
