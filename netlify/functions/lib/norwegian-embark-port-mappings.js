/**
 * Norwegian Cruise Line — authoritative embark port code mappings.
 *
 * NCL browse filters expose stable embPort codes. These map directly to the
 * physical cruise port canonical_name in data/ports/ports-catalogue.csv.
 *
 * Geography beats marketing labels: when NCL uses "Barcelona (Tarragona)" the
 * code TAR maps to Tarragona, not Barcelona.
 */

const NCL_EMBARK_PORTS = Object.freeze([
  { code: "AKL", source_name: "Auckland, New Zealand", canonical_name: "Auckland", classification: "EXACT" },
  { code: "BCN", source_name: "Barcelona, Spain", canonical_name: "Barcelona", classification: "EXACT" },
  { code: "BOS", source_name: "Boston, Massachusetts", canonical_name: "Boston", classification: "EXACT" },
  { code: "BUE", source_name: "Buenos Aires, Argentina", canonical_name: "Buenos Aires", classification: "EXACT" },
  {
    code: "CIV",
    source_name: "Rome (Civitavecchia), Italy",
    canonical_name: "Civitavecchia",
    classification: "EXISTING_ALIAS",
    note: "Marketing city Rome; physical port Civitavecchia"
  },
  { code: "CPH", source_name: "Copenhagen, Denmark", canonical_name: "Copenhagen", classification: "EXACT" },
  { code: "GAL", source_name: "Galveston, Texas", canonical_name: "Galveston", classification: "EXACT" },
  { code: "HEL", source_name: "Helsinki, Finland", canonical_name: "Helsinki", classification: "EXACT" },
  { code: "HKG", source_name: "Hong Kong, China", canonical_name: "Hong Kong", classification: "EXACT" },
  {
    code: "HNL",
    source_name: "Honolulu, Oahu",
    canonical_name: "Honolulu",
    classification: "EXISTING_ALIAS",
    note: "Oahu is island context on Honolulu record"
  },
  {
    code: "INC",
    source_name: "Seoul (Incheon), South Korea",
    canonical_name: "Incheon",
    classification: "NEW_PORT_REQUIRED",
    note: "Physical cruise port is Incheon, not central Seoul"
  },
  { code: "IST", source_name: "Istanbul, Turkey", canonical_name: "Istanbul", classification: "EXACT" },
  {
    code: "JAX",
    source_name: "Jacksonville, Florida",
    canonical_name: "Jacksonville",
    classification: "NEW_PORT_REQUIRED"
  },
  {
    code: "LAX",
    source_name: "Los Angeles, California",
    canonical_name: "Los Angeles",
    classification: "SAFE_EQUIVALENT",
    note: "Catalogue canonical Los Angeles maps to San Pedro cruise terminal"
  },
  { code: "LIS", source_name: "Lisbon, Portugal", canonical_name: "Lisbon", classification: "EXACT" },
  { code: "LTK", source_name: "Lautoka, Fiji", canonical_name: "Lautoka", classification: "EXACT" },
  { code: "MIA", source_name: "Miami, Florida", canonical_name: "Miami", classification: "EXACT" },
  { code: "MSY", source_name: "New Orleans, Louisiana", canonical_name: "New Orleans", classification: "EXACT" },
  { code: "NYC", source_name: "New York, New York", canonical_name: "New York", classification: "EXACT" },
  {
    code: "PCV",
    source_name: "Orlando (Port Canaveral), Florida",
    canonical_name: "Port Canaveral",
    classification: "EXISTING_ALIAS",
    note: "Marketing city Orlando; physical port Port Canaveral"
  },
  {
    code: "PHL",
    source_name: "Philadelphia, Pennsylvania",
    canonical_name: "Philadelphia",
    classification: "NEW_PORT_REQUIRED"
  },
  {
    code: "PIR",
    source_name: "Athens (Piraeus), Greece",
    canonical_name: "Piraeus",
    classification: "EXISTING_ALIAS",
    note: "Marketing city Athens; physical port Piraeus"
  },
  {
    code: "PPT",
    source_name: "Papeete (Tahiti), French Polynesia",
    canonical_name: "Papeete",
    classification: "EXISTING_ALIAS",
    note: "Tahiti island context on Papeete record"
  },
  {
    code: "QUE",
    source_name: "Québec City, Canada",
    canonical_name: "Quebec City",
    classification: "EXISTING_ALIAS",
    note: "Diacritic variant on Quebec City record"
  },
  {
    code: "RAV",
    source_name: "Venice (Ravenna), Italy",
    canonical_name: "Ravenna",
    classification: "DISTINCT_PORT_REQUIRED",
    note: "Must not resolve to Venice — Ravenna is a separate Adriatic port"
  },
  { code: "REY", source_name: "Reykjavik, Iceland", canonical_name: "Reykjavik", classification: "EXACT" },
  {
    code: "SAI",
    source_name: "Santiago (San Antonio), Chile",
    canonical_name: "San Antonio",
    classification: "DISTINCT_PORT_REQUIRED",
    note: "Must not resolve to Valparaiso — San Antonio is a separate Chilean port"
  },
  { code: "SAN", source_name: "San Diego, California", canonical_name: "San Diego", classification: "EXACT" },
  { code: "SEA", source_name: "Seattle, Washington", canonical_name: "Seattle", classification: "EXACT" },
  { code: "SIN", source_name: "Singapore, Singapore", canonical_name: "Singapore", classification: "EXACT" },
  { code: "SJU", source_name: "San Juan, Puerto Rico", canonical_name: "San Juan", classification: "EXACT" },
  {
    code: "SOU",
    source_name: "London (Southampton), United Kingdom",
    canonical_name: "Southampton",
    classification: "EXISTING_ALIAS",
    note: "Marketing city London; physical port Southampton"
  },
  { code: "SYD", source_name: "Sydney, Australia", canonical_name: "Sydney", classification: "EXACT" },
  {
    code: "TAR",
    source_name: "Barcelona (Tarragona), Spain",
    canonical_name: "Tarragona",
    classification: "DISTINCT_PORT_REQUIRED",
    note: "Must not resolve to Barcelona — Tarragona is a separate Mediterranean port"
  },
  { code: "TOK", source_name: "Tokyo, Japan", canonical_name: "Tokyo", classification: "EXACT" },
  { code: "TPA", source_name: "Tampa, Florida", canonical_name: "Tampa", classification: "EXACT" },
  { code: "VAN", source_name: "Vancouver, British Columbia", canonical_name: "Vancouver", classification: "EXACT" },
  {
    code: "VCE",
    source_name: "Venice (Trieste), Italy",
    canonical_name: "Trieste",
    classification: "DISTINCT_PORT_REQUIRED",
    note: "NCL reuses VCE code for Trieste sailings — must not resolve to Venice"
  },
  { code: "WQF", source_name: "Whittier, Alaska", canonical_name: "Whittier", classification: "EXACT" },
  {
    code: "YOK",
    source_name: "Tokyo (Yokohama), Japan",
    canonical_name: "Yokohama",
    classification: "EXISTING_ALIAS",
    note: "Tokyo metro marketing; physical port Yokohama"
  }
]);

