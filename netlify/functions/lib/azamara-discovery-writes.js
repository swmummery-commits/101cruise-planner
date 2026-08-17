/**
 * Azamara discovery writes — manifest building and controlled apply.
 */

const crypto = require("crypto");
const { upsertCandidateRecord } = require("./cruise-discovery-ops");
const { ensureGlobalCruiseWriteLockForMutation } = require("./cruise-discovery-global-write-lock");
const { snapshotRecordForRollback } = require("./cruise-discovery-maintenance-manifests");
const {
  isOfficialAzamaraRecord,
  isLegacyGenericAzamaraRow,
  candidateChanged
} = require("./azamara-discovery-adapter");
const { refineProposedActionForWeekly, ALLOWED_WEEKLY_UPDATE_FIELDS } = require("./azamara-weekly-update-policy");
const { mergeAzamaraStableRawExtract } = require("./azamara-weekly-safe-metadata");

const SAFE_METADATA_FIELD_SET = new Set(ALLOWED_WEEKLY_UPDATE_FIELDS);

function buildAzamaraSafeUpdatePatch(existing, candidate, safeFields = ALLOWED_WEEKLY_UPDATE_FIELDS) {
  const patch = {};
  for (const field of safeFields) {
    if (!SAFE_METADATA_FIELD_SET.has(field)) continue;
    if (field === "official_url") {
      patch.official_url = candidate.official_url ?? existing.official_url;
    }
    if (field === "raw_extract") {
      patch.raw_extract = mergeAzamaraStableRawExtract(existing.raw_extract, candidate.raw_extract);
    }
  }
  patch.last_seen_at = new Date().toISOString();
  patch.last_verified_at = new Date().toISOString();
  return patch;
}

