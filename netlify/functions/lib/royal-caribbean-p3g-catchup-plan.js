/**
 * Royal Caribbean P3G controlled catch-up master plan.
 * Freeze current safe candidates. Material writes per batch stay at 30.
 */

const crypto = require("crypto");

const P3G_ROYAL_CATCHUP_BATCH_CAP = 30;
const P3G_CATCHUP_MASTER_MODE = "royal_caribbean_p3g_catchup_master";
const CATCHUP_CLASSES = Object.freeze([
  "TRUE_NEW_COMPLETE",
  "SAFE_METADATA",
  "REVIEW_REQUIRED",
  "COLLISION",
  "AMBIGUOUS"
]);

function present(value) {
  if (value == null) return false;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

function indexProductionRows(rows = []) {
  const byOfficial = new Map();
  const byExternal = new Map();
  const byIdentity = new Map();
  for (const row of rows || []) {
    const official = row.official_sailing_id;
    const external = row.external_key;
    const identity = row.identity_key;
    if (official) {
      const list = byOfficial.get(official) || [];
      list.push(row);
      byOfficial.set(official, list);
    }
    if (external) {
      const list = byExternal.get(external) || [];
      list.push(row);
      byExternal.set(external, list);
    }
    if (identity) {
      const list = byIdentity.get(identity) || [];
      list.push(row);
      byIdentity.set(identity, list);
    }
  }
  return { byOfficial, byExternal, byIdentity };
}

function classifyRoyalCatchupCandidate(entry = {}, indexes = indexProductionRows()) {
  const official = entry.official_sailing_id || entry.stable_identity_key || entry.candidate?.official_sailing_id;
  const candidate = entry.candidate || {};
  const identity = entry.identity_key || candidate.identity_key;
  const external = entry.external_key || candidate.external_key;
  const ship = entry.canonical_ship_id || entry.resolved_ship_db_id || candidate.ship_id;
  const port = entry.resolved_embarkation_port_name || candidate.departure_port;
  const destination = entry.resolved_destination_id || candidate.destination_id;
  const provenance =
    entry.source_provenance || candidate.official_url || candidate.source_url || entry.official_url || null;

  const officialHits = official ? indexes.byOfficial.get(official) || [] : [];
  const externalHits = external ? indexes.byExternal.get(external) || [] : [];
  const identityHits = identity ? indexes.byIdentity.get(identity) || [] : [];
  if (officialHits.length || externalHits.length || identityHits.length) {
    return {
      classification: "COLLISION",
      reason: officialHits.length
        ? "official_sailing_id_collision"
        : externalHits.length
          ? "external_key_collision"
          : "identity_key_collision",
      official_sailing_id: official || null,
      existing_uuids: [...officialHits, ...externalHits, ...identityHits].map((row) => row.id).filter(Boolean)
    };
  }

  if (entry.proposed_action === "update_exact_legacy_match") {
    return {
      classification: "SAFE_METADATA",
      reason: "exact_legacy_metadata_update",
      official_sailing_id: official || null
    };
  }

  const complete =
    present(official) &&
    present(identity) &&
    present(ship) &&
    present(port) &&
    present(destination) &&
    present(provenance);

  if (complete && entry.proposed_action === "insert_active") {
    return {
      classification: "TRUE_NEW_COMPLETE",
      reason: "complete_identity_no_collision",
      official_sailing_id: official
    };
  }

  if (!present(official) || !present(identity)) {
    return {
      classification: "AMBIGUOUS",
      reason: !present(official) ? "missing_official_id" : "missing_identity_key",
      official_sailing_id: official || null
    };
  }

  return {
    classification: "REVIEW_REQUIRED",
    reason: [
      !present(ship) && "ship_unresolved",
      !present(port) && "departure_port_unresolved",
      !present(destination) && "destination_unresolved",
      !present(provenance) && "missing_source_provenance"
    ]
      .filter(Boolean)
      .join(",") || "incomplete_candidate",
    official_sailing_id: official
  };
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function freezeRoyalCatchupMasterPlan({
  proposedInserts = [],
  proposedUpdates = [],
  productionRows = [],
  today = null,
  sourceSnapshotId = null,
  unionCount = null
} = {}) {
  if (P3G_ROYAL_CATCHUP_BATCH_CAP > 30) {
    throw new Error("p3g_catchup_batch_cap_must_not_exceed_30");
  }
  const indexes = indexProductionRows(productionRows);
  const classified = [...proposedInserts, ...proposedUpdates].map((entry) => {
    const classification = classifyRoyalCatchupCandidate(entry, indexes);
    const candidate = entry.candidate || null;
    return {
      official_sailing_id: classification.official_sailing_id || entry.official_sailing_id || entry.stable_identity_key || null,
      source_identity: entry.stable_identity_key || classification.official_sailing_id || entry.official_sailing_id || null,
      proposed_action: entry.proposed_action || null,
      identity_key: entry.identity_key || candidate?.identity_key || null,
      external_key: entry.external_key || candidate?.external_key || null,
      ship_id: entry.canonical_ship_id || candidate?.ship_id || null,
      ship_name: entry.canonical_ship_name || candidate?.ship_name || null,
      departure_date: entry.departure_date || candidate?.departure_date || null,
      return_date: entry.return_date || candidate?.return_date || null,
      nights: entry.nights ?? candidate?.nights ?? null,
      departure_port: entry.official_departure_port || entry.resolved_embarkation_port_name || candidate?.departure_port || null,
      destination_id: entry.resolved_destination_id || entry.destination_id || candidate?.destination_id || null,
      destination_name: entry.destination_name || null,
      source_evidence: entry.source_url || entry.official_url || candidate?.official_url || candidate?.source_url || null,
      canonical_write_payload: candidate,
      candidate,
      ...classification
    };
  });

  const byClass = Object.fromEntries(CATCHUP_CLASSES.map((name) => [name, classified.filter((row) => row.classification === name)]));
  const trueNew = byClass.TRUE_NEW_COMPLETE;
  const batches = chunk(trueNew, P3G_ROYAL_CATCHUP_BATCH_CAP).map((entries, index) => ({
    batch_number: index + 1,
    max_batch_size: P3G_ROYAL_CATCHUP_BATCH_CAP,
    expected_record_count: entries.length,
    official_sailing_ids: entries.map((row) => row.official_sailing_id)
  }));

  const counts = Object.fromEntries(CATCHUP_CLASSES.map((name) => [name, byClass[name].length]));
  const plan = {
    mode: P3G_CATCHUP_MASTER_MODE,
    frozen_at: new Date().toISOString(),
    perth_today: today,
    source_snapshot_id: sourceSnapshotId,
    union_count: unionCount,
    batch_cap: P3G_ROYAL_CATCHUP_BATCH_CAP,
    safe_backlog: trueNew.length,
    review_or_ambiguous: counts.REVIEW_REQUIRED + counts.AMBIGUOUS,
    collision_count: counts.COLLISION,
    classification_counts: counts,
    batches,
    classified
  };
  plan.plan_hash = crypto.createHash("sha256").update(JSON.stringify({
    mode: plan.mode,
    perth_today: plan.perth_today,
    source_snapshot_id: plan.source_snapshot_id,
    official_sailing_ids: trueNew.map((row) => row.official_sailing_id),
    batch_cap: plan.batch_cap
  })).digest("hex");
  return plan;
}

function verifyFrozenRoyalCatchupPlanHash(plan) {
  const trueNew = (plan?.classified || []).filter((row) => row.classification === "TRUE_NEW_COMPLETE");
  const expected = crypto.createHash("sha256").update(JSON.stringify({
    mode: plan.mode,
    perth_today: plan.perth_today,
    source_snapshot_id: plan.source_snapshot_id,
    official_sailing_ids: trueNew.map((row) => row.official_sailing_id),
    batch_cap: plan.batch_cap
  })).digest("hex");
  return { ok: expected === plan.plan_hash, expected, actual: plan.plan_hash };
}

function buildRoyalCatchupBatchWeeklyManifest({
  plan,
  batch,
  runId,
  computeManifestHash,
  weeklyManifestMode,
  confirmToken
}) {
  if (!batch || (batch.expected_record_count || 0) > P3G_ROYAL_CATCHUP_BATCH_CAP) {
    throw new Error("royal_catchup_batch_exceeds_cap_30");
  }
  const byId = new Map((plan.classified || []).map((row) => [row.official_sailing_id, row]));
  const inserts = (batch.official_sailing_ids || []).map((id) => {
    const row = byId.get(id);
    if (!row?.candidate) {
      throw new Error(`royal_catchup_missing_write_payload:${id}`);
    }
    return {
      official_sailing_id: id,
      identity_key: row.identity_key || row.candidate.identity_key || null,
      external_key: row.external_key || row.candidate.external_key || null,
      proposed_action: "insert_active",
      candidate: row.candidate
    };
  });
  const weeklyManifest = {
    generated_at: new Date().toISOString(),
    mode: weeklyManifestMode,
    confirm_token: confirmToken,
    perth_today: plan.perth_today,
    first_activation_cycle: false,
    source_snapshot_id: plan.source_snapshot_id,
    run_id: runId,
    inserts,
    updates: [],
    cutoff_hides: [],
    source_absence_observations: [],
    source_absence_hides: [],
    review_required: [],
    writes_performed: false,
    actual_writes: 0,
    p3h_catchup: true,
    p3h_master_plan_hash: plan.plan_hash,
    p3h_batch_number: batch.batch_number
  };
  weeklyManifest.manifest_hash = computeManifestHash(weeklyManifest);
  return weeklyManifest;
}

module.exports = {
  P3G_ROYAL_CATCHUP_BATCH_CAP,
  P3G_CATCHUP_MASTER_MODE,
  CATCHUP_CLASSES,
  classifyRoyalCatchupCandidate,
  freezeRoyalCatchupMasterPlan,
  verifyFrozenRoyalCatchupPlanHash,
  buildRoyalCatchupBatchWeeklyManifest,
  indexProductionRows
};
