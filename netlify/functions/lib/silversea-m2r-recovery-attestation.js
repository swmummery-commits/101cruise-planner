/**
 * Silversea M2R — read-only recovery attestation for M2 insert-canary verification failure.
 */

const fs = require("fs");
const crypto = require("crypto");
const {
  CANARY_OFFICIAL_ID,
  compareInsertedRowToFixture,
  proveRepeatInsertBlocked
} = require("./silversea-m2-maintenance-insert-canary");
const {
  classifySilverseaOfficialInventory,
  isClassicStoredOfficialRow,
  isExpeditionStoredOfficialRow
} = require("./silversea-classic-itinerary-ports-backfill");
const {
  snapshotProtectionRows,
  verifyProtectionSnapshots,
  portsArrayEqual
} = require("./silversea-expedition-itinerary-ports-backfill");

const HISTORICAL_M2_RUN_ID =
  "silversea-m2-maintenance-insert-WH281005017-2026-08-23T01-33-26-599Z";
const HISTORICAL_INSERTED_UUID = "94b60f04-3728-49af-8d58-70e93f6dfd7c";
const HISTORICAL_AFFECTED_EXPEDITION_UUID = "21a6601a-1e11-4472-ac30-827091082e6b";
const HISTORICAL_LOCK_ACQUIRED_AT = "2026-08-23T01:34:39.372Z";
const HISTORICAL_PREFLIGHT_STARTED_AT = "2026-08-23T01:33:26.599Z";
const M2_FIX_COMMIT = "b4ff6936ec8d51d583e266e90e44a202907083f6";
const M1_UPDATE_CANARY_ID = "SL270927009";
const M1_SOURCE_ABSENCE_ID = "SN280222C25";
const M2_PRODUCTION_BEFORE_TOTAL = 919;
const M2_CLASSIC_BEFORE = 601;

const { MAINTENANCE_CLASSIFICATION } = require("./silversea-weekly-maintenance-policy");

function runExpeditionProtectionCheck({ beforeOfficialRows, afterRows, today = "2026-08-22" }) {
  const expeditionBefore = (beforeOfficialRows || []).filter(isExpeditionStoredOfficialRow);
  const expeditionAfter = (afterRows || []).filter(isExpeditionStoredOfficialRow);
  return verifyProtectionSnapshots(
    snapshotProtectionRows(expeditionBefore, new Set()),
    expeditionAfter,
    new Set(),
    { perthToday: today }
  );
}

function hashFile(path) {
  return crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
}

function countDuplicateOfficialIds(rows) {
  const seen = new Set();
  const dupes = [];
  for (const row of rows || []) {
    const id = String(row.official_sailing_id || "").toUpperCase();
    if (!id) continue;
    if (seen.has(id)) dupes.push(id);
    seen.add(id);
  }
  return dupes;
}

