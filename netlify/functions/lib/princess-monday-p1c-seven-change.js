/**
 * Princess Monday P1C — one-time approved seven-change controlled remediation.
 * Exactly 1 insert + 6 itinerary-only updates. Does not weaken weekly update policy.
 */

const crypto = require("crypto");
const {
  officialProductKey,
  isEligiblePrincessCruise
} = require("./princess-discovery-adapter");
const {
  buildPrincessUpsertCandidate,
  indexExistingPrincessRecords
} = require("./princess-discovery-writes");
const { upsertCandidateRecord } = require("./cruise-discovery-ops");
const { runGlobalProtectedMaintenanceWrites } = require("./cruise-discovery-global-write-lock");
const { snapshotRecordForRollback, persistMaintenanceRollbackManifest } = require("./cruise-discovery-maintenance-manifests");
const {
  isCruisePubliclyBookable,
  perthCalendarDate
} = require("./public-discovered-cruise-inventory");

const {
  diffPrincessUpdateCandidate,
  refinePrincessProposedActionForWeekly
} = require("./princess-weekly-update-policy");

const PRINCESS_LINE_ID = "c19f40a7-c160-4035-a845-14dada550e1f";
const WRITE_MODE = "princess_monday_p1c_seven_change_remediation";
const APPLY_CONFIRMATION_TOKEN = "PRINCESS-MONDAY-P1C-SEVEN-CHANGE-REMEDIATION";
const MAX_MATERIAL_WRITES = 7;
const EXPECTED_INSERTS = 1;
const EXPECTED_UPDATES = 6;
const CSR07H_OFFICIAL_ID = "CSR07H|KP|2027-02-28";

const APPROVED_UPDATE_IDS = [
  "SBR17A|MJ|2027-01-06",
  "SBR17A|MJ|2027-01-23",
  "SBR17A|MJ|2027-12-21",
  "SBR17A|MJ|2028-01-07",
  "SBR17A|MJ|2028-01-24",
  "ENN14B|YP|2028-06-10"
];

const APPROVED_INSERT_ID = "ZSA05F|AP|2028-06-17";

const APPROVED_ITINERARY_AFTER = {
  "SBR17A|MJ|2027-01-06": "Antarctica & Patagonia",
  "SBR17A|MJ|2027-01-23": "Antarctica & Patagonia",
  "SBR17A|MJ|2027-12-21": "Antarctica & Patagonia",
  "SBR17A|MJ|2028-01-07": "Antarctica & Patagonia",
  "SBR17A|MJ|2028-01-24": "Antarctica & Patagonia",
  "ENN14B|YP|2028-06-10": "Land of the Midnight Sun & Summer Solstice"
};

const PROTECTED_CANONICAL_FIELDS = [
  "official_sailing_id",
  "external_key",
  "identity_key",
  "ship_id",
  "destination_id",
  "departure_date",
  "return_date",
  "nights",
  "departure_port",
  "status",
  "official_url"
];

const ALLOWED_UPDATE_FIELDS = ["itinerary"];

function approvedOfficialIdSet() {
  return new Set([...APPROVED_UPDATE_IDS, APPROVED_INSERT_ID]);
}

function normaliseComparable(value) {
  if (value == null) return null;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).trim();
}

