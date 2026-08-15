/**
 * Silversea Expedition itinerary semantic classification (Phase E1 — policy prototype).
 *
 * NOT wired to production adapter or eligibility in E1.
 */

const { normaliseName } = require("./cruise-finder-v2/enrichment/match-entities");
const { resolveRawPortText } = require("./discovery-departure-port");

const SEMANTIC = Object.freeze({
  CONVENTIONAL_PORT: "CONVENTIONAL_PORT",
  EMBARK_DISEMBARK_LOGISTICS: "EMBARK_DISEMBARK_LOGISTICS",
  EXPEDITION_LANDING_SITE: "EXPEDITION_LANDING_SITE",
  ANCHORAGE_OR_ZODIAC_SITE: "ANCHORAGE_OR_ZODIAC_SITE",
  SCENIC_OR_GEOGRAPHIC_REGION: "SCENIC_OR_GEOGRAPHIC_REGION",
  PASSAGE_OR_TRANSIT: "PASSAGE_OR_TRANSIT",
  LAND_EXCURSION_OR_INLAND_SITE: "LAND_EXCURSION_OR_INLAND_SITE",
  AMBIGUOUS: "AMBIGUOUS"
});

const LOGISTICS_NAMES = Object.freeze([
  /^puerto williams\b/i,
  /^king george island\b/i,
  /^baltra\b/i,
  /^san crist[oó]bal\b/i,
  /^puerto ayora\b/i
]);

const CONVENTIONAL_PORT_CODES = Object.freeze({
  CLWPU: "Puerto Williams",
  CLPUW: "Puerto Williams",
  AQPWM: "Puerto Williams",
  AQKGI: "King George Island",
  AQKGG: "King George Island",
  ECPSJ: "San Cristobal",
  ECBAL: "Baltra",
  ECGPS: "Puerto Ayora",
  ARUSH: "Ushuaia",
  CLPUQ: "Punta Arenas",
  NOTOS: "Tromso",
  NOTRM: "Tromso",
  FIPRV: "Port Vila",
  AUBME: "Broome",
  AUDRW: "Darwin",
  MUPLU: "Port Louis",
  NALUD: "Luderitz",
  CVRAI: "Praia",
  NOLOF: "Longyearbyen",
  GLGOH: "Nuuk",
  ISREY: "Reykjavik",
  ISAKU: "Akureyri",
  ISIFJ: "Isafjordur",
  GLJHS: "Sisimiut",
  GLJAV: "Ilulissat",
  FJLAU: "Lautoka",
  FJSUV: "Suva",
  PFPPT: "Papeete",
  PFMTH: "Motu Taha'a",
  PFBOR: "Bora Bora",
  PGRAB: "Rabaul",
  SBNNB: "Santa Ana"
});

const LOGISTICS_PORT_CODES = Object.freeze({
  CLWPU: true,
  CLPUW: true,
  AQPWM: true,
  AQKGI: true,
  ECPSJ: true,
  ECBAL: true,
  ECGPS: true
});

const PASSAGE_PATTERNS = Object.freeze([/\bdrake passage\b/i, /\bbeagle channel\b/i, /\bgerlache strait\b/i, /\blemaire channel\b/i]);

const SCENIC_REGION_PATTERNS = Object.freeze([
  /^antarctic peninsula\b/i,
  /^south shetland islands\b/i,
  /^south georgia\b/i,
  /\bregion\b/i,
  /\barchipelago region\b/i,
  /\bfjord\b/i,
  /\bglacier\b/i,
  /\bwaterfalls\b/i,
  /\breef\b/i,
  /^svalbard\b/i
]);

const INLAND_PATTERNS = Object.freeze([/\bhighlands\b/i, /\binland\b/i, /\bhighland\b/i]);

const ANCHORAGE_PATTERNS = Object.freeze([
  /\bkicker rock\b/i,
  /\bislet\b/i,
  /\bchampion islet\b/i,
  /\bnorth seymour\b/i,
  /\banchorage\b/i,
  /\bashmore reef\b/i
]);

function isGalapagosCode(code) {
  return String(code || "").trim().toUpperCase().startsWith("ECG");
}

function isAntarcticaExpeditionCode(code) {
  const c = String(code || "").trim().toUpperCase();
  return c.startsWith("AQE") || c.startsWith("AQ");
}

