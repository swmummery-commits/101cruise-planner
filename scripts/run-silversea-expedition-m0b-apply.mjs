#!/usr/bin/env node
/**
 * Silversea Expedition Phase M0B — controlled itinerary_ports backfill (200 updates).
 *
 *   node scripts/run-silversea-expedition-m0b-apply.mjs --preflight
 *   SILVERSEA_DISCOVERY_WRITE_ENABLED=true node scripts/run-silversea-expedition-m0b-apply.mjs \
 *     --apply --confirm=SILVERSEA-EXPEDITION-M0B-ITINERARY-PORTS-BACKFILL
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
} catch {
  /* optional */
}

const REPORT_DIR = path.join(root, "reports");
const FIXTURE_PATH = path.join(root, "scripts/fixtures/silversea/expedition-m0a-itinerary-ports-backfill.json");

const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const {
  loadFrozenExpeditionIds,
  E3_FIRST_250_FIXTURE,
  E5_NEXT_BATCH_FIXTURE
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-controlled-batch"));
const { indexExistingSilverseaRecords } = require(path.join(
  root,
  "netlify/functions/lib/silversea-discovery-writes"
));
const {
  M0A_BACKFILL_FIXTURE,
  M0B_OPERATION,
  M0B_APPLY_CONFIRMATION_TOKEN,
  E6_RUN_ID,
  UPDATE_WHITELIST,
  isExpeditionOfficialId,
  portsArrayEqual,
  normalizeStoredPorts,
  buildExpectedItineraryPorts,
  classifyItineraryPortsRepair,
  validateRepairFixture,
  verifyFrozenBeforeMatch,
  snapshotComparableFields,
  dryRunItineraryPortsBackfill,
  buildM0bRollbackManifest,
  applyItineraryPortsRepairBatch,
  verifyRepairBatchResults
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-itinerary-ports-backfill"));
const { buildDiscoveredCruiseUpsertPayload } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-ops"
));
const { verifyStoredExpeditionRow } = require(path.join(
  root,
  "netlify/functions/lib/silversea-expedition-verification"
));
const {
  RUN_STATUS,
  buildApplyReportLifecycle,
  updateReportLifecycle,
  ControlledProductionRunStore,
  executeHardenedControlledProductionApply
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-controlled-production-run"));
const { DEFAULT_GLOBAL_LEASE_SECONDS } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-global-write-lock"
));
const {
  resolveSilverseaDiscoveryMode,
  assertSilverseaWritesAllowed
} = require(path.join(root, "netlify/functions/lib/silversea-discovery-mode"));
const { perthCalendarDate } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));
const { loadClassificationDestinations } = require(path.join(
  root,
  "netlify/functions/lib/destination-queries"
));
const { createMaintenanceSupabase, exactCountSupabase } = require(path.join(
  root,
  "scripts/lib/supabase-rest.cjs"
));

export const M0B_RUNNER_PATH = "scripts/run-silversea-expedition-m0b-apply.mjs";
export const M0B_USES_HARDENED_RUNNER = true;

