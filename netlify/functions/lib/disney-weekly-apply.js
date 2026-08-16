/**
 * Disney Cruise Line — weekly maintenance apply (inserts, safe updates, source absence, touches).
 */

const {
  officialProductKey,
  buildDisneyUpsertCandidate
} = require("./disney-discovery-adapter");
const { upsertCandidateRecord } = require("./cruise-discovery-ops");
const { snapshotRecordForRollback } = require("./cruise-discovery-maintenance-manifests");
const {
  expirationMetadataForMaintenance,
  perthCalendarDate,
  daysUntilDeparture,
  PUBLIC_BOOKING_CUTOFF_DAYS
} = require("./public-discovered-cruise-inventory");
const {
  enhanceDisneyCandidate,
  indexExistingDisneyRecords
} = require("./disney-discovery-writes");
const { SAFE_METADATA_FIELDS } = require("./disney-weekly-update-policy");
const { DISNEY_LEGACY_ROW_IDS } = require("./disney-controlled-batch");

const SAFE_METADATA_FIELD_SET = new Set(SAFE_METADATA_FIELDS);

async function fetchRecordById(supabase, id) {
  const rows = await supabase(
    `discovered_cruises?id=eq.${encodeURIComponent(id)}&select=id,status,departure_date,return_date,official_sailing_id,external_key,identity_key,cruise_line_id,ship_id,destination_id,official_url,source_url,raw_extract&limit=1`
  );
  return rows?.[0] || null;
}

async function hideDisneyFromPublicInventory({
  supabase,
  row,
  runId,
  perthToday,
  reason = "source_absent"
}) {
  const now = new Date().toISOString();
  const rawExtract = { ...(row.raw_extract || {}) };
  const meta = expirationMetadataForMaintenance({ departureDate: row.departure_date, perthToday });
  rawExtract.expired_at = now;
  rawExtract.expiration_reason = meta?.expiration_reason || reason;
  rawExtract.public_unavailability = meta?.public_unavailability || reason;
  rawExtract.expiration_run_id = runId || null;
  rawExtract.previous_status = row.status;
  rawExtract.maintenance_expired_at = now;
  rawExtract.source_absence_confirmed_at = now;
  rawExtract.disney_weekly_source_absence = true;
  rawExtract.cancelled = false;
  rawExtract.cancellation_inferred_from_absence = false;

  await supabase(`discovered_cruises?id=eq.${encodeURIComponent(row.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status: "expired", last_changed_at: now, raw_extract: rawExtract })
  });

  return {
    discovered_cruise_id: row.id,
    official_sailing_id: row.official_sailing_id || null,
    result_action: "expired",
    reason,
    rollback_snapshot: snapshotRecordForRollback(row)
  };
}

async function touchDisneySourceCurrent({ supabase, row, runId }) {
  const now = new Date().toISOString();
  const rawExtract = {
    ...(row.raw_extract || {}),
    disney_last_seen_at: now,
    disney_last_verified_at: now,
    disney_weekly_touch_run_id: runId || null
  };
  await supabase(`discovered_cruises?id=eq.${encodeURIComponent(row.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      last_seen_at: now,
      last_verified_at: now,
      raw_extract: rawExtract
    })
  });
  return {
    discovered_cruise_id: row.id,
    official_sailing_id: row.official_sailing_id || null,
    result_action: "source_current_touch"
  };
}

function buildSafeUpdatePatch(existing, candidate, safeFields = []) {
  const patch = {};
  const rawExtract = { ...(existing.raw_extract || {}) };
  for (const field of safeFields) {
    if (!SAFE_METADATA_FIELD_SET.has(field)) continue;
    if (field === "official_url") patch.official_url = candidate.official_url ?? existing.official_url;
    if (field === "source_url") patch.source_url = candidate.source_url ?? existing.source_url;
  }
  rawExtract.disney_weekly_safe_update = true;
  rawExtract.disney_last_verified_at = new Date().toISOString();
  patch.raw_extract = rawExtract;
  patch.last_seen_at = new Date().toISOString();
  patch.last_verified_at = new Date().toISOString();
  return patch;
}

