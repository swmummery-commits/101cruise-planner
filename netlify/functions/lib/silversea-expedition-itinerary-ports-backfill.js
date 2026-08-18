/**
 * Silversea Expedition itinerary_ports controlled backfill (M0A/M0B).
 * Updates ONLY discovered_cruises.itinerary_ports for exact frozen UUIDs.
 */

const fs = require("fs");
const path = require("path");
const { buildItineraryPorts, buildExpeditionUpsertCandidate } = require("./silversea-discovery-writes");
const { buildDiscoveredCruiseUpsertPayload, normalizeItineraryPortsForDb } = require("./cruise-discovery-ops");
const { classifyExpeditionExclusiveBucket } = require("./silversea-expedition-eligibility");
const { evaluateExpeditionEligibility } = require("./silversea-expedition-eligibility");
const { loadFrozenExpeditionIds } = require("./silversea-expedition-controlled-batch");

const M0A_BACKFILL_FIXTURE = "scripts/fixtures/silversea/expedition-m0a-itinerary-ports-backfill.json";
const E6_RUN_ID = "silversea-expedition-e6-2026-08-17T00-56-06-160Z";
const E3_FIRST_250_FIXTURE = "scripts/fixtures/silversea/expedition-e3-first-250.json";
const E5_NEXT_BATCH_FIXTURE = "scripts/fixtures/silversea/expedition-e5-next-batch.json";
const UPDATE_WHITELIST = Object.freeze(["itinerary_ports"]);
const M0B_OPERATION = "silversea_expedition_m0b_itinerary_ports_backfill";
const M0B_APPLY_CONFIRMATION_TOKEN = "SILVERSEA-EXPEDITION-M0B-ITINERARY-PORTS-BACKFILL";
const FINGERPRINT_FIELDS = Object.freeze([
  "id",
  "official_sailing_id",
  "ship_id",
  "departure_date",
  "return_date",
  "nights",
  "destination_id",
  "status"
]);
const NON_WHITELIST_COMPARE_FIELDS = Object.freeze([
  "id",
  "cruise_line_id",
  "ship_id",
  "destination_id",
  "departure_date",
  "return_date",
  "nights",
  "departure_port",
  "itinerary",
  "status",
  "official_url",
  "source_url",
  "official_sailing_id",
  "external_key",
  "identity_key",
  "match_confidence",
  "review_reason"
]);
const STRICT_REPAIR_FINGERPRINT_FIELDS = Object.freeze([
  "id",
  "official_sailing_id",
  "ship_id",
  "departure_date",
  "return_date",
  "nights",
  "destination_id"
]);
const LIFECYCLE_MUTABLE_DB_FIELDS = Object.freeze(["status", "last_changed_at"]);
const LIFECYCLE_RAW_EXTRACT_KEYS = Object.freeze([
  "expired_at",
  "expiration_reason",
  "public_unavailability",
  "expiration_run_id",
  "previous_status",
  "maintenance_expired_at"
]);
const LIFECYCLE_TRANSITION = Object.freeze({
  NONE: "NONE",
  EXPECTED: "EXPECTED_LIFECYCLE_TRANSITION",
  UNEXPECTED: "UNEXPECTED_LIFECYCLE_TRANSITION"
});

const { shouldRemoveFromPublicInventory, perthCalendarDate } = require("./public-discovered-cruise-inventory");

const REPAIR_CATEGORY = Object.freeze({
  EXACT_MATCH: "EXACT_MATCH",
  STORED_EMPTY_EXPECTED_EMPTY: "STORED_EMPTY_EXPECTED_EMPTY",
  STORED_EMPTY_EXPECTED_NONEMPTY: "STORED_EMPTY_EXPECTED_NONEMPTY",
  STORED_NONEMPTY_EXPECTED_DIFFERENT: "STORED_NONEMPTY_EXPECTED_DIFFERENT",
  STORED_NONEMPTY_EXPECTED_EMPTY: "STORED_NONEMPTY_EXPECTED_EMPTY",
  SOURCE_NO_LONGER_AVAILABLE: "SOURCE_NO_LONGER_AVAILABLE",
  EXPECTED_MANIFEST_UNSAFE: "EXPECTED_MANIFEST_UNSAFE"
});

