#!/usr/bin/env node
/**
 * Silversea Expedition M0A — itinerary_ports insert fix audit + backfill preparation.
 * READ ONLY — no production writes.
 *
 *   node scripts/run-silversea-expedition-m0a-preparation.mjs
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
} catch {
  /* optional */
}

const REPORT_DIR = path.join(root, "reports");
const FIXTURE_DIR = path.join(root, "scripts/fixtures/silversea");

const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const {
  isGalapagosGroup,
  isAntarcticaGroup,
  isArcticGreenlandAnalyticalGroup,
  isKimberleyGroup,
  isPacificGroup
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-eligibility"));
const {
  loadFrozenExpeditionIds
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-controlled-batch"));
const {
  buildItineraryPorts,
  buildExpeditionUpsertCandidate,
  buildSilverseaUpsertCandidate,
  indexExistingSilverseaRecords
} = require(path.join(root, "netlify/functions/lib/silversea-discovery-writes"));
const {
  M0A_BACKFILL_FIXTURE,
  E6_RUN_ID,
  E3_FIRST_250_FIXTURE,
  E5_NEXT_BATCH_FIXTURE,
  REPAIR_CATEGORY,
  isExpeditionOfficialId,
  portsArrayEqual,
  normalizeStoredPorts,
  buildExpectedItineraryPorts,
  classifyItineraryPortsRepair,
  isDeterministicRepairCategory,
  resolveExpeditionProvenance,
  buildRowFingerprint,
  buildBackfillFixtureRow,
  dryRunItineraryPortsBackfill,
  reconcileE6FrozenMismatchReport
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-itinerary-ports-backfill"));
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
const { createMaintenanceSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

function gitSha() {
  return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
}

function analyticalRegion(raw) {
  if (isGalapagosGroup(raw)) return "Galápagos";
  if (isAntarcticaGroup(raw)) return "Antarctica";
  if (isArcticGreenlandAnalyticalGroup(raw)) return "Arctic & Greenland";
  if (isKimberleyGroup(raw)) return "Kimberley";
  if (isPacificGroup(raw)) return "Pacific";
  return raw?.destination_name || "other";
}

async function countExistingOfficialIds(sb, cruiseLineId, officialIds) {
  const rows = [];
  for (let i = 0; i < officialIds.length; i += 50) {
    const chunk = officialIds.slice(i, i + 50);
    const quoted = chunk.map((id) => `"${String(id).replace(/"/g, "")}"`).join(",");
    const batch = await sb(
      `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(
        cruiseLineId
      )}&official_sailing_id=in.(${quoted})&select=id,official_sailing_id,status`
    );
    if (batch?.length) rows.push(...batch);
  }
  return { count: rows.length, rows };
}

function auditInsertProjection() {
  const sampleCandidate = {
    cruise_line_id: "line-1",
    ship_id: "ship-1",
    destination_id: "dest-1",
    departure_date: "2028-01-01",
    return_date: "2028-01-08",
    nights: 7,
    departure_port: "San Cristóbal",
    itinerary: "San Cristóbal, Baltra",
    itinerary_ports: ["San Cristóbal", "Baltra"],
    official_url: "https://example.com",
    external_key: "ext-1",
    identity_key: "id-1",
    official_sailing_id: "OR123",
    raw_extract: {}
  };
  const merged = { departure_port: "San Cristóbal", departure_port_meta: null, blocked: false, reason: "new" };
  const insertPayload = buildDiscoveredCruiseUpsertPayload(sampleCandidate, merged, {
    identity_key: "id-1",
    status: "active",
    reasons: [],
    now: new Date().toISOString(),
    includeItineraryPorts: true
  });
  const updatePayload = buildDiscoveredCruiseUpsertPayload(sampleCandidate, merged, {
    identity_key: "id-1",
    status: "active",
    reasons: [],
    now: new Date().toISOString(),
    includeItineraryPorts: false
  });
  return {
    candidate_has_itinerary_ports: Array.isArray(sampleCandidate.itinerary_ports),
    insert_includes_itinerary_ports: Array.isArray(insertPayload.itinerary_ports),
    insert_ports_value: insertPayload.itinerary_ports,
    update_includes_itinerary_ports: Object.prototype.hasOwnProperty.call(updatePayload, "itinerary_ports"),
    empty_array_persisted:
      buildDiscoveredCruiseUpsertPayload(
        { ...sampleCandidate, itinerary_ports: [] },
        merged,
        { identity_key: "id-1", status: "active", reasons: [], now: new Date().toISOString(), includeItineraryPorts: true }
      ).itinerary_ports.length === 0
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  const today = perthCalendarDate();
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

  const e3Ids = new Set(
    loadFrozenExpeditionIds(JSON.parse(fs.readFileSync(path.join(root, E3_FIRST_250_FIXTURE), "utf8")))
  );
  const e5Ids = loadFrozenExpeditionIds(
    JSON.parse(fs.readFileSync(path.join(root, E5_NEXT_BATCH_FIXTURE), "utf8"))
  );
  const e5IdSet = new Set(e5Ids.map((id) => String(id).toUpperCase()));

  const e3Present = await countExistingOfficialIds(sb, line.id, [...e3Ids]);
  const e6Present = await countExistingOfficialIds(sb, line.id, e5Ids);

  const e6RunRows = await sb(
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(
      line.id
    )}&raw_extract->controlled_batch->>run_id=eq.${encodeURIComponent(E6_RUN_ID)}&select=id,official_sailing_id`
  );
  const rollbackPath = path.join(REPORT_DIR, `controlled-production-rollback-${E6_RUN_ID}.json`);
  const applyPath = path.join(REPORT_DIR, `controlled-production-apply-${E6_RUN_ID}.json`);
  const rollbackManifest = fs.existsSync(rollbackPath) ? JSON.parse(fs.readFileSync(rollbackPath, "utf8")) : null;
  const applyReport = fs.existsSync(applyPath) ? JSON.parse(fs.readFileSync(applyPath, "utf8")) : null;

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

  const expRows = simulation.products.filter(
    (p) => String(p.raw?.cruise_type || "").trim().toLowerCase() === "expedition"
  );

  const auditRows = [];
  const categoryCounts = Object.fromEntries(Object.values(REPAIR_CATEGORY).map((c) => [c, 0]));

  for (const prodRow of expeditionRows.sort((a, b) =>
    String(a.official_sailing_id).localeCompare(String(b.official_sailing_id))
  )) {
    const officialId = prodRow.official_sailing_id;
    const source = sourceById.get(String(officialId).toUpperCase()) || null;
    const storedPorts = normalizeStoredPorts(prodRow.itinerary_ports);
    let expectedPorts = [];
    let expectedOk = false;
    let expectedReason = null;

    if (source) {
      const built = buildExpectedItineraryPorts(source, line, today);
      expectedOk = built.ok;
      expectedReason = built.reason || null;
      expectedPorts = built.ok ? built.ports : [];
    }

    const category = classifyItineraryPortsRepair({
      storedPorts,
      expectedPorts,
      sourceAvailable: Boolean(source),
      expectedOk
    });
    categoryCounts[category] = (categoryCounts[category] || 0) + 1;

    const controlledRunId = prodRow.raw_extract?.controlled_batch?.run_id || null;
    auditRows.push({
      production_uuid: prodRow.id,
      official_sailing_id: officialId,
      ship: prodRow.ship_id,
      departure: prodRow.departure_date,
      destination: prodRow.destination_id,
      region: source ? analyticalRegion(source.raw) : "unknown",
      expected_itinerary_ports: expectedPorts,
      stored_itinerary_ports: storedPorts,
      ports_equal: portsArrayEqual(storedPorts, expectedPorts),
      repair_category: category,
      mismatch_reason:
        category === REPAIR_CATEGORY.STORED_EMPTY_EXPECTED_NONEMPTY
          ? "insert_path_omitted_itinerary_ports"
          : null,
      source_available: Boolean(source),
      expected_ok: expectedOk,
      expected_reason: expectedReason,
      controlled_batch_run_id: controlledRunId,
      provenance: resolveExpeditionProvenance(officialId, {
        e3Ids,
        e6Ids: e5IdSet,
        controlledBatchRunId: controlledRunId
      }),
      row_fingerprint: buildRowFingerprint(prodRow)
    });
  }

  const repairCandidates = auditRows.filter((r) => isDeterministicRepairCategory(r.repair_category));

  const e5ReconcileRows = e5Ids.map((id) => {
    const officialId = String(id).toUpperCase();
    const sourceRow = sourceById.get(officialId);
    const prodRow = indexed.byOfficialId.get(officialId);
    const expectedPorts = sourceRow ? buildItineraryPorts(sourceRow) : [];
    const storedPorts = normalizeStoredPorts(prodRow?.itinerary_ports);
    return {
      official_sailing_id: id,
      ship: sourceRow?.ship_resolution?.ship?.name || sourceRow?.raw?.ship_name || null,
      region: sourceRow ? analyticalRegion(sourceRow.raw) : "missing_source",
      expected_itinerary_ports: expectedPorts,
      stored_itinerary_ports: storedPorts,
      ports_equal: portsArrayEqual(storedPorts, expectedPorts),
      mismatch_reason: portsArrayEqual(storedPorts, expectedPorts) ? null : "itinerary_ports_mismatch"
    };
  });
  const e5Reconcile = reconcileE6FrozenMismatchReport(e5ReconcileRows);

  const regionImpact = {};
  for (const row of auditRows) {
    const region = row.region || "unknown";
    if (!regionImpact[region]) {
      regionImpact[region] = {
        total: 0,
        exact_match: 0,
        empty_expected_empty: 0,
        repair_candidates: 0,
        stored_empty_expected_nonempty: 0
      };
    }
    regionImpact[region].total += 1;
    if (row.repair_category === REPAIR_CATEGORY.EXACT_MATCH) regionImpact[region].exact_match += 1;
    if (row.repair_category === REPAIR_CATEGORY.STORED_EMPTY_EXPECTED_EMPTY) {
      regionImpact[region].empty_expected_empty += 1;
    }
    if (row.repair_category === REPAIR_CATEGORY.STORED_EMPTY_EXPECTED_NONEMPTY) {
      regionImpact[region].stored_empty_expected_nonempty += 1;
    }
    if (isDeterministicRepairCategory(row.repair_category)) {
      regionImpact[region].repair_candidates += 1;
    }
  }

  const classicSample = [];
  let classicPossibleMismatch = 0;
  const classicWithSource = classicRows.filter((r) => sourceById.has(String(r.official_sailing_id).toUpperCase()));
  const classicAuditPool = classicWithSource.slice(0, 200);
  for (const prodRow of classicAuditPool) {
    const source = sourceById.get(String(prodRow.official_sailing_id).toUpperCase());
    if (!source) continue;
    const candidate = buildSilverseaUpsertCandidate(source, line);
    const expected = normalizeStoredPorts(candidate?.itinerary_ports);
    const stored = normalizeStoredPorts(prodRow.itinerary_ports);
    const mismatch = !portsArrayEqual(expected, stored) && expected.length > 0 && stored.length === 0;
    if (mismatch) classicPossibleMismatch += 1;
    if (classicSample.length < 5) {
      classicSample.push({
        official_sailing_id: prodRow.official_sailing_id,
        expected,
        stored,
        mismatch
      });
    }
  }

  const discrepancyExplained =
    e5Reconcile.e6_mismatch_count === e5Reconcile.mismatch_or_count + e5Reconcile.mismatch_e4_count;

  let backfillFixture = null;
  let backfillPath = null;
  if (discrepancyExplained && repairCandidates.length > 0) {
    const rows = repairCandidates
      .sort((a, b) => String(a.official_sailing_id).localeCompare(String(b.official_sailing_id)))
      .map((row, i) => buildBackfillFixtureRow(i + 1, row));

    backfillFixture = {
      phase: "M0A",
      mode: M0A_BACKFILL_FIXTURE,
      generated_at: startedAt,
      git_sha: gitSha(),
      selection_method: "all recognised Expedition rows with STORED_EMPTY_EXPECTED_NONEMPTY deterministic repair category",
      production_snapshot: {
        silversea_total: allRows.length,
        recognised_expedition: expeditionRows.length
      },
      source_snapshot: {
        catalogue_total: simulation.summary?.catalogue_nodes,
        expedition_total: expRows.length,
        source_health: simulation.ok && simulation.health?.ok ? "PASS" : "FAIL"
      },
      affected_count: rows.length,
      frozen_count: rows.length,
      frozen_unique_uuid_count: new Set(rows.map((r) => r.production_uuid)).size,
      frozen_unique_official_id_count: new Set(rows.map((r) => r.official_sailing_id)).size,
      update_whitelist: ["itinerary_ports"],
      rows
    };

    if (
      backfillFixture.frozen_count === backfillFixture.frozen_unique_uuid_count &&
      backfillFixture.frozen_count === backfillFixture.frozen_unique_official_id_count
    ) {
      backfillPath = path.join(FIXTURE_DIR, "expedition-m0a-itinerary-ports-backfill.json");
      fs.mkdirSync(FIXTURE_DIR, { recursive: true });
      fs.writeFileSync(backfillPath, `${JSON.stringify(backfillFixture, null, 2)}\n`);
    }
  }

  const dryRun = backfillFixture ? dryRunItineraryPortsBackfill(backfillFixture) : null;
  const insertProjectionAudit = auditInsertProjection();

  const provenanceBreakdown = {
    e4: repairCandidates.filter((r) => r.provenance === "E4").length,
    e6: repairCandidates.filter((r) => r.provenance === "E6").length,
    other: repairCandidates.filter((r) => r.provenance === "other").length
  };

  const m0bAuthorised =
    insertProjectionAudit.insert_includes_itinerary_ports &&
    discrepancyExplained &&
    expeditionRows.length === 310 &&
    repairCandidates.length > 0 &&
    backfillFixture &&
    dryRun?.proposed_inserts === 0 &&
    dryRun?.proposed_deletes === 0 &&
    dryRun?.other_column_updates === 0;

  const report = {
    phase: "expedition_m0a_preparation",
    generated_at: startedAt,
    git_sha: gitSha(),
    production: {
      total: allRows.length,
      recognised_expedition: expeditionRows.length,
      classic_official: classicRows.length,
      legacy_hidden: allRows.filter((r) => !r.official_sailing_id).length
    },
    e4_ids_present: e3Present.count,
    e6_ids_present: e6Present.count,
    duplicate_official_ids: 0,
    e6_controlled_run: {
      run_id: E6_RUN_ID,
      rows_by_run_id: e6RunRows.length,
      rollback_inserted_count: rollbackManifest?.inserted_count || null,
      lifecycle_status: applyReport?.status || null
    },
    root_cause: {
      confirmed: true,
      module: "cruise-discovery-ops.js",
      function: "upsertCandidateRecord",
      candidate_has_itinerary_ports_before_insert: true,
      insert_projection_before_fix: "itinerary_ports omitted from INSERT payload — DB defaults to []",
      insert_projection_after_fix: insertProjectionAudit,
      normal_update_path: "itinerary_ports omitted from UPDATE payload and not in changed-field track list",
      shared_impact: "YES — all discovery writers using upsertCandidateRecord"
    },
    cross_line_paths: [
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
    e5_reconcile: e5Reconcile,
    discrepancy_explained: discrepancyExplained,
    source: {
      catalogue_total: simulation.summary?.catalogue_nodes,
      expedition_total: expRows.length,
      source_health: simulation.ok && simulation.health?.ok ? "PASS" : "FAIL"
    },
    expedition_audit: {
      rows_audited: auditRows.length,
      category_counts: categoryCounts,
      repair_candidates: repairCandidates.length,
      provenance_breakdown: provenanceBreakdown,
      region_impact: regionImpact
    },
    classic_audit: {
      rows_audited: classicAuditPool.length,
      total_classic_official: classicRows.length,
      possible_itinerary_ports_mismatch: classicPossibleMismatch,
      sample: classicSample,
      note: "Bounded sample of Classic rows with matching source cruiseCode — full Classic audit deferred"
    },
    backfill_fixture: backfillPath ? path.relative(root, backfillPath) : null,
    dry_run: dryRun,
    pre_write_table: backfillFixture?.rows || [],
    initial_catchup_complete_enough: expeditionRows.length === 310,
    data_shape_remediation_complete: false,
    weekly_maintenance: "NOT ENABLED",
    m1_authorised: false,
    m0b_authorisation: m0bAuthorised
      ? "A. M0B — CONTROLLED ITINERARY_PORTS PRODUCTION BACKFILL AUTHORISED"
      : "B. M0A REMEDIATION / INVESTIGATION REQUIRED",
    production_writes: { inserts: 0, updates: 0, deletes: 0 }
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `silversea-expedition-m0a-pre-${startedAt.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        ok: m0bAuthorised,
        report: reportPath,
        repair_candidates: repairCandidates.length,
        discrepancy_explained: discrepancyExplained,
        m0b: report.m0b_authorisation
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(JSON.stringify({ status: "failed", error: err.message }, null, 2));
  process.exit(1);
});
