/**
 * Princess planned-write idempotency.
 *
 * An already-applied frozen target is a successful verification, not a
 * failed write. Reload the UUID under the write lock and compare current
 * DB state to the frozen target before any mutation.
 */

function normalise(value) {
  if (value == null) return "";
  return String(value).trim();
}

function dateOnly(value) {
  return String(value || "").slice(0, 10);
}

function nightsOf(value) {
  if (value == null || value === "") return "";
  return String(value);
}

function voyageCoreEqual(current = {}, target = {}) {
  return (
    normalise(current.ship_id) === normalise(target.ship_id) &&
    dateOnly(current.departure_date) === dateOnly(target.departure_date) &&
    dateOnly(current.return_date) === dateOnly(target.return_date) &&
    nightsOf(current.nights) === nightsOf(target.nights) &&
    normalise(current.departure_port) === normalise(target.departure_port) &&
    normalise(current.destination_id) === normalise(target.destination_id)
  );
}

function princessCurrentEqualsFrozenTarget(current, target, { mode } = {}) {
  if (!current?.id || !target) return false;
  if (normalise(current.status) && normalise(current.status) !== "active") return false;
  if (normalise(current.official_sailing_id) !== normalise(target.official_sailing_id)) {
    return false;
  }
  if (!voyageCoreEqual(current, target)) return false;
  if (mode === "remap") return true;
  if (Object.prototype.hasOwnProperty.call(target, "itinerary")) {
    return normalise(current.itinerary) === normalise(target.itinerary);
  }
  return true;
}

function classifyPrincessPlannedWriteAgainstCurrent({
  currentRow = null,
  frozenTarget = null,
  plannedAction = null
} = {}) {
  const mode = plannedAction === "remap_official_id_allowed" ? "remap" : "update";
  if (!currentRow?.id) {
    return {
      classification: "MUTATION_REQUIRED",
      attempted_mutation: 1,
      committed_mutation: 0,
      failed_write: 0,
      idempotent_skip: 0
    };
  }
  if (princessCurrentEqualsFrozenTarget(currentRow, frozenTarget, { mode })) {
    return {
      classification: "IDEMPOTENT_ALREADY_APPLIED",
      attempted_mutation: 0,
      committed_mutation: 0,
      failed_write: 0,
      idempotent_skip: 1,
      discovered_cruise_id: currentRow.id
    };
  }
  return {
    classification: "MUTATION_REQUIRED",
    attempted_mutation: 1,
    committed_mutation: 0,
    failed_write: 0,
    idempotent_skip: 0,
    discovered_cruise_id: currentRow.id
  };
}

async function reloadPrincessDiscoveredCruise(supabase, id) {
  if (!supabase || !id) return null;
  const rows = await supabase(
    `discovered_cruises?id=eq.${encodeURIComponent(id)}&select=id,status,official_sailing_id,official_url,external_key,identity_key,ship_id,destination_id,departure_date,return_date,nights,departure_port,itinerary&limit=1`
  );
  return Array.isArray(rows) ? rows[0] || null : rows || null;
}

function frozenTargetFromCandidate(candidate = {}) {
  return {
    official_sailing_id: candidate.official_sailing_id || null,
    official_url: candidate.official_url || null,
    external_key: candidate.external_key || null,
    identity_key: candidate.identity_key || null,
    ship_id: candidate.ship_id || null,
    destination_id: candidate.destination_id || null,
    departure_date: candidate.departure_date || null,
    return_date: candidate.return_date || null,
    nights: candidate.nights,
    departure_port: candidate.departure_port || null,
    itinerary: candidate.itinerary,
    status: candidate.status || "active"
  };
}

function princessWriteAccountingFromStats(stats = {}) {
  const inserted = Number(stats.inserted) || 0;
  const updated = Number(stats.updated) || 0;
  const failed = Number(stats.failed) || 0;
  const idempotentSkips = Number(stats.idempotent_skips) || 0;
  const material = inserted + updated;
  return {
    planned_targets: Number(stats.planned_targets) || material + failed + idempotentSkips,
    material_mutations: material,
    material_writes: material,
    idempotent_skips: idempotentSkips,
    failed_writes: failed,
    attempted_mutations: material + failed,
    committed_material_writes: material,
    inventory_changed: material > 0
  };
}

module.exports = {
  princessCurrentEqualsFrozenTarget,
  classifyPrincessPlannedWriteAgainstCurrent,
  reloadPrincessDiscoveredCruise,
  frozenTargetFromCandidate,
  princessWriteAccountingFromStats
};