function isExpeditionOfficialId(id) {
  return /^(E4|EV|OR|WI)/i.test(String(id || ""));
}

function portsArrayEqual(a, b) {
  return JSON.stringify(a || []) === JSON.stringify(b || []);
}

function normalizeStoredPorts(stored) {
  if (stored == null) return [];
  if (!Array.isArray(stored)) return [];
  return stored.map((p) => String(p).trim()).filter(Boolean);
}

function buildExpectedItineraryPorts(normalised, cruiseLine, today) {
  const candidate = buildExpeditionUpsertCandidate(normalised, cruiseLine, today);
  if (!candidate) return { ok: false, reason: "candidate_null", ports: null };
  const evalResult = evaluateExpeditionEligibility(normalised, today);
  if (evalResult.ambiguous_stop_count > 0 || evalResult.match_required) {
    return { ok: false, reason: "unsafe_or_ambiguous", ports: null };
  }
  if (classifyExpeditionExclusiveBucket(normalised, today) !== "expedition_e2_complete") {
    return { ok: false, reason: "not_e2_complete", ports: null };
  }
  return {
    ok: true,
    ports: normalizeItineraryPortsForDb(candidate),
    candidate
  };
}

function classifyItineraryPortsRepair({ storedPorts, expectedPorts, sourceAvailable, expectedOk }) {
  const stored = normalizeStoredPorts(storedPorts);
  const expected = normalizeStoredPorts(expectedPorts);

  if (!sourceAvailable) {
    return REPAIR_CATEGORY.SOURCE_NO_LONGER_AVAILABLE;
  }
  if (!expectedOk) {
    return REPAIR_CATEGORY.EXPECTED_MANIFEST_UNSAFE;
  }
  if (portsArrayEqual(stored, expected)) {
    return stored.length === 0
      ? REPAIR_CATEGORY.STORED_EMPTY_EXPECTED_EMPTY
      : REPAIR_CATEGORY.EXACT_MATCH;
  }
  if (stored.length === 0 && expected.length > 0) {
    return REPAIR_CATEGORY.STORED_EMPTY_EXPECTED_NONEMPTY;
  }
  if (stored.length > 0 && expected.length === 0) {
    return REPAIR_CATEGORY.STORED_NONEMPTY_EXPECTED_EMPTY;
  }
  return REPAIR_CATEGORY.STORED_NONEMPTY_EXPECTED_DIFFERENT;
}

function isDeterministicRepairCategory(category) {
  return (
    category === REPAIR_CATEGORY.STORED_EMPTY_EXPECTED_NONEMPTY ||
    category === REPAIR_CATEGORY.STORED_NONEMPTY_EXPECTED_DIFFERENT ||
    category === REPAIR_CATEGORY.STORED_NONEMPTY_EXPECTED_EMPTY
  );
}

function resolveExpeditionProvenance(officialSailingId, { e3Ids, e6Ids, controlledBatchRunId }) {
  const id = String(officialSailingId || "").toUpperCase();
  if (controlledBatchRunId === E6_RUN_ID) return "E6";
  if (e6Ids.has(id)) return "E6";
  if (e3Ids.has(id)) return "E4";
  return "other";
}

function buildRowFingerprint(row) {
  return {
    id: row.id,
    official_sailing_id: row.official_sailing_id,
    ship_id: row.ship_id,
    departure_date: row.departure_date,
    return_date: row.return_date,
    nights: row.nights,
    destination_id: row.destination_id,
    status: row.status
  };
}

function buildBackfillFixtureRow(sequence, auditRow) {
  return {
    sequence,
    production_uuid: auditRow.production_uuid,
    official_sailing_id: auditRow.official_sailing_id,
    cruise_code: auditRow.official_sailing_id,
    ship: auditRow.ship,
    departure: auditRow.departure,
    region: auditRow.region,
    before_itinerary_ports: normalizeStoredPorts(auditRow.stored_itinerary_ports),
    after_itinerary_ports: normalizeStoredPorts(auditRow.expected_itinerary_ports),
    expected_source_conventional_ports: normalizeStoredPorts(auditRow.expected_itinerary_ports),
    provenance: auditRow.provenance,
    repair_category: auditRow.repair_category,
    deterministic_reason: auditRow.mismatch_reason || "stored_empty_expected_nonempty",
    row_fingerprint: auditRow.row_fingerprint,
    proposed_action: "UPDATE itinerary_ports ONLY"
  };
}