async function applyAzamaraSafeMetadataUpdate({ supabase, entry, runId, stats }) {
  const existingId = entry.existing_record_id;
  if (!existingId) {
    stats.skipped += 1;
    return;
  }
  const rows = await supabase(
    `discovered_cruises?id=eq.${encodeURIComponent(existingId)}&cruise_line_id=eq.${encodeURIComponent(entry.candidate.cruise_line_id)}&select=*&limit=1`
  );
  const existing = rows?.[0] || null;
  if (!existing) {
    stats.failed += 1;
    stats.write_details.push({
      official_sailing_id: entry.official_sailing_id,
      result_action: "failed",
      error: "existing_record_not_found"
    });
    return;
  }
  if (String(existing.official_sailing_id || "").toUpperCase() !== String(entry.official_sailing_id || "").toUpperCase()) {
    stats.failed += 1;
    stats.write_details.push({
      official_sailing_id: entry.official_sailing_id,
      result_action: "failed",
      error: "official_sailing_id_mismatch"
    });
    return;
  }

  const candidate = {
    ...entry.candidate,
    raw_extract: mergeAzamaraStableRawExtract(existing.raw_extract, entry.candidate.raw_extract)
  };
  const patch = buildAzamaraSafeUpdatePatch(existing, candidate);
  const before = snapshotRecordForRollback(existing);
  await supabase(`discovered_cruises?id=eq.${encodeURIComponent(existing.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch)
  });
  stats.updated += 1;
  stats.write_details.push({
    official_sailing_id: entry.official_sailing_id,
    result_action: "updated",
    id: existing.id,
    rollback_snapshot: before
  });
}

function computeManifestHash(manifest) {
  return crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex").slice(0, 40);
}

function classifyProposedAction(product, existingOfficial) {
  if (!product?.candidate) return "invalid_skip";
  if (product.disposition === "policy_excluded_cruisetour") return "policy_excluded_cruisetour";
  if (product.disposition === "source_stale_or_unavailable") return "source_stale_or_unavailable";
  if (product.disposition === "http_source_failure") return "http_source_failure";
  if (product.disposition === "validation_failed") return "validation_failed";

  if (existingOfficial) {
    if (!candidateChanged(existingOfficial, product.candidate)) return "duplicate_skip";
    return "update_official_match";
  }

  if (product.disposition === "new_candidate") return "insert_active";
  return "not_discovery_ready";
}

async function indexExistingAzamaraRecords(supabase, cruiseLineId) {
  const select =
    "id,cruise_line_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,itinerary,status,official_url,external_key,identity_key,official_sailing_id,raw_extract,review_reason";
  const rows = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const batch = await supabase(
      `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}&select=${select}&limit=${pageSize}&offset=${offset}`
    );
    if (!batch?.length) break;
    rows.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }

  const officialBySailingId = new Map();
  const legacyRows = [];
  for (const row of rows) {
    if (isOfficialAzamaraRecord(row) && row.official_sailing_id) {
      officialBySailingId.set(String(row.official_sailing_id).toUpperCase(), row);
    } else if (isLegacyGenericAzamaraRow(row)) {
      legacyRows.push(row);
    }
  }
  return { rows, officialBySailingId, legacyRows };
}

function buildManifestEntry(product, cruiseLine, existingOfficial, batchPosition) {
  const baseAction = classifyProposedAction(product, existingOfficial);
  const weeklyAction = refineProposedActionForWeekly(baseAction, existingOfficial, product.candidate);
  return {
    batch_position: batchPosition,
    official_sailing_id: product.official_sailing_id,
    stable_identity_key: product.identity_key,
    ship_name: product.ship,
    departure_date: product.departure,
    nights: product.nights,
    destination_name: product.destination,
    product_type: product.product_type,
    disposition: product.disposition,
    proposed_action: weeklyAction,
    base_action: baseAction,
    existing_record_id: existingOfficial?.id || null,
    candidate: product.candidate,
    source_url: product.url
  };
}

async function buildAzamaraWeeklyEntries({ products, cruiseLine, indexes }) {
  const entries = [];
  let pos = 0;
  for (const product of products || []) {
    if (!product.candidate) continue;
    const existing =
      indexes.officialBySailingId.get(String(product.official_sailing_id || "").toUpperCase()) || null;
    entries.push(buildManifestEntry(product, cruiseLine, existing, pos += 1));
  }
  return entries;
}

async function applyAzamaraBatchWritesBody({
  manifest,
  cruiseLine,
  maxWrites = 50,
  runId = null,
  supabase,
  performWrites = true,
  expectedHash = null
}) {
  if (expectedHash && manifest.manifest_hash !== expectedHash) {
    const err = new Error("Azamara manifest hash mismatch");
    err.code = "azamara_manifest_hash_mismatch";
    throw err;
  }

  const stats = {
    inserted: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    write_details: []
  };
  const writeStats = { new: 0, unchanged: 0, cruises_inserted: 0, updates: 0, failed: 0, skipped_existing: 0 };

  const actionable = (manifest.entries || []).filter(
    (e) => e.proposed_action === "insert_active" || e.proposed_action === "update_safe_metadata_allowed"
  );
  const limited = actionable.slice(0, maxWrites);

  for (const entry of limited) {
    if (!performWrites) {
      stats.skipped += 1;
      continue;
    }
    try {
      if (entry.proposed_action === "update_safe_metadata_allowed") {
        await applyAzamaraSafeMetadataUpdate({ supabase, entry, runId, stats });
        continue;
      }
      const candidate = {
        ...entry.candidate,
        raw_extract: {
          ...(entry.candidate.raw_extract || {}),
          azamara_weekly_run_id: runId || null,
          azamara_weekly_action: entry.proposed_action
        }
      };
      const out = await upsertCandidateRecord(candidate, writeStats, {
        matchPolicy: "official_sailing_id_only",
        requireGlobalWriteLock: true,
        allowUpdate: false
      });
      if (out.created) {
        stats.inserted += 1;
        stats.write_details.push({
          official_sailing_id: entry.official_sailing_id,
          result_action: "inserted",
          id: out.row?.id,
          rollback_snapshot: null
        });
      } else if (out.updated) {
        stats.updated += 1;
        stats.write_details.push({
          official_sailing_id: entry.official_sailing_id,
          result_action: "updated",
          id: out.row?.id,
          rollback_snapshot: snapshotRecordForRollback(out.previous || null)
        });
      } else if (out.duplicate) {
        stats.skipped += 1;
      } else {
        stats.skipped += 1;
      }
    } catch (error) {
      stats.failed += 1;
      stats.write_details.push({
        official_sailing_id: entry.official_sailing_id,
        result_action: "failed",
        error: error.message
      });
    }
  }

  return { stats, writeStats };
}

async function applyAzamaraBatchWrites(params = {}) {
  if (params.performWrites === false) return applyAzamaraBatchWritesBody(params);
  return ensureGlobalCruiseWriteLockForMutation(
    params.supabase,
    {
      ownerId: params.runId,
      runId: params.runId,
      lineSlug: params.cruiseLine?.slug || "azamara",
      operation: "azamara_weekly_maintenance"
    },
    () => applyAzamaraBatchWritesBody(params)
  );
}

module.exports = {
  computeManifestHash,
  classifyProposedAction,
  indexExistingAzamaraRecords,
  buildManifestEntry,
  buildAzamaraWeeklyEntries,
  applyAzamaraBatchWrites,
  buildAzamaraSafeUpdatePatch,
  applyAzamaraSafeMetadataUpdate,
  isOfficialAzamaraRecord,
  isLegacyGenericAzamaraRow
};
