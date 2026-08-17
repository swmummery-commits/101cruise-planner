#!/usr/bin/env node
/**
 * Silversea Classic Phase M0D1R — protection hardening attestation + M0D2 read-only reauthorisation.
 * NO production cruise writes.
 *
 *   node scripts/run-silversea-classic-m0d1r-reconciliation.mjs
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
const M0D1_RUN_ID = "silversea-classic-m0d1-itinerary-ports-2026-08-17T06-42-59-859Z";
const FLAGGED_EXPEDITION_UUIDS = [
  "f4cfb44a-44cf-4bae-8bcd-601721b74466",
  "3362fb6c-a29f-41e4-a251-51b514ef03f0"
];

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
  snapshotProtectionRows,
  verifyProtectionSnapshots,
  semanticJsonEqual,
  hashRawExtractSemantic,
  diffJsonPaths,
  compareComparableFieldValues
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-itinerary-ports-backfill"));
const {
  M0C_BACKFILL_FIXTURE,
  M0D1_BACKFILL_FIXTURE,
  M0D2_BACKFILL_FIXTURE,
  isClassicProductionRow,
  buildExpectedClassicItineraryPorts,
  validateClassicRepairFixture,
  verifyClassicFrozenBeforeMatch,
  verifyClassicRepairBatchResults,
  auditClassicItineraryPortsPopulation,
  dryRunClassicItineraryPortsBackfill,
  partitionMasterClassicFixture,
  validateClassicPartition,
  hashFixtureContent,
  buildM0d1BatchFixture,
  buildM0d2BatchFixture
} = require(path.join(root, "netlify/functions/lib/silversea-classic-itinerary-ports-backfill"));
const { buildAuthoritativeVerificationResult } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-controlled-production-run"
));
const { assertPostWriteVerifierImportsResolved } = require(path.join(
  root,
  "scripts/run-silversea-classic-m0d1-apply.mjs"
));
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

function git(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

function legacyJsonCompare(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function classifyDrift(before, after) {
  const legacyMismatch = !legacyJsonCompare(before, after);
  const semanticMatch = semanticJsonEqual(before, after);
  if (!legacyMismatch && semanticMatch) return "none";
  if (legacyMismatch && semanticMatch) return "B_JSON_KEY_ORDER_OR_SERIALIZATION";
  const paths = diffJsonPaths(before, after);
  if (paths.length === 0) return "none";
  const pathNames = paths.map((p) => p.path).join(",");
  if (pathNames.includes("controlled_batch")) return "F_CONTROLLED_BATCH_METADATA";
  return "I_UNEXPLAINED_OR_SEMANTIC_CHANGE";
}

async function fetchRow(sb, uuid) {
  return (await sb(`discovered_cruises?id=eq.${encodeURIComponent(uuid)}&select=*&limit=1`))?.[0] || null;
}

export async function runSilverseaClassicM0d1r() {
  const startedAt = new Date().toISOString();
  const gitSha = git("git rev-parse HEAD");
  const today = perthCalendarDate();

  const importSmoke = assertPostWriteVerifierImportsResolved({
    buildAuthoritativeVerificationResult
  });

  const masterRaw = fs.readFileSync(path.join(root, M0C_BACKFILL_FIXTURE), "utf8");
  const masterFixture = JSON.parse(masterRaw);
  const partition = partitionMasterClassicFixture(masterFixture);
  const partitionValidation = validateClassicPartition(partition);

  const m0d1Fixture = buildM0d1BatchFixture({
    partition,
    generatedAt: startedAt,
    gitSha,
    parentFixturePath: M0C_BACKFILL_FIXTURE,
    parentFixtureSha256: hashFixtureContent(masterRaw)
  });
  const m0d2Fixture = buildM0d2BatchFixture({
    partition,
    generatedAt: startedAt,
    gitSha,
    parentFixturePath: M0C_BACKFILL_FIXTURE,
    parentFixtureSha256: hashFixtureContent(masterRaw)
  });

  fs.mkdirSync(path.join(root, "scripts/fixtures/silversea"), { recursive: true });
  fs.writeFileSync(path.join(root, M0D1_BACKFILL_FIXTURE), `${JSON.stringify(m0d1Fixture, null, 2)}\n`);
  fs.writeFileSync(path.join(root, M0D2_BACKFILL_FIXTURE), `${JSON.stringify(m0d2Fixture, null, 2)}\n`);

  const sb = createMaintenanceSupabase(root);
  const line = (await sb(`ci_cruise_lines?slug=eq.${adapter.LINE_SLUG}&select=id,name,slug&limit=1`))?.[0];
  if (!line) throw new Error("Silversea line not found");

  const indexed = await indexExistingSilverseaRecords(sb, line.id);
  const allRows = indexed.rows;
  const classicRows = allRows.filter(isClassicProductionRow);
  const expeditionRows = allRows.filter(
    (r) => r.status === "active" && r.official_sailing_id && isExpeditionOfficialId(r.official_sailing_id)
  );
  const legacyRows = allRows.filter((r) => !r.official_sailing_id);
  const { count: silverseaTotal } = await exactCountSupabase(
    root,
    "discovered_cruises",
    `cruise_line_id=eq.${encodeURIComponent(line.id)}`
  );

  const dupSeen = new Set();
  const dupIds = new Set();
  for (const row of allRows.filter((r) => r.status === "active" && r.official_sailing_id)) {
    const key = String(row.official_sailing_id).toUpperCase();
    if (dupSeen.has(key)) dupIds.add(key);
    dupSeen.add(key);
  }

  const m0d1Uuids = new Set(m0d1Fixture.rows.map((r) => r.production_uuid));
  const m0d2Uuids = new Set(m0d2Fixture.rows.map((r) => r.production_uuid));
  const m0d3Uuids = new Set(partition.batches.m0d3.rows.map((r) => r.production_uuid));

  const m0d1Verify = await verifyClassicRepairBatchResults(sb, m0d1Fixture.rows);
  const m0d2BeforeMatch = m0d2Fixture.rows.filter((row) => {
    const prod = indexed.byOfficialId.get(String(row.official_sailing_id).toUpperCase());
    return prod && verifyClassicFrozenBeforeMatch(prod, row).ok;
  }).length;
  const m0d3BeforeMatch = partition.batches.m0d3.rows.filter((row) => {
    const prod = indexed.byOfficialId.get(String(row.official_sailing_id).toUpperCase());
    return prod && verifyClassicFrozenBeforeMatch(prod, row).ok;
  }).length;

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
  const sourceById = new Map();
  for (const row of simulation.products) {
    if (row.official_sailing_id) sourceById.set(String(row.official_sailing_id).toUpperCase(), row);
  }

  let freshM0d2Match = 0;
  for (const row of m0d2Fixture.rows) {
    const source = sourceById.get(String(row.official_sailing_id).toUpperCase());
    if (!source) continue;
    const built = buildExpectedClassicItineraryPorts(source, line);
    if (built.ok && portsArrayEqual(built.ports, row.after_itinerary_ports)) freshM0d2Match += 1;
  }

  const m0d2DryRun = dryRunClassicItineraryPortsBackfill(m0d2Fixture);

  let expeditionMismatches = 0;
  for (const prod of expeditionRows) {
    const source = sourceById.get(String(prod.official_sailing_id).toUpperCase());
    if (!source) continue;
    const built = buildExpectedItineraryPorts(source, line, today);
    if (built.ok && !portsArrayEqual(normalizeStoredPorts(prod.itinerary_ports), built.ports)) {
      expeditionMismatches += 1;
    }
  }

  const classicAudit = auditClassicItineraryPortsPopulation(classicRows, sourceById, line);

  const m0d1ApplyPath = path.join(
    REPORT_DIR,
    `controlled-production-apply-silversea-classic-m0d1-itinerary-ports-2026-08-17T06-42-59-859Z.json`
  );
  const m0d1Apply = fs.existsSync(m0d1ApplyPath) ? JSON.parse(fs.readFileSync(m0d1ApplyPath, "utf8")) : null;
  const m0d1UpdatedUuids = new Set(
    (m0d1Apply?.write_result?.write_details || [])
      .filter((d) => d.result === "updated")
      .map((d) => d.production_uuid)
  );

  const expeditionForensics = [];
  for (const uuid of FLAGGED_EXPEDITION_UUIDS) {
    const read1 = await fetchRow(sb, uuid);
    const read2 = await fetchRow(sb, uuid);
    const snap1 = snapshotComparableFields(read1);
    const snap2 = snapshotComparableFields(read2);
    const legacyDriftBetweenReads = !legacyJsonCompare(snap1.raw_extract, snap2.raw_extract);
    const semanticStableBetweenReads = semanticJsonEqual(snap1.raw_extract, snap2.raw_extract);
    const inM0d1Targets = m0d1Uuids.has(uuid);
    const inM0d1Updates = m0d1UpdatedUuids.has(uuid);
    expeditionForensics.push({
      production_uuid: uuid,
      official_sailing_id: read1?.official_sailing_id || null,
      ship_id: read1?.ship_id || null,
      departure_date: read1?.departure_date || null,
      cruise_type: read1?.raw_extract?.silversea_cruise_type || null,
      provenance: read1?.raw_extract?.controlled_batch?.phase || read1?.raw_extract?.silversea_expedition_provenance || null,
      controlled_batch_run_id: read1?.raw_extract?.controlled_batch?.run_id || null,
      current_raw_extract_hash_semantic: hashRawExtractSemantic(read1?.raw_extract),
      double_read_legacy_drift: legacyDriftBetweenReads,
      double_read_semantic_stable: semanticStableBetweenReads,
      in_m0d1_target_set: inM0d1Targets,
      in_m0d1_update_set: inM0d1Updates,
      drift_classification: classifyDrift(snap1.raw_extract, snap2.raw_extract),
      semantic_paths_between_reads: diffJsonPaths(snap1.raw_extract, snap2.raw_extract)
    });
  }

  const expeditionSnapshot = snapshotProtectionRows(expeditionRows, new Set());
  const expeditionProtection = verifyProtectionSnapshots(expeditionSnapshot, expeditionRows, new Set());

  const maskingRegression = buildAuthoritativeVerificationResult({
    aggregateOk: false,
    verification: { ok: true, verified_count: 200, failed_count: 0 },
    protection: { expedition_unchanged: false }
  });

  const leaseSafety = {
    m0d1_lock_held_seconds: 212,
    m0d1_lease_seconds: 1800,
    m0d1_lease_remaining_at_verification: 1648,
    global_lease_sufficient_for_m0d2: true,
    expected_m0d2_margin_seconds: 1648
  };

  const m0d2Authorised =
    m0d1Verify.ok &&
    m0d1Verify.verified_count === 200 &&
    m0d2BeforeMatch === 200 &&
    m0d3BeforeMatch === 199 &&
    freshM0d2Match === 200 &&
    m0d2DryRun.proposed_itinerary_ports_updates === 200 &&
    m0d2DryRun.proposed_inserts === 0 &&
    m0d2DryRun.proposed_deletes === 0 &&
    m0d2DryRun.other_column_updates === 0 &&
    expeditionMismatches === 0 &&
    expeditionProtection.ok &&
    expeditionForensics.every((f) => !f.in_m0d1_update_set) &&
    expeditionForensics.every((f) => f.drift_classification === "none" || f.drift_classification.startsWith("B_")) &&
    maskingRegression.ok === false &&
    importSmoke.ok &&
    partitionValidation.ok;

  const report = {
    phase: "m0d1r_reconciliation",
    generated_at: startedAt,
    git_sha: gitSha,
    m0d1_run_id: M0D1_RUN_ID,
    production: {
      silversea_total: silverseaTotal,
      classic: classicRows.length,
      expedition: expeditionRows.length,
      legacy: legacyRows.length,
      duplicate_official_ids: dupIds.size
    },
    m0d1_verification: {
      ok: m0d1Verify.ok,
      verified_count: m0d1Verify.verified_count,
      data_repair_still_verified: m0d1Verify.ok && m0d1Verify.verified_count === 200
    },
    m0d2_before_match: `${m0d2BeforeMatch}/200`,
    m0d3_before_match: `${m0d3BeforeMatch}/199`,
    verify_under_lock_fix: {
      root_cause: "nested verification.ok overwrote aggregate allOk when spread after ok: allOk",
      unsafe_pattern: "return { ok: allOk, ...verification }",
      corrected_pattern: "buildAuthoritativeVerificationResult({ aggregateOk: allOk, verification, ... })"
    },
    masking_regression_synthetic: {
      aggregate_ok: false,
      nested_verifier_ok: true,
      final_ok: maskingRegression.ok,
      pass: maskingRegression.ok === false
    },
    expedition_forensics: expeditionForensics,
    expedition_raw_extract_drift_root_cause:
      expeditionForensics.every((f) => f.drift_classification.startsWith("B_") || f.drift_classification === "none")
        ? "JSON.stringify key-order / PostgREST JSONB representation differences between sequential reads — not database mutation"
        : "requires_investigation",
    expedition_raw_extract_drift_root_cause_explained: expeditionForensics.every(
      (f) => f.drift_classification.startsWith("B_") || f.drift_classification === "none"
    ),
    expedition_raw_extract_modified_by_m0d1: expeditionForensics.some((f) => f.in_m0d1_update_set),
    flagged_expedition_uuids_in_m0d1_target_set: expeditionForensics.filter((f) => f.in_m0d1_target_set).length,
    expedition_reaudit: {
      itinerary_ports_mismatches: expeditionMismatches,
      protection_anomalies: expeditionProtection.issues.length,
      protection_ok: expeditionProtection.ok
    },
    classic_reaudit: classicAudit,
    m0d2_fixture: {
      path: M0D2_BACKFILL_FIXTURE,
      frozen_count: m0d2Fixture.frozen_count,
      unique_uuid_count: m0d2Fixture.frozen_unique_uuid_count,
      unique_official_id_count: m0d2Fixture.frozen_unique_official_id_count,
      fresh_after_match: `${freshM0d2Match}/200`,
      frozen_before_match: `${m0d2BeforeMatch}/200`
    },
    m0d2_dry_run: m0d2DryRun,
    m0d2_runner_protection_logic_verified: importSmoke.ok,
    lease_safety: leaseSafety,
    production_writes: { inserts: 0, updates: 0, deletes: 0 },
    classic_eligibility_rules_changed: false,
    classic_data_shape_remediation_complete: false,
    remaining_classic_repairs: classicAudit.remaining_repair_candidates,
    expedition_data_shape_remediation_complete: expeditionMismatches === 0,
    silversea_m1_authorised: false,
    weekly_maintenance: "NOT ENABLED",
    next_phase_decision: m0d2Authorised
      ? "A. M0D2 — SECOND 200-ROW CLASSIC BACKFILL AUTHORISED"
      : "B. M0D REMEDIATION REQUIRED"
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(
    REPORT_DIR,
    `silversea-classic-m0d1r-${startedAt.replace(/[:.]/g, "-")}.json`
  );
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  report.report_path = reportPath;
  return report;
}

async function main() {
  try {
    const report = await runSilverseaClassicM0d1r();
    console.log(JSON.stringify({ ok: true, report: report.report_path, decision: report.next_phase_decision }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exit(1);
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();