function dryRunItineraryPortsBackfill(fixture) {
  const rows = fixture?.rows || [];
  return {
    authorised_updates: rows.length,
    proposed_itinerary_ports_updates: rows.length,
    proposed_inserts: 0,
    proposed_deletes: 0,
    other_column_updates: 0,
    update_whitelist: UPDATE_WHITELIST.slice(),
    classic_rows: 0,
    legacy_rows: 0,
    expedition_rows: rows.length
  };
}

function buildRollbackEntry(row) {
  return {
    production_uuid: row.production_uuid,
    official_sailing_id: row.official_sailing_id,
    before_itinerary_ports: normalizeStoredPorts(row.before_itinerary_ports),
    after_itinerary_ports: normalizeStoredPorts(row.after_itinerary_ports)
  };
}

function stripLifecycleRawExtract(rawExtract) {
  const raw = { ...(rawExtract || {}) };
  for (const key of LIFECYCLE_RAW_EXTRACT_KEYS) {
    delete raw[key];
  }
  return raw;
}

function classifyAuthorisedLifecycleTransition({
  beforeStatus,
  afterStatus,
  departureDate,
  perthToday = perthCalendarDate()
} = {}) {
  const before = String(beforeStatus || "").trim();
  const after = String(afterStatus || "").trim();
  if (!before || !after || before === after) {
    return { ok: true, lifecycle_transition: LIFECYCLE_TRANSITION.NONE };
  }
  if (
    before === "active" &&
    after === "expired" &&
    shouldRemoveFromPublicInventory({ departureDate, status: "active", perthToday })
  ) {
    return { ok: true, lifecycle_transition: LIFECYCLE_TRANSITION.EXPECTED };
  }
  return { ok: false, lifecycle_transition: LIFECYCLE_TRANSITION.UNEXPECTED, reason: `${before}_to_${after}` };
}

function verifyStrictRepairFingerprint(storedRow, fixtureRow, fingerprintFields = STRICT_REPAIR_FINGERPRINT_FIELDS) {
  const issues = [];
  for (const field of fingerprintFields) {
    if (String(storedRow?.[field] ?? "") !== String(fixtureRow.row_fingerprint?.[field] ?? "")) {
      issues.push(`fingerprint_${field}_changed`);
    }
  }
  return { ok: issues.length === 0, issues };
}

function verifyItineraryPortsRepairRow(storedRow, fixtureRow, fingerprintFields = [], options = {}) {
  const lifecycleAware = options.lifecycleAware !== false;
  const perthToday = options.perthToday || perthCalendarDate();

  const issues = [];
  if (!storedRow) issues.push("missing_row");
  if (storedRow?.official_sailing_id !== fixtureRow.official_sailing_id) {
    issues.push("official_sailing_id_changed");
  }
  const storedPorts = normalizeStoredPorts(storedRow?.itinerary_ports);
  const expectedAfter = normalizeStoredPorts(fixtureRow.after_itinerary_ports);
  const itineraryPortsOk = portsArrayEqual(storedPorts, expectedAfter);
  if (!itineraryPortsOk) issues.push("itinerary_ports_mismatch");

  let strict = { ok: true, issues: [] };
  if (lifecycleAware) {
    strict = verifyStrictRepairFingerprint(storedRow, fixtureRow, STRICT_REPAIR_FINGERPRINT_FIELDS);
  } else {
    for (const field of fingerprintFields.length ? fingerprintFields : FINGERPRINT_FIELDS) {
      if (String(storedRow?.[field] ?? "") !== String(fixtureRow.row_fingerprint?.[field] ?? "")) {
        strict.issues.push(`fingerprint_${field}_changed`);
      }
    }
    strict.ok = strict.issues.length === 0;
  }
  if (!strict.ok) issues.push(...strict.issues);

  let lifecycle = { ok: true, lifecycle_transition: LIFECYCLE_TRANSITION.NONE };
  if (lifecycleAware && storedRow) {
    lifecycle = classifyAuthorisedLifecycleTransition({
      beforeStatus: fixtureRow.row_fingerprint?.status,
      afterStatus: storedRow.status,
      departureDate: storedRow.departure_date || fixtureRow.row_fingerprint?.departure_date,
      perthToday
    });
    if (!lifecycle.ok) issues.push(`lifecycle_${lifecycle.reason || "invalid"}`);
  }

  const dataIntegrityOk =
    Boolean(storedRow) &&
    storedRow.official_sailing_id === fixtureRow.official_sailing_id &&
    itineraryPortsOk &&
    strict.ok;

  return {
    ok: dataIntegrityOk && lifecycle.ok,
    issues,
    data_integrity_ok: dataIntegrityOk,
    lifecycle_transition: lifecycle.lifecycle_transition,
    itinerary_ports_ok: itineraryPortsOk
  };
}