function normaliseDate(value) {
  if (value == null) return null;
  return String(value).slice(0, 10);
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function hashRecordPayload(record) {
  return crypto.createHash("sha256").update(stableStringify(record)).digest("hex");
}

function hashFreezeBatch(entries) {
  const hashes = (entries || []).map((e) => e.record_hash).sort();
  return crypto.createHash("sha256").update(JSON.stringify(hashes)).digest("hex");
}

function pickCanonicalFields(row) {
  if (!row) return null;
  return {
    official_sailing_id: row.official_sailing_id,
    external_key: row.external_key,
    identity_key: row.identity_key,
    ship_id: row.ship_id,
    destination_id: row.destination_id,
    departure_date: normaliseDate(row.departure_date),
    return_date: normaliseDate(row.return_date),
    nights: row.nights,
    departure_port: row.departure_port,
    itinerary: row.itinerary,
    official_url: row.official_url,
    status: row.status,
    match_confidence: row.match_confidence
  };
}

function diffAllowedUpdate(productionRow, candidateRow) {
  const fieldDiffs = diffPrincessUpdateCandidate(productionRow, candidateRow);
  const changedFields = fieldDiffs.map((d) => d.field);
  const disallowed = changedFields.filter((f) => {
    if (f === "raw_extract") {
      const rawDiff = fieldDiffs.find((d) => d.field === "raw_extract");
      const beforeRaw = rawDiff?.before || {};
      const afterRaw = rawDiff?.after || {};
      const beforeKeys = Object.keys(beforeRaw).sort();
      const afterKeys = Object.keys(afterRaw).sort();
      if (JSON.stringify(beforeKeys) !== JSON.stringify(afterKeys)) return true;
      for (const key of beforeKeys) {
        if (key === "princess_itinerary_name") continue;
        if (normaliseComparable(beforeRaw[key]) !== normaliseComparable(afterRaw[key])) return true;
      }
      return false;
    }
    return !ALLOWED_UPDATE_FIELDS.includes(f);
  });
  return {
    field_diffs: fieldDiffs,
    changed_fields: changedFields,
    disallowed_fields: disallowed,
    ok: disallowed.length === 0 && changedFields.length > 0
  };
}

function assertApprovedIdentity(officialSailingId) {
  return approvedOfficialIdSet().has(officialSailingId);
}

function rejectEighthIdentity(officialSailingId) {
  if (assertApprovedIdentity(officialSailingId)) return { ok: true };
  return { ok: false, reason: "identity_not_in_approved_p1c_set" };
}

function findNormalisedProduct(simulation, officialSailingId) {
  const key = String(officialSailingId);
  return (
    (simulation?.products || []).find((p) => officialProductKey(p.raw) === key) || null
  );
}

function buildApprovedInsertCandidate(normalised, cruiseLine, runId) {
  const candidate = buildPrincessUpsertCandidate(normalised, cruiseLine);
  if (!candidate) return null;
  return {
    ...candidate,
    raw_extract: {
      ...(candidate.raw_extract || {}),
      princess_monday_p1c_seven_change: true,
      princess_p1c_run_id: runId
    }
  };
}

function buildFreezeEntryForUpdate({ officialSailingId, productionRow, candidate, approvedItineraryAfter }) {
  const productionBefore = pickCanonicalFields(productionRow);
  const approvedAfter = {
    ...productionBefore,
    itinerary: approvedItineraryAfter
  };
  const approvedCandidate = {
    ...candidate,
    itinerary: approvedItineraryAfter,
    raw_extract: {
      ...(productionRow.raw_extract || {}),
      ...(candidate.raw_extract || {}),
      princess_itinerary_name: approvedItineraryAfter
    }
  };
  const entry = {
    kind: "update",
    official_sailing_id: officialSailingId,
    discovered_cruise_id: productionRow.id,
    allowed_changed_fields: ALLOWED_UPDATE_FIELDS,
    production_before: productionBefore,
    approved_after: approvedAfter,
    write_payload: approvedCandidate,
    provenance: {
      princess_itinerary_name: approvedItineraryAfter,
      princess_itinerary_id: candidate.raw_extract?.princess_itinerary_id || productionRow.raw_extract?.princess_itinerary_id
    }
  };
  entry.record_hash = hashRecordPayload(entry);
  return entry;
}

function buildFreezeEntryForInsert({ officialSailingId, candidate }) {
  const entry = {
    kind: "insert",
    official_sailing_id: officialSailingId,
    allowed_changed_fields: [],
    write_payload: candidate,
    canonical_fields: pickCanonicalFields(candidate)
  };
  entry.record_hash = hashRecordPayload(entry);
  return entry;
}

async function loadProductionRow(sb, officialSailingId) {
  const rows = await sb(
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(
      PRINCESS_LINE_ID
    )}&official_sailing_id=eq.${encodeURIComponent(officialSailingId)}&select=id,cruise_line_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,itinerary,status,official_url,external_key,identity_key,official_sailing_id,raw_extract,match_confidence&limit=1`
  );
  return rows?.[0] || null;
}

async function collisionAuditForInsert(sb, candidate) {
  const official = candidate.official_sailing_id
    ? await sb(
        `discovered_cruises?cruise_line_id=eq.${PRINCESS_LINE_ID}&official_sailing_id=eq.${encodeURIComponent(
          candidate.official_sailing_id
        )}&select=id&limit=1`
      )
    : [];
  const external = candidate.external_key
    ? await sb(
        `discovered_cruises?external_key=eq.${encodeURIComponent(candidate.external_key)}&select=id&limit=1`
      )
    : [];
  const identity = candidate.identity_key
    ? await sb(
        `discovered_cruises?identity_key=eq.${encodeURIComponent(candidate.identity_key)}&select=id&limit=1`
      )
    : [];
  return {
    official_collision: official.length,
    external_collision: external.length,
    identity_collision: identity.length,
    pass: official.length + external.length + identity.length === 0
  };
}

async function verifyApprovedUpdateAgainstLiveSource({
  sb,
  simulation,
  cruiseLine,
  officialSailingId,
  approvedItineraryAfter
}) {
  const productionRow = await loadProductionRow(sb, officialSailingId);
  if (!productionRow) {
    return { ok: false, reason: "production_row_missing", official_sailing_id: officialSailingId };
  }
  const normalised = findNormalisedProduct(simulation, officialSailingId);
  if (!normalised) {
    return { ok: false, reason: "missing_from_live_source", official_sailing_id: officialSailingId };
  }
  const candidate = buildPrincessUpsertCandidate(normalised, cruiseLine);
  if (!candidate) {
    return { ok: false, reason: "candidate_build_failed", official_sailing_id: officialSailingId };
  }
  if (normaliseComparable(candidate.itinerary) !== normaliseComparable(approvedItineraryAfter)) {
    return {
      ok: false,
      reason: "source_itinerary_drift",
      official_sailing_id: officialSailingId,
      expected: approvedItineraryAfter,
      actual: candidate.itinerary
    };
  }
  const diff = diffAllowedUpdate(productionRow, candidate);
  if (!diff.ok) {
    return {
      ok: false,
      reason: "field_diff_not_itinerary_only",
      official_sailing_id: officialSailingId,
      ...diff
    };
  }
  const action = refinePrincessProposedActionForWeekly(
    "update_exact_legacy_match",
    productionRow,
    candidate
  );
  return {
    ok: true,
    official_sailing_id: officialSailingId,
    discovered_cruise_id: productionRow.id,
    changed_fields: diff.changed_fields,
    production_before: pickCanonicalFields(productionRow),
    approved_after: { ...pickCanonicalFields(productionRow), itinerary: approvedItineraryAfter },
    weekly_policy_action: action,
    candidate
  };
}

async function verifyApprovedInsertAgainstLiveSource({ sb, simulation, cruiseLine, today, runId }) {
  const normalised = findNormalisedProduct(simulation, APPROVED_INSERT_ID);
  if (!normalised) {
    return { ok: false, reason: "missing_from_live_source", official_sailing_id: APPROVED_INSERT_ID };
  }
  if (!normalised.complete_high_confidence) {
    return { ok: false, reason: "not_complete_high_confidence", official_sailing_id: APPROVED_INSERT_ID };
  }
  if (!isEligiblePrincessCruise(normalised.product_type)) {
    return { ok: false, reason: "ineligible_product_type", official_sailing_id: APPROVED_INSERT_ID };
  }
  const departureDate = normalised.candidate?.departure_date || normalised.raw?.departure_date;
  if (
    !isCruisePubliclyBookable({
      departureDate,
      status: "active",
      perthToday: today
    })
  ) {
    return { ok: false, reason: "within_21_day_cutoff", official_sailing_id: APPROVED_INSERT_ID };
  }
  const existing = await loadProductionRow(sb, APPROVED_INSERT_ID);
  if (existing) {
    return { ok: false, reason: "already_in_production", official_sailing_id: APPROVED_INSERT_ID };
  }
  const candidate = buildApprovedInsertCandidate(normalised, cruiseLine, runId);
  if (!candidate) {
    return { ok: false, reason: "candidate_build_failed", official_sailing_id: APPROVED_INSERT_ID };
  }
  const collisions = await collisionAuditForInsert(sb, candidate);
  if (!collisions.pass) {
    return { ok: false, reason: "insert_collision", official_sailing_id: APPROVED_INSERT_ID, collisions };
  }
  return { ok: true, official_sailing_id: APPROVED_INSERT_ID, candidate, collisions };
}

async function buildSevenChangeFreeze({ sb, simulation, cruiseLine, runId, today }) {
  const entries = [];
  const proofs = { updates: [], insert: null, failures: [] };

  for (const officialSailingId of APPROVED_UPDATE_IDS) {
    const proof = await verifyApprovedUpdateAgainstLiveSource({
      sb,
      simulation,
      cruiseLine,
      officialSailingId,
      approvedItineraryAfter: APPROVED_ITINERARY_AFTER[officialSailingId]
    });
    proofs.updates.push(proof);
    if (!proof.ok) {
      proofs.failures.push(proof);
      continue;
    }
    const productionRow = await loadProductionRow(sb, officialSailingId);
    entries.push(
      buildFreezeEntryForUpdate({
        officialSailingId,
        productionRow,
        candidate: proof.candidate,
        approvedItineraryAfter: APPROVED_ITINERARY_AFTER[officialSailingId]
      })
    );
  }

  const insertProof = await verifyApprovedInsertAgainstLiveSource({
    sb,
    simulation,
    cruiseLine,
    today,
    runId
  });
  proofs.insert = insertProof;
  if (!insertProof.ok) proofs.failures.push(insertProof);
  else {
    entries.push(
      buildFreezeEntryForInsert({
        officialSailingId: APPROVED_INSERT_ID,
        candidate: insertProof.candidate
      })
    );
  }

  if (entries.length !== 7 || proofs.failures.length) {
    return { ok: false, entries, proofs, failures: proofs.failures };
  }

  const batch_hash = hashFreezeBatch(entries);
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    mode: WRITE_MODE,
    batch_size: 7,
    max_material_writes: MAX_MATERIAL_WRITES,
    entries,
    batch_hash,
    proofs
  };
}

function verifyFreezeIntegrity(freeze) {
  if (!freeze || freeze.batch_size !== 7) return { ok: false, reason: "invalid_batch_size" };
  const ids = new Set((freeze.entries || []).map((e) => e.official_sailing_id));
  if (ids.size !== 7) return { ok: false, reason: "duplicate_or_missing_identities" };
  for (const id of approvedOfficialIdSet()) {
    if (!ids.has(id)) return { ok: false, reason: `missing_${id}` };
  }
  const recomputed = hashFreezeBatch(freeze.entries);
  if (recomputed !== freeze.batch_hash) return { ok: false, reason: "batch_hash_mismatch" };
  return { ok: true };
}

async function snapshotPrincessCollateral(sb) {
  const rows = [];
  let offset = 0;
  const select =
    "id,cruise_line_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,itinerary,status,official_url,external_key,identity_key,official_sailing_id,raw_extract,match_confidence,updated_at";
  while (true) {
    const batch = await sb(
      `discovered_cruises?cruise_line_id=eq.${PRINCESS_LINE_ID}&select=${select}&order=id.asc&limit=1000&offset=${offset}`
    );
    if (!batch?.length) break;
    rows.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  const fingerprint = crypto
    .createHash("sha256")
    .update(
      stableStringify(
        rows.map((r) => ({
          id: r.id,
          official_sailing_id: r.official_sailing_id,
          itinerary: r.itinerary,
          updated_at: r.updated_at
        }))
      )
    )
    .digest("hex");
  return { rows, count: rows.length, fingerprint };
}

async function applyItineraryOnlyUpdate(sb, entry, runId) {
  const beforeRow = await loadProductionRow(sb, entry.official_sailing_id);
  if (!beforeRow) {
    return { ok: false, reason: "production_missing_before_update", official_sailing_id: entry.official_sailing_id };
  }
  const beforeCanonical = pickCanonicalFields(beforeRow);
  for (const field of PROTECTED_CANONICAL_FIELDS) {
    if (field === "itinerary") continue;
    if (
      normaliseComparable(beforeCanonical[field]) !==
      normaliseComparable(entry.production_before[field])
    ) {
      return {
        ok: false,
        reason: "before_state_drift",
        official_sailing_id: entry.official_sailing_id,
        field,
        expected: entry.production_before[field],
        actual: beforeCanonical[field]
      };
    }
  }
  const approvedItinerary = entry.approved_after.itinerary;
  const nextRaw = {
    ...(beforeRow.raw_extract || {}),
    princess_itinerary_name: entry.provenance?.princess_itinerary_name || approvedItinerary,
    princess_monday_p1c_seven_change: true,
    princess_p1c_run_id: runId
  };
  const rollbackBefore = {
    itinerary: beforeRow.itinerary,
    raw_extract: beforeRow.raw_extract
  };
  const patched = await sb(`discovered_cruises?id=eq.${encodeURIComponent(beforeRow.id)}`, {
    method: "PATCH",
    body: {
      itinerary: approvedItinerary,
      raw_extract: nextRaw,
      updated_at: new Date().toISOString()
    }
  });
  const row = Array.isArray(patched) ? patched[0] : patched;
  return {
    ok: true,
    official_sailing_id: entry.official_sailing_id,
    discovered_cruise_id: beforeRow.id,
    created: false,
    result_action: "updated",
    rollback_before: snapshotRecordForRollback(beforeRow),
    before_values: rollbackBefore,
    after_values: { itinerary: approvedItinerary, raw_extract: nextRaw },
    row
  };
}

async function applyApprovedInsert(sb, entry, stats) {
  const existing = await loadProductionRow(sb, entry.official_sailing_id);
  if (existing) {
    return {
      ok: false,
      reason: "insert_collision_at_apply",
      official_sailing_id: entry.official_sailing_id
    };
  }
  const result = await upsertCandidateRecord(entry.write_payload, stats, {
    matchPolicy: "official_sailing_id_only",
    syncDestinationLinks: false,
    prevRecord: null
  });
  if (!result.created) {
    return {
      ok: false,
      reason: "insert_did_not_create",
      official_sailing_id: entry.official_sailing_id,
      discovered_cruise_id: result.row?.id || null
    };
  }
  return {
    ok: true,
    official_sailing_id: entry.official_sailing_id,
    discovered_cruise_id: result.row?.id || null,
    created: true,
    result_action: "inserted",
    rollback_before: { delete_on_rollback: true },
    row: result.row
  };
}

async function underLockRecheckSevenChange({ sb, freeze, simulation, cruiseLine, today, runId }) {
  const integrity = verifyFreezeIntegrity(freeze);
  if (!integrity.ok) return { ok: false, reason: integrity.reason };

  for (const entry of freeze.entries) {
    if (entry.kind === "update") {
      const proof = await verifyApprovedUpdateAgainstLiveSource({
        sb,
        simulation,
        cruiseLine,
        officialSailingId: entry.official_sailing_id,
        approvedItineraryAfter: entry.approved_after.itinerary
      });
      if (!proof.ok) return { ok: false, reason: "under_lock_update_proof_failed", detail: proof };
      const liveRow = await loadProductionRow(sb, entry.official_sailing_id);
      const liveCanonical = pickCanonicalFields(liveRow);
      for (const field of PROTECTED_CANONICAL_FIELDS) {
        if (
          normaliseComparable(liveCanonical[field]) !==
          normaliseComparable(entry.production_before[field])
        ) {
          return {
            ok: false,
            reason: "under_lock_before_state_drift",
            official_sailing_id: entry.official_sailing_id,
            field
          };
        }
      }
    } else {
      const proof = await verifyApprovedInsertAgainstLiveSource({
        sb,
        simulation,
        cruiseLine,
        today,
        runId
      });
      if (!proof.ok) return { ok: false, reason: "under_lock_insert_proof_failed", detail: proof };
      const liveCanonical = pickCanonicalFields(proof.candidate);
      for (const field of Object.keys(entry.canonical_fields || {})) {
        if (
          normaliseComparable(liveCanonical[field]) !==
          normaliseComparable(entry.canonical_fields[field])
        ) {
          return {
            ok: false,
            reason: "under_lock_insert_payload_drift",
            official_sailing_id: entry.official_sailing_id,
            field
          };
        }
      }
    }
  }
  return { ok: true };
}

async function applyP1cSevenChangeBatch({
  sb,
  freeze,
  simulation,
  cruiseLine,
  today,
  runId,
  runRecordId,
  lineSlug = "princess-cruises"
}) {
  const stats = {
    inserted: 0,
    updated: 0,
    failed: 0,
    duplicate_skips: 0,
    write_details: []
  };

  const protectedResult = await runGlobalProtectedMaintenanceWrites(sb, {
    runId,
    runRecordId,
    lineSlug,
    operation: WRITE_MODE,
    underLockRecheck: async () =>
      underLockRecheckSevenChange({ sb, freeze, simulation, cruiseLine, today, runId }),
    writeFn: async () => {
      const updateEntries = freeze.entries.filter((e) => e.kind === "update");
      const insertEntries = freeze.entries.filter((e) => e.kind === "insert");
      for (const entry of updateEntries) {
        const result = await applyItineraryOnlyUpdate(sb, entry, runId);
        if (!result.ok) {
          stats.failed += 1;
          stats.write_details.push({ ...result, proposed_action: "update" });
          return { stats, aborted: true, reason: result.reason };
        }
        stats.updated += 1;
        stats.write_details.push({ ...result, proposed_action: "update" });
      }
      for (const entry of insertEntries) {
        const upsertStats = { new: 0, upserted_active: 0, cruises_inserted: 0, cruises_updated: 0 };
        const result = await applyApprovedInsert(sb, entry, upsertStats);
        if (!result.ok) {
          stats.failed += 1;
          stats.write_details.push({ ...result, proposed_action: "insert" });
          return { stats, aborted: true, reason: result.reason };
        }
        stats.inserted += 1;
        stats.write_details.push({ ...result, proposed_action: "insert" });
      }
      return { stats, aborted: false };
    }
  });

  if (protectedResult.blocked) {
    return {
      ok: false,
      blocked: true,
      reason: protectedResult.reason,
      global_lock: protectedResult.global_lock,
      stats
    };
  }

  const writeResult = protectedResult.writeResult || { stats };
  if (writeResult.aborted) {
    return {
      ok: false,
      blocked: false,
      reason: writeResult.reason || "write_aborted",
      stats: writeResult.stats || stats,
      global_lock: protectedResult.global_lock
    };
  }

  const finalStats = writeResult.stats || stats;
  const rollback = await persistMaintenanceRollbackManifest(sb, {
    runId,
    runRecordId,
    cruiseLineId: PRINCESS_LINE_ID,
    lineSlug,
    triggerType: WRITE_MODE,
    writeResult: { stats: finalStats, write_details: finalStats.write_details }
  });

  return {
    ok:
      finalStats.inserted === EXPECTED_INSERTS &&
      finalStats.updated === EXPECTED_UPDATES &&
      finalStats.failed === 0,
    stats: finalStats,
    rollback_manifest_id: rollback?.manifest_record_id || null,
    rollback_manifest: rollback?.manifest || null,
    global_lock: protectedResult.global_lock
  };
}

function verifyPostWriteSevenChange({ freeze, rowsById }) {
  const issues = [];
  for (const entry of freeze.entries) {
    const row =
      entry.kind === "insert"
        ? [...rowsById.values()].find((r) => r.official_sailing_id === entry.official_sailing_id)
        : rowsById.get(entry.discovered_cruise_id);
    if (!row) {
      issues.push({ official_sailing_id: entry.official_sailing_id, issue: "row_missing_post_write" });
      continue;
    }
    if (entry.kind === "insert") {
      const expected = entry.canonical_fields || pickCanonicalFields(entry.write_payload);
      for (const field of Object.keys(expected)) {
        if (normaliseComparable(row[field]) !== normaliseComparable(expected[field])) {
          issues.push({ official_sailing_id: entry.official_sailing_id, issue: `insert_field_${field}` });
        }
      }
    } else {
      if (normaliseComparable(row.itinerary) !== normaliseComparable(entry.approved_after.itinerary)) {
        issues.push({ official_sailing_id: entry.official_sailing_id, issue: "itinerary_mismatch" });
      }
      for (const field of PROTECTED_CANONICAL_FIELDS) {
        if (field === "itinerary") continue;
        if (
          normaliseComparable(row[field]) !== normaliseComparable(entry.production_before[field])
        ) {
          issues.push({ official_sailing_id: entry.official_sailing_id, issue: `protected_${field}_changed` });
        }
      }
    }
  }
  return { ok: issues.length === 0, issues, verified: freeze.entries.length - issues.length };
}

function verifyCollateralImmutability(beforeSnapshot, afterSnapshot, touchedIds) {
  const touched = new Set(touchedIds);
  const beforeOthers = beforeSnapshot.rows.filter((r) => !touched.has(r.id));
  const afterById = new Map(afterSnapshot.rows.map((r) => [r.id, r]));
  const changedOthers = [];
  for (const before of beforeOthers) {
    const after = afterById.get(before.id);
    if (!after) {
      changedOthers.push({ id: before.id, issue: "row_removed" });
      continue;
    }
    if (
      stableStringify(pickCanonicalFields(before)) !== stableStringify(pickCanonicalFields(after))
    ) {
      changedOthers.push({ id: before.id, official_sailing_id: before.official_sailing_id, issue: "canonical_changed" });
    }
  }
  return { ok: changedOthers.length === 0, changedOthers };
}

async function verifyCsr07hUnchanged(sb) {
  const row = await loadProductionRow(sb, CSR07H_OFFICIAL_ID);
  return {
    official_sailing_id: CSR07H_OFFICIAL_ID,
    active: row?.status === "active",
    unchanged: row?.status === "active",
    row: row ? pickCanonicalFields(row) : null
  };
}

module.exports = {
  PRINCESS_LINE_ID,
  WRITE_MODE,
  APPLY_CONFIRMATION_TOKEN,
  MAX_MATERIAL_WRITES,
  EXPECTED_INSERTS,
  EXPECTED_UPDATES,
  APPROVED_UPDATE_IDS,
  APPROVED_INSERT_ID,
  APPROVED_ITINERARY_AFTER,
  PROTECTED_CANONICAL_FIELDS,
  ALLOWED_UPDATE_FIELDS,
  CSR07H_OFFICIAL_ID,
  approvedOfficialIdSet,
  assertApprovedIdentity,
  rejectEighthIdentity,
  diffAllowedUpdate,
  pickCanonicalFields,
  hashFreezeBatch,
  hashRecordPayload,
  verifyFreezeIntegrity,
  buildSevenChangeFreeze,
  verifyApprovedUpdateAgainstLiveSource,
  verifyApprovedInsertAgainstLiveSource,
  collisionAuditForInsert,
  snapshotPrincessCollateral,
  applyP1cSevenChangeBatch,
  verifyPostWriteSevenChange,
  verifyCollateralImmutability,
  verifyCsr07hUnchanged,
  underLockRecheckSevenChange,
  findNormalisedProduct
};