function git(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

function parseArgs(argv = process.argv) {
  const args = { preflight: false, apply: false, confirm: null };
  for (const arg of argv.slice(2)) {
    if (arg === "--preflight") args.preflight = true;
    if (arg === "--apply") args.apply = true;
    if (arg.startsWith("--confirm=")) args.confirm = String(arg.split("=")[1]).trim();
  }
  if (args.apply) args.preflight = true;
  if (!args.preflight && !args.apply) args.preflight = true;
  return args;
}

function assertApplyAllowed(args) {
  if (!args.apply) return;
  if (args.confirm !== M0B_APPLY_CONFIRMATION_TOKEN) {
    throw new Error("m0b_apply_confirmation_required");
  }
  if (String(process.env.SILVERSEA_DISCOVERY_WRITE_ENABLED || "").toLowerCase() !== "true") {
    throw new Error("SILVERSEA_DISCOVERY_WRITE_ENABLED must be true for apply");
  }
}

function verifyInsertPathFix() {
  const candidate = {
    cruise_line_id: "l1",
    ship_id: "s1",
    destination_id: "d1",
    departure_date: "2028-01-01",
    return_date: "2028-01-08",
    nights: 7,
    departure_port: "Baltra",
    itinerary: "Baltra",
    itinerary_ports: ["San Cristóbal", "Baltra"],
    official_url: "https://x",
    external_key: "e1",
    official_sailing_id: "OR1",
    raw_extract: {}
  };
  const merged = { departure_port: "Baltra", departure_port_meta: null, blocked: false, reason: "new" };
  const payload = buildDiscoveredCruiseUpsertPayload(candidate, merged, {
    identity_key: "k1",
    status: "active",
    reasons: [],
    now: new Date().toISOString(),
    includeItineraryPorts: true
  });
  return Array.isArray(payload.itinerary_ports) && payload.itinerary_ports.length === 2;
}

async function headLineCount(lineId) {
  const { count } = await exactCountSupabase(root, "discovered_cruises", `cruise_line_id=eq.${encodeURIComponent(lineId)}`);
  return count;
}

function snapshotProtectionRows(rows, targetUuids) {
  const out = new Map();
  for (const row of rows) {
    if (targetUuids.has(row.id)) continue;
    out.set(row.id, {
      itinerary_ports: normalizeStoredPorts(row.itinerary_ports),
      comparable: snapshotComparableFields(row)
    });
  }
  return out;
}

function verifyProtectionSnapshots(beforeMap, afterRows, targetUuids) {
  const issues = [];
  for (const row of afterRows) {
    if (targetUuids.has(row.id)) continue;
    const before = beforeMap.get(row.id);
    if (!before) continue;
    if (!portsArrayEqual(before.itinerary_ports, row.itinerary_ports)) {
      issues.push({ id: row.id, field: "itinerary_ports" });
    }
    const afterComparable = snapshotComparableFields(row);
    for (const field of Object.keys(before.comparable)) {
      if (JSON.stringify(before.comparable[field]) !== JSON.stringify(afterComparable[field])) {
        issues.push({ id: row.id, field });
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

async function auditAllExpeditionItineraryPorts(expeditionRows, sourceById, line, today) {
  const categoryCounts = {};
  let mismatches = 0;
  for (const prodRow of expeditionRows) {
    const source = sourceById.get(String(prodRow.official_sailing_id).toUpperCase()) || null;
    const stored = normalizeStoredPorts(prodRow.itinerary_ports);
    let expected = [];
    let expectedOk = false;
    if (source) {
      const built = buildExpectedItineraryPorts(source, line, today);
      expectedOk = built.ok;
      expected = built.ok ? built.ports : [];
    }
    const category = classifyItineraryPortsRepair({
      storedPorts: stored,
      expectedPorts: expected,
      sourceAvailable: Boolean(source),
      expectedOk
    });
    categoryCounts[category] = (categoryCounts[category] || 0) + 1;
    if (!portsArrayEqual(stored, expected) && expectedOk) mismatches += 1;
  }
  return {
    ok: mismatches === 0,
    mismatches,
    category_counts: categoryCounts,
    total: expeditionRows.length
  };
}

export async function runSilverseaExpeditionM0b(options = {}) {
  const args = options.args || parseArgs();
  assertApplyAllowed(args);
  const startedAt = new Date().toISOString();
  const today = perthCalendarDate();

  if (!verifyInsertPathFix()) {
    throw new Error("insert_path_fix_regressed — STOP WITH ZERO WRITES");
  }

  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
  const fixtureValidation = validateRepairFixture(fixture);
  if (!fixtureValidation.ok) {
    throw new Error(`fixture_invalid:${fixtureValidation.issues.join(",")} — STOP WITH ZERO WRITES`);
  }

  const repairRows = fixture.rows.slice().sort((a, b) =>
    String(a.official_sailing_id).localeCompare(String(b.official_sailing_id))
  );
  const targetUuids = new Set(repairRows.map((r) => r.production_uuid));
  const dryRun = dryRunItineraryPortsBackfill(fixture);

  const sb = createMaintenanceSupabase(root);
  const line = (await sb(`ci_cruise_lines?slug=eq.${adapter.LINE_SLUG}&select=id,name,slug&limit=1`))?.[0];
  if (!line) throw new Error("Silversea line not found");

  const indexed = await indexExistingSilverseaRecords(sb, line.id);
  const allRows = indexed.rows;
  const expeditionRows = allRows.filter(
    (r) => r.status === "active" && r.official_sailing_id && isExpeditionOfficialId(r.official_sailing_id)
  );
  const classicRows = allRows.filter(
    (r) => r.status === "active" && r.official_sailing_id && !isExpeditionOfficialId(r.official_sailing_id)
  );
  const legacyRows = allRows.filter((r) => !r.official_sailing_id);

  for (const row of repairRows) {
    const prod = indexed.byOfficialId.get(String(row.official_sailing_id).toUpperCase());
    if (!prod || prod.id !== row.production_uuid) {
      throw new Error(`missing_frozen_row:${row.official_sailing_id} — STOP WITH ZERO WRITES`);
    }
  }

  const destinations = adapter.catalogueDestinations(
    await loadClassificationDestinations(async (q) => sb(q))
  );
  const ships = await sb(
    `ci_cruise_ships?cruise_line_id=eq.${line.id}&select=id,name,cruise_line_id,official_line_ship_id`
  );
  const simulation = await adapter.simulateSilverseaInventory({
    cruiseLine: line,
    ships,
    destinations,
    existingRows: allRows,
    today,
    concurrency: 6
  });
  if (!simulation.ok || !simulation.health?.ok) {
    throw new Error("source_health_failed — STOP WITH ZERO WRITES");
  }

  const sourceById = new Map();
  for (const row of simulation.products) {
    if (row.official_sailing_id) {
      sourceById.set(String(row.official_sailing_id).toUpperCase(), row);
    }
  }

  let freshMatchCount = 0;
  const freshMismatches = [];
  for (const row of repairRows) {
    const source = sourceById.get(String(row.official_sailing_id).toUpperCase());
    if (!source) {
      freshMismatches.push({ official_sailing_id: row.official_sailing_id, reason: "source_missing" });
      continue;
    }
    const built = buildExpectedItineraryPorts(source, line, today);
    if (!built.ok) {
      freshMismatches.push({ official_sailing_id: row.official_sailing_id, reason: built.reason });
      continue;
    }
    if (portsArrayEqual(built.ports, row.after_itinerary_ports)) {
      freshMatchCount += 1;
    } else {
      freshMismatches.push({
        official_sailing_id: row.official_sailing_id,
        reason: "after_mismatch",
        fresh: built.ports,
        frozen: row.after_itinerary_ports
      });
    }
  }
  if (freshMatchCount !== 200 || freshMismatches.length > 0) {
    throw new Error(`fresh_reconstruction_mismatch:${freshMismatches.length} — STOP WITH ZERO WRITES`);
  }

  let preliminaryBeforeMatch = 0;
  const preliminaryFailures = [];
  for (const row of repairRows) {
    const prod = (await sb(`discovered_cruises?id=eq.${encodeURIComponent(row.production_uuid)}&select=*&limit=1`))?.[0];
    const check = verifyFrozenBeforeMatch(prod, row);
    if (check.ok) preliminaryBeforeMatch += 1;
    else preliminaryFailures.push({ official_sailing_id: row.official_sailing_id, issues: check.issues });
  }
  if (preliminaryBeforeMatch !== 200) {
    throw new Error(`preliminary_frozen_before_failed:${preliminaryFailures.length} — STOP WITH ZERO WRITES`);
  }

  const countsBefore = {
    silversea_total: await headLineCount(line.id),
    expedition: expeditionRows.length,
    classic: classicRows.length,
    legacy: legacyRows.length
  };

  const nonTargetExpeditionSnapshot = snapshotProtectionRows(expeditionRows, targetUuids);
  const classicSnapshot = snapshotProtectionRows(classicRows, new Set());
  const legacyBefore = legacyRows.map((r) => ({
    id: r.id,
    status: r.status,
    official_sailing_id: r.official_sailing_id,
    review_reason: r.review_reason
  }));

  const preWriteTable = repairRows.map((row, i) => ({
    sequence: i + 1,
    production_uuid: row.production_uuid,
    official_sailing_id: row.official_sailing_id,
    region: row.region,
    provenance: row.provenance,
    current_itinerary_ports: row.before_itinerary_ports,
    frozen_before: row.before_itinerary_ports,
    frozen_after: row.after_itinerary_ports,
    fresh_expected: row.after_itinerary_ports,
    precondition: "PASS",
    proposed_action: "UPDATE itinerary_ports ONLY"
  }));

  if (
    dryRun.proposed_itinerary_ports_updates !== 200 ||
    dryRun.proposed_inserts !== 0 ||
    dryRun.proposed_deletes !== 0 ||
    dryRun.other_column_updates !== 0
  ) {
    throw new Error("dry_run_counts_invalid — STOP WITH ZERO WRITES");
  }

  const runId = options.runId || `silversea-expedition-m0b-itinerary-ports-${startedAt.replace(/[:.]/g, "-")}`;
  const store = new ControlledProductionRunStore(REPORT_DIR, runId);

  let rollbackManifest = buildM0bRollbackManifest({
    runId,
    fixturePath: M0A_BACKFILL_FIXTURE,
    lineSlug: adapter.LINE_SLUG,
    cruiseLineId: line.id,
    rows: repairRows,
    expectedUpdates: 200,
    productionBefore: countsBefore,
    createdAt: startedAt
  });

  let applyReport = buildApplyReportLifecycle({
    runId,
    createdAt: startedAt,
    fixturePath: M0A_BACKFILL_FIXTURE,
    operation: M0B_OPERATION,
    lineSlug: adapter.LINE_SLUG,
    expectedInserts: 0,
    productionBefore: countsBefore
  });
  applyReport.phase = "M0B";
  applyReport.expected_updates = 200;
  applyReport.update_whitelist = UPDATE_WHITELIST.slice();
  applyReport.hardened_runner = true;
  applyReport.m0b_runner_path = M0B_RUNNER_PATH;

  const rollbackPath = store.persistPreparedRollback(rollbackManifest);
  const applyReportPath = store.persistPreparedReport(applyReport);
  applyReport = updateReportLifecycle(applyReport, {
    rollback_manifest_path: rollbackPath,
    apply_report_path: applyReportPath
  });
  store.updateReport(applyReport);

  const preparedRollback = store.readRollback();
  const preparedReport = JSON.parse(fs.readFileSync(applyReportPath, "utf8"));
  if (preparedRollback?.status !== RUN_STATUS.PREPARED || preparedReport.status !== RUN_STATUS.PREPARED) {
    throw new Error("prepared_state_reread_failed — STOP WITH ZERO WRITES");
  }

  let writeResult = null;
  let hardenedResult = null;
  let verification = null;
  let full310Audit = null;
  let protection = null;

  if (args.apply) {
    assertSilverseaWritesAllowed(resolveSilverseaDiscoveryMode("production_write"));

    hardenedResult = await executeHardenedControlledProductionApply(
      sb,
      {
        runId,
        lineSlug: adapter.LINE_SLUG,
        operation: M0B_OPERATION,
        performWrites: true,
        leaseSeconds: DEFAULT_GLOBAL_LEASE_SECONDS,
        underLockRecheck: async () => {
          let underLockMatch = 0;
          for (const row of repairRows) {
            const prod = (await sb(`discovered_cruises?id=eq.${encodeURIComponent(row.production_uuid)}&select=*&limit=1`))?.[0];
            if (verifyFrozenBeforeMatch(prod, row).ok) underLockMatch += 1;
          }
          if (underLockMatch !== 200) {
            return { ok: false, reason: "under_lock_frozen_before_mismatch", matched: underLockMatch };
          }
          return { ok: true, matched: underLockMatch, proposed_updates: 200 };
        }
      },
      {
        onLockAcquired: async (lockMeta) => {
          rollbackManifest.status = RUN_STATUS.LOCK_ACQUIRED;
          store.updateRollback(rollbackManifest);
          applyReport = updateReportLifecycle(applyReport, {
            status: RUN_STATUS.LOCK_ACQUIRED,
            global_lock: lockMeta.observability || lockMeta
          });
          store.updateReport(applyReport);
        },
        mutate: async () => {
          rollbackManifest.status = RUN_STATUS.MUTATING;
          store.updateRollback(rollbackManifest);
          applyReport = updateReportLifecycle(applyReport, { status: RUN_STATUS.MUTATING });
          store.updateReport(applyReport);

          return applyItineraryPortsRepairBatch(sb, repairRows, {
            onUpdateSuccess: async ({ production_uuid }) => {
              if (!rollbackManifest.updated_record_ids.includes(production_uuid)) {
                rollbackManifest.updated_record_ids.push(production_uuid);
                store.updateRollback(rollbackManifest);
              }
            }
          });
        },
        onWriteComplete: async ({ writeResult: wr }) => {
          writeResult = wr;
          rollbackManifest.status = RUN_STATUS.WRITE_COMPLETE;
          rollbackManifest.updated_count = wr.stats.updated;
          store.updateRollback(rollbackManifest);
          applyReport = updateReportLifecycle(applyReport, {
            status: RUN_STATUS.WRITE_COMPLETE,
            write_result: wr.stats
          });
          store.updateReport(applyReport);
        },
        onVerificationStart: async () => {
          rollbackManifest.status = RUN_STATUS.VERIFYING;
          store.updateRollback(rollbackManifest);
          applyReport = updateReportLifecycle(applyReport, { status: RUN_STATUS.VERIFYING });
          store.updateReport(applyReport);
        },
        verifyUnderLock: async ({ writeResult: wr }) => {
          if (wr.stats.updated !== 200 || wr.stats.failed !== 0) {
            return {
              ok: false,
              reason: `write_count_mismatch:updated=${wr.stats.updated},failed=${wr.stats.failed}`,
              lock_held: true
            };
          }

          verification = await verifyRepairBatchResults(sb, repairRows);
          verification.lock_held_through_verification = true;

          const indexedAfter = await indexExistingSilverseaRecords(sb, line.id);
          const expeditionAfter = indexedAfter.rows.filter(
            (r) => r.status === "active" && r.official_sailing_id && isExpeditionOfficialId(r.official_sailing_id)
          );

          full310Audit = await auditAllExpeditionItineraryPorts(expeditionAfter, sourceById, line, today);

          const nonTargetCheck = verifyProtectionSnapshots(
            nonTargetExpeditionSnapshot,
            expeditionAfter,
            targetUuids
          );
          const classicCheck = verifyProtectionSnapshots(classicSnapshot, indexedAfter.rows, targetUuids);
          const legacyAfter = indexedAfter.rows
            .filter((r) => !r.official_sailing_id)
            .map((r) => ({
              id: r.id,
              status: r.status,
              official_sailing_id: r.official_sailing_id,
              review_reason: r.review_reason
            }));

          const e5Fixture = JSON.parse(
            fs.readFileSync(path.join(root, E5_NEXT_BATCH_FIXTURE), "utf8")
          );
          const e5OfficialIds = loadFrozenExpeditionIds(e5Fixture);
          const e6Checks = [];
          for (const officialId of e5OfficialIds) {
            const row = indexedAfter.byOfficialId.get(String(officialId).toUpperCase());
            const sourceRow = sourceById.get(String(officialId).toUpperCase()) || null;
            const rowCheck = verifyStoredExpeditionRow(row, {
              lineId: line.id,
              manifestEntry: null,
              sourceRow
            });
            e6Checks.push({
              official_sailing_id: officialId,
              discovered_cruise_id: row?.id || null,
              ok: rowCheck.ok,
              issues: rowCheck.issues || []
            });
          }
          const e6Verify = {
            ok: e6Checks.every((c) => c.ok) && e6Checks.length === 60,
            verified_count: e6Checks.filter((c) => c.ok).length,
            failed_count: e6Checks.filter((c) => !c.ok).length,
            records: e6Checks
          };

          protection = {
            non_target_expedition_unchanged: nonTargetCheck.ok,
            non_target_issues: nonTargetCheck.issues,
            classic_unchanged: classicCheck.ok,
            classic_issues: classicCheck.issues.slice(0, 10),
            legacy_8_unchanged: JSON.stringify(legacyBefore) === JSON.stringify(legacyAfter),
            full_310_audit: full310Audit,
            e6_reverification: e6Verify
          };

          const allOk =
            verification.ok &&
            full310Audit.ok &&
            nonTargetCheck.ok &&
            classicCheck.ok &&
            protection.legacy_8_unchanged &&
            e6Verify.ok &&
            e6Verify.verified_count === 60;

          return {
            ok: allOk,
            ...verification,
            protection,
            full_310_audit: full310Audit,
            e6_data_remediated: e6Verify.ok && e6Verify.verified_count === 60
          };
        },
        finalizeUnderLock: async ({ verificationResult, verificationError, writeResult: wr }) => {
          const finalStatus =
            verificationError || verificationResult?.ok === false
              ? RUN_STATUS.WRITE_SUCCEEDED_VERIFICATION_FAILED
              : RUN_STATUS.VERIFIED;

          rollbackManifest.status = finalStatus;
          rollbackManifest.verification_status = verificationResult;
          rollbackManifest.verification_error = verificationError || null;
          store.updateRollback(rollbackManifest);

          applyReport = updateReportLifecycle(applyReport, {
            status: finalStatus === RUN_STATUS.VERIFIED ? RUN_STATUS.COMPLETE : finalStatus,
            verification: verificationResult,
            verification_error: verificationError || null,
            global_lock_held_through_verification: true
          });
          store.updateReport(applyReport);

          if (wr.stats.updated !== 200) {
            throw new Error(`update_count_mismatch:${wr.stats.updated}`);
          }
          if (finalStatus !== RUN_STATUS.VERIFIED) {
            throw new Error("write_succeeded_verification_failed");
          }

          return { persisted: true, final_status: finalStatus };
        }
      }
    );

    writeResult = hardenedResult.writeResult;

    if (hardenedResult.blocked) {
      return { blocked: true, reason: hardenedResult.reason, run_id: runId };
    }
    if (hardenedResult.writeError) throw hardenedResult.writeError;
    if (hardenedResult.run_status === RUN_STATUS.WRITE_SUCCEEDED_VERIFICATION_FAILED) {
      throw new Error("write_succeeded_verification_failed");
    }
  }

  const indexedFinal = args.apply ? await indexExistingSilverseaRecords(sb, line.id) : indexed;
  const countsAfter = args.apply
    ? {
        silversea_total: await headLineCount(line.id),
        expedition: indexedFinal.rows.filter(
          (r) => r.status === "active" && r.official_sailing_id && isExpeditionOfficialId(r.official_sailing_id)
        ).length
      }
    : countsBefore;

  const report = {
    phase: args.apply ? "m0b_apply" : "m0b_preflight",
    run_id: runId,
    m0b_runner_path: M0B_RUNNER_PATH,
    m0b_uses_hardened_runner: true,
    fixture_path: M0A_BACKFILL_FIXTURE,
    fixture_validation: fixtureValidation,
    insert_path_fix_verified: true,
    fresh_reconstruction: { matched: freshMatchCount, total: 200 },
    preliminary_frozen_before_match: preliminaryBeforeMatch,
    dry_run: dryRun,
    pre_write_table: preWriteTable,
    production_before: countsBefore,
    production_after: countsAfter,
    row_delta: args.apply ? countsAfter.silversea_total - countsBefore.silversea_total : 0,
    prepared_state: { rollback_path: rollbackPath, apply_report_path: applyReportPath },
    write_result: writeResult?.stats || null,
    verification,
    protection,
    full_310_audit: full310Audit,
    hardened_apply: hardenedResult,
    data_shape_remediation_complete: args.apply && full310Audit?.ok === true,
    e6_data_remediated_and_verified: args.apply && protection?.e6_reverification?.ok === true,
    initial_catchup_complete_enough: true,
    weekly_maintenance: "NOT ENABLED",
    m1_authorised: false,
    next_phase: args.apply && full310Audit?.ok ? "A. M0C — FULL CLASSIC ITINERARY_PORTS IMPACT AUDIT + BACKFILL PREPARATION" : null,
    production_writes: {
      inserts: 0,
      itinerary_ports_updates: writeResult?.stats?.updated || 0,
      deletes: 0,
      other_column_updates: 0
    },
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    git: { branch: git("git rev-parse --abbrev-ref HEAD"), sha: git("git rev-parse HEAD") }
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `silversea-expedition-m0b-${runId}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  report.report_path = reportPath;

  return report;
}

async function main() {
  try {
    const report = await runSilverseaExpeditionM0b();
    console.log(
      JSON.stringify(
        {
          ok: !report.blocked,
          phase: report.phase,
          updates: report.production_writes?.itinerary_ports_updates,
          report: report.report_path
        },
        null,
        2
      )
    );
    if (report.blocked) process.exit(1);
    if (report.phase === "m0b_apply" && report.production_writes.itinerary_ports_updates !== 200) process.exit(1);
  } catch (err) {
    console.error(JSON.stringify({ status: "failed", error: err.message }, null, 2));
    process.exit(1);
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();
