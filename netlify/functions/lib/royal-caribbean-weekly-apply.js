/**
 * Royal Caribbean weekly maintenance — apply frozen weekly manifest (stop on first failure).
 */

const { upsertCandidateRecord } = require("./cruise-discovery-ops");
const { snapshotRecordForRollback } = require("./cruise-discovery-maintenance-manifests");
const {
  indexExistingRoyalCaribbeanRecords,
  isLegacyHtmlDiscoveryRow
} = require("./royal-caribbean-discovery-writes");
const { SAFE_UPDATE_FIELDS } = require("./royal-caribbean-weekly-updates");
const {
  expirationMetadataForMaintenance,
  perthCalendarDate
} = require("./public-discovered-cruise-inventory");
const { validateFrozenWeeklyManifest } = require("./royal-caribbean-weekly-manifest");
const { assertGlobalCruiseWriteLockHeld } = require("./cruise-discovery-global-write-lock");

async function fetchRecordById(supabase, id) {
  const rows = await supabase(
    `discovered_cruises?id=eq.${encodeURIComponent(id)}&select=id,status,departure_date,official_sailing_id,raw_extract,ship_id,destination_id,official_url,return_date,nights,departure_port,itinerary&limit=1`
  );
  return rows?.[0] || null;
}

async function verifyPreApplyConcurrency({ manifest, supabase, cruiseLine }) {
  const failures = [];
  const indexes = await indexExistingRoyalCaribbeanRecords(supabase, cruiseLine.id);

  for (const entry of manifest.inserts || []) {
    const existing =
      indexes.byProductKey.get(entry.official_sailing_id) ||
      (entry.identity_key ? indexes.byIdentity.get(entry.identity_key) : null) ||
      (entry.external_key ? indexes.byExternal.get(entry.external_key) : null);
    if (existing && !isLegacyHtmlDiscoveryRow(existing)) {
      failures.push(`insert_target_already_exists:${entry.official_sailing_id}`);
    }
  }

  for (const entry of manifest.updates || []) {
    const existing = indexes.byProductKey.get(entry.official_sailing_id);
    if (!existing) {
      failures.push(`update_target_missing:${entry.official_sailing_id}`);
      continue;
    }
    for (const field of entry.safe_fields || []) {
      if (!SAFE_UPDATE_FIELDS.has(field)) {
        failures.push(`unsafe_update_field:${entry.official_sailing_id}:${field}`);
      }
    }
  }

  for (const entry of manifest.cutoff_hides || []) {
    const row = await fetchRecordById(supabase, entry.id);
    if (!row) {
      failures.push(`cutoff_hide_target_missing:${entry.id}`);
      continue;
    }
    if (row.status === "expired") failures.push(`cutoff_hide_already_expired:${entry.id}`);
    if (row.official_sailing_id && entry.official_sailing_id && row.official_sailing_id !== entry.official_sailing_id) {
      failures.push(`cutoff_hide_sailing_id_mismatch:${entry.id}`);
    }
  }

  for (const entry of manifest.source_absence_hides || []) {
    const row = entry.discovered_cruise_id
      ? await fetchRecordById(supabase, entry.discovered_cruise_id)
      : indexes.byProductKey.get(entry.official_sailing_id);
    if (!row) failures.push(`source_absence_hide_target_missing:${entry.official_sailing_id}`);
    else if (row.status === "expired") failures.push(`source_absence_hide_already_expired:${entry.official_sailing_id}`);
  }

  return { passed: failures.length === 0, failures };
}

function buildSafeUpdatePatch(existing, candidate, safeFields = []) {
  const patch = {};
  const rawExtract = { ...(existing.raw_extract || {}) };
  for (const field of safeFields) {
    if (!SAFE_UPDATE_FIELDS.has(field)) continue;
    if (field === "sailing_status") {
      const next = candidate?.raw_extract?.sailing_status ?? candidate?.sailing_status ?? null;
      if (next != null) rawExtract.sailing_status = next;
      continue;
    }
    if (field === "booking_url") {
      patch.official_url = candidate?.official_url ?? candidate?.booking_url ?? existing.official_url;
      continue;
    }
    if (candidate && Object.prototype.hasOwnProperty.call(candidate, field)) {
      patch[field] = candidate[field];
    }
  }
  if (Object.keys(rawExtract).length) patch.raw_extract = rawExtract;
  return patch;
}