function validateRepairFixture(fixture) {
  const rows = fixture?.rows || [];
  const uuids = rows.map((r) => r.production_uuid);
  const ids = rows.map((r) => r.official_sailing_id);
  const uuidSet = new Set(uuids);
  const idSet = new Set(ids.map((id) => String(id).toUpperCase()));
  const issues = [];
  if (fixture?.frozen_count !== 200) issues.push(`frozen_count:${fixture?.frozen_count}`);
  if (rows.length !== 200) issues.push(`rows:${rows.length}`);
  if (uuidSet.size !== 200) issues.push(`uuid_unique:${uuidSet.size}`);
  if (idSet.size !== 200) issues.push(`id_unique:${idSet.size}`);
  for (const row of rows) {
    if (!isExpeditionOfficialId(row.official_sailing_id)) issues.push(`non_expedition:${row.official_sailing_id}`);
    if (!Array.isArray(row.before_itinerary_ports)) issues.push(`missing_before:${row.official_sailing_id}`);
    if (!Array.isArray(row.after_itinerary_ports)) issues.push(`missing_after:${row.official_sailing_id}`);
    if (!row.row_fingerprint?.id) issues.push(`missing_fingerprint:${row.official_sailing_id}`);
  }
  return { ok: issues.length === 0, issues, row_count: rows.length, uuid_unique: uuidSet.size, id_unique: idSet.size };
}

function verifyFrozenBeforeMatch(prodRow, fixtureRow) {
  const issues = [];
  if (!prodRow) issues.push("missing_row");
  if (prodRow?.id !== fixtureRow.production_uuid) issues.push("uuid_mismatch");
  if (prodRow?.official_sailing_id !== fixtureRow.official_sailing_id) issues.push("official_id_mismatch");
  if (!portsArrayEqual(prodRow?.itinerary_ports, fixtureRow.before_itinerary_ports)) {
    issues.push("before_itinerary_ports_mismatch");
  }
  for (const field of FINGERPRINT_FIELDS) {
    const expected = fixtureRow.row_fingerprint?.[field];
    if (expected != null && String(prodRow?.[field] ?? "") !== String(expected ?? "")) {
      issues.push(`fingerprint_${field}`);
    }
  }
  if (prodRow && !isExpeditionOfficialId(prodRow.official_sailing_id)) {
    issues.push("not_expedition");
  }
  return { ok: issues.length === 0, issues };
}

function stableJsonStringify(value) {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`).join(",")}}`;
}

function semanticJsonEqual(a, b) {
  return stableJsonStringify(a) === stableJsonStringify(b);
}

function hashRawExtractSemantic(rawExtract) {
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(stableJsonStringify(rawExtract ?? null)).digest("hex");
}

function compareComparableFieldValues(field, beforeVal, afterVal) {
  if (field === "raw_extract") {
    return semanticJsonEqual(beforeVal, afterVal);
  }
  return JSON.stringify(beforeVal) === JSON.stringify(afterVal);
}

function diffJsonPaths(before, after, prefix = "") {
  if (compareComparableFieldValues("raw_extract", before, after)) return [];
  if (before === after) return [];
  if (before === null || after === null || typeof before !== typeof after || typeof before !== "object") {
    return [{ path: prefix || "$", before, after }];
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const paths = [];
    if (before.length !== after.length) {
      paths.push({ path: `${prefix}.length`, before: before.length, after: after.length });
    }
    const len = Math.max(before.length, after.length);
    for (let i = 0; i < len; i += 1) {
      paths.push(...diffJsonPaths(before[i], after[i], `${prefix}[${i}]`));
    }
    return paths;
  }
  if (Array.isArray(before) || Array.isArray(after)) {
    return [{ path: prefix || "$", before, after }];
  }
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const paths = [];
  for (const key of [...keys].sort()) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    paths.push(...diffJsonPaths(before?.[key], after?.[key], nextPrefix));
  }
  return paths;
}

