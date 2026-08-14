/**
 * Stable public-search voyage identity keys for deduplication and audit checks.
 * Includes duration so nested Princess sailings (e.g. 7-night segment vs 14-night
 * grand adventure on the same ship/date/port) remain distinct.
 */

function normaliseToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

/**
 * Primary dedupe key for public Cruise Finder / search-current-cruises results.
 * @param {{ cruiseLine?: string, ship?: string, departureDateIso?: string, departureDate?: string, durationNights?: number, departurePort?: string }} result
 */
function publicSearchVoyageIdentityKey(result) {
  return [
    normaliseToken(result.cruiseLine),
    normaliseToken(result.ship),
    normaliseToken(result.departureDateIso || result.departureDate),
    String(result.durationNights || ""),
    normaliseToken(result.departurePort)
  ].join("|");
}

/**
 * Coarse audit key (ship + date + port only). Collisions here are not necessarily duplicates.
 */
function publicSearchCoarseAuditKey(result) {
  return [
    normaliseToken(result.cruiseLine),
    normaliseToken(result.ship),
    normaliseToken(result.departureDateIso || result.departureDate),
    normaliseToken(result.departurePort)
  ].join("|");
}

/**
 * Count duplicate identity keys in a result set.
 * @returns {{ total: number, unique: number, duplicateGroups: number, duplicateRows: number }}
 */
function summarisePublicSearchDuplicates(results, keyFn = publicSearchVoyageIdentityKey) {
  const groups = new Map();
  for (const row of results || []) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const duplicateGroups = [...groups.values()].filter((g) => g.length > 1);
  return {
    total: (results || []).length,
    unique: groups.size,
    duplicateGroups: duplicateGroups.length,
    duplicateRows: duplicateGroups.reduce((n, g) => n + g.length - 1, 0)
  };
}

module.exports = {
  publicSearchVoyageIdentityKey,
  publicSearchCoarseAuditKey,
  summarisePublicSearchDuplicates
};