function classifyByCodePrefix(code, name) {
  const c = String(code || "").trim().toUpperCase();
  const prefix3 = c.slice(0, 3);
  if (!c) return null;

  if (isGalapagosCode(c)) {
    if (INLAND_PATTERNS.some((p) => p.test(name))) return { semantic: SEMANTIC.LAND_EXCURSION_OR_INLAND_SITE, confidence: "high", evidence: ["ecg_inland", c] };
    if (ANCHORAGE_PATTERNS.some((p) => p.test(name)) || /\brock\b/i.test(name)) {
      return { semantic: SEMANTIC.ANCHORAGE_OR_ZODIAC_SITE, confidence: "high", evidence: ["ecg_anchorage", c] };
    }
    return { semantic: SEMANTIC.EXPEDITION_LANDING_SITE, confidence: "high", evidence: ["ecg_landing", c] };
  }

  if (isAntarcticaExpeditionCode(c)) {
    if (SCENIC_REGION_PATTERNS.some((p) => p.test(name))) {
      return { semantic: SEMANTIC.SCENIC_OR_GEOGRAPHIC_REGION, confidence: "high", evidence: ["aqe_region", c] };
    }
    return { semantic: SEMANTIC.EXPEDITION_LANDING_SITE, confidence: "medium", evidence: ["aqe_site", c] };
  }

  if (prefix3 === "NOE" || prefix3 === "GSE") {
    return { semantic: SEMANTIC.SCENIC_OR_GEOGRAPHIC_REGION, confidence: "high", evidence: ["polar_region_code", c] };
  }
  if (prefix3 === "AUK") {
    return { semantic: SEMANTIC.SCENIC_OR_GEOGRAPHIC_REGION, confidence: "high", evidence: ["kimberley_region_code", c] };
  }
  if (prefix3 === "GLE" || prefix3 === "GLJ" || prefix3 === "GLG") {
    if (SCENIC_REGION_PATTERNS.some((p) => p.test(name))) {
      return { semantic: SEMANTIC.SCENIC_OR_GEOGRAPHIC_REGION, confidence: "high", evidence: ["greenland_scenic_code", c] };
    }
    return { semantic: SEMANTIC.EXPEDITION_LANDING_SITE, confidence: "medium", evidence: ["greenland_site_code", c] };
  }
  if (prefix3 === "GBE" || prefix3 === "GBL" || prefix3 === "GBF" || prefix3 === "GBI" || prefix3 === "GBS" || prefix3 === "GBM") {
    return { semantic: SEMANTIC.EXPEDITION_LANDING_SITE, confidence: "medium", evidence: ["uk_expedition_site_code", c] };
  }
  if (prefix3 === "ISD" || prefix3 === "ISL") {
    return { semantic: SEMANTIC.LAND_EXCURSION_OR_INLAND_SITE, confidence: "medium", evidence: ["iceland_site_code", c] };
  }
  if (prefix3 === "PFF" || prefix3 === "PFH") {
    return { semantic: SEMANTIC.EXPEDITION_LANDING_SITE, confidence: "medium", evidence: ["polynesia_site_code", c] };
  }
  if (prefix3 === "CAC" || prefix3 === "CAH" || prefix3 === "CAL" || prefix3 === "CAP" || prefix3 === "CAD") {
    return { semantic: SEMANTIC.EXPEDITION_LANDING_SITE, confidence: "medium", evidence: ["canada_arctic_site_code", c] };
  }
  if (prefix3 === "IDI" || prefix3 === "IDK" || prefix3 === "IDP") {
    return { semantic: SEMANTIC.EXPEDITION_LANDING_SITE, confidence: "medium", evidence: ["indonesia_site_code", c] };
  }

  return null;
}