const CODE_TO_MAPPING = Object.freeze(Object.fromEntries(NCL_EMBARK_PORTS.map((row) => [row.code, row])));

const pocMappings = require("./norwegian-port-of-call-mappings");
const COMBINED_CODE_TO_MAPPING = Object.freeze({
  ...pocMappings.POC_CODE_TO_MAPPING,
  ...CODE_TO_MAPPING
});

const PORT_OF_CALL_SAMPLES = Object.freeze([
  {
    source_name: "Great Stirrup Cay, Bahamas",
    canonical_name: "Great Stirrup Cay",
    classification: "NEW_PORT_REQUIRED",
    note: "NCL private destination — distinct from CocoCay and other Bahamas islands"
  },
  {
    source_name: "Ketchikan (Ward Cove), Alaska",
    canonical_name: "Ketchikan",
    classification: "SAFE_EQUIVALENT",
    note: "Ward Cove is NCL's Ketchikan cruise terminal — model under Ketchikan canonical port"
  }
]);

function getEmbarkPortMapping(code) {
  const normalised = String(code || "").trim().toUpperCase();
  return COMBINED_CODE_TO_MAPPING[normalised] || null;
}

function getEmbarkPortCanonicalName(code) {
  return getEmbarkPortMapping(code)?.canonical_name || null;
}

function listEmbarkPorts() {
  return NCL_EMBARK_PORTS.slice();
}

module.exports = {
  NCL_EMBARK_PORTS,
  CODE_TO_MAPPING,
  PORT_OF_CALL_SAMPLES,
  getEmbarkPortMapping,
  getEmbarkPortCanonicalName,
  listEmbarkPorts
};
