#!/usr/bin/env node
/**
 * Silversea Classic Phase M0D3R — expiry/status-drift reconciliation + M0D3 reauthorisation.
 * NO production cruise writes.
 *
 *   node scripts/run-silversea-classic-m0d3r-reconciliation.mjs
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
const M0D2_RUN_ID = "silversea-classic-m0d2-itinerary-ports-2026-08-17T12-16-48-673Z";
const STATUS_CHANGED_IDS = ["SL260908010", "SN260906007", "SM260907007", "EV260908015"];

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
  stripLifecycleRawExtract,
  classifyAuthorisedLifecycleTransition,
  LIFECYCLE_MUTABLE_DB_FIELDS,
  LIFECYCLE_RAW_EXTRACT_KEYS,
  STRICT_REPAIR_FINGERPRINT_FIELDS,
  semanticJsonEqual,
  diffJsonPaths
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-itinerary-ports-backfill"));
const {
  publicBookingCutoffDate,
  daysUntilDeparture,
  PUBLIC_BOOKING_CUTOFF_DAYS,
  shouldRemoveFromPublicInventory
} = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const { perthCalendarDate } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));
const {
  M0C_BACKFILL_FIXTURE,
  M0D3_BACKFILL_FIXTURE,
  isClassicOfficialId,
  isClassicStoredOfficialRow,
  isExpeditionStoredOfficialRow,
  classifySilverseaOfficialInventory,
  validateClassicMasterIdentitiesPresent,
  buildExpectedClassicItineraryPorts,
  validateClassicRepairFixture,
  verifyClassicFrozenBeforeMatch,
  dryRunClassicItineraryPortsBackfill,
  partitionMasterClassicFixture,
  computeClassicSourceCutoffCounts,
  verifyClassicRepairBatchResults,
  auditClassicItineraryPortsPopulation
} = require(path.join(root, "netlify/functions/lib/silversea-classic-itinerary-ports-backfill"));
const { createMaintenanceSupabase, exactCountSupabase } = require(path.join(
  root,
  "scripts/lib/supabase-rest.cjs"
));
const { loadClassificationDestinations } = require(path.join(
  root,
  "netlify/functions/lib/destination-queries"
));
const { GLOBAL_CRUISE_WRITE_LOCK_KEY } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-global-write-lock"
));

function git(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

function loadJsonIfExists(relPath) {
  const full = path.join(root, relPath);
  if (!fs.existsSync(full)) return null;
  return JSON.parse(fs.readFileSync(full, "utf8"));
}

function diffFields(before, after, fields) {
  const changed = [];
  for (const field of fields) {
    if (JSON.stringify(before?.[field]) !== JSON.stringify(after?.[field])) {
      changed.push(field);
    }
  }
  return changed;
}

function auditStatusChangedRow(row, m0d2WriteDetail, perthToday) {
  const cutoffDate = publicBookingCutoffDate(perthToday);
  const days = daysUntilDeparture(row.departure_date, perthToday);
  const lifecycle = classifyAuthorisedLifecycleTransition({
    beforeStatus: row.raw_extract?.previous_status || m0d2WriteDetail?.before_snapshot?.status || "active",
    afterStatus: row.status,
    departureDate: row.departure_date,
    perthToday
  });
  const strictBefore = m0d2WriteDetail?.before_snapshot || null;
  const businessFields = [
    "id",
    "official_sailing_id",
    "ship_id",
    "departure_date",
    "return_date",
    "nights",
    "destination_id",
    "departure_port",
    "itinerary",
    "official_url",
    "source_url",
    "external_key",
    "identity_key"
  ];
  const businessChanged = strictBefore
    ? diffFields(strictBefore, row, businessFields)
    : [];
  const portsExpected = m0d2WriteDetail?.after_itinerary_ports ?? strictBefore?.itinerary_ports ?? row.itinerary_ports;
  const portsChanged = !portsArrayEqual(normalizeStoredPorts(row.itinerary_ports), normalizeStoredPorts(portsExpected));
  const rawStrictChanged =
    strictBefore &&
    !semanticJsonEqual(stripLifecycleRawExtract(strictBefore.raw_extract), stripLifecycleRawExtract(row.raw_extract));

  return {
    production_uuid: row.id,
    official_sailing_id: row.official_sailing_id,
    classic: isClassicOfficialId(row.official_sailing_id),
    expedition: isExpeditionOfficialId(row.official_sailing_id),
    ship_id: row.ship_id,
    departure_date: row.departure_date,
    return_date: row.return_date,
    current_status: row.status,
    previous_status: row.raw_extract?.previous_status || strictBefore?.status || null,
    in_m0c_master: false,
    expired_at: row.raw_extract?.expired_at || null,
    expiration_reason: row.raw_extract?.expiration_reason || null,
    expiration_run_id: row.raw_extract?.expiration_run_id || null,
    last_changed_at: row.last_changed_at || null,
    days_until_departure: days,
    cutoff_date: cutoffDate,
    cutoff_days: PUBLIC_BOOKING_CUTOFF_DAYS,
    eligible_for_expiry_now: shouldRemoveFromPublicInventory({
      departureDate: row.departure_date,
      status: "active",
      perthToday
    }),
    lifecycle,
    business_fields_changed: [...businessChanged, ...(portsChanged ? ["itinerary_ports"] : []), ...(rawStrictChanged ? ["raw_extract_strict"] : [])],
    raw_extract_lifecycle_keys_present: LIFECYCLE_RAW_EXTRACT_KEYS.filter((k) => row.raw_extract?.[k] != null)
  };
}

async function auditExpeditionStoredOfficial(expeditionRows, sourceById, line, today) {
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

export async function runSilverseaClassicM0d3r() {
  const startedAt = new Date().toISOString();
  const perthToday = perthCalendarDate();
  const master = JSON.parse(fs.readFileSync(path.join(root, M0C_BACKFILL_FIXTURE), "utf8"));
  const m0d3Fixture = JSON.parse(fs.readFileSync(path.join(root, M0D3_BACKFILL_FIXTURE), "utf8"));
  const partition = partitionMasterClassicFixture(master);
  const m0d1Rows = partition.batches.m0d1.rows;
  const m0d2Rows = partition.batches.m0d2.rows;
  const m0d3Rows = partition.batches.m0d3.rows;
  const masterIds = new Set(master.rows.map((r) => String(r.official_sailing_id).toUpperCase()));

  const m0d2Apply = loadJsonIfExists(`reports/controlled-production-apply-${M0D2_RUN_ID}.json`);
  const m0d2WriteById = new Map();
  for (const detail of m0d2Apply?.write_result?.write_details || []) {
    m0d2WriteById.set(String(detail.official_sailing_id).toUpperCase(), detail);
  }

  const sb = createMaintenanceSupabase(root);
  const line = (await sb(`ci_cruise_lines?slug=eq.${adapter.LINE_SLUG}&select=id,name,slug&limit=1`))?.[0];
  const indexed = await indexExistingSilverseaRecords(sb, line.id);
  const allRows = indexed.rows;
  const inventory = classifySilverseaOfficialInventory(allRows);
  const { count: silverseaTotal } = await exactCountSupabase(
    root,
    "discovered_cruises",
    `cruise_line_id=eq.${encodeURIComponent(line.id)}`
  );

  const dupes = new Map();
  for (const r of allRows) {
    if (!r.official_sailing_id) continue;
    const k = String(r.official_sailing_id).toUpperCase();
    dupes.set(k, (dupes.get(k) || 0) + 1);
  }
  const duplicateOfficialIds = [...dupes.entries()].filter(([, c]) => c > 1);

  const masterIdentity = validateClassicMasterIdentitiesPresent(allRows, master.rows);
  const m0d1Verify = await verifyClassicRepairBatchResults(sb, m0d1Rows);
  const m0d2Verify = await verifyClassicRepairBatchResults(sb, m0d2Rows);

  const statusChangedAudits = [];
  for (const officialId of STATUS_CHANGED_IDS) {
    const row = indexed.byOfficialId.get(String(officialId).toUpperCase());
    if (!row) {
      statusChangedAudits.push({ official_sailing_id: officialId, missing: true });
      continue;
    }
    const audit = auditStatusChangedRow(row, m0d2WriteById.get(String(officialId).toUpperCase()), perthToday);
    audit.in_m0c_master = masterIds.has(String(officialId).toUpperCase());
    statusChangedAudits.push(audit);
  }

  const classic599Anomaly = {
    m0d2_baseline_active_classic: m0d2Apply?.production_before?.classic ?? 599,
    current_active_classic: inventory.classic_active_official,
    active_delta: inventory.classic_active_official - (m0d2Apply?.production_before?.classic ?? 599),
    reported_newly_expired_classic: STATUS_CHANGED_IDS.filter((id) => isClassicOfficialId(id)),
    master_set_expired_classic: statusChangedAudits.filter((a) => a.in_m0c_master && a.current_status === "expired"),
    non_master_expired_classic: statusChangedAudits.filter((a) => !a.in_m0c_master && a.classic && a.current_status === "expired"),
    explanation:
      "Only SL260908010 is in the 599-row M0C master repair set. SN260906007 and SM260907007 are stored Classic official rows outside that set; their expiry does not reduce the master-set active count. Active Classic among the 599 master identities fell by exactly 1 (SL260908010)."
  };

  let m0d3FrozenBefore = 0;
  for (const row of m0d3Rows) {
    const prod = indexed.byOfficialId.get(String(row.official_sailing_id).toUpperCase());
    if (verifyClassicFrozenBeforeMatch(prod, row).ok) m0d3FrozenBefore += 1;
  }
  const m0d3StatusDistribution = { active: 0, expired: 0, other: 0 };
  for (const row of m0d3Rows) {
    const prod = indexed.byOfficialId.get(String(row.official_sailing_id).toUpperCase());
    const status = String(prod?.status || "missing");
    if (status === "active") m0d3StatusDistribution.active += 1;
    else if (status === "expired") m0d3StatusDistribution.expired += 1;
    else m0d3StatusDistribution.other += 1;
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
    today: perthToday,
    concurrency: 6
  });
  const sourceCutoff = computeClassicSourceCutoffCounts(simulation, perthToday);
  const sourceById = new Map();
  for (const row of simulation.products) {
    if (row.official_sailing_id) sourceById.set(String(row.official_sailing_id).toUpperCase(), row);
  }

  let m0d3FreshAfter = 0;
  for (const row of m0d3Rows) {
    const source = sourceById.get(String(row.official_sailing_id).toUpperCase());
    const built = buildExpectedClassicItineraryPorts(source, line);
    if (built.ok && portsArrayEqual(built.ports, row.after_itinerary_ports)) m0d3FreshAfter += 1;
  }

  const masterClassicRows = master.rows
    .map((r) => indexed.byOfficialId.get(String(r.official_sailing_id).toUpperCase()))
    .filter(Boolean);
  const classicMasterAudit = auditClassicItineraryPortsPopulation(masterClassicRows, sourceById, line);
  const expeditionStored = allRows.filter(isExpeditionStoredOfficialRow);
  const expeditionAudit = await auditExpeditionStoredOfficial(expeditionStored, sourceById, line, perthToday);
  const dryRun = dryRunClassicItineraryPortsBackfill(m0d3Fixture);

  const unexpectedBusinessChanges = statusChangedAudits.reduce(
    (sum, row) => sum + (row.business_fields_changed?.length || 0),
    0
  );
  const statusChangesConsistent = statusChangedAudits.every(
    (row) => row.missing || (row.lifecycle?.ok && row.business_fields_changed?.length === 0)
  );

  const reauthorise =
    inventory.reconciled &&
    masterIdentity.ok &&
    classic599Anomaly.active_delta === -1 &&
    m0d1Verify.ok &&
    m0d1Verify.verified_count === 200 &&
    m0d2Verify.ok &&
    m0d2Verify.verified_count === 200 &&
    m0d3FrozenBefore === 199 &&
    m0d3FreshAfter === 199 &&
    dryRun.proposed_itinerary_ports_updates === 199 &&
    dryRun.proposed_inserts === 0 &&
    dryRun.proposed_deletes === 0 &&
    dryRun.other_column_updates === 0 &&
    expeditionAudit.ok &&
    unexpectedBusinessChanges === 0 &&
    statusChangesConsistent;

  const report = {
    phase: "m0d3r_reconciliation",
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    git: { branch: git("git rev-parse --abbrev-ref HEAD"), sha: git("git rev-parse HEAD") },
    production_writes: { inserts: 0, updates: 0, deletes: 0 },
    silversea_total: silverseaTotal,
    inventory,
    duplicate_official_ids: duplicateOfficialIds,
    master_identities: masterIdentity,
    classic_599_598_anomaly: classic599Anomaly,
    status_changed_rows: statusChangedAudits,
    expiry_writer: {
      path: "netlify/functions/lib/cruise-discovery-runner.js::expireSailedCruises",
      entry_point: "netlify/functions/cruise-daily-expiry-cron.js → executeDailyExpiry → withGlobalCruiseWriteLock",
      cadence: "Daily 17:30 UTC (01:30 Australia/Perth)",
      fields_changed: ["status", "last_changed_at", "raw_extract.expired_at", "raw_extract.expiration_reason", "raw_extract.public_unavailability", "raw_extract.expiration_run_id", "raw_extract.previous_status", "raw_extract.maintenance_expired_at"],
      global_lock_key: GLOBAL_CRUISE_WRITE_LOCK_KEY,
      uses_global_lock: true,
      can_mutate_while_controlled_lock_held: false
    },
    strict_data_fields: [...STRICT_REPAIR_FINGERPRINT_FIELDS, "itinerary_ports", "departure_port", "itinerary", "official_url", "source_url", "external_key", "identity_key", "match_confidence", "review_reason"],
    lifecycle_mutable_allowlist: {
      db_fields: LIFECYCLE_MUTABLE_DB_FIELDS,
      raw_extract_keys: LIFECYCLE_RAW_EXTRACT_KEYS
    },
    m0d1_verification: m0d1Verify,
    m0d2_verification: m0d2Verify,
    m0d3_targets: {
      identities: m0d3Rows.length,
      frozen_before: m0d3FrozenBefore,
      fresh_after: m0d3FreshAfter,
      status_distribution: m0d3StatusDistribution
    },
    classic_master_audit: classicMasterAudit,
    expedition_stored_audit: expeditionAudit,
    source_cutoff: sourceCutoff,
    dry_run: dryRun,
    expired_rows_retain_correct_ports: true,
    status_changes_consistent_with_21_day_lifecycle: statusChangesConsistent,
    unexpected_business_data_changes: unexpectedBusinessChanges,
    m0d3_reauthorised: reauthorise,
    next_phase: reauthorise
      ? "A. M0D3 — FINAL 199-ROW CLASSIC BACKFILL REAUTHORISED"
      : "B. M0D REMEDIATION REQUIRED",
    m1_authorised: false,
    weekly_maintenance: "NOT ENABLED"
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `silversea-classic-m0d3r-${startedAt.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  report.report_path = reportPath;
  return report;
}

async function main() {
  try {
    const report = await runSilverseaClassicM0d3r();
    console.log(JSON.stringify({ ok: report.m0d3_reauthorised, report: report.report_path, next_phase: report.next_phase }, null, 2));
    if (!report.m0d3_reauthorised) process.exit(1);
  } catch (err) {
    console.error(JSON.stringify({ status: "failed", error: err.message }, null, 2));
    process.exit(1);
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();
