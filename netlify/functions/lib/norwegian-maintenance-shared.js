/**
 * Norwegian Cruise Line — shared maintenance helpers (publication, hide, promote).
 */

const {
  isGenuineInventoryRow,
  isLegacyGenericDiscoveryRow
} = require("./norwegian-discovery-adapter");
const {
  PUBLIC_BOOKING_CUTOFF_DAYS,
  daysUntilDeparture,
  expirationMetadataForMaintenance,
  perthCalendarDate,
  isCruisePubliclyBookable
} = require("./public-discovered-cruise-inventory");
const { assertGlobalCruiseWriteLockHeld } = require("./cruise-discovery-global-write-lock");

const NCL_LINE_SLUG = "norwegian-cruise-line";

function snapshotRecordForRollback(row) {
  return {
    id: row.id,
    status: row.status,
    destination_id: row.destination_id,
    ship_id: row.ship_id,
    departure_date: row.departure_date,
    official_sailing_id: row.official_sailing_id,
    external_key: row.external_key,
    identity_key: row.identity_key,
    raw_extract: row.raw_extract
  };
}

function assessPublicationEligibility(row, { today, sourceEligibleOfficialIds = new Set() } = {}) {
  const exclusions = [];
  if (!row) {
    return { eligible: false, exclusions: ["missing_row"] };
  }
  if (isLegacyGenericDiscoveryRow(row)) exclusions.push("legacy");
  if (!isGenuineInventoryRow(row)) exclusions.push("not_genuine");
  if (!row.official_sailing_id) exclusions.push("missing_official_sailing_id");
  if (row.status !== "match_required") exclusions.push(`status_${row.status || "unknown"}`);
  if (!row.destination_id) exclusions.push("null_destination_id");
  if (!sourceEligibleOfficialIds.has(row.official_sailing_id)) exclusions.push("source_absent");
  const days = daysUntilDeparture(row.departure_date, today);
  if (days <= PUBLIC_BOOKING_CUTOFF_DAYS) exclusions.push("within_cutoff");
  const enrichStatus = row.raw_extract?.ncl_enrichment_status;
  if (enrichStatus !== "enrichment_ready") exclusions.push("incomplete_enrichment");
  if (!Array.isArray(row.itinerary_ports) || row.itinerary_ports.length === 0) {
    exclusions.push("missing_itinerary_ports");
  }
  return {
    eligible: exclusions.length === 0,
    exclusions,
    days_until_departure: days
  };
}

async function hideNorwegianFromPublicInventory({
  supabase,
  row,
  runId,
  perthToday,
  reason = "within_public_booking_cutoff"
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
  rawExtract.ncl_maintenance_hide_reason = reason;

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

async function promoteNorwegianToActive({ supabase, row, runId, perthToday }) {
  const now = new Date().toISOString();
  const rawExtract = { ...(row.raw_extract || {}) };
  rawExtract.ncl_phase13_activated_at = now;
  rawExtract.ncl_activation_run_id = runId || null;
  rawExtract.previous_status = row.status;
  rawExtract.ncl_publication_perth_date = perthToday || perthCalendarDate();

  await assertGlobalCruiseWriteLockHeld(options);
  const rows = await supabase(`discovered_cruises?id=eq.${encodeURIComponent(row.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status: "active", last_changed_at: now, raw_extract: rawExtract })
  });

  return {
    discovered_cruise_id: row.id,
    official_sailing_id: row.official_sailing_id,
    external_key: row.external_key,
    result_action: "promoted_active",
    row: rows?.[0] || null,
    rollback_snapshot: snapshotRecordForRollback(row)
  };
}

function buildPublicationStagePlan(target) {
  const thresholds = [1, 49, 100, 350, 500];
  const stages = [];
  let cumulative = 0;
  let prev = 0;
  for (let i = 0; i < thresholds.length; i++) {
    const next = cumulative + thresholds[i];
    if (cumulative >= target) break;
    const newWrites = Math.min(thresholds[i], target - cumulative);
    cumulative += newWrites;
    stages.push({
      stage: stages.length + 1,
      newWrites,
      cumulative,
      prevCumulative: prev
    });
    prev = cumulative;
    if (cumulative >= target) break;
  }
  if (cumulative < target) {
    stages.push({
      stage: stages.length + 1,
      newWrites: target - cumulative,
      cumulative: target,
      prevCumulative: cumulative
    });
  }
  return stages;
}

module.exports = {
  NCL_LINE_SLUG,
  snapshotRecordForRollback,
  assessPublicationEligibility,
  hideNorwegianFromPublicInventory,
  promoteNorwegianToActive,
  buildPublicationStagePlan,
  isCruisePubliclyBookable,
  daysUntilDeparture,
  perthCalendarDate,
  PUBLIC_BOOKING_CUTOFF_DAYS
};
