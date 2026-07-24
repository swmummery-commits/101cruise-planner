/**
 * Track.cruises discovery provider (POC). Not activated for customers.
 * search() reads fixtures by default; live only when explicitly enabled.
 */

const { CruiseDiscoveryProvider } = require("./provider-base");
const { stripProviderPrices } = require("../inventory/strip-prices");
const { buildCanonicalSailing } = require("../inventory/build-canonical-sailing");
const { deduplicateCanonicalSailings } = require("../inventory/dedupe-canonical");

class TrackCruisesProvider extends CruiseDiscoveryProvider {
  /**
   * @param {{ catalogues: object, rows?: object[], client?: object|null }} options
   */
  constructor(options = {}) {
    super();
    this.catalogues = options.catalogues || null;
    this.rows = Array.isArray(options.rows) ? options.rows : [];
    this.client = options.client || null;
  }

  get id() {
    return "track-cruises";
  }

  getFeasibility() {
    return {
      suitable: true,
      recommendation: "POC_ONLY",
      reasons: [
        "Live API validated for schedule fields.",
        "Nine-line coverage only — not sole permanent global provider.",
        "Prices must be stripped; Route Object needs catalogue geodata."
      ]
    };
  }

  /**
   * Import / normalise provided rows (or previously loaded this.rows).
   * Does not call live API.
   */
  importRows(rows, catalogues = this.catalogues) {
    if (!catalogues) throw new Error("Catalogues required for Track.cruises import.");
    const sailings = [];
    for (const row of rows || []) {
      const { cleaned } = stripProviderPrices(row);
      sailings.push(buildCanonicalSailing(cleaned, catalogues));
    }
    const deduped = deduplicateCanonicalSailings(sailings);
    return {
      ok: true,
      sailings: deduped.unique,
      duplicates: deduped.duplicates,
      rawCount: sailings.length
    };
  }

  async search(_request) {
    if (!this.catalogues) {
      return { ok: false, error: { code: "missing_catalogues", message: "Catalogues not loaded." } };
    }
    const result = this.importRows(this.rows, this.catalogues);
    return {
      ok: true,
      candidates: result.sailings,
      meta: {
        provider: this.id,
        rawCount: result.rawCount,
        uniqueCount: result.sailings.length,
        duplicates: result.duplicates.length,
        note: "Canonical sailings (inventory POC), not CandidateCruise UI contract."
      }
    };
  }

  async getCruiseDetails(candidateReference) {
    const id = String(candidateReference?.providerCruiseId || candidateReference?.cruise_id || "");
    const row = this.rows.find((r) => String(r.cruise_id) === id);
    if (!row) return { ok: false, error: { code: "not_found", message: "Cruise not in loaded rows." } };
    const { cleaned } = stripProviderPrices(row);
    return { ok: true, details: buildCanonicalSailing(cleaned, this.catalogues) };
  }

  normalise(rawCruise) {
    const { cleaned } = stripProviderPrices(rawCruise);
    return buildCanonicalSailing(cleaned, this.catalogues);
  }
}

module.exports = {
  TrackCruisesProvider
};
