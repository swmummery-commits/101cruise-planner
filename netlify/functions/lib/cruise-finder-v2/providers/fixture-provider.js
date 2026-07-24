/**
 * Development-only fixture provider for Engine V2 POC.
 * Returns up to 10 Mediterranean sailings in the common candidate format.
 * No network. No prices. Not for production activation.
 */

const { CruiseDiscoveryProvider } = require("./provider-base");
const { normaliseCruiseResult } = require("../normalise-cruise-result");

const FIXTURE_CRUISES = Object.freeze([
  {
    provider: "fixture",
    providerCruiseId: "fx-med-oceania-sirena-2026-09-12",
    sourceUrl: "https://example.invalid/fixture/oceania-sirena-2026-09-12",
    cruiseLineName: "Oceania Cruises",
    shipName: "Sirena",
    departureDate: "2026-09-12",
    returnDate: "2026-09-22",
    nights: 10,
    departurePortName: "Barcelona",
    arrivalPortName: "Athens (Piraeus)",
    title: "Western Mediterranean — Barcelona to Athens",
    confidence: "HIGH",
    itinerary: [
      { dayNumber: 1, date: "2026-09-12", type: "embarkation", portName: "Barcelona" },
      { dayNumber: 2, date: "2026-09-13", type: "port", portName: "Marseille" },
      { dayNumber: 3, date: "2026-09-14", type: "port", portName: "Genoa" },
      { dayNumber: 4, date: "2026-09-15", type: "port", portName: "Rome (Civitavecchia)" },
      { dayNumber: 5, date: "2026-09-16", type: "sea", portName: null },
      { dayNumber: 6, date: "2026-09-17", type: "port", portName: "Naples" },
      { dayNumber: 7, date: "2026-09-18", type: "port", portName: "Messina" },
      { dayNumber: 8, date: "2026-09-19", type: "sea", portName: null },
      { dayNumber: 9, date: "2026-09-20", type: "port", portName: "Corfu" },
      { dayNumber: 10, date: "2026-09-21", type: "sea", portName: null },
      { dayNumber: 11, date: "2026-09-22", type: "disembarkation", portName: "Athens (Piraeus)" }
    ]
  },
  {
    provider: "fixture",
    providerCruiseId: "fx-med-celebrity-constellation-2026-10-03",
    sourceUrl: "https://example.invalid/fixture/celebrity-constellation-2026-10-03",
    cruiseLineName: "Celebrity Cruises",
    shipName: "Celebrity Constellation",
    departureDate: "2026-10-03",
    returnDate: "2026-10-10",
    nights: 7,
    departurePortName: "Rome (Civitavecchia)",
    arrivalPortName: "Barcelona",
    title: "Italy, France & Spain",
    confidence: "HIGH",
    itinerary: [
      { dayNumber: 1, date: "2026-10-03", type: "embarkation", portName: "Rome (Civitavecchia)" },
      { dayNumber: 2, date: "2026-10-04", type: "port", portName: "Naples" },
      { dayNumber: 3, date: "2026-10-05", type: "sea", portName: null },
      { dayNumber: 4, date: "2026-10-06", type: "port", portName: "Palma de Mallorca" },
      { dayNumber: 5, date: "2026-10-07", type: "port", portName: "Valencia" },
      { dayNumber: 6, date: "2026-10-08", type: "port", portName: "Cartagena" },
      { dayNumber: 7, date: "2026-10-09", type: "sea", portName: null },
      { dayNumber: 8, date: "2026-10-10", type: "disembarkation", portName: "Barcelona" }
    ]
  },
  {
    provider: "fixture",
    providerCruiseId: "fx-med-princess-island-2026-09-20",
    sourceUrl: "https://example.invalid/fixture/princess-island-2026-09-20",
    cruiseLineName: "Princess Cruises",
    shipName: "Island Princess",
    departureDate: "2026-09-20",
    returnDate: "2026-10-02",
    nights: 12,
    departurePortName: "Southampton",
    arrivalPortName: "Southampton",
    title: "Mediterranean Explorer",
    confidence: "MEDIUM",
    itinerary: [
      { dayNumber: 1, date: "2026-09-20", type: "embarkation", portName: "Southampton" },
      { dayNumber: 2, date: "2026-09-21", type: "sea", portName: null },
      { dayNumber: 3, date: "2026-09-22", type: "port", portName: "Vigo" },
      { dayNumber: 5, date: "2026-09-24", type: "port", portName: "Cadiz" },
      { dayNumber: 7, date: "2026-09-26", type: "port", portName: "Malaga" },
      { dayNumber: 8, date: "2026-09-27", type: "port", portName: "Cartagena" },
      { dayNumber: 9, date: "2026-09-28", type: "port", portName: "Valencia" },
      { dayNumber: 10, date: "2026-09-29", type: "port", portName: "Barcelona" },
      { dayNumber: 13, date: "2026-10-02", type: "disembarkation", portName: "Southampton" }
    ]
  },
  {
    provider: "fixture",
    providerCruiseId: "fx-med-holland-oosterdam-2026-08-15",
    sourceUrl: "https://example.invalid/fixture/holland-oosterdam-2026-08-15",
    cruiseLineName: "Holland America Line",
    shipName: "Oosterdam",
    departureDate: "2026-08-15",
    returnDate: "2026-08-22",
    nights: 7,
    departurePortName: "Venice",
    arrivalPortName: "Venice",
    title: "Adriatic Dreams",
    confidence: "HIGH",
    itinerary: [
      { dayNumber: 1, date: "2026-08-15", type: "embarkation", portName: "Venice" },
      { dayNumber: 2, date: "2026-08-16", type: "port", portName: "Zadar" },
      { dayNumber: 3, date: "2026-08-17", type: "port", portName: "Corfu" },
      { dayNumber: 4, date: "2026-08-18", type: "sea", portName: null },
      { dayNumber: 5, date: "2026-08-19", type: "port", portName: "Katakolon" },
      { dayNumber: 6, date: "2026-08-20", type: "port", portName: "Dubrovnik" },
      { dayNumber: 7, date: "2026-08-21", type: "sea", portName: null },
      { dayNumber: 8, date: "2026-08-22", type: "disembarkation", portName: "Venice" }
    ]
  },
  {
    provider: "fixture",
    providerCruiseId: "fx-med-celebrity-constellation-2026-10-03-dup",
    sourceUrl: "https://example.invalid/fixture/celebrity-constellation-2026-10-03-alt",
    cruiseLineName: "Celebrity Cruises",
    shipName: "Celebrity Constellation",
    departureDate: "2026-10-03",
    returnDate: "2026-10-10",
    nights: 7,
    departurePortName: "Rome (Civitavecchia)",
    arrivalPortName: "Barcelona",
    title: "Italy France Spain (duplicate sailing)",
    confidence: "LOW",
    itinerary: [
      { dayNumber: 1, date: "2026-10-03", type: "embarkation", portName: "Civitavecchia" },
      { dayNumber: 8, date: "2026-10-10", type: "disembarkation", portName: "Barcelona" }
    ]
  },
  {
    provider: "fixture",
    providerCruiseId: "fx-med-unknown-line-2026-09-01",
    sourceUrl: "https://example.invalid/fixture/unknown-line-2026-09-01",
    cruiseLineName: "Imaginary Seas Line",
    shipName: "Phantom Voyager",
    departureDate: "2026-09-01",
    returnDate: "2026-09-08",
    nights: 7,
    departurePortName: "Barcelona",
    arrivalPortName: "Barcelona",
    title: "Unmatched line/ship probe",
    confidence: "LOW",
    itinerary: [
      { dayNumber: 1, date: "2026-09-01", type: "embarkation", portName: "Barcelona" },
      { dayNumber: 3, date: "2026-09-03", type: "port", portName: "Atlantis Bay" },
      { dayNumber: 8, date: "2026-09-08", type: "disembarkation", portName: "Barcelona" }
    ]
  },
  {
    provider: "fixture",
    providerCruiseId: "fx-med-msc-seaview-2026-07-18",
    sourceUrl: "https://example.invalid/fixture/msc-seaview-2026-07-18",
    cruiseLineName: "MSC Cruises",
    shipName: "MSC Seaview",
    departureDate: "2026-07-18",
    returnDate: "2026-07-25",
    nights: 7,
    departurePortName: "Genoa",
    arrivalPortName: "Genoa",
    title: "Western Med Roundtrip",
    confidence: "MEDIUM",
    itinerary: [
      { dayNumber: 1, date: "2026-07-18", type: "embarkation", portName: "Genoa" },
      { dayNumber: 2, date: "2026-07-19", type: "port", portName: "Marseille" },
      { dayNumber: 3, date: "2026-07-20", type: "port", portName: "Barcelona" },
      { dayNumber: 4, date: "2026-07-21", type: "port", portName: "Palma" },
      { dayNumber: 5, date: "2026-07-22", type: "sea", portName: null },
      { dayNumber: 6, date: "2026-07-23", type: "port", portName: "Naples" },
      { dayNumber: 7, date: "2026-07-24", type: "port", portName: "Messina" },
      { dayNumber: 8, date: "2026-07-25", type: "disembarkation", portName: "Genoa" }
    ]
  },
  {
    provider: "fixture",
    providerCruiseId: "fx-med-viking-jupiter-2026-09-05",
    sourceUrl: "https://example.invalid/fixture/viking-jupiter-2026-09-05",
    cruiseLineName: "Viking",
    shipName: "Viking Jupiter",
    departureDate: "2026-09-05",
    returnDate: "2026-09-19",
    nights: 14,
    departurePortName: "Barcelona",
    arrivalPortName: "Istanbul",
    title: "Iconic Western Mediterranean",
    confidence: "MEDIUM",
    itinerary: [
      { dayNumber: 1, date: "2026-09-05", type: "embarkation", portName: "Barcelona" },
      { dayNumber: 3, date: "2026-09-07", type: "port", portName: "Marseille" },
      { dayNumber: 5, date: "2026-09-09", type: "port", portName: "Livorno" },
      { dayNumber: 7, date: "2026-09-11", type: "port", portName: "Rome" },
      { dayNumber: 9, date: "2026-09-13", type: "port", portName: "Naples" },
      { dayNumber: 12, date: "2026-09-16", type: "port", portName: "Athens" },
      { dayNumber: 15, date: "2026-09-19", type: "disembarkation", portName: "Istanbul" }
    ]
  },
  {
    provider: "fixture",
    providerCruiseId: "fx-med-azamara-pursuit-2026-10-12",
    sourceUrl: "https://example.invalid/fixture/azamara-pursuit-2026-10-12",
    cruiseLineName: "Azamara",
    shipName: "Azamara Pursuit",
    departureDate: "2026-10-12",
    returnDate: "2026-10-19",
    nights: 7,
    departurePortName: "Athens (Piraeus)",
    arrivalPortName: "Athens (Piraeus)",
    title: "Greek Isles",
    confidence: "HIGH",
    itinerary: [
      { dayNumber: 1, date: "2026-10-12", type: "embarkation", portName: "Piraeus" },
      { dayNumber: 2, date: "2026-10-13", type: "port", portName: "Mykonos" },
      { dayNumber: 3, date: "2026-10-14", type: "port", portName: "Santorini" },
      { dayNumber: 4, date: "2026-10-15", type: "port", portName: "Rhodes" },
      { dayNumber: 5, date: "2026-10-16", type: "port", portName: "Kusadasi" },
      { dayNumber: 6, date: "2026-10-17", type: "sea", portName: null },
      { dayNumber: 7, date: "2026-10-18", type: "port", portName: "Patmos" },
      { dayNumber: 8, date: "2026-10-19", type: "disembarkation", portName: "Athens (Piraeus)" }
    ]
  },
  {
    provider: "fixture",
    providerCruiseId: "fx-med-regent-explorer-2026-11-01",
    sourceUrl: "https://example.invalid/fixture/regent-explorer-2026-11-01",
    cruiseLineName: "Regent Seven Seas Cruises",
    shipName: "Seven Seas Explorer",
    departureDate: "2026-11-01",
    returnDate: "2026-11-11",
    nights: 10,
    departurePortName: "Barcelona",
    arrivalPortName: "Rome (Civitavecchia)",
    title: "Iberian & Italian Coasts",
    confidence: "HIGH",
    itinerary: [
      { dayNumber: 1, date: "2026-11-01", type: "embarkation", portName: "Barcelona" },
      { dayNumber: 2, date: "2026-11-02", type: "port", portName: "Palma de Mallorca" },
      { dayNumber: 3, date: "2026-11-03", type: "port", portName: "Valencia" },
      { dayNumber: 5, date: "2026-11-05", type: "port", portName: "Marseille" },
      { dayNumber: 6, date: "2026-11-06", type: "port", portName: "Monte Carlo" },
      { dayNumber: 7, date: "2026-11-07", type: "port", portName: "Livorno" },
      { dayNumber: 8, date: "2026-11-08", type: "port", portName: "Portofino" },
      { dayNumber: 11, date: "2026-11-11", type: "disembarkation", portName: "Civitavecchia" }
    ]
  }
]);

