#!/usr/bin/env node
/**
 * Silversea Classic Phase M0D3 — final controlled itinerary_ports backfill (199 of 599).
 *
 *   node scripts/run-silversea-classic-m0d3-apply.mjs --preflight
 *   SILVERSEA_DISCOVERY_WRITE_ENABLED=true node scripts/run-silversea-classic-m0d3-apply.mjs \
 *     --apply --confirm=SILVERSEA-CLASSIC-M0D3-ITINERARY-PORTS-BACKFILL
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
const FIXTURE_DIR = path.join(root, "scripts/fixtures/silversea");
const MASTER_FIXTURE_PATH = path.join(root, "scripts/fixtures/silversea/classic-m0c-itinerary-ports-backfill.json");
const M0D3_FIXTURE_PATH = path.join(root, "scripts/fixtures/silversea/classic-m0d3-itinerary-ports-backfill.json");
const M0D2_FIXTURE_PATH = path.join(root, "scripts/fixtures/silversea/classic-m0d2-itinerary-ports-backfill.json");
const M0D1_FIXTURE_PATH = path.join(root, "scripts/fixtures/silversea/classic-m0d1-itinerary-ports-backfill.json");
const EXPECTED_BATCH_SIZE = 199;
const EXPECTED_CLASSIC_EXACT_MATCH = 599;
const EXPECTED_REMAINING_REPAIRS = 0;
const EXPECTED_M0D1_SIZE = 200;
const EXPECTED_M0D2_SIZE = 200;
const NON_MASTER_CLASSIC_OFFICIAL_IDS = Object.freeze(["SN260906007", "SM260907007"]);

const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const { indexExistingSilverseaRecords } = require(path.join(
  root,
  "netlify/functions/lib/silversea-discovery-writes"
));
const {
  isExpeditionOfficialId,
  buildExpectedItineraryPorts,
  portsArrayEqual,
  normalizeStoredPorts,
  snapshotComparableFields,
  compareNonWhitelistSnapshots,
  snapshotProtectionRows,
  verifyProtectionSnapshots
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-itinerary-ports-backfill"));
const { verifyStoredExpeditionRow } = require(path.join(
  root,
  "netlify/functions/lib/silversea-expedition-verification"
));
const {
  M0C_BACKFILL_FIXTURE,
  M0D1_BACKFILL_FIXTURE,
  M0D2_BACKFILL_FIXTURE,
  M0D3_BACKFILL_FIXTURE,
  M0D3_OPERATION,
  M0D3_APPLY_CONFIRMATION_TOKEN,
  UPDATE_WHITELIST,
  isClassicProductionRow,
  isClassicStoredOfficialRow,
  isExpeditionStoredOfficialRow,
  classifySilverseaOfficialInventory,
  validateClassicMasterIdentitiesPresent,
  buildExpectedClassicItineraryPorts,
  validateClassicRepairFixture,
  verifyClassicFrozenBeforeMatch,
  dryRunClassicItineraryPortsBackfill,
  buildM0dRollbackManifest,
  partitionMasterClassicFixture,
  validateClassicPartition,
  hashFixtureContent,
  buildM0d3BatchFixture,
  buildM0d2BatchFixture,
  buildM0d1BatchFixture,
  computeClassicSourceCutoffCounts,
  applyClassicItineraryPortsRepairBatch,
  verifyClassicRepairBatchResults,
  auditClassicItineraryPortsPopulation
} = require(path.join(root, "netlify/functions/lib/silversea-classic-itinerary-ports-backfill"));
const {
  RUN_STATUS,
  buildApplyReportLifecycle,
  updateReportLifecycle,
  ControlledProductionRunStore,
  executeHardenedControlledProductionApply,
  buildAuthoritativeVerificationResult
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

export const M0D3_RUNNER_PATH = "scripts/run-silversea-classic-m0d3-apply.mjs";
export const M0D3_USES_HARDENED_RUNNER = true;

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
  if (args.confirm !== M0D3_APPLY_CONFIRMATION_TOKEN) {
    throw new Error("m0d3_apply_confirmation_required");
  }
  if (String(process.env.SILVERSEA_DISCOVERY_WRITE_ENABLED || "").toLowerCase() !== "true") {
    throw new Error("SILVERSEA_DISCOVERY_WRITE_ENABLED must be true for apply");
  }
}

export function assertPostWriteVerifierImportsResolved(deps = {}) {
  const checks = {
    verifyClassicRepairBatchResults: typeof (deps.verifyClassicRepairBatchResults || verifyClassicRepairBatchResults) === "function",
    verifyClassicFrozenBeforeMatch: typeof (deps.verifyClassicFrozenBeforeMatch || verifyClassicFrozenBeforeMatch) === "function",
    applyClassicItineraryPortsRepairBatch:
      typeof (deps.applyClassicItineraryPortsRepairBatch || applyClassicItineraryPortsRepairBatch) === "function",
    auditClassicItineraryPortsPopulation:
      typeof (deps.auditClassicItineraryPortsPopulation || auditClassicItineraryPortsPopulation) === "function",
    compareNonWhitelistSnapshots: typeof (deps.compareNonWhitelistSnapshots || compareNonWhitelistSnapshots) === "function",
    snapshotComparableFields: typeof (deps.snapshotComparableFields || snapshotComparableFields) === "function",
    verifyStoredExpeditionRow: typeof (deps.verifyStoredExpeditionRow || verifyStoredExpeditionRow) === "function",
    buildExpectedItineraryPorts: typeof (deps.buildExpectedItineraryPorts || buildExpectedItineraryPorts) === "function",
    verifyProtectionSnapshots: typeof (deps.verifyProtectionSnapshots || verifyProtectionSnapshots) === "function",
    buildAuthoritativeVerificationResult:
      typeof (deps.buildAuthoritativeVerificationResult || buildAuthoritativeVerificationResult) === "function",
    executeHardenedControlledProductionApply:
      typeof (deps.executeHardenedControlledProductionApply || executeHardenedControlledProductionApply) === "function"
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  if (failed.length) throw new Error(`unresolved_post_write_verifier_imports:${failed.join(",")}`);
  return { ok: true, checks };
}

async function auditExpeditionMismatches(expeditionRows, sourceById, line, today) {
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
    if (!portsArrayEqual(stored, expected) && expectedOk) mismatches += 1;
  }
  return { ok: mismatches === 0, mismatches, total: expeditionRows.length };
}

function resolveMasterClassicRows(indexed, masterFixture) {
  return masterFixture.rows
    .map((row) => indexed.byOfficialId.get(String(row.official_sailing_id).toUpperCase()))
    .filter(Boolean);
}

function auditNonMasterClassicRows(allRows, masterFixture, sourceById, line) {
  const masterIds = new Set(masterFixture.rows.map((r) => String(r.official_sailing_id).toUpperCase()));
  const nonMaster = allRows.filter(
    (row) => isClassicStoredOfficialRow(row) && !masterIds.has(String(row.official_sailing_id).toUpperCase())
  );
  const audits = [];
  let matchCount = 0;
  for (const prodRow of nonMaster) {
    const source = sourceById.get(String(prodRow.official_sailing_id).toUpperCase()) || null;
    const built = source ? buildExpectedClassicItineraryPorts(source, line) : { ok: false };
    const stored = normalizeStoredPorts(prodRow.itinerary_ports);
    const expected = built.ok ? built.ports : [];
    const equal = built.ok && portsArrayEqual(stored, expected);
    if (equal) matchCount += 1;
    audits.push({
      production_uuid: prodRow.id,
      official_sailing_id: prodRow.official_sailing_id,
      status: prodRow.status,
      departure_date: prodRow.departure_date,
      ship_id: prodRow.ship_id,
      source_available: Boolean(source),
      stored_itinerary_ports: stored,
      expected_itinerary_ports: expected,
      equal
    });
  }
  const expectedIds = new Set(NON_MASTER_CLASSIC_OFFICIAL_IDS.map((id) => id.toUpperCase()));
  const foundIds = new Set(nonMaster.map((row) => String(row.official_sailing_id).toUpperCase()));
  return {
    ok:
      nonMaster.length === NON_MASTER_CLASSIC_OFFICIAL_IDS.length &&
      matchCount === nonMaster.length &&
      [...expectedIds].every((id) => foundIds.has(id)),
    audited: nonMaster.length,
    matches: matchCount,
    rows: audits
  };
}

async function headLineCount(lineId) {
  const { count } = await exactCountSupabase(root, "discovered_cruises", `cruise_line_id=eq.${encodeURIComponent(lineId)}`);
  return count;
}

function ensureFixtureFromPartition(fixturePath, builder) {
  if (!fs.existsSync(fixturePath)) {
    const masterRaw = fs.readFileSync(MASTER_FIXTURE_PATH, "utf8");
    const masterFixture = JSON.parse(masterRaw);
    const partition = partitionMasterClassicFixture(masterFixture);
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    fs.writeFileSync(
      fixturePath,
      `${JSON.stringify(
        builder({
          partition,
          generatedAt: new Date().toISOString(),
          gitSha: git("git rev-parse HEAD"),
          parentFixturePath: M0C_BACKFILL_FIXTURE,
          parentFixtureSha256: hashFixtureContent(masterRaw)
        }),
        null,
        2
      )}\n`
    );
  }
}

export async function runSilverseaClassicM0d3(options = {}) {
  const args = options.args || parseArgs();
  assertApplyAllowed(args);
  const importSmoke = assertPostWriteVerifierImportsResolved();
  const startedAt = new Date().toISOString();
  const today = perthCalendarDate();
  const timings = { started_at: startedAt };

  const masterRaw = fs.readFileSync(MASTER_FIXTURE_PATH, "utf8");
  const masterFixture = JSON.parse(masterRaw);
  const masterValidation = validateClassicRepairFixture(masterFixture);
  if (!masterValidation.ok || masterValidation.row_count !== 599) {
    throw new Error(`master_fixture_invalid:${masterValidation.issues?.join(",")} — STOP WITH ZERO WRITES`);
  }

  const partition = partitionMasterClassicFixture(masterFixture);
  const partitionValidation = validateClassicPartition(partition);
  if (!partition.ok || !partitionValidation.ok) {
    throw new Error(`partition_invalid — STOP WITH ZERO WRITES`);
  }

  if (!fs.existsSync(M0D3_FIXTURE_PATH)) {
    throw new Error("m0d3_frozen_fixture_missing — STOP WITH ZERO WRITES");
  }
  const m0d3Fixture = JSON.parse(fs.readFileSync(M0D3_FIXTURE_PATH, "utf8"));
  const m0d3Validation = validateClassicRepairFixture(m0d3Fixture);
  if (!m0d3Validation.ok || m0d3Validation.row_count !== EXPECTED_BATCH_SIZE) {
    throw new Error(`m0d3_fixture_invalid — STOP WITH ZERO WRITES`);
  }
  const m0d3MasterUuids = new Set(partition.batches.m0d3.rows.map((r) => r.production_uuid));
  const m0d3MasterIds = new Set(partition.batches.m0d3.rows.map((r) => String(r.official_sailing_id).toUpperCase()));
  if (m0d3Fixture.rows.length !== partition.batches.m0d3.count) {
    throw new Error("m0d3_fixture_partition_count_mismatch — STOP WITH ZERO WRITES");
  }
  for (const row of m0d3Fixture.rows) {
    if (!m0d3MasterUuids.has(row.production_uuid)) {
      throw new Error(`m0d3_fixture_not_partition_batch:${row.official_sailing_id} — STOP WITH ZERO WRITES`);
    }
    if (!m0d3MasterIds.has(String(row.official_sailing_id).toUpperCase())) {
      throw new Error(`m0d3_fixture_official_id_not_partition_batch:${row.official_sailing_id} — STOP WITH ZERO WRITES`);
    }
  }

  ensureFixtureFromPartition(M0D1_FIXTURE_PATH, buildM0d1BatchFixture);
  ensureFixtureFromPartition(M0D2_FIXTURE_PATH, buildM0d2BatchFixture);

  const m0d1Fixture = JSON.parse(fs.readFileSync(M0D1_FIXTURE_PATH, "utf8"));
  const m0d1Validation = validateClassicRepairFixture(m0d1Fixture);
  if (!m0d1Validation.ok || m0d1Validation.row_count !== EXPECTED_M0D1_SIZE) {
    throw new Error(`m0d1_fixture_invalid — STOP WITH ZERO WRITES`);
  }

  const m0d2Fixture = JSON.parse(fs.readFileSync(M0D2_FIXTURE_PATH, "utf8"));
  const m0d2Validation = validateClassicRepairFixture(m0d2Fixture);
  if (!m0d2Validation.ok || m0d2Validation.row_count !== EXPECTED_M0D2_SIZE) {
    throw new Error(`m0d2_fixture_invalid — STOP WITH ZERO WRITES`);
  }

  const repairRows = m0d3Fixture.rows;
  const m0d1Uuids = new Set(m0d1Fixture.rows.map((r) => r.production_uuid));
  const m0d2Uuids = new Set(m0d2Fixture.rows.map((r) => r.production_uuid));
  const m0d3Uuids = new Set(repairRows.map((r) => r.production_uuid));
  const dryRun = dryRunClassicItineraryPortsBackfill(m0d3Fixture);

  const sb = createMaintenanceSupabase(root);
  const line = (await sb(`ci_cruise_lines?slug=eq.${adapter.LINE_SLUG}&select=id,name,slug&limit=1`))?.[0];
  if (!line) throw new Error("Silversea line not found");

  const indexed = await indexExistingSilverseaRecords(sb, line.id);
  const allRows = indexed.rows;
  const inventory = classifySilverseaOfficialInventory(allRows);
  const classicRows = allRows.filter(isClassicProductionRow);
  const classicStoredOfficial = allRows.filter(isClassicStoredOfficialRow);
  const expeditionRows = allRows.filter(
    (r) => r.status === "active" && r.official_sailing_id && isExpeditionOfficialId(r.official_sailing_id)
  );
  const expeditionStoredOfficial = allRows.filter(isExpeditionStoredOfficialRow);
  const legacyRows = allRows.filter((r) => !r.official_sailing_id);

  const masterIdentity = validateClassicMasterIdentitiesPresent(allRows, masterFixture.rows);
  if (!masterIdentity.ok || masterIdentity.present !== 599) {
    throw new Error(`classic_master_identities_missing:${masterIdentity.missing?.slice(0, 3).join(",")} — STOP WITH ZERO WRITES`);
  }
  if (!inventory.reconciled) {
    throw new Error("official_vs_active_inventory_unreconciled — STOP WITH ZERO WRITES");
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

  const sourceCutoff = computeClassicSourceCutoffCounts(simulation, today);
  if (!sourceCutoff.reconciles || !sourceCutoff.m0c_classic_cutoff_count_discrepancy_explained) {
    throw new Error("m0c_classic_cutoff_count_discrepancy_not_explained — STOP WITH ZERO WRITES");
  }

  const sourceById = new Map();
  for (const row of simulation.products) {
    if (row.official_sailing_id) {
      sourceById.set(String(row.official_sailing_id).toUpperCase(), row);
    }
  }

  const expeditionBefore = await auditExpeditionMismatches(expeditionStoredOfficial, sourceById, line, today);
  if (!expeditionBefore.ok) {
    throw new Error(`expedition_not_clean:${expeditionBefore.mismatches} — STOP WITH ZERO WRITES`);
  }

  const nonMasterClassicBefore = auditNonMasterClassicRows(allRows, masterFixture, sourceById, line);
  if (!nonMasterClassicBefore.ok || nonMasterClassicBefore.matches !== NON_MASTER_CLASSIC_OFFICIAL_IDS.length) {
    throw new Error(`non_master_classic_not_clean:${nonMasterClassicBefore.matches}/${NON_MASTER_CLASSIC_OFFICIAL_IDS.length} — STOP WITH ZERO WRITES`);
  }

  for (const row of repairRows) {
    const prod = indexed.byOfficialId.get(String(row.official_sailing_id).toUpperCase());
    if (!prod || prod.id !== row.production_uuid) {
      throw new Error(`missing_frozen_row:${row.official_sailing_id} — STOP WITH ZERO WRITES`);
    }
    if (m0d1Uuids.has(row.production_uuid) || m0d2Uuids.has(row.production_uuid)) {
      throw new Error(`m0d3_target_overlaps_prior_batch:${row.production_uuid} — STOP WITH ZERO WRITES`);
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
    const built = buildExpectedClassicItineraryPorts(source, line);
    if (!built.ok) {
      freshMismatches.push({ official_sailing_id: row.official_sailing_id, reason: built.reason });
      continue;
    }
    if (portsArrayEqual(built.ports, row.after_itinerary_ports)) freshMatchCount += 1;
    else {
      freshMismatches.push({
        official_sailing_id: row.official_sailing_id,
        reason: "after_mismatch",
        fresh: built.ports,
        frozen: row.after_itinerary_ports
      });
    }
  }
  if (freshMatchCount !== EXPECTED_BATCH_SIZE || freshMismatches.length > 0) {
    throw new Error(`fresh_reconstruction_mismatch:${freshMismatches.length} — STOP WITH ZERO WRITES`);
  }

  let preliminaryBeforeMatch = 0;
  for (const row of repairRows) {
    const prod = (await sb(`discovered_cruises?id=eq.${encodeURIComponent(row.production_uuid)}&select=*&limit=1`))?.[0];
    if (verifyClassicFrozenBeforeMatch(prod, row).ok) preliminaryBeforeMatch += 1;
  }
  if (preliminaryBeforeMatch !== EXPECTED_BATCH_SIZE) {
    throw new Error(`preliminary_frozen_before_failed — STOP WITH ZERO WRITES`);
  }

  const m0d1BeforeApply = await verifyClassicRepairBatchResults(sb, m0d1Fixture.rows);
  if (!m0d1BeforeApply.ok || m0d1BeforeApply.verified_count !== EXPECTED_M0D1_SIZE) {
    throw new Error(`m0d1_repaired_rows_not_clean:${m0d1BeforeApply.failed_count} — STOP WITH ZERO WRITES`);
  }

  const m0d2BeforeApply = await verifyClassicRepairBatchResults(sb, m0d2Fixture.rows);
  if (!m0d2BeforeApply.ok || m0d2BeforeApply.verified_count !== EXPECTED_M0D2_SIZE) {
    throw new Error(`m0d2_repaired_rows_not_clean:${m0d2BeforeApply.failed_count} — STOP WITH ZERO WRITES`);
  }

  const countsBefore = {
    silversea_total: await headLineCount(line.id),
    inventory,
    classic_active: inventory.classic_active_official,
    classic_stored_official: inventory.classic_stored_official_total,
    expedition_active: inventory.expedition_active_official,
    expedition_stored_official: inventory.expedition_stored_official_total,
    legacy: legacyRows.length,
    master_identities_present: masterIdentity.present
  };

  const m0d1Snapshot = snapshotProtectionRows(classicStoredOfficial.filter((r) => m0d1Uuids.has(r.id)), new Set());
  const m0d2Snapshot = snapshotProtectionRows(classicStoredOfficial.filter((r) => m0d2Uuids.has(r.id)), new Set());
  const nonMasterSnapshot = snapshotProtectionRows(
    classicStoredOfficial.filter((r) =>
      NON_MASTER_CLASSIC_OFFICIAL_IDS.map((id) => id.toUpperCase()).includes(
        String(r.official_sailing_id).toUpperCase()
      )
    ),
    new Set()
  );
  const expeditionSnapshot = snapshotProtectionRows(expeditionStoredOfficial, new Set());
  const legacyBefore = legacyRows.map((r) => ({
    id: r.id,
    status: r.status,
    official_sailing_id: r.official_sailing_id,
    review_reason: r.review_reason
  }));

  if (
    dryRun.proposed_itinerary_ports_updates !== EXPECTED_BATCH_SIZE ||
    dryRun.proposed_inserts !== 0 ||
    dryRun.proposed_deletes !== 0 ||
    dryRun.other_column_updates !== 0
  ) {
    throw new Error("dry_run_counts_invalid — STOP WITH ZERO WRITES");
  }

  const runId = options.runId || `silversea-classic-m0d3-itinerary-ports-${startedAt.replace(/[:.]/g, "-")}`;
  const store = new ControlledProductionRunStore(REPORT_DIR, runId);

  let rollbackManifest = buildM0dRollbackManifest({
    runId,
    fixturePath: M0D3_BACKFILL_FIXTURE,
    lineSlug: adapter.LINE_SLUG,
    cruiseLineId: line.id,
    rows: repairRows,
    expectedUpdates: EXPECTED_BATCH_SIZE,
    productionBefore: countsBefore,
    createdAt: startedAt
  });
  rollbackManifest.operation = M0D3_OPERATION;

  let applyReport = buildApplyReportLifecycle({
    runId,
    createdAt: startedAt,
    fixturePath: M0D3_BACKFILL_FIXTURE,
    operation: M0D3_OPERATION,
    lineSlug: adapter.LINE_SLUG,
    expectedInserts: 0,
    productionBefore: countsBefore
  });
  applyReport.phase = "M0D3";
  applyReport.parent_fixture_path = M0C_BACKFILL_FIXTURE;
  applyReport.expected_updates = EXPECTED_BATCH_SIZE;
  applyReport.update_whitelist = UPDATE_WHITELIST.slice();
  applyReport.hardened_runner = true;
  applyReport.m0d3_runner_path = M0D3_RUNNER_PATH;
  applyReport.source_cutoff = sourceCutoff;
  applyReport.partition = {
    policy: partition.partition_policy,
    m0d1: 200,
    m0d2: 200,
    m0d3: 199,
    coverage: partition.coverage
  };

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
  let classicAudit = null;
  let storedClassicAudit = null;
  let nonMasterClassicAudit = null;
  let protection = null;
  let performance = null;

  if (args.apply) {
    assertSilverseaWritesAllowed(resolveSilverseaDiscoveryMode("production_write"));
    timings.mutation_started_at = new Date().toISOString();

    hardenedResult = await executeHardenedControlledProductionApply(
      sb,
      {
        runId,
        lineSlug: adapter.LINE_SLUG,
        operation: M0D3_OPERATION,
        performWrites: true,
        leaseSeconds: DEFAULT_GLOBAL_LEASE_SECONDS,
        underLockRecheck: async () => {
          let underLockMatch = 0;
          for (const row of repairRows) {
            const prod = (await sb(`discovered_cruises?id=eq.${encodeURIComponent(row.production_uuid)}&select=*&limit=1`))?.[0];
            if (verifyClassicFrozenBeforeMatch(prod, row).ok) underLockMatch += 1;
          }
          if (underLockMatch !== EXPECTED_BATCH_SIZE) {
            return { ok: false, reason: "under_lock_frozen_before_mismatch", matched: underLockMatch };
          }
          return { ok: true, matched: underLockMatch, proposed_updates: EXPECTED_BATCH_SIZE };
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
          timings.mutate_phase_started_at = new Date().toISOString();
          rollbackManifest.status = RUN_STATUS.MUTATING;
          store.updateRollback(rollbackManifest);
          applyReport = updateReportLifecycle(applyReport, { status: RUN_STATUS.MUTATING });
          store.updateReport(applyReport);
          const result = await applyClassicItineraryPortsRepairBatch(sb, repairRows, {
            onUpdateSuccess: async ({ production_uuid }) => {
              if (!rollbackManifest.updated_record_ids.includes(production_uuid)) {
                rollbackManifest.updated_record_ids.push(production_uuid);
                store.updateRollback(rollbackManifest);
              }
            }
          });
          timings.mutate_phase_ended_at = new Date().toISOString();
          return result;
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
          timings.verification_started_at = new Date().toISOString();
          rollbackManifest.status = RUN_STATUS.VERIFYING;
          store.updateRollback(rollbackManifest);
          applyReport = updateReportLifecycle(applyReport, { status: RUN_STATUS.VERIFYING });
          store.updateReport(applyReport);
        },
        verifyUnderLock: async ({ writeResult: wr, lockMeta }) => {
          if (wr.stats.updated !== EXPECTED_BATCH_SIZE || wr.stats.failed !== 0) {
            return {
              ok: false,
              reason: `write_count_mismatch:updated=${wr.stats.updated},failed=${wr.stats.failed}`,
              lock_held: true
            };
          }

          verification = await verifyClassicRepairBatchResults(sb, repairRows);
          verification.lock_held_through_verification = true;

          const indexedAfter = await indexExistingSilverseaRecords(sb, line.id);
          const classicStoredOfficialAfter = indexedAfter.rows.filter(isClassicStoredOfficialRow);
          const expeditionStoredOfficialAfter = indexedAfter.rows.filter(isExpeditionStoredOfficialRow);
          const masterClassicRowsAfter = resolveMasterClassicRows(indexedAfter, masterFixture);

          classicAudit = auditClassicItineraryPortsPopulation(masterClassicRowsAfter, sourceById, line);
          storedClassicAudit = auditClassicItineraryPortsPopulation(classicStoredOfficialAfter, sourceById, line);
          nonMasterClassicAudit = auditNonMasterClassicRows(indexedAfter.rows, masterFixture, sourceById, line);
          const expeditionAudit = await auditExpeditionMismatches(expeditionStoredOfficialAfter, sourceById, line, today);

          const m0d1Check = verifyProtectionSnapshots(
            m0d1Snapshot,
            classicStoredOfficialAfter.filter((r) => m0d1Uuids.has(r.id)),
            new Set(),
            { perthToday: today }
          );
          const m0d1AfterVerify = await verifyClassicRepairBatchResults(sb, m0d1Fixture.rows);
          const m0d2Check = verifyProtectionSnapshots(
            m0d2Snapshot,
            classicStoredOfficialAfter.filter((r) => m0d2Uuids.has(r.id)),
            new Set(),
            { perthToday: today }
          );
          const m0d2AfterVerify = await verifyClassicRepairBatchResults(sb, m0d2Fixture.rows);
          const nonMasterCheck = verifyProtectionSnapshots(
            nonMasterSnapshot,
            classicStoredOfficialAfter.filter((r) =>
              NON_MASTER_CLASSIC_OFFICIAL_IDS.map((id) => id.toUpperCase()).includes(
                String(r.official_sailing_id).toUpperCase()
              )
            ),
            new Set(),
            { perthToday: today }
          );
          const expeditionCheck = verifyProtectionSnapshots(expeditionSnapshot, expeditionStoredOfficialAfter, new Set(), {
            perthToday: today
          });
          const legacyAfter = indexedAfter.rows
            .filter((r) => !r.official_sailing_id)
            .map((r) => ({
              id: r.id,
              status: r.status,
              official_sailing_id: r.official_sailing_id,
              review_reason: r.review_reason
            }));

          protection = {
            m0d1_unchanged: m0d1Check.ok && m0d1AfterVerify.ok,
            m0d1_issues: [...m0d1Check.issues, ...(m0d1AfterVerify.failed_count ? [{ reason: "after_verify_failed" }] : [])].slice(0, 5),
            m0d1_after_verify: m0d1AfterVerify,
            m0d2_unchanged: m0d2Check.ok && m0d2AfterVerify.ok,
            m0d2_issues: [...m0d2Check.issues, ...(m0d2AfterVerify.failed_count ? [{ reason: "after_verify_failed" }] : [])].slice(0, 5),
            m0d2_after_verify: m0d2AfterVerify,
            non_master_classic_unchanged: nonMasterCheck.ok && nonMasterClassicAudit.ok,
            non_master_classic_audit: nonMasterClassicAudit,
            non_master_classic_issues: nonMasterCheck.issues.slice(0, 5),
            expedition_unchanged: expeditionCheck.ok,
            expedition_issues: expeditionCheck.issues.slice(0, 5),
            expedition_audit: expeditionAudit,
            legacy_8_unchanged: JSON.stringify(legacyBefore) === JSON.stringify(legacyAfter),
            master_classic_audit: classicAudit,
            stored_classic_audit: storedClassicAudit,
            whole_stored_official_rows_audited:
              classicStoredOfficialAfter.length + expeditionStoredOfficialAfter.length,
            whole_stored_official_itinerary_ports_mismatches:
              storedClassicAudit.total -
              storedClassicAudit.exact_match +
              expeditionAudit.mismatches
          };

          const lockExpires = lockMeta?.observability?.global_lock_expires_at || lockMeta?.expires_at;
          const leaseRemainingSec = lockExpires
            ? Math.max(0, Math.floor((new Date(lockExpires).getTime() - Date.now()) / 1000))
            : null;

          performance = {
            mutation_ms: timings.mutate_phase_ended_at
              ? new Date(timings.mutate_phase_ended_at) - new Date(timings.mutate_phase_started_at)
              : null,
            verification_started_at: timings.verification_started_at,
            lease_remaining_seconds_at_verification: leaseRemainingSec,
            global_lease_sufficient: leaseRemainingSec == null || leaseRemainingSec > 60
          };

          const allOk =
            verification.ok &&
            classicAudit.exact_match === EXPECTED_CLASSIC_EXACT_MATCH &&
            classicAudit.remaining_repair_candidates === EXPECTED_REMAINING_REPAIRS &&
            classicAudit.deferred_unsafe === 0 &&
            storedClassicAudit.exact_match === storedClassicAudit.total &&
            nonMasterClassicAudit.ok &&
            nonMasterCheck.ok &&
            m0d1Check.ok &&
            m0d1AfterVerify.ok &&
            m0d2Check.ok &&
            m0d2AfterVerify.ok &&
            expeditionCheck.ok &&
            expeditionAudit.ok &&
            protection.legacy_8_unchanged;

          timings.verification_ended_at = new Date().toISOString();

          return buildAuthoritativeVerificationResult({
            aggregateOk: allOk,
            verification,
            protection,
            classic_audit: classicAudit,
            performance,
            lock_held_through_verification: true
          });
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
            global_lock_held_through_verification: true,
            performance
          });
          store.updateReport(applyReport);

          if (wr.stats.updated !== EXPECTED_BATCH_SIZE) {
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
    timings.ended_at = new Date().toISOString();

    if (hardenedResult.blocked) {
      return { blocked: true, reason: hardenedResult.reason, run_id: runId };
    }
    if (hardenedResult.writeError) throw hardenedResult.writeError;
    if (hardenedResult.run_status === RUN_STATUS.WRITE_SUCCEEDED_VERIFICATION_FAILED) {
      throw new Error("write_succeeded_verification_failed");
    }
  }

  const indexedFinal = args.apply ? await indexExistingSilverseaRecords(sb, line.id) : indexed;
  const classicFinal = indexedFinal.rows.filter(isClassicProductionRow);
  const expeditionFinal = indexedFinal.rows.filter(
    (r) => r.status === "active" && r.official_sailing_id && isExpeditionOfficialId(r.official_sailing_id)
  );
  const legacyFinal = indexedFinal.rows.filter((r) => !r.official_sailing_id);

  const countsAfter = args.apply
    ? {
        silversea_total: await headLineCount(line.id),
        inventory: classifySilverseaOfficialInventory(indexedFinal.rows),
        master_identities_present: validateClassicMasterIdentitiesPresent(indexedFinal.rows, masterFixture.rows).present
      }
    : countsBefore;

  const storedClassicComplete =
    args.apply &&
    storedClassicAudit?.exact_match === storedClassicAudit?.total &&
    nonMasterClassicAudit?.ok;

  const classicComplete =
    args.apply &&
    classicAudit?.exact_match === EXPECTED_CLASSIC_EXACT_MATCH &&
    classicAudit?.remaining_repair_candidates === EXPECTED_REMAINING_REPAIRS &&
    storedClassicComplete;

  const report = {
    phase: args.apply ? "m0d3_apply" : "m0d3_preflight",
    run_id: runId,
    m0d3_runner_path: M0D3_RUNNER_PATH,
    m0d3_uses_hardened_runner: true,
    master_fixture_path: M0C_BACKFILL_FIXTURE,
    m0d3_fixture_path: M0D3_BACKFILL_FIXTURE,
    m0d1_fixture_path: M0D1_BACKFILL_FIXTURE,
    m0d2_fixture_path: M0D2_BACKFILL_FIXTURE,
    m0d1_preflight_verification: m0d1BeforeApply,
    m0d2_preflight_verification: m0d2BeforeApply,
    non_master_classic_preflight: nonMasterClassicBefore,
    expedition_preflight: expeditionBefore,
    source_cutoff: sourceCutoff,
    m0c_classic_cutoff_count_discrepancy_explained: sourceCutoff.m0c_classic_cutoff_count_discrepancy_explained,
    partition: partition.coverage,
    partition_validation: partitionValidation,
    master_validation: masterValidation,
    m0d3_validation: m0d3Validation,
    m0d1_validation: m0d1Validation,
    m0d2_validation: m0d2Validation,
    import_smoke: importSmoke,
    fresh_reconstruction: { matched: freshMatchCount, total: EXPECTED_BATCH_SIZE },
    preliminary_frozen_before_match: preliminaryBeforeMatch,
    expedition_before: expeditionBefore,
    dry_run: dryRun,
    pre_write_table: repairRows,
    production_before: countsBefore,
    production_after: countsAfter,
    row_delta: args.apply ? countsAfter.silversea_total - countsBefore.silversea_total : 0,
    prepared_state: { rollback_path: rollbackPath, apply_report_path: applyReportPath },
    write_result: writeResult?.stats || null,
    verification,
    classic_audit: classicAudit,
    stored_classic_audit: storedClassicAudit,
    non_master_classic_audit: nonMasterClassicAudit,
    protection,
    performance,
    hardened_apply: hardenedResult,
    classic_master_data_shape_remediation_complete: classicComplete,
    current_stored_classic_official_data_shape_clean: storedClassicComplete,
    expedition_data_shape_complete: protection?.expedition_audit?.ok ?? expeditionBefore.ok,
    current_stored_expedition_official_data_shape_clean: protection?.expedition_audit?.ok ?? expeditionBefore.ok,
    silversea_stored_official_inventory_data_shape_clean:
      storedClassicComplete && (protection?.expedition_audit?.ok ?? expeditionBefore.ok),
    weekly_maintenance: "NOT ENABLED",
    m1_authorised: false,
    next_phase: classicComplete
      ? "A. SILVERSEA M0E — FINAL READ-ONLY WHOLE-LINE INTEGRITY / MAINTENANCE-READINESS AUDIT"
      : null,
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
  const reportPath = path.join(REPORT_DIR, `silversea-classic-m0d3-${runId}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  report.report_path = reportPath;

  return report;
}

async function main() {
  try {
    const report = await runSilverseaClassicM0d3();
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
    if (report.phase === "m0d3_apply" && report.production_writes.itinerary_ports_updates !== EXPECTED_BATCH_SIZE) {
      process.exit(1);
    }
  } catch (err) {
    console.error(JSON.stringify({ status: "failed", error: err.message }, null, 2));
    process.exit(1);
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();