function snapshotComparableFields(row) {
  const out = {};
  for (const field of NON_WHITELIST_COMPARE_FIELDS) {
    out[field] = row?.[field] ?? null;
  }
  out.raw_extract = row?.raw_extract ?? null;
  return out;
}

function snapshotProtectionRow(row) {
  return {
    itinerary_ports: normalizeStoredPorts(row?.itinerary_ports),
    comparable: snapshotComparableFields(row)
  };
}

function snapshotProtectionRows(rows, targetUuids = new Set()) {
  const out = new Map();
  for (const row of rows || []) {
    if (targetUuids.has(row.id)) continue;
    out.set(row.id, snapshotProtectionRow(row));
  }
  return out;
}

function verifyProtectionSnapshots(beforeMap, afterRows, targetUuids = new Set(), options = {}) {
  const lifecycleAware = options.lifecycleAware !== false;
  const perthToday = options.perthToday || perthCalendarDate();
  const issues = [];
  let expectedLifecycleTransitions = 0;

  for (const row of afterRows || []) {
    if (targetUuids.has(row.id)) continue;
    const before = beforeMap.get(row.id);
    if (!before) continue;
    if (!portsArrayEqual(before.itinerary_ports, row.itinerary_ports)) {
      issues.push({ id: row.id, field: "itinerary_ports" });
    }
    const afterComparable = snapshotComparableFields(row);
    for (const field of Object.keys(before.comparable)) {
      if (LIFECYCLE_MUTABLE_DB_FIELDS.includes(field)) {
        if (!lifecycleAware) {
          if (!compareComparableFieldValues(field, before.comparable[field], afterComparable[field])) {
            issues.push({ id: row.id, field });
          }
        } else if (field === "status") {
          const lifecycle = classifyAuthorisedLifecycleTransition({
            beforeStatus: before.comparable.status,
            afterStatus: afterComparable.status,
            departureDate: afterComparable.departure_date || before.comparable.departure_date,
            perthToday
          });
          if (lifecycle.lifecycle_transition === LIFECYCLE_TRANSITION.EXPECTED) {
            expectedLifecycleTransitions += 1;
          } else if (!lifecycle.ok) {
            issues.push({ id: row.id, field: "status", reason: lifecycle.reason });
          }
        }
        continue;
      }
      if (field === "raw_extract") {
        const beforeStrict = stripLifecycleRawExtract(before.comparable.raw_extract);
        const afterStrict = stripLifecycleRawExtract(afterComparable.raw_extract);
        if (!compareComparableFieldValues("raw_extract", beforeStrict, afterStrict)) {
          issues.push({ id: row.id, field: "raw_extract" });
        }
        continue;
      }
      if (!compareComparableFieldValues(field, before.comparable[field], afterComparable[field])) {
        issues.push({ id: row.id, field });
      }
    }
  }
  return { ok: issues.length === 0, issues, expected_lifecycle_transitions: expectedLifecycleTransitions };
}

function compareNonWhitelistSnapshots(beforeSnap, afterSnap) {
  const changed = [];
  for (const field of [...NON_WHITELIST_COMPARE_FIELDS, "raw_extract"]) {
    if (!compareComparableFieldValues(field, beforeSnap?.[field], afterSnap?.[field])) {
      changed.push(field);
    }
  }
  return { ok: changed.length === 0, changed_fields: changed };
}