async function applyDisneyWeeklyMaintenanceWrites({
  manifest = {},
  supabase,
  cruiseLine,
  performWrites = true,
  runId = null,
  maxMaterialWrites = 30,
  perthToday = null,
  sourceComplete = true,
  deactivationEnabled = false
}) {
  const today = perthToday || perthCalendarDate();
  const stats = {
    inserted: 0,
    updated: 0,
    source_absence_hidden: 0,
    reactivated: 0,
    touches: 0,
    skipped: 0,
    failed: 0,
    material_actions_total: 0,
    material_actions_applied: 0,
    material_actions_deferred: 0,
    write_details: []
  };

  const upsertStats = { new: 0, upserted_active: 0, cruises_inserted: 0, cruises_updated: 0 };
  let materialRemaining = maxMaterialWrites;

  const materialQueue = [
    ...(manifest.inserts || []).map((e) => ({ ...e, kind: "insert" })),
    ...(manifest.safe_updates || []).map((e) => ({ ...e, kind: "safe_update" })),
    ...(manifest.reactivations || []).map((e) => ({ ...e, kind: "reactivation" }))
  ].sort((a, b) => String(a.official_sailing_id || "").localeCompare(String(b.official_sailing_id || "")));

  stats.material_actions_total = materialQueue.length;
  const deferred = materialQueue.slice(maxMaterialWrites);
  stats.material_actions_deferred = deferred.length;
  const toApply = materialQueue.slice(0, maxMaterialWrites);

  for (const entry of toApply) {
    if (materialRemaining <= 0) break;

    if (entry.kind === "insert") {
      const normalised = entry.normalised;
      const candidate = enhanceDisneyCandidate(normalised, cruiseLine, { mode: "weekly_maintenance" });
      if (!candidate) {
        stats.skipped += 1;
        continue;
      }
      if (!performWrites) {
        stats.skipped += 1;
        continue;
      }
      try {
        const before = null;
        const result = await upsertCandidateRecord(candidate, upsertStats, {
          matchPolicy: "official_sailing_id_only",
          syncDestinationLinks: false,
          prevRecord: null,
          globalWriteLockOwnerId: runId
        });
        if (!result.created) throw new Error("insert_path_expected_create");
        materialRemaining -= 1;
        stats.material_actions_applied += 1;
        stats.inserted += 1;
        stats.write_details.push({
          discovered_cruise_id: result.row?.id || null,
          official_sailing_id: candidate.official_sailing_id,
          proposed_action: "insert_active",
          result_action: "inserted",
          rollback_before: before
        });
      } catch (error) {
        stats.failed += 1;
        stats.write_details.push({
          official_sailing_id: entry.official_sailing_id,
          proposed_action: "insert_active",
          error: error.message || String(error)
        });
      }
      continue;
    }

    if (entry.kind === "safe_update") {
      const existing = entry.existing;
      const candidate = entry.candidate;
      if (!existing || !candidate) {
        stats.skipped += 1;
        continue;
      }
      if (!performWrites) {
        stats.skipped += 1;
        continue;
      }
      try {
        const patch = buildSafeUpdatePatch(existing, candidate, entry.safe_fields || SAFE_METADATA_FIELDS);
        const before = snapshotRecordForRollback(existing);
        await supabase(`discovered_cruises?id=eq.${encodeURIComponent(existing.id)}`, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(patch)
        });
        materialRemaining -= 1;
        stats.material_actions_applied += 1;
        stats.updated += 1;
        stats.write_details.push({
          discovered_cruise_id: existing.id,
          official_sailing_id: existing.official_sailing_id,
          proposed_action: "update_safe_metadata_allowed",
          result_action: "updated",
          rollback_before: before
        });
      } catch (error) {
        stats.failed += 1;
        stats.write_details.push({
          official_sailing_id: entry.official_sailing_id,
          proposed_action: "update_safe_metadata_allowed",
          error: error.message || String(error)
        });
      }
      continue;
    }

    if (entry.kind === "reactivation") {
      const existing = entry.existing;
      const candidate = entry.candidate;
      if (!existing || !candidate) {
        stats.skipped += 1;
        continue;
      }
      const days = daysUntilDeparture(existing.departure_date, today);
      if (days == null || days <= PUBLIC_BOOKING_CUTOFF_DAYS) {
        stats.skipped += 1;
        continue;
      }
      if (!performWrites) {
        stats.skipped += 1;
        continue;
      }
      try {
        const before = snapshotRecordForRollback(existing);
        const now = new Date().toISOString();
        const rawExtract = {
          ...(existing.raw_extract || {}),
          disney_source_absence_reactivated_at: now,
          disney_reactivation_run_id: runId || null,
          expiration_reason: null,
          public_unavailability: null
        };
        await supabase(`discovered_cruises?id=eq.${encodeURIComponent(existing.id)}`, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            status: "active",
            last_changed_at: now,
            last_seen_at: now,
            last_verified_at: now,
            raw_extract: rawExtract
          })
        });
        materialRemaining -= 1;
        stats.material_actions_applied += 1;
        stats.reactivated += 1;
        stats.write_details.push({
          discovered_cruise_id: existing.id,
          official_sailing_id: existing.official_sailing_id,
          proposed_action: "reactivation_candidate",
          result_action: "reactivated",
          rollback_before: before
        });
      } catch (error) {
        stats.failed += 1;
        stats.write_details.push({
          official_sailing_id: entry.official_sailing_id,
          proposed_action: "reactivation_candidate",
          error: error.message || String(error)
        });
      }
    }
  }

  if (sourceComplete === true && deactivationEnabled === true) {
    for (const hide of manifest.source_absence_hides || []) {
      if (materialRemaining <= 0) {
        stats.material_actions_deferred += 1;
        continue;
      }
      const row = hide.discovered_cruise_id
        ? await fetchRecordById(supabase, hide.discovered_cruise_id)
        : null;
      if (!row || row.status !== "active" || DISNEY_LEGACY_ROW_IDS.includes(row.id)) {
        stats.skipped += 1;
        continue;
      }
      if (!performWrites) {
        stats.skipped += 1;
        continue;
      }
      try {
        const result = await hideDisneyFromPublicInventory({
          supabase,
          row,
          runId,
          perthToday: today,
          reason: "source_absent"
        });
        materialRemaining -= 1;
        stats.material_actions_applied += 1;
        stats.source_absence_hidden += 1;
        stats.write_details.push(result);
      } catch (error) {
        stats.failed += 1;
        stats.write_details.push({ ...hide, result_action: "failed", error: error.message });
      }
    }
  }

  for (const touch of manifest.source_current_touches || []) {
    if (DISNEY_LEGACY_ROW_IDS.includes(touch.discovered_cruise_id)) continue;
    const row = touch.existing || (await fetchRecordById(supabase, touch.discovered_cruise_id));
    if (!row) continue;
    if (!performWrites) {
      stats.skipped += 1;
      continue;
    }
    try {
      const result = await touchDisneySourceCurrent({ supabase, row, runId });
      stats.touches += 1;
      stats.write_details.push(result);
    } catch (error) {
      stats.failed += 1;
      stats.write_details.push({
        discovered_cruise_id: touch.discovered_cruise_id,
        result_action: "touch_failed",
        error: error.message
      });
    }
  }

  return { stats, upsertStats, performWrites: performWrites === true, deferred_actions: deferred };
}

