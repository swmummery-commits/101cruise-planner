/**
 * Deterministic candidate keys + dedupe for Engine V2.
 *
 * Key uses strongest available identity fields — never title alone.
 * Multi-provider merge (future): same candidateKey from different providers
 * collapses to one sailing; keep highest confidence, merge sourceUrls.
 */

function normaliseKeyPart(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {import("./contracts").CandidateCruise|object} cruise
 * @returns {string}
 */
function buildCandidateKey(cruise) {
  const line = normaliseKeyPart(cruise.cruiseLineName);
  const ship = normaliseKeyPart(cruise.shipName);
  const date = String(cruise.departureDate || "").trim();
  const nights =
    cruise.nights != null && Number.isFinite(Number(cruise.nights))
      ? String(Number(cruise.nights))
      : "";
  const port = normaliseKeyPart(cruise.departurePortName);
  if (!line || !ship || !date) return "";
  return [line, ship, date, nights || "n?", port || "p?"].join("|");
}

/**
 * @param {Array<import("./contracts").CandidateCruise>} cruises
 * @returns {{ unique: Array, duplicates: Array<{key:string,kept:object,dropped:object}> }}
 */
function deduplicateCandidates(cruises) {
  const rank = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  const byKey = new Map();
  const duplicates = [];

  for (const cruise of cruises || []) {
    const key = buildCandidateKey(cruise);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, cruise);
      continue;
    }
    const keepExisting = (rank[existing.confidence] || 0) >= (rank[cruise.confidence] || 0);
    if (keepExisting) {
      duplicates.push({ key, kept: existing, dropped: cruise });
    } else {
      duplicates.push({ key, kept: cruise, dropped: existing });
      byKey.set(key, cruise);
    }
  }

  return { unique: [...byKey.values()], duplicates };
}

module.exports = {
  buildCandidateKey,
  deduplicateCandidates,
  normaliseKeyPart
};