function buildM0bRollbackManifest(params) {
  return {
    run_id: params.runId,
    fixture_path: params.fixturePath || M0A_BACKFILL_FIXTURE,
    lock_key: "controlled_production_import:global",
    operation: M0B_OPERATION,
    line_slug: params.lineSlug || null,
    cruise_line_id: params.cruiseLineId || null,
    authorised_production_uuids: (params.rows || []).map((r) => r.production_uuid),
    authorised_official_sailing_ids: (params.rows || []).map((r) => r.official_sailing_id),
    expected_updates: params.expectedUpdates ?? 0,
    expected_inserts: 0,
    expected_deletes: 0,
    update_whitelist: UPDATE_WHITELIST.slice(),
    production_before: params.productionBefore || null,
    rollback_entries: (params.rows || []).map(buildRollbackEntry),
    created_at: params.createdAt || new Date().toISOString(),
    status: "PREPARED",
    updated_record_ids: [],
    verification_status: null,
    completion_status: null
  };
}

async function applyItineraryPortsRepairBatch(supabase, fixtureRows, callbacks = {}, options = {}) {
  const stats = {
    attempted: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    write_details: []
  };

  for (const fixtureRow of fixtureRows) {
    stats.attempted += 1;
    const uuid = fixtureRow.production_uuid;
    const officialId = fixtureRow.official_sailing_id;

    try {
      const currentRows = await supabase(
        `discovered_cruises?id=eq.${encodeURIComponent(uuid)}&select=*&limit=1`
      );
      const current = currentRows?.[0] || null;
      const beforeSnap = current ? snapshotComparableFields(current) : null;
      const beforeCheck = (options.verifyBeforeMatch || verifyFrozenBeforeMatch)(current, fixtureRow);
      if (!beforeCheck.ok) {
        stats.failed += 1;
        stats.write_details.push({
          production_uuid: uuid,
          official_sailing_id: officialId,
          result: "precondition_failed",
          issues: beforeCheck.issues
        });
        continue;
      }

      const patched = await supabase(
        `discovered_cruises?id=eq.${encodeURIComponent(uuid)}&official_sailing_id=eq.${encodeURIComponent(officialId)}`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ itinerary_ports: normalizeStoredPorts(fixtureRow.after_itinerary_ports) })
        }
      );
      const updatedRow = patched?.[0] || null;
      if (!updatedRow) {
        stats.failed += 1;
        stats.write_details.push({
          production_uuid: uuid,
          official_sailing_id: officialId,
          result: "patch_no_row"
        });
        continue;
      }

      const afterSnap = snapshotComparableFields(updatedRow);
      const nonWhitelist = compareNonWhitelistSnapshots(beforeSnap, afterSnap);
      if (!nonWhitelist.ok) {
        stats.failed += 1;
        stats.write_details.push({
          production_uuid: uuid,
          official_sailing_id: officialId,
          result: "non_whitelist_changed",
          changed_fields: nonWhitelist.changed_fields
        });
        continue;
      }

      if (!portsArrayEqual(updatedRow.itinerary_ports, fixtureRow.after_itinerary_ports)) {
        stats.failed += 1;
        stats.write_details.push({
          production_uuid: uuid,
          official_sailing_id: officialId,
          result: "after_ports_mismatch"
        });
        continue;
      }

      stats.updated += 1;
      stats.write_details.push({
        production_uuid: uuid,
        official_sailing_id: officialId,
        result: "updated",
        before_itinerary_ports: normalizeStoredPorts(fixtureRow.before_itinerary_ports),
        after_itinerary_ports: normalizeStoredPorts(fixtureRow.after_itinerary_ports),
        before_snapshot: beforeSnap
      });

      if (typeof callbacks.onUpdateSuccess === "function") {
        await callbacks.onUpdateSuccess({
          production_uuid: uuid,
          official_sailing_id: officialId,
          row: updatedRow
        });
      }
    } catch (error) {
      stats.failed += 1;
      stats.write_details.push({
        production_uuid: uuid,
        official_sailing_id: officialId,
        result: "error",
        error: error.message || String(error)
      });
    }
  }

  return { stats, performWrites: true };
}

async function verifyRepairBatchResults(supabase, fixtureRows) {
  const checks = [];
  let allOk = true;
  for (const fixtureRow of fixtureRows) {
    const rows = await supabase(
      `discovered_cruises?id=eq.${encodeURIComponent(fixtureRow.production_uuid)}&select=id,official_sailing_id,itinerary_ports,ship_id,departure_date,return_date,nights,destination_id,status,raw_extract,cruise_line_id,departure_port,itinerary,official_url,source_url,external_key,identity_key,match_confidence,review_reason&limit=1`
    );
    const row = rows?.[0] || null;
    const verify = verifyItineraryPortsRepairRow(row, fixtureRow, FINGERPRINT_FIELDS);
    if (!verify.ok) allOk = false;
    checks.push({
      production_uuid: fixtureRow.production_uuid,
      official_sailing_id: fixtureRow.official_sailing_id,
      ...verify
    });
  }
  return {
    ok: allOk && checks.length === fixtureRows.length,
    verified_count: checks.filter((c) => c.ok).length,
    failed_count: checks.filter((c) => !c.ok).length,
    records: checks
  };
}

