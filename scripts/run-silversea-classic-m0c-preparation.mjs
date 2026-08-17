#!/usr/bin/env node
/**
 * Silversea Classic Phase M0C — full itinerary_ports impact audit + backfill preparation.
 * READ ONLY — no production writes.
 *
 *   node scripts/run-silversea-classic-m0c-preparation.mjs
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
} catch {}

const REPORT_DIR = path.join(root, "reports");
const FIXTURE_DIR = path.join(root, "scripts/fixtures/silversea");

const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const { isClassic } = require(path.join(root, "netlify/functions/lib/silversea-controlled-batch"));
const { indexExistingSilverseaRecords } = require(path.join(
  root,
  "netlify/functions/lib/silversea-discovery-writes"
));
const {
  isExpeditionOfficialId,
  buildExpectedItineraryPorts,
  classifyItineraryPortsRepair,
  portsArrayEqual,
  normalizeStoredPorts,
  REPAIR_CATEGORY
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-itinerary-ports-backfill"));
const {
  M0C_BACKFILL_FIXTURE,
  CLASSIC_AUDIT_CATEGORY,
  SOURCE_RECONCILE_STATUS,
  CLASSIC_ITINERARY_PORTS_CONTRACT,
  isClassicProductionRow,
  buildExpectedClassicItineraryPorts,
  buildExpectedPortsFromRawExtract,
  reconcileClassicSourceStatus,
  classifyClassicItineraryPortsAudit,
  isClassicDeterministicRepairCategory,
  isClassicDeferredCategory,
  resolveClassicProvenance,
  loadClassicProvenanceSets,
  buildClassicBackfillFixtureRow,
  validateClassicRepairFixture,
  dryRunClassicItineraryPortsBackfill,
  assertClassicInsertPayloadIncludesItineraryPorts,
  countByKey
} = require(path.join(root, "netlify/functions/lib/silversea-classic-itinerary-ports-backfill"));
const { buildDiscoveredCruiseUpsertPayload } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-ops"
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
const { runM0bRecoveryAttestation } = await import(
  path.join(root, "scripts/run-silversea-expedition-m0b-recovery-attestation.mjs")
);

function gitSha() {
  return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
}

function auditClassicInsertProjection() {
  const merged = { departure_port: "Barcelona", departure_port_meta: null, blocked: false, reason: "new" };
  const now = new Date().toISOString();
  const nonempty = assertClassicInsertPayloadIncludesItineraryPorts(
    {
      cruise_line_id: "l1",
      ship_id: "s1",
      destination_id: "d1",
      departure_date: "2028-06-01",
      return_date: "2028-06-08",
      nights: 7,
      departure_port: "Barcelona",
      itinerary: "Barcelona, Marseille",
      itinerary_ports: ["Barcelona", "Marseille"],
      official_url: "https://x",
      external_key: "e1",
      official_sailing_id: "SL123",
      raw_extract: {}
    },
    merged,
    "k1",
    "active",
    [],
    now
  );
  const empty = assertClassicInsertPayloadIncludesItineraryPorts(
    {
      cruise_line_id: "l1",
      ship_id: "s1",
      destination_id: "d1",
      departure_date: "2028-06-01",
      return_date: "2028-06-08",
      nights: 7,
      departure_port: "At Sea",
      itinerary: "At Sea",
      itinerary_ports: [],
      official_url: "https://x",
      external_key: "e2",
      official_sailing_id: "SL124",
      raw_extract: {}
    },
    merged,
    "k2",
    "active",
    [],
    now
  );
  const update = buildDiscoveredCruiseUpsertPayload(
    { ...nonempty, itinerary_ports: ["Barcelona"] },
    merged,
    { identity_key: "k1", status: "active", reasons: [], now, includeItineraryPorts: false }
  );
  return {
    nonempty_persisted: Array.isArray(nonempty.itinerary_ports) && nonempty.itinerary_ports.length === 2,
    empty_persisted: Array.isArray(empty.itinerary_ports) && empty.itinerary_ports.length === 0,
    update_omits_itinerary_ports: !Object.prototype.hasOwnProperty.call(update, "itinerary_ports")
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  const today = perthCalendarDate();
  const sb = createMaintenanceSupabase(root);

  const m0bAttestation = await runM0bRecoveryAttestation();

  const line = (await sb(`ci_cruise_lines?slug=eq.${adapter.LINE_SLUG}&select=id,name,slug&limit=1`))[0];
  if (!line) throw new Error("Silversea line not found");

  const indexed = await indexExistingSilverseaRecords(sb, line.id);
  const allRows = indexed.rows;
  const expeditionRows = allRows.filter(
    (r) => r.status === "active" && r.official_sailing_id && isExpeditionOfficialId(r.official_sailing_id)
  );
  const classicRows = allRows.filter(isClassicProductionRow);
  const legacyRows = allRows.filter((r) => !r.official_sailing_id);
  const officialIds = allRows.map((r) => r.official_sailing_id).filter(Boolean);
  const duplicateOfficialIds = officialIds.length - new Set(officialIds).size;

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
    if (row.official_sailing_id) {
      sourceById.set(String(row.official_sailing_id).toUpperCase(), row);
    }
  }

  const classicSourceRows = simulation.products.filter((p) => isClassic(p.raw || {}));
  const expAuditRows = [];
  let expeditionMismatches = 0;
  for (const prodRow of expeditionRows.sort((a, b) =>
    String(a.official_sailing_id).localeCompare(String(b.official_sailing_id))
  )) {
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
    if (!portsArrayEqual(stored, expected) && expectedOk) expeditionMismatches += 1;
    expAuditRows.push({ official_sailing_id: prodRow.official_sailing_id, category });
  }

  const provenanceSets = loadClassicProvenanceSets(root, fs);
  const categoryCounts = Object.fromEntries(Object.values(CLASSIC_AUDIT_CATEGORY).map((c) => [c, 0]));
  const sourceReconcileCounts = Object.fromEntries(
    Object.values(SOURCE_RECONCILE_STATUS).map((s) => [s, 0])
  );
  const auditRows = [];
  const nonCurrentSourceRows = [];

  for (const prodRow of classicRows.sort((a, b) =>
    String(a.official_sailing_id).localeCompare(String(b.official_sailing_id))
  )) {
    const officialId = prodRow.official_sailing_id;
    const source = sourceById.get(String(officialId).toUpperCase()) || null;
    const storedPorts = normalizeStoredPorts(prodRow.itinerary_ports);
    const sourceReconcileStatus = reconcileClassicSourceStatus(prodRow, source);
    sourceReconcileCounts[sourceReconcileStatus] = (sourceReconcileCounts[sourceReconcileStatus] || 0) + 1;

    let expectedPorts = [];
    let expectedOk = false;
    let expectedReason = null;
    let reconstructionMethod = null;
    let sourceEvidenceType = null;
    let rawExtractReconstructable = null;

    if (sourceReconcileStatus === SOURCE_RECONCILE_STATUS.CURRENT_SOURCE_MATCH) {
      const built = buildExpectedClassicItineraryPorts(source, line);
      expectedOk = built.ok;
      expectedReason = built.reason || null;
      expectedPorts = built.ok ? built.ports : [];
      reconstructionMethod = built.reconstruction_method || null;
      sourceEvidenceType = "current_source";
    } else if (sourceReconcileStatus === SOURCE_RECONCILE_STATUS.SOURCE_ABSENT) {
      rawExtractReconstructable = buildExpectedPortsFromRawExtract(prodRow.raw_extract);
      if (rawExtractReconstructable.ok) {
        expectedOk = true;
        expectedPorts = rawExtractReconstructable.ports;
        reconstructionMethod = rawExtractReconstructable.reconstruction_method;
        sourceEvidenceType = "raw_extract";
      } else {
        expectedOk = false;
        expectedReason = rawExtractReconstructable.reason;
        sourceEvidenceType = "raw_extract_insufficient";
      }
    } else {
      expectedOk = false;
      expectedReason = sourceReconcileStatus.toLowerCase();
      sourceEvidenceType = "none";
    }

    const category = classifyClassicItineraryPortsAudit({
      storedPorts,
      expectedPorts,
      expectedOk,
      sourceReconcileStatus,
      rawExtractReconstructable
    });
    categoryCounts[category] = (categoryCounts[category] || 0) + 1;

    const mismatchReason =
      category === CLASSIC_AUDIT_CATEGORY.STORED_EMPTY_EXPECTED_NONEMPTY ||
      category === CLASSIC_AUDIT_CATEGORY.SOURCE_ABSENT_RECONSTRUCTABLE
        ? "insert_path_omitted_itinerary_ports"
        : null;

    if (sourceReconcileStatus !== SOURCE_RECONCILE_STATUS.CURRENT_SOURCE_MATCH) {
      nonCurrentSourceRows.push({
        official_sailing_id: officialId,
        production_uuid: prodRow.id,
        ship: prodRow.ship_id,
        departure: prodRow.departure_date,
        production_destination: prodRow.destination_id,
        source_status: sourceReconcileStatus,
        likely_reason: expectedReason || sourceReconcileStatus
      });
    }

    auditRows.push({
      production_uuid: prodRow.id,
      official_sailing_id: officialId,
      ship: prodRow.ship_id,
      departure: prodRow.departure_date,
      destination: prodRow.destination_id,
      stored_itinerary_ports: storedPorts,
      expected_itinerary_ports: expectedPorts,
      ports_equal: portsArrayEqual(storedPorts, expectedPorts),
      repair_category: category,
      mismatch_reason: mismatchReason,
      source_reconcile_status: sourceReconcileStatus,
      source_evidence_type: sourceEvidenceType,
      reconstruction_method: reconstructionMethod,
      expected_ok: expectedOk,
      expected_reason: expectedReason,
      provenance: resolveClassicProvenance(officialId, provenanceSets),
      row_fingerprint: {
        id: prodRow.id,
        official_sailing_id: prodRow.official_sailing_id,
        ship_id: prodRow.ship_id,
        departure_date: prodRow.departure_date,
        return_date: prodRow.return_date,
        nights: prodRow.nights,
        destination_id: prodRow.destination_id,
        status: prodRow.status
      }
    });
  }

  const repairCandidates = auditRows.filter((r) => isClassicDeterministicRepairCategory(r.repair_category));
  const deferredRows = auditRows.filter((r) => isClassicDeferredCategory(r.repair_category));

  const sourceAbsentRows = auditRows.filter(
    (r) => r.source_reconcile_status === SOURCE_RECONCILE_STATUS.SOURCE_ABSENT
  );
  const sourceAbsentReconstructable = sourceAbsentRows.filter(
    (r) => r.repair_category === CLASSIC_AUDIT_CATEGORY.SOURCE_ABSENT_RECONSTRUCTABLE
  );
  const sourceAbsentUnsafe = sourceAbsentRows.filter(
    (r) => r.repair_category === CLASSIC_AUDIT_CATEGORY.SOURCE_ABSENT_NOT_SAFE_TO_REPAIR
  );

  const insertProjection = auditClassicInsertProjection();
  let backfillFixture = null;
  let backfillPath = null;

  if (repairCandidates.length > 0) {
    const rows = repairCandidates
      .sort((a, b) => String(a.official_sailing_id).localeCompare(String(b.official_sailing_id)))
      .map((row, i) => buildClassicBackfillFixtureRow(i + 1, row));

    backfillFixture = {
      phase: "M0C",
      mode: M0C_BACKFILL_FIXTURE,
      generated_at: startedAt,
      git_sha: gitSha(),
      selection_method:
        "all recognised Classic rows with deterministic itinerary_ports repair category (current source or raw_extract)",
      reconstruction_policy: {
        current_source: "buildSilverseaUpsertCandidate via buildExpectedClassicItineraryPorts",
        source_absent:
          "raw_extract.itinerary_stops with fully resolved conventional ports only — no guesswork"
      },
      production_snapshot: {
        silversea_total: allRows.length,
        recognised_classic: classicRows.length,
        recognised_expedition: expeditionRows.length,
        legacy_hidden: legacyRows.length
      },
      source_snapshot: {
        catalogue_total: simulation.summary?.catalogue_nodes,
        classic_source_total: classicSourceRows.length,
        source_health: simulation.ok && simulation.health?.ok ? "PASS" : "FAIL"
      },
      classic_rows_audited: classicRows.length,
      repair_candidate_count: rows.length,
      deferred_count: deferredRows.length,
      affected_count: rows.length,
      frozen_count: rows.length,
      frozen_unique_uuid_count: new Set(rows.map((r) => r.production_uuid)).size,
      frozen_unique_official_id_count: new Set(rows.map((r) => r.official_sailing_id)).size,
      update_whitelist: ["itinerary_ports"],
      rows
    };

    const validation = validateClassicRepairFixture(backfillFixture);
    if (
      validation.ok &&
      backfillFixture.frozen_count === backfillFixture.frozen_unique_uuid_count &&
      backfillFixture.frozen_count === backfillFixture.frozen_unique_official_id_count &&
      validation.expedition_rows === 0 &&
      validation.legacy_rows === 0
    ) {
      backfillPath = path.join(FIXTURE_DIR, "classic-m0c-itinerary-ports-backfill.json");
      fs.mkdirSync(FIXTURE_DIR, { recursive: true });
      fs.writeFileSync(backfillPath, `${JSON.stringify(backfillFixture, null, 2)}\n`);
    }
  }

  const dryRun = backfillFixture ? dryRunClassicItineraryPortsBackfill(backfillFixture) : null;

  const provenanceBreakdown = countByKey(repairCandidates, (r) => r.provenance);
  const destinationBreakdown = countByKey(repairCandidates, (r) => r.destination);
  const shipBreakdown = countByKey(repairCandidates, (r) => r.ship);
  const yearBreakdown = countByKey(repairCandidates, (r) =>
    r.departure ? String(r.departure).slice(0, 4) : "unknown"
  );

  const m0dAuthorised =
    insertProjection.nonempty_persisted &&
    insertProjection.empty_persisted &&
    expeditionMismatches === 0 &&
    backfillFixture &&
    dryRun?.proposed_inserts === 0 &&
    dryRun?.proposed_deletes === 0 &&
    dryRun?.other_column_updates === 0 &&
    validateClassicRepairFixture(backfillFixture).ok;

  const crossLineBacklog = {
    affected_write_path: "cruise-discovery-ops.js upsertCandidateRecord INSERT via includeItineraryPorts",
    insert_fix_commit: "7ef5ecfc8acd75fc29f652884d457c6e53f951ad",
    future_inserts_fixed: true,
    historical_production_audit_may_be_required: true,
    lines: [
      "silversea-discovery-writes",
      "celebrity-discovery-writes",
      "royal-caribbean-discovery-writes",
      "norwegian-discovery-writes",
      "carnival-discovery-writes",
      "disney-discovery-writes",
      "princess-discovery-writes",
      "seabourn-discovery-writes",
      "explora-discovery-writes",
      "holland-america-discovery-writes",
      "cruise-discovery-runner"
    ],
    note: "Future INSERT path fixed in shared upsert payload; historical row audits deferred per line."
  };

  const report = {
    phase: "classic_m0c_preparation",
    generated_at: startedAt,
    git_sha: gitSha(),
    production: {
      total: allRows.length,
      classic_official: classicRows.length,
      expedition_official: expeditionRows.length,
      legacy_hidden: legacyRows.length,
      duplicate_official_ids: duplicateOfficialIds
    },
    m0b_recovery_attestation: {
      path: path.relative(root, m0bAttestation.report_path),
      historical_lifecycle_status: "WRITE_SUCCEEDED_VERIFICATION_FAILED",
      m0b_data_recovered_and_independently_verified:
        m0bAttestation.attestation.m0b_data_recovered_and_independently_verified,
      original_m0b_lifecycle_record_modified: false
    },
    expedition_protection: {
      rows_audited: expeditionRows.length,
      itinerary_ports_mismatches: expeditionMismatches,
      clean: expeditionMismatches === 0
    },
    classic_contract: CLASSIC_ITINERARY_PORTS_CONTRACT,
    source: {
      catalogue_total: simulation.summary?.catalogue_nodes,
      classic_source_total: classicSourceRows.length,
      classic_within_cutoff: simulation.summary?.within_21_day_cutoff ?? null,
      classic_beyond_cutoff: simulation.summary?.eligible_beyond_cutoff ?? null,
      duplicate_cruise_codes: simulation.summary?.duplicate_official_sailing_ids ?? 0,
      source_health: simulation.ok && simulation.health?.ok ? "PASS" : "FAIL"
    },
    classic_source_reconciliation: sourceReconcileCounts,
    non_current_source_sample: nonCurrentSourceRows.slice(0, 20),
    classic_audit: {
      rows_audited: classicRows.length,
      category_counts: categoryCounts,
      repair_candidates: repairCandidates.length,
      deferred_unsafe: deferredRows.length,
      provenance_breakdown: provenanceBreakdown,
      destination_breakdown: destinationBreakdown,
      ship_breakdown: shipBreakdown,
      departure_year_breakdown: yearBreakdown
    },
    source_absent: {
      total: sourceAbsentRows.length,
      reconstructable: sourceAbsentReconstructable.length,
      not_safely_reconstructable: sourceAbsentUnsafe.length
    },
    insert_projection: insertProjection,
    backfill_fixture: backfillPath ? path.relative(root, backfillPath) : null,
    dry_run: dryRun,
    pre_write_table: backfillFixture?.rows || [],
    classic_data_shape_remediation_complete: false,
    classic_deterministic_repair_coverage: `${repairCandidates.length}/${classicRows.length}`,
    classic_deferred_rows: deferredRows.length,
    cross_line_integrity_backlog: crossLineBacklog,
    weekly_maintenance: "NOT ENABLED",
    m1_authorised: false,
    m0d_authorisation: m0dAuthorised
      ? "A. M0D — CONTROLLED CLASSIC ITINERARY_PORTS BACKFILL AUTHORISED"
      : repairCandidates.length === 0
        ? "C. NO MATERIAL CLASSIC BACKFILL REQUIRED — PROCEED TO M1"
        : "B. M0C INVESTIGATION / REMEDIATION REQUIRED",
    production_writes: { inserts: 0, updates: 0, deletes: 0 },
    reference_writes: {
      canonical_ports: 0,
      port_aliases: 0,
      destinations: 0,
      semantic_rules: 0
    }
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `silversea-classic-m0c-pre-${startedAt.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        ok: m0dAuthorised || repairCandidates.length > 0,
        report: reportPath,
        classic_audited: classicRows.length,
        repair_candidates: repairCandidates.length,
        deferred: deferredRows.length,
        fixture: report.backfill_fixture,
        m0d: report.m0d_authorisation
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(JSON.stringify({ status: "failed", error: err.message, stack: err.stack }, null, 2));
  process.exit(1);
});
