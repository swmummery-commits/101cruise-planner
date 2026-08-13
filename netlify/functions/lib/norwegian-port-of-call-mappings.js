/**
 * Norwegian Cruise Line — port-of-call code mappings (Phase 5C).
 * Extends embark mappings for schedule-page portsOfCall resolution.
 */

const NCL_PORT_OF_CALL_CODES = Object.freeze([
  { code: "MLA", source_name: "Valletta, Malta", canonical_name: "Valletta", classification: "NEW_PORT_REQUIRED", country: "Malta" },
  { code: "EPM", source_name: "Eastport, Maine", canonical_name: "Eastport", classification: "NEW_PORT_REQUIRED", country: "United States" },
  { code: "MOT", source_name: "Motril, Spain", canonical_name: "Motril", classification: "NEW_PORT_REQUIRED", country: "Spain" },
  { code: "POP", source_name: "Puerto Plata, Dominican Republic", canonical_name: "Puerto Plata", classification: "NEW_PORT_REQUIRED", country: "Dominican Republic" },
  {
    code: "PWM",
    source_name: "Portland, Maine",
    canonical_name: "Portland Maine",
    classification: "DISTINCT_PORT_REQUIRED",
    country: "United States",
    note: "Must not map to Portland, Oregon"
  },
  { code: "AKI", source_name: "Akita, Japan", canonical_name: "Akita", classification: "NEW_PORT_REQUIRED", country: "Japan" },
  { code: "KZW", source_name: "Kanazawa, Japan", canonical_name: "Kanazawa", classification: "NEW_PORT_REQUIRED", country: "Japan" },
  { code: "HKD", source_name: "Hakodate, Japan", canonical_name: "Hakodate", classification: "NEW_PORT_REQUIRED", country: "Japan" },
  {
    code: "SMZ",
    source_name: "Mount Fuji (Shimizu), Japan",
    canonical_name: "Shimizu",
    classification: "EXISTING_ALIAS",
    country: "Japan",
    note: "Physical cruise port is Shimizu, not Mount Fuji"
  },
  {
    code: "BPI",
    source_name: "Harvest Caye, Belize",
    canonical_name: "Harvest Caye",
    classification: "DISTINCT_PORT_REQUIRED",
    country: "Belize",
    note: "NCL private destination — distinct from Belize City"
  },
  {
    code: "FMH",
    source_name: "Falmouth, Jamaica",
    canonical_name: "Falmouth Jamaica",
    classification: "DISTINCT_PORT_REQUIRED",
    country: "Jamaica",
    note: "Jamaica Falmouth — not Falmouth UK"
  },
  { code: "LGN", source_name: "La Goulette, Tunisia", canonical_name: "La Goulette", classification: "NEW_PORT_REQUIRED", country: "Tunisia" },
  {
    code: "FPO",
    source_name: "Grand Bahama Island, Bahamas",
    canonical_name: "Freeport",
    classification: "EXISTING_ALIAS",
    country: "Bahamas",
    note: "NCL label for Freeport/Grand Bahama cruise port"
  },
  { code: "SAM", source_name: "Samana, Dominican Republic", canonical_name: "Samana", classification: "NEW_PORT_REQUIRED", country: "Dominican Republic" },
  { code: "KOT", source_name: "Kotor, Montenegro", canonical_name: "Kotor", classification: "NEW_PORT_REQUIRED", country: "Montenegro" },
  {
    code: "WRF",
    source_name: "Royal Naval Dockyard, Bermuda",
    canonical_name: "Royal Naval Dockyard",
    classification: "NEW_PORT_REQUIRED",
    country: "Bermuda",
    note: "Bermuda cruise terminal at King's Wharf"
  },
  {
    code: "BAR",
    source_name: "Bar, Montenegro",
    canonical_name: "Bar",
    classification: "NEW_PORT_REQUIRED",
    country: "Montenegro",
    note: "Adriatic port Bar, Montenegro — not Bar ME abbreviation alone"
  },
  {
    code: "LEH",
    source_name: "Paris (Le Havre), France",
    canonical_name: "Le Havre",
    classification: "EXISTING_ALIAS",
    country: "France",
    note: "Marketing city Paris; physical port Le Havre"
  },
  {
    code: "ZEE",
    source_name: "Brussels / Bruges (Zeebrugge), Belgium",
    canonical_name: "Zeebrugge",
    classification: "NEW_PORT_REQUIRED",
    country: "Belgium"
  },
  { code: "MLY", source_name: "Maloy, Norway", canonical_name: "Maloy", classification: "NEW_PORT_REQUIRED", country: "Norway" },
  { code: "SKJ", source_name: "Skjolden, Norway", canonical_name: "Skjolden", classification: "NEW_PORT_REQUIRED", country: "Norway" },
  { code: "SAK", source_name: "Sakaiminato, Japan", canonical_name: "Sakaiminato", classification: "NEW_PORT_REQUIRED", country: "Japan" },
  { code: "AOM", source_name: "Aomori, Japan", canonical_name: "Aomori", classification: "NEW_PORT_REQUIRED", country: "Japan" },
  { code: "NGO", source_name: "Nagoya, Japan", canonical_name: "Nagoya", classification: "NEW_PORT_REQUIRED", country: "Japan" },
  {
    code: "SDA",
    source_name: "Sendai (Ishinomaki), Japan",
    canonical_name: "Sendai",
    classification: "NEW_PORT_REQUIRED",
    country: "Japan",
    note: "Ishinomaki/Sendai region cruise port"
  },
  { code: "MAI", source_name: "Maizuru, Japan", canonical_name: "Maizuru", classification: "NEW_PORT_REQUIRED", country: "Japan" },
  {
    code: "KOA",
    source_name: "Kona, Hawaii",
    canonical_name: "Kona",
    classification: "NEW_PORT_REQUIRED",
    country: "United States",
    note: "Hawaii convention — Kailua-Kona cruise port"
  },
  { code: "MLN", source_name: "Melillia, Spain", canonical_name: "Melilla", classification: "NEW_PORT_REQUIRED", country: "Spain" },
  {
    code: "PSY",
    source_name: "Stanley, Falkland Islands",
    canonical_name: "Stanley",
    classification: "NEW_PORT_REQUIRED",
    country: "Falkland Islands",
    note: "Falkland Islands — disambiguated by country, not generic Stanley"
  },
  { code: "NPI", source_name: "Great Stirrup Cay, Bahamas", canonical_name: "Great Stirrup Cay", classification: "EXISTING_ALIAS", country: "Bahamas" }
]);

const POC_CODE_TO_MAPPING = Object.freeze(Object.fromEntries(NCL_PORT_OF_CALL_CODES.map((row) => [row.code, row])));

function getPortOfCallMapping(code) {
  const normalised = String(code || "").trim().toUpperCase();
  return POC_CODE_TO_MAPPING[normalised] || null;
}

function getPortOfCallCanonicalName(code) {
  return getPortOfCallMapping(code)?.canonical_name || null;
}

function listPortOfCallCodes() {
  return NCL_PORT_OF_CALL_CODES.slice();
}

module.exports = {
  NCL_PORT_OF_CALL_CODES,
  POC_CODE_TO_MAPPING,
  getPortOfCallMapping,
  getPortOfCallCanonicalName,
  listPortOfCallCodes
};