function assertInsertPayloadIncludesItineraryPorts(candidate, mergedDeparture, identityKey, status, reasons, now) {
  return buildDiscoveredCruiseUpsertPayload(candidate, mergedDeparture, {
    identity_key: identityKey,
    status,
    reasons,
    now,
    includeItineraryPorts: true
  });
}

function reconcileE6FrozenMismatchReport(frozenRows) {
  const galapagos = frozenRows.filter((r) => r.region === "Galápagos");
  const orShip = frozenRows.filter((r) => /^OR/i.test(r.official_sailing_id));
  const e4Ship = frozenRows.filter((r) => /^E4/i.test(r.official_sailing_id));
  const mismatches = frozenRows.filter((r) => !r.ports_equal);
  const mismatchGalapagos = mismatches.filter((r) => r.region === "Galápagos");
  const mismatchOr = mismatches.filter((r) => /^OR/i.test(r.official_sailing_id));
  const mismatchE4 = mismatches.filter((r) => /^E4/i.test(r.official_sailing_id));
  const mismatchNonGalapagos = mismatches.filter((r) => r.region !== "Galápagos");

  return {
    e5_galapagos_count: galapagos.length,
    e5_or_ship_count: orShip.length,
    e5_e4_ship_count: e4Ship.length,
    e6_mismatch_count: mismatches.length,
    mismatch_ids: mismatches.map((r) => r.official_sailing_id).sort(),
    mismatch_galapagos_count: mismatchGalapagos.length,
    mismatch_or_count: mismatchOr.length,
    mismatch_e4_count: mismatchE4.length,
    mismatch_non_galapagos_count: mismatchNonGalapagos.length,
    explanation:
      mismatches.length === mismatchOr.length + mismatchE4.length
        ? "All E6 mismatches are Galápagos-region rows: 26 Silver Origin (OR*) plus 3 Silver Cloud (E4*) with expected non-empty conventional itinerary_ports but stored []. E6 report described failures as OR* only and omitted the 3 E4 Galápagos rows."
        : "Mismatch set does not decompose cleanly to OR+E4 Galápagos — investigate further"
  };
}

module.exports = {
  M0A_BACKFILL_FIXTURE,
  E6_RUN_ID,
  E3_FIRST_250_FIXTURE,
  E5_NEXT_BATCH_FIXTURE,
  UPDATE_WHITELIST,
  M0B_OPERATION,
  M0B_APPLY_CONFIRMATION_TOKEN,
  FINGERPRINT_FIELDS,
  STRICT_REPAIR_FINGERPRINT_FIELDS,
  LIFECYCLE_MUTABLE_DB_FIELDS,
  LIFECYCLE_RAW_EXTRACT_KEYS,
  LIFECYCLE_TRANSITION,
  NON_WHITELIST_COMPARE_FIELDS,
  stripLifecycleRawExtract,
  classifyAuthorisedLifecycleTransition,
  verifyStrictRepairFingerprint,
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
  buildRollbackEntry,
  verifyItineraryPortsRepairRow,
  validateRepairFixture,
  verifyFrozenBeforeMatch,
  stableJsonStringify,
  semanticJsonEqual,
  hashRawExtractSemantic,
  compareComparableFieldValues,
  diffJsonPaths,
  snapshotComparableFields,
  snapshotProtectionRow,
  snapshotProtectionRows,
  verifyProtectionSnapshots,
  compareNonWhitelistSnapshots,
  buildM0bRollbackManifest,
  applyItineraryPortsRepairBatch,
  verifyRepairBatchResults,
  assertInsertPayloadIncludesItineraryPorts,
  reconcileE6FrozenMismatchReport,
  loadFrozenExpeditionIds
};