class FixtureProvider extends CruiseDiscoveryProvider {
  get id() {
    return "fixture";
  }

  getFeasibility() {
    return {
      suitable: true,
      recommendation: "DEV_ONLY",
      reasons: ["Local fixture provider for POC matching/dedupe — not a live data source."]
    };
  }

  async search(request, options = {}) {
    const limit = Math.min(10, Math.max(1, Number(options.limit) || 10));
    const destOk =
      !request?.destinationIds?.length ||
      request.destinationIds.some((id) => /mediterranean|greek|europe|spain|italy/i.test(id)) ||
      request.destinationNames.some((n) => /mediterranean|greek|europe/i.test(n));

    if (!destOk) {
      return {
        ok: true,
        candidates: [],
        meta: { provider: this.id, note: "Fixture scoped to Mediterranean-like destinations." }
      };
    }

    const month = request?.travelWindow?.month;
    let rows = FIXTURE_CRUISES.slice();
    if (month) {
      rows = rows.filter((c) => Number(String(c.departureDate).slice(5, 7)) === Number(month));
    }

    const candidates = [];
    for (const raw of rows.slice(0, limit)) {
      const normalised = normaliseCruiseResult({
        ...raw,
        discoveredAt: new Date().toISOString(),
        rawSourceReference: { fixtureId: raw.providerCruiseId }
      });
      if (normalised.ok) candidates.push(normalised.cruise);
    }

    return {
      ok: true,
      candidates,
      meta: { provider: this.id, returned: candidates.length, limit }
    };
  }

  async getCruiseDetails(ref) {
    const id = ref?.providerCruiseId || ref?.id;
    const raw = FIXTURE_CRUISES.find((c) => c.providerCruiseId === id);
    if (!raw) {
      return { ok: false, error: { code: "not_found", message: "Fixture cruise not found." } };
    }
    const normalised = normaliseCruiseResult({
      ...raw,
      discoveredAt: new Date().toISOString(),
      rawSourceReference: { fixtureId: raw.providerCruiseId }
    });
    return normalised.ok
      ? { ok: true, details: normalised.cruise }
      : { ok: false, error: { code: "invalid", message: "Fixture failed normalisation." } };
  }
}

module.exports = {
  FixtureProvider,
  FIXTURE_CRUISES
};