function classifyExpeditionStopSemantic(stop, context = {}) {
  const name = String(stop?.port_name || stop?.source_name || stop?.name || "").trim();
  const code = String(stop?.port_code || stop?.source_code || stop?.code || "").trim().toUpperCase();
  const role = context.role || stop?.role || "itinerary";

  if (!name && !code) {
    return { semantic: SEMANTIC.AMBIGUOUS, confidence: "low", evidence: ["missing_name_and_code"] };
  }

  if (PASSAGE_PATTERNS.some((p) => p.test(name))) {
    return { semantic: SEMANTIC.PASSAGE_OR_TRANSIT, confidence: "high", evidence: ["passage_name", code || name] };
  }

  if (INLAND_PATTERNS.some((p) => p.test(name))) {
    return { semantic: SEMANTIC.LAND_EXCURSION_OR_INLAND_SITE, confidence: "high", evidence: ["inland_pattern", code || name] };
  }

  const resolution = name ? resolveRawPortText(name) : { status: "missing" };
  if (resolution.status === "resolved") {
    return {
      semantic: SEMANTIC.CONVENTIONAL_PORT,
      confidence: "high",
      evidence: ["existing_canonical_resolver", resolution.canonicalPortName],
      canonical_port: resolution.canonicalPortName
    };
  }

  if (LOGISTICS_NAMES.some((p) => p.test(name))) {
    return { semantic: SEMANTIC.EMBARK_DISEMBARK_LOGISTICS, confidence: "high", evidence: ["logistics_name", code || name] };
  }

  if (code && CONVENTIONAL_PORT_CODES[code]) {
    const logistics = LOGISTICS_PORT_CODES[code];
    return {
      semantic: logistics ? SEMANTIC.EMBARK_DISEMBARK_LOGISTICS : SEMANTIC.CONVENTIONAL_PORT,
      confidence: "high",
      evidence: ["silversea_conventional_code", code, CONVENTIONAL_PORT_CODES[code]]
    };
  }

  const byPrefix = classifyByCodePrefix(code, name);
  if (byPrefix) return byPrefix;

  if (SCENIC_REGION_PATTERNS.some((p) => p.test(name))) {
    return { semantic: SEMANTIC.SCENIC_OR_GEOGRAPHIC_REGION, confidence: "medium", evidence: ["scenic_region_name", code || name] };
  }

  if (ANCHORAGE_PATTERNS.some((p) => p.test(name))) {
    return { semantic: SEMANTIC.ANCHORAGE_OR_ZODIAC_SITE, confidence: "medium", evidence: ["anchorage_name", code || name] };
  }

  if (/^isla\b|^punta\b|\bbay\b|\bcove\b|\bisland\b|\bisles\b/i.test(name)) {
    return { semantic: SEMANTIC.EXPEDITION_LANDING_SITE, confidence: "medium", evidence: ["landing_name_shape", code || name] };
  }

  if (role === "embark" || role === "disembark") {
    return { semantic: SEMANTIC.EMBARK_DISEMBARK_LOGISTICS, confidence: "medium", evidence: ["endpoint_role", role, code || name] };
  }

  return { semantic: SEMANTIC.AMBIGUOUS, confidence: "low", evidence: ["no_deterministic_rule", code || name] };
}

function isExpeditionSemanticEligible(classification) {
  if (!classification) return false;
  if (classification.semantic === SEMANTIC.CONVENTIONAL_PORT) return Boolean(classification.canonical_port);
  if (classification.semantic === SEMANTIC.AMBIGUOUS) return false;
  if (classification.confidence === "low") return false;
  return [
    SEMANTIC.EMBARK_DISEMBARK_LOGISTICS,
    SEMANTIC.EXPEDITION_LANDING_SITE,
    SEMANTIC.ANCHORAGE_OR_ZODIAC_SITE,
    SEMANTIC.SCENIC_OR_GEOGRAPHIC_REGION,
    SEMANTIC.PASSAGE_OR_TRANSIT,
    SEMANTIC.LAND_EXCURSION_OR_INLAND_SITE
  ].includes(classification.semantic);
}

function portIdentityKey(sourceName, sourceCode) {
  return `${normaliseName(sourceName || "")}|${String(sourceCode || "").toUpperCase()}`;
}

function codePrefix(code) {
  const c = String(code || "").trim().toUpperCase();
  return c.length >= 3 ? c.slice(0, 3) : c;
}

module.exports = {
  SEMANTIC,
  CONVENTIONAL_PORT_CODES,
  LOGISTICS_PORT_CODES,
  classifyExpeditionStopSemantic,
  isExpeditionSemanticEligible,
  portIdentityKey,
  codePrefix
};