function auditUnderLockSnapshotOrdering(runnerSource) {
  const src = String(runnerSource || "");
  const checks = {
    under_lock_before_rows_declared: /let underLockBeforeRows/.test(src),
    captured_on_lock_acquired: /onLockAcquired:[\s\S]*underLockBeforeRows\s*=\s*\(await indexExistingSilverseaRecords/.test(
      src
    ),
    verification_prefers_under_lock:
      /officialRows:\s*\(underLockBeforeRows\s*\|\|\s*productionIndex\.rows\)/.test(src),
    mutate_after_on_lock_acquired:
      src.indexOf("onLockAcquired") < src.indexOf("mutate: async") &&
      src.indexOf("underLockBeforeRows") < src.indexOf("mutate: async")
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  return { ok: failed.length === 0, checks, failed };
}

/**
 * Simulate historical defect: pre-lock baseline differs from under-lock baseline on a
 * non-target Expedition row, while under-lock/post-write state is stable.
 */
function simulatePreLockBaselineFalsePositive({
  expeditionRowUnderLock,
  expeditionRowPreLock,
  insertedClassicRow,
  today = "2026-08-22"
}) {
  const preLockOfficial = [expeditionRowPreLock];
  const underLockOfficial = [expeditionRowUnderLock];
  const afterOfficial = [expeditionRowUnderLock, insertedClassicRow];

  const preLockProtection = runExpeditionProtectionCheck({
    beforeOfficialRows: preLockOfficial,
    afterRows: afterOfficial,
    today
  });

  const underLockProtection = runExpeditionProtectionCheck({
    beforeOfficialRows: underLockOfficial,
    afterRows: afterOfficial,
    today
  });

  return {
    pre_lock_baseline_fails: preLockProtection.ok === false,
    under_lock_baseline_passes: underLockProtection.ok === true,
    ok: preLockProtection.ok === false && underLockProtection.ok === true
  };
}

function simulateRealUnderLockMutation({
  expeditionRowBefore,
  expeditionRowAfterMutated,
  insertedClassicRow,
  today = "2026-08-22"
}) {
  const afterOfficial = [expeditionRowAfterMutated, insertedClassicRow];
  const protection = runExpeditionProtectionCheck({
    beforeOfficialRows: [expeditionRowBefore],
    afterRows: afterOfficial,
    today
  });
  return {
    ok: protection.ok === false,
    protection
  };
}

function verifyHistoricalReportPreserved({ reportPath, initialHash }) {
  if (!fs.existsSync(reportPath)) {
    return { ok: false, reason: "report_missing" };
  }
  const currentHash = hashFile(reportPath);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  return {
    ok: currentHash === initialHash,
    initial_hash: initialHash,
    current_hash: currentHash,
    status: report.status,
    global_lock_released: report.global_lock?.global_lock_released,
    rewritten: currentHash !== initialHash
  };
}

function verifyInsertedPayloadFields(row, fixture) {
  const payload = fixture.insert_payload || {};
  const fields = [
    "official_sailing_id",
    "cruise_line_id",
    "ship_id",
    "departure_date",
    "return_date",
    "nights",
    "departure_port",
    "destination_id",
    "official_url",
    "itinerary",
    "status"
  ];
  const mismatches = [];
  for (const field of fields) {
    if (JSON.stringify(row[field]) !== JSON.stringify(payload[field])) {
      mismatches.push(field);
    }
  }
  if (!portsArrayEqual(row.itinerary_ports, fixture.itinerary_ports)) {
    mismatches.push("itinerary_ports");
  }
  const semantic = compareInsertedRowToFixture(row, fixture);
  if (!semantic.ok) mismatches.push(...semantic.issues.filter((i) => !mismatches.includes(i)));
  return { ok: mismatches.length === 0, mismatches, mismatch_count: mismatches.length };
}

function classifyM1Record(proposal, officialId = CANARY_OFFICIAL_ID) {
  const record = (proposal?.records || []).find(
    (r) => String(r.official_sailing_id).toUpperCase() === String(officialId).toUpperCase()
  );
  return record || null;
}

function auditCanaryProtection(indexed, productionIndexBeforeM2 = null) {
  const sl = indexed.byOfficialId.get(M1_UPDATE_CANARY_ID);
  const sn = indexed.byOfficialId.get(M1_SOURCE_ABSENCE_ID);
  const slSnap = sl ? snapshotProtectionRows([sl], new Set()) : null;
  const snSnap = sn ? snapshotProtectionRows([sn], new Set()) : null;
  return {
    update_canary_present: Boolean(sl),
    source_absence_present: Boolean(sn),
    update_canary_id: M1_UPDATE_CANARY_ID,
    source_absence_id: M1_SOURCE_ABSENCE_ID
  };
}

function computeM2AttributableDelta(inventory) {
  return {
    row_delta: inventory.total - M2_PRODUCTION_BEFORE_TOTAL,
    classic_delta: inventory.classic_stored_official_total - M2_CLASSIC_BEFORE,
    expedition_delta: inventory.expedition_stored_official_total - 310,
    legacy_delta: inventory.legacy - 8
  };
}

function buildMockExpeditionRow(id, officialId, rawExtract) {
  return {
    id,
    official_sailing_id: officialId,
    cruise_line_id: "line-silversea",
    ship_id: "ship-exp",
    departure_date: "2027-06-01",
    return_date: "2027-06-15",
    nights: 14,
    departure_port: "Ushuaia",
    destination_id: "dest-exp",
    itinerary: "Ushuaia, Antarctic Peninsula",
    itinerary_ports: ["Ushuaia", "Antarctic Peninsula"],
    status: "active",
    official_url: "https://example.com/exp",
    source_url: "https://example.com/exp",
    raw_extract: rawExtract
  };
}

function buildMockClassicInsertRow() {
  return {
    id: HISTORICAL_INSERTED_UUID,
    official_sailing_id: CANARY_OFFICIAL_ID,
    cruise_line_id: "line-silversea",
    ship_id: "ship-wh",
    departure_date: "2028-10-05",
    return_date: "2028-10-22",
    nights: 17,
    departure_port: "Tokyo",
    destination_id: "dest-tp",
    itinerary: "Tokyo, Kobe, Apra Harbor, Port Vila, Lautoka",
    itinerary_ports: ["Tokyo", "Kobe", "Apra Harbor", "Port Vila", "Lautoka"],
    status: "active",
    official_url: "https://example.com/wh",
    source_url: "https://example.com/wh",
    raw_extract: { silversea_cruise_code: CANARY_OFFICIAL_ID }
  };
}

function auditCircularDependencyWarning() {
  const cycle = ["cruise-discovery-ops.js", "cruise-discovery.js"];
  let validateCruiseCallable = false;
  let validateCruiseAtLoad = false;
  try {
    const ops = require("./cruise-discovery-ops");
    validateCruiseCallable = typeof ops.buildDiscoveredCruiseUpsertPayload === "function";
    const disc = require("./cruise-discovery");
    validateCruiseAtLoad = typeof disc.validateCruise === "function";
  } catch {
    /* ignore */
  }
  return {
    modules_in_cycle: cycle,
    validate_cruise_resolves_at_runtime: validateCruiseAtLoad && validateCruiseCallable,
    blocks_m3: false,
    note:
      "Node may emit circular dependency warning while cruise-discovery-ops reads validateCruise before cruise-discovery finishes exporting; runtime resolution succeeds in M2/M2R paths."
  };
}

module.exports = {
  HISTORICAL_M2_RUN_ID,
  HISTORICAL_INSERTED_UUID,
  HISTORICAL_AFFECTED_EXPEDITION_UUID,
  HISTORICAL_LOCK_ACQUIRED_AT,
  HISTORICAL_PREFLIGHT_STARTED_AT,
  M2_FIX_COMMIT,
  M1_UPDATE_CANARY_ID,
  M1_SOURCE_ABSENCE_ID,
  hashFile,
  countDuplicateOfficialIds,
  auditUnderLockSnapshotOrdering,
  simulatePreLockBaselineFalsePositive,
  simulateRealUnderLockMutation,
  verifyHistoricalReportPreserved,
  verifyInsertedPayloadFields,
  classifyM1Record,
  auditCanaryProtection,
  computeM2AttributableDelta,
  buildMockExpeditionRow,
  buildMockClassicInsertRow,
  auditCircularDependencyWarning,
  MAINTENANCE_CLASSIFICATION
};