async function hideFromPublicInventory({ supabase, row, runId, perthToday, reason = "within_public_booking_cutoff" }) {
  const now = new Date().toISOString();
  const rawExtract = { ...(row.raw_extract || {}) };
  const meta = expirationMetadataForMaintenance({ departureDate: row.departure_date, perthToday });
  rawExtract.expired_at = now;
  rawExtract.expiration_reason = meta?.expiration_reason || reason;
  rawExtract.public_unavailability = meta?.public_unavailability || reason;
  rawExtract.expiration_run_id = runId || null;
  rawExtract.previous_status = row.status;
  rawExtract.maintenance_expired_at = now;

  await assertGlobalCruiseWriteLockHeld(options);
  await supabase(`discovered_cruises?id=eq.${encodeURIComponent(row.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status: "expired", last_changed_at: now, raw_extract: rawExtract })
  });

  return {
    discovered_cruise_id: row.id,
    official_sailing_id: row.official_sailing_id || null,
    result_action: "expired",
    rollback_snapshot: snapshotRecordForRollback(row)
  };
}

async function applyRoyalCaribbeanWeeklyManifest({
  manifest,
  supabase,
  cruiseLine,
  performWrites = true,
  runId = null,
  firstActivationCycle = false
}) {
  const validation = validateFrozenWeeklyManifest(manifest, { firstActivationCycle });
  if (!validation.passed) {
    const err = new Error(`Royal Caribbean weekly manifest validation failed: ${validation.failures.join("; ")}`);
    err.code = "royal_caribbean_weekly_manifest_validation_failed";
    err.failures = validation.failures;
    throw err;
  }

  if (firstActivationCycle && (manifest.source_absence_hides || []).length > 0) {
    const err = new Error("First activation cycle forbids source absence hides");
    err.code = "first_activation_cycle_source_absence_hides_forbidden";
    throw err;
  }

  const concurrency = await verifyPreApplyConcurrency({ manifest, supabase, cruiseLine });
  if (!concurrency.passed) {
    const err = new Error(`Royal Caribbean pre-apply concurrency failed: ${concurrency.failures.join("; ")}`);
    err.code = "royal_caribbean_pre_apply_concurrency_failed";
    err.failures = concurrency.failures;
    throw err;
  }

  const stats = {
    attempted: 0,
    inserted: 0,
    updated: 0,
    expired: 0,
    failed: 0,
    stopped_early: false,
    write_details: [],
    manifest_hash: manifest.manifest_hash
  };

  const indexes = await indexExistingRoyalCaribbeanRecords(supabase, cruiseLine.id);
  const upsertStats = { new: 0, upserted_active: 0, cruises_inserted: 0, cruises_updated: 0 };
  const perthToday = manifest.perth_today || perthCalendarDate();

  for (const entry of manifest.inserts || []) {
    stats.attempted += 1;
    const candidate = entry.candidate;
    if (!candidate?.cruise_line_id || !candidate?.ship_id || !candidate?.destination_id) {
      stats.failed += 1;
      stats.stopped_early = true;
      stats.write_details.push({
        official_sailing_id: entry.official_sailing_id,
        result_action: "failed",
        error: "missing_write_candidate"
      });
      break;
    }

    const existing =
      indexes.byProductKey.get(entry.official_sailing_id) ||
      (entry.identity_key ? indexes.byIdentity.get(entry.identity_key) : null);
    if (existing && !isLegacyHtmlDiscoveryRow(existing)) {
      stats.failed += 1;
      stats.stopped_early = true;
      stats.write_details.push({
        official_sailing_id: entry.official_sailing_id,
        discovered_cruise_id: existing.id,
        result_action: "duplicate_abort",
        error: "official_sailing_id_already_exists"
      });
      break;
    }

    if (!performWrites) continue;

    try {
      const result = await upsertCandidateRecord(candidate, upsertStats, {
        prevRecord: null,
        matchPolicy: "official_sailing_id_only",
        syncDestinationLinks: false
      });
      if (!result.created || !result.row?.id) {
        stats.failed += 1;
        stats.stopped_early = true;
        stats.write_details.push({
          official_sailing_id: entry.official_sailing_id,
          result_action: result.duplicate ? "duplicate_abort" : "failed",
          error: result.duplicate ? "duplicate_during_insert" : "insert_not_created"
        });
        break;
      }
      stats.inserted += 1;
      indexes.byProductKey.set(entry.official_sailing_id, result.row);
      stats.write_details.push({
        official_sailing_id: entry.official_sailing_id,
        discovered_cruise_id: result.row.id,
        result_action: "inserted",
        rollback_snapshot: snapshotRecordForRollback(result.row)
      });
    } catch (error) {
      stats.failed += 1;
      stats.stopped_early = true;
      stats.write_details.push({
        official_sailing_id: entry.official_sailing_id,
        result_action: "failed",
        error: error.message || String(error)
      });
      break;
    }
  }

  if (!stats.stopped_early) {
    for (const entry of manifest.updates || []) {
      stats.attempted += 1;
      const existing = indexes.byProductKey.get(entry.official_sailing_id);
      if (!existing) {
        stats.failed += 1;
        stats.stopped_early = true;
        stats.write_details.push({
          official_sailing_id: entry.official_sailing_id,
          result_action: "failed",
          error: "update_target_missing"
        });
        break;
      }

      const patch = buildSafeUpdatePatch(existing, entry.candidate || {}, entry.safe_fields || []);
      if (!Object.keys(patch).length) {
        stats.write_details.push({
          official_sailing_id: entry.official_sailing_id,
          discovered_cruise_id: existing.id,
          result_action: "no_change"
        });
        continue;
      }

      if (!performWrites) continue;

      try {
        const now = new Date().toISOString();
        const rows = await supabase(`discovered_cruises?id=eq.${encodeURIComponent(existing.id)}`, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ ...patch, last_changed_at: now })
        });
        stats.updated += 1;
        stats.write_details.push({
          official_sailing_id: entry.official_sailing_id,
          discovered_cruise_id: existing.id,
          result_action: "updated",
          safe_fields: entry.safe_fields || [],
          rollback_snapshot: snapshotRecordForRollback(existing)
        });
        if (rows?.[0]) indexes.byProductKey.set(entry.official_sailing_id, rows[0]);
      } catch (error) {
        stats.failed += 1;
        stats.stopped_early = true;
        stats.write_details.push({
          official_sailing_id: entry.official_sailing_id,
          result_action: "failed",
          error: error.message || String(error)
        });
        break;
      }
    }
  }

  if (!stats.stopped_early) {
    for (const entry of manifest.cutoff_hides || []) {
      stats.attempted += 1;
      const row = await fetchRecordById(supabase, entry.id);
      if (!row || row.status === "expired") {
        stats.failed += 1;
        stats.stopped_early = true;
        stats.write_details.push({
          discovered_cruise_id: entry.id,
          official_sailing_id: entry.official_sailing_id,
          result_action: "failed",
          error: "cutoff_hide_precondition_failed"
        });
        break;
      }
      if (!performWrites) continue;
      try {
        stats.write_details.push(
          await hideFromPublicInventory({
            supabase,
            row,
            runId,
            perthToday,
            reason: "within_public_booking_cutoff"
          })
        );
        stats.expired += 1;
      } catch (error) {
        stats.failed += 1;
        stats.stopped_early = true;
        stats.write_details.push({
          discovered_cruise_id: entry.id,
          official_sailing_id: entry.official_sailing_id,
          result_action: "failed",
          error: error.message || String(error)
        });
        break;
      }
    }
  }

  if (!stats.stopped_early && !firstActivationCycle) {
    for (const entry of manifest.source_absence_hides || []) {
      stats.attempted += 1;
      const row = entry.discovered_cruise_id
        ? await fetchRecordById(supabase, entry.discovered_cruise_id)
        : indexes.byProductKey.get(entry.official_sailing_id);
      if (!row || row.status === "expired") {
        stats.failed += 1;
        stats.stopped_early = true;
        stats.write_details.push({
          official_sailing_id: entry.official_sailing_id,
          result_action: "failed",
          error: "source_absence_hide_precondition_failed"
        });
        break;
      }
      if (!performWrites) continue;
      try {
        stats.write_details.push(
          await hideFromPublicInventory({
            supabase,
            row,
            runId,
            perthToday,
            reason: "source_absent_consecutive_healthy_absence"
          })
        );
        stats.expired += 1;
      } catch (error) {
        stats.failed += 1;
        stats.stopped_early = true;
        stats.write_details.push({
          official_sailing_id: entry.official_sailing_id,
          result_action: "failed",
          error: error.message || String(error)
        });
        break;
      }
    }
  }

  stats.actual_writes = stats.inserted + stats.updated + stats.expired;
  return {
    ok: stats.failed === 0 && !stats.stopped_early,
    stats,
    run_id: runId,
    manifest_hash: manifest.manifest_hash,
    perform_writes: performWrites === true
  };
}

module.exports = {
  verifyPreApplyConcurrency,
  applyRoyalCaribbeanWeeklyManifest
};
