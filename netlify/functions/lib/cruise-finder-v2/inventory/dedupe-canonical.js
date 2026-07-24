/**
 * Canonical sailing key + dedupe (locale/currency/title must not fork sailings).
 */

const { normaliseKeyPart } = require("../deduplicate");

/**
 * @param {import("./canonical-inventory").CanonicalSailing|object} sailing
 * @returns {string}
 */
function buildSailingKey(sailing) {
  const lineId = sailing.cruiseLine?.id || null;
  const shipId = sailing.ship?.id || null;
  const line =
    lineId ||
    normaliseKeyPart(sailing.cruiseLine?.canonicalName || sailing.cruiseLine?.providerName);
  const ship =
    shipId ||
    normaliseKeyPart(sailing.ship?.canonicalName || sailing.ship?.providerName);
  const date = String(sailing.departureDate || "").trim();
  const nights =
    sailing.nights != null && Number.isFinite(Number(sailing.nights))
      ? String(Number(sailing.nights))
      : "n?";
  const depPort =
    sailing.departurePort?.portId ||
    normaliseKeyPart(sailing.departurePort?.canonicalName) ||
    "p?";
  if (!line || !ship || !date) return "";
  return [line, ship, date, nights, depPort].join("|");
}

/**
 * @param {Array<object>} sailings
 */
function deduplicateCanonicalSailings(sailings) {
  const byKey = new Map();
  const duplicates = [];

  for (const sailing of sailings || []) {
    const key = sailing.sailingKey || buildSailingKey(sailing);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...sailing, sailingKey: key });
      continue;
    }
    duplicates.push({
      key,
      keptProviderCruiseId: existing.providerCruiseId,
      droppedProviderCruiseId: sailing.providerCruiseId,
      keptLocale: existing._locale || null,
      droppedLocale: sailing._locale || null
    });
    // Prefer richer itinerary / matched ship
    const existingScore =
      (existing.ship?.matchStatus === "MATCHED" ? 2 : 0) +
      (existing.itinerary?.length || 0);
    const nextScore =
      (sailing.ship?.matchStatus === "MATCHED" ? 2 : 0) + (sailing.itinerary?.length || 0);
    if (nextScore > existingScore) {
      byKey.set(key, { ...sailing, sailingKey: key });
    }
  }

  return { unique: [...byKey.values()], duplicates };
}

module.exports = {
  buildSailingKey,
  deduplicateCanonicalSailings
};