async function buildDisneyWeeklyManifest({
  products = [],
  cruiseLine,
  supabase,
  runId,
  writeContext = { mode: "weekly_maintenance" }
}) {
  const indexes = supabase ? await indexExistingDisneyRecords(supabase, cruiseLine.id) : { byOfficialId: new Map() };
  const entries = [];

  for (const normalised of products) {
    const productKey = officialProductKey(normalised.raw);
    const existing = indexes.byOfficialId.get(String(productKey).toUpperCase()) || null;
    let proposed_action = require("./disney-discovery-adapter").classifyProposedAction(normalised, existing, null);
    let candidate = null;

    if (existing && ["update_exact_existing", "update_exact_legacy_match"].includes(proposed_action)) {
      candidate = enhanceDisneyCandidate(normalised, cruiseLine, writeContext);
      proposed_action = require("./disney-weekly-update-policy").refineDisneyProposedActionForWeekly(
        proposed_action,
        existing,
        candidate
      );
    }

    entries.push({
      official_sailing_id: productKey,
      normalised,
      existing,
      candidate,
      proposed_action
    });
  }

  const inserts = [];
  const safeUpdates = [];
  const review = [];
  const sourceCurrentTouches = [];
  const unchanged = [];

  for (const entry of entries) {
    if (entry.proposed_action === "insert_active") {
      inserts.push({
        official_sailing_id: entry.official_sailing_id,
        normalised: entry.normalised
      });
    } else if (entry.proposed_action === "update_safe_metadata_allowed") {
      safeUpdates.push({
        official_sailing_id: entry.official_sailing_id,
        existing: entry.existing,
        candidate: entry.candidate,
        safe_fields: [...SAFE_METADATA_FIELDS]
      });
    } else if (entry.proposed_action === "update_identity_review_required") {
      review.push(entry);
    } else if (entry.proposed_action === "duplicate_skip" && entry.existing) {
      unchanged.push(entry);
      sourceCurrentTouches.push({
        discovered_cruise_id: entry.existing.id,
        official_sailing_id: entry.official_sailing_id,
        existing: entry.existing
      });
    }
  }

  return {
    run_id: runId || null,
    cruise_line_id: cruiseLine.id,
    products: entries,
    inserts,
    safe_updates: safeUpdates,
    review,
    unchanged,
    source_current_touches: sourceCurrentTouches
  };
}

module.exports = {
  buildDisneyWeeklyManifest,
  applyDisneyWeeklyMaintenanceWrites,
  hideDisneyFromPublicInventory,
  touchDisneySourceCurrent
};
