/**
 * Silversea Expedition itinerary semantic classification (Phase E2 — production-capable).
 *
 * Expedition-scoped only. Classic must not call classifyExpeditionStop().
 */

const { normaliseName } = require("./cruise-finder-v2/enrichment/match-entities");
const { resolveRawPortText } = require("./discovery-departure-port");

const EXPEDITION_SEMANTIC = Object.freeze({
  CONVENTIONAL_PORT: "conventional_port",
  EMBARK_DISEMBARK_LOGISTICS: "embark_disembark_logistics",
  LANDING_SITE: "landing_site",
  ANCHORAGE: "anchorage",
  SCENIC_REGION: "scenic_region",
  TRANSIT: "transit",
  INLAND_VISIT: "inland_visit"
});

const SEMANTIC_CONFIDENCE = Object.freeze({
  DETERMINISTIC: "deterministic",
  AMBIGUOUS: "ambiguous"
});

const SEMANTIC_SOURCE = Object.freeze({
  EXACT_IDENTITY_RULE: "exact_identity_rule",
  PORT_CODE_RULE: "port_code_rule",
  EXISTING_PORT_RESOLUTION: "existing_port_resolution",
  NAME_PATTERN: "name_pattern"
});

/** @deprecated E1 alias map — use EXPEDITION_SEMANTIC */
const SEMANTIC = Object.freeze({
  CONVENTIONAL_PORT: EXPEDITION_SEMANTIC.CONVENTIONAL_PORT,
  EMBARK_DISEMBARK_LOGISTICS: EXPEDITION_SEMANTIC.EMBARK_DISEMBARK_LOGISTICS,
  EXPEDITION_LANDING_SITE: EXPEDITION_SEMANTIC.LANDING_SITE,
  ANCHORAGE_OR_ZODIAC_SITE: EXPEDITION_SEMANTIC.ANCHORAGE,
  SCENIC_OR_GEOGRAPHIC_REGION: EXPEDITION_SEMANTIC.SCENIC_REGION,
  PASSAGE_OR_TRANSIT: EXPEDITION_SEMANTIC.TRANSIT,
  LAND_EXCURSION_OR_INLAND_SITE: EXPEDITION_SEMANTIC.INLAND_VISIT,
  AMBIGUOUS: "ambiguous"
});

const LOGISTICS_GATEWAY_CODES = Object.freeze({
  CLWPU: true,
  CLPUW: true,
  AQPWM: true,
  AQKGI: true,
  AQKGG: true
});

const CONVENTIONAL_PORT_CODES = Object.freeze({
  GLJHS: "Sisimiut",
  GLJAV: "Ilulissat",
  NOTOS: "Tromso",
  NOTRM: "Tromso",
  PGRAB: "Rabaul",
  SBNNB: "Santa Ana",
  ARUSH: "Ushuaia",
  CLPUQ: "Punta Arenas",
  AUBME: "Broome",
  AUDRW: "Darwin",
  FIPRV: "Port Vila",
  MUPLU: "Port Louis",
  NALUD: "Luderitz",
  CVRAI: "Praia",
  NOLOF: "Longyearbyen",
  GLGOH: "Nuuk",
  ISREY: "Reykjavik",
  ISAKU: "Akureyri",
  ISIFJ: "Isafjordur",
  FJLAU: "Lautoka",
  FJSUV: "Suva",
  PFPPT: "Papeete",
  PFMTH: "Motu Taha'a",
  PFBOR: "Bora Bora",
  ECPSJ: "San Cristobal",
  ECBAL: "Baltra",
  ECGPS: "Puerto Ayora"
});

const EXACT_IDENTITY_RULES = Object.freeze({
  AQE43: { semantic: EXPEDITION_SEMANTIC.SCENIC_REGION, rule_id: "aqe43_antarctic_peninsula" },
  AQE44: { semantic: EXPEDITION_SEMANTIC.SCENIC_REGION, rule_id: "aqe44_south_shetland" },
  AQE42: { semantic: EXPEDITION_SEMANTIC.TRANSIT, rule_id: "aqe42_antarctic_sound" },
  ZZC39: { semantic: EXPEDITION_SEMANTIC.TRANSIT, rule_id: "zzc39_drake_passage" },
  ECG12: { semantic: EXPEDITION_SEMANTIC.INLAND_VISIT, rule_id: "ecg12_santa_cruz_highlands" },
  ECG34: { semantic: EXPEDITION_SEMANTIC.ANCHORAGE, rule_id: "ecg34_kicker_rock" },
  ECG18: { semantic: EXPEDITION_SEMANTIC.ANCHORAGE, rule_id: "ecg18_north_seymour" },
  GSE28: { semantic: EXPEDITION_SEMANTIC.SCENIC_REGION, rule_id: "gse28_south_georgia" },
  AUK03: { semantic: EXPEDITION_SEMANTIC.SCENIC_REGION, rule_id: "auk03_buccaneer_archipelago" },
  AUK02: { semantic: EXPEDITION_SEMANTIC.SCENIC_REGION, rule_id: "auk02_hunter_river" },
  NOE45: { semantic: EXPEDITION_SEMANTIC.SCENIC_REGION, rule_id: "noe45_svalbard_south" },
  NOE46: { semantic: EXPEDITION_SEMANTIC.SCENIC_REGION, rule_id: "noe46_svalbard_north" }
});

const NAME_CONFLICT_CHECKS = Object.freeze([
  {
    code: "AQE43",
    pattern: /^antarctic peninsula\b/i,
    rule_id: "aqe43_name_guard"
  },
  {
    code: "AQE44",
    pattern: /^south shetland islands\b/i,
    rule_id: "aqe44_name_guard"
  },
  {
    code: "ECG12",
    pattern: /highlands/i,
    rule_id: "ecg12_name_guard"
  },
  {
    code: "ECG34",
    pattern: /kicker rock/i,
    rule_id: "ecg34_name_guard"
  }
]);

function buildResult({
  expedition_semantic = null,
  semantic_confidence = SEMANTIC_CONFIDENCE.AMBIGUOUS,
  semantic_source = null,
  semantic_rule_id = null,
  ambiguity_reason = null,
  canonical_port = null,
  evidence = []
}) {
  return {
    expedition_semantic,
    semantic_confidence,
    semantic_source,
    semantic_rule_id,
    ambiguity_reason,
    canonical_port,
    evidence,
    semantic: expedition_semantic || SEMANTIC.AMBIGUOUS,
    confidence: semantic_confidence === SEMANTIC_CONFIDENCE.DETERMINISTIC ? "high" : "low"
  };
}

function ambiguous(reason, evidence = []) {
  return buildResult({
    semantic_confidence: SEMANTIC_CONFIDENCE.AMBIGUOUS,
    ambiguity_reason: reason,
    evidence
  });
}

function deterministic(semantic, source, rule_id, extra = {}) {
  return buildResult({
    expedition_semantic: semantic,
    semantic_confidence: SEMANTIC_CONFIDENCE.DETERMINISTIC,
    semantic_source: source,
    semantic_rule_id: rule_id,
    ...extra
  });
}

function hasNameCodeConflict(code, name) {
  if (!code || !name) return false;
  const upper = String(code).trim().toUpperCase();
  for (const guard of NAME_CONFLICT_CHECKS) {
    if (guard.code === upper && !guard.pattern.test(String(name))) return true;
  }
  return false;
}

function classifyGalapagosFamily(code, name) {
  if (/\bhighlands\b/i.test(name)) {
    return deterministic(EXPEDITION_SEMANTIC.INLAND_VISIT, SEMANTIC_SOURCE.PORT_CODE_RULE, "ecg_family_inland");
  }
  if (
    /\bkicker rock\b/i.test(name) ||
    /\bnorth seymour\b/i.test(name) ||
    /\bislet\b/i.test(name) ||
    /\brock\b/i.test(name)
  ) {
    return deterministic(EXPEDITION_SEMANTIC.ANCHORAGE, SEMANTIC_SOURCE.PORT_CODE_RULE, "ecg_family_anchorage");
  }
  return deterministic(EXPEDITION_SEMANTIC.LANDING_SITE, SEMANTIC_SOURCE.PORT_CODE_RULE, "ecg_family_landing_default");
}

function classifyAntarcticaFamily(code, name) {
  if (/^antarctic peninsula\b/i.test(name) || /^south shetland islands\b/i.test(name)) {
    return deterministic(EXPEDITION_SEMANTIC.SCENIC_REGION, SEMANTIC_SOURCE.PORT_CODE_RULE, "aqe_family_region");
  }
  if (/^antarctic sound\b/i.test(name) || /\bdrake passage\b/i.test(name)) {
    return deterministic(EXPEDITION_SEMANTIC.TRANSIT, SEMANTIC_SOURCE.PORT_CODE_RULE, "aq_family_transit");
  }
  if (code.startsWith("AQE") || code.startsWith("AQC") || code.startsWith("AQI")) {
    return deterministic(EXPEDITION_SEMANTIC.LANDING_SITE, SEMANTIC_SOURCE.PORT_CODE_RULE, "aq_antarctica_landing_default");
  }
  return ambiguous("unknown_aqe_identity", ["aq_prefix_unclassified", code, name]);
}

function classifyKimberleyFamily(code, name) {
  if (/\bregion\b/i.test(name) || /\barchipelago\b/i.test(name)) {
    return deterministic(EXPEDITION_SEMANTIC.SCENIC_REGION, SEMANTIC_SOURCE.PORT_CODE_RULE, "auk_family_region");
  }
  if (/\breef\b/i.test(name)) {
    return deterministic(EXPEDITION_SEMANTIC.ANCHORAGE, SEMANTIC_SOURCE.PORT_CODE_RULE, "auk_family_anchorage");
  }
  return deterministic(EXPEDITION_SEMANTIC.LANDING_SITE, SEMANTIC_SOURCE.PORT_CODE_RULE, "auk_family_landing_default");
}

function classifyGreenlandFamily(code, name) {
  if (
    /\bregion\b/i.test(name) ||
    /\bglacier\b/i.test(name) ||
    /\bfjord\b/i.test(name) ||
    /\bwaterfalls\b/i.test(name) ||
    /\bbay\b/i.test(name) ||
    /\bbahia\b/i.test(name)
  ) {
    return deterministic(EXPEDITION_SEMANTIC.SCENIC_REGION, SEMANTIC_SOURCE.PORT_CODE_RULE, "greenland_family_scenic");
  }
  return deterministic(EXPEDITION_SEMANTIC.LANDING_SITE, SEMANTIC_SOURCE.PORT_CODE_RULE, "greenland_family_landing_default");
}

function classifyByPortCodeFamily(code, name) {
  const upper = String(code || "").trim().toUpperCase();
  if (!upper) return null;
  if (upper.startsWith("ECG")) return classifyGalapagosFamily(upper, name);
  if (upper.startsWith("AQE")) return classifyAntarcticaFamily(upper, name);
  if (upper.startsWith("AUK")) return classifyKimberleyFamily(upper, name);
  if (upper.startsWith("NOE") || upper.startsWith("GSE")) {
    return deterministic(EXPEDITION_SEMANTIC.SCENIC_REGION, SEMANTIC_SOURCE.PORT_CODE_RULE, "polar_region_prefix");
  }
  if (upper.startsWith("GLE") || upper.startsWith("GLJ") || upper.startsWith("GLG")) {
    return classifyGreenlandFamily(upper, name);
  }
  if (/^GB[ELFSIM]/.test(upper) || upper.startsWith("GBP")) {
    return deterministic(EXPEDITION_SEMANTIC.LANDING_SITE, SEMANTIC_SOURCE.PORT_CODE_RULE, "uk_expedition_prefix");
  }
  if (/^PFF|^PFH|^PFP/.test(upper)) {
    return deterministic(EXPEDITION_SEMANTIC.LANDING_SITE, SEMANTIC_SOURCE.PORT_CODE_RULE, "polynesia_prefix");
  }
  if (/^CAC|^CAH|^CAL|^CAP|^CAD|^CAY/.test(upper)) {
    return deterministic(EXPEDITION_SEMANTIC.LANDING_SITE, SEMANTIC_SOURCE.PORT_CODE_RULE, "canada_arctic_prefix");
  }
  if (/^IDI|^IDK|^IDP|^IDB/.test(upper)) {
    return deterministic(EXPEDITION_SEMANTIC.LANDING_SITE, SEMANTIC_SOURCE.PORT_CODE_RULE, "indonesia_prefix");
  }
  if (/^ISD|^ISL|^ISS/.test(upper)) {
    if (/\bhighlands\b/i.test(name) || /\binland\b/i.test(name)) {
      return deterministic(EXPEDITION_SEMANTIC.INLAND_VISIT, SEMANTIC_SOURCE.PORT_CODE_RULE, "iceland_inland_prefix");
    }
    return deterministic(EXPEDITION_SEMANTIC.LANDING_SITE, SEMANTIC_SOURCE.PORT_CODE_RULE, "iceland_site_prefix");
  }
  if (/^FKE|^FK/.test(upper)) {
    return deterministic(EXPEDITION_SEMANTIC.LANDING_SITE, SEMANTIC_SOURCE.PORT_CODE_RULE, "falklands_prefix");
  }
  if (/^AUA|^AUB|^AUD/.test(upper)) {
    return deterministic(EXPEDITION_SEMANTIC.LANDING_SITE, SEMANTIC_SOURCE.PORT_CODE_RULE, "australia_expedition_prefix");
  }
  if (/^JPO|^JPK|^JPN/.test(upper)) {
    return deterministic(EXPEDITION_SEMANTIC.LANDING_SITE, SEMANTIC_SOURCE.PORT_CODE_RULE, "japan_expedition_prefix");
  }
  if (/^PGG|^PGR|^PGP/.test(upper)) {
    return deterministic(EXPEDITION_SEMANTIC.LANDING_SITE, SEMANTIC_SOURCE.PORT_CODE_RULE, "papua_prefix");
  }
  if (/^FJL|^FJS|^FJV/.test(upper)) {
    return deterministic(EXPEDITION_SEMANTIC.LANDING_SITE, SEMANTIC_SOURCE.PORT_CODE_RULE, "fiji_prefix");
  }
  if (/^NZN|^NZL/.test(upper)) {
    return deterministic(EXPEDITION_SEMANTIC.LANDING_SITE, SEMANTIC_SOURCE.PORT_CODE_RULE, "new_zealand_prefix");
  }
  return null;
}

function classifyExpeditionStop(stop, context = {}) {
  const name = String(stop?.port_name || stop?.source_name || stop?.name || "").trim();
  const code = String(stop?.port_code || stop?.source_code || stop?.code || "")
    .trim()
    .toUpperCase();
  const role = context.role || stop?.role || "itinerary";
  const portResolution = stop?.port_resolution || null;

  if (!name && !code) {
    return ambiguous("insufficient_context", ["missing_name_and_code"]);
  }

  if (code && hasNameCodeConflict(code, name)) {
    return ambiguous("conflicting_code_name", [code, name]);
  }

  if (code && EXACT_IDENTITY_RULES[code]) {
    const rule = EXACT_IDENTITY_RULES[code];
    return deterministic(rule.semantic, SEMANTIC_SOURCE.EXACT_IDENTITY_RULE, rule.rule_id);
  }

  if (code && LOGISTICS_GATEWAY_CODES[code]) {
    return deterministic(
      EXPEDITION_SEMANTIC.EMBARK_DISEMBARK_LOGISTICS,
      SEMANTIC_SOURCE.EXACT_IDENTITY_RULE,
      `logistics_gateway_${code.toLowerCase()}`
    );
  }

  if (portResolution?.status === "resolved") {
    return deterministic(EXPEDITION_SEMANTIC.CONVENTIONAL_PORT, SEMANTIC_SOURCE.EXISTING_PORT_RESOLUTION, "canonical_resolver", {
      canonical_port: portResolution.canonicalPortName
    });
  }

  const aliasedResolution = name ? resolveRawPortText(name) : { status: "missing" };
  if (aliasedResolution.status === "resolved") {
    return deterministic(EXPEDITION_SEMANTIC.CONVENTIONAL_PORT, SEMANTIC_SOURCE.EXISTING_PORT_RESOLUTION, "canonical_resolver", {
      canonical_port: aliasedResolution.canonicalPortName
    });
  }

  if (code && CONVENTIONAL_PORT_CODES[code]) {
    return deterministic(
      EXPEDITION_SEMANTIC.CONVENTIONAL_PORT,
      SEMANTIC_SOURCE.EXACT_IDENTITY_RULE,
      `conventional_code_${code.toLowerCase()}`,
      { canonical_port: null }
    );
  }

  const family = classifyByPortCodeFamily(code, name);
  if (family) return family;

  if (/^puerto williams\b/i.test(name) || /^king george island\b/i.test(name)) {
    return deterministic(
      EXPEDITION_SEMANTIC.EMBARK_DISEMBARK_LOGISTICS,
      SEMANTIC_SOURCE.NAME_PATTERN,
      "logistics_gateway_name"
    );
  }

  if (/\bdrake passage\b/i.test(name) || /\bbeagle channel\b/i.test(name)) {
    return deterministic(EXPEDITION_SEMANTIC.TRANSIT, SEMANTIC_SOURCE.NAME_PATTERN, "passage_name");
  }

  if (role === "embark" || role === "disembark") {
    return ambiguous("uncertain_port_vs_landing", ["endpoint_unclassified", role, code || name]);
  }

  return ambiguous("unsupported_identity", [code || name]);
}

/** @deprecated use classifyExpeditionStop */
function classifyExpeditionStopSemantic(stop, context = {}) {
  return classifyExpeditionStop(stop, context);
}

function isExpeditionStopItineraryComplete(classification, portResolution = null) {
  if (!classification) return false;
  if (classification.semantic_confidence !== SEMANTIC_CONFIDENCE.DETERMINISTIC) return false;
  if (classification.expedition_semantic === EXPEDITION_SEMANTIC.CONVENTIONAL_PORT) {
    return portResolution?.status === "resolved" || Boolean(classification.canonical_port);
  }
  if (classification.expedition_semantic === EXPEDITION_SEMANTIC.EMBARK_DISEMBARK_LOGISTICS) {
    return true;
  }
  return [
    EXPEDITION_SEMANTIC.LANDING_SITE,
    EXPEDITION_SEMANTIC.ANCHORAGE,
    EXPEDITION_SEMANTIC.SCENIC_REGION,
    EXPEDITION_SEMANTIC.TRANSIT,
    EXPEDITION_SEMANTIC.INLAND_VISIT
  ].includes(classification.expedition_semantic);
}

function isExpeditionSemanticEligible(classification) {
  return isExpeditionStopItineraryComplete(classification);
}

function enrichExpeditionItineraryStop(stop, context = {}) {
  const kind = stop.kind || "port";
  if (kind !== "port") {
    return {
      ...stop,
      expedition_semantic: null,
      semantic_confidence: null,
      semantic_source: null,
      semantic_rule_id: null,
      ambiguity_reason: null
    };
  }
  const port_resolution =
    stop.port_resolution != null
      ? stop.port_resolution
      : resolveRawPortText(stop.port_name, { sourceField: "silversea_gatsby_itinerary" });
  const semantic = classifyExpeditionStop({ ...stop, port_resolution }, context);
  return {
    ...stop,
    port_resolution,
    expedition_semantic: semantic.expedition_semantic,
    semantic_confidence: semantic.semantic_confidence,
    semantic_source: semantic.semantic_source,
    semantic_rule_id: semantic.semantic_rule_id,
    ambiguity_reason: semantic.ambiguity_reason,
    semantic_evidence: semantic.evidence
  };
}

function portIdentityKey(sourceName, sourceCode) {
  return `${normaliseName(sourceName || "")}|${String(sourceCode || "").toUpperCase()}`;
}

function codePrefix(code) {
  const c = String(code || "").trim().toUpperCase();
  return c.length >= 3 ? c.slice(0, 3) : c;
}

module.exports = {
  EXPEDITION_SEMANTIC,
  SEMANTIC,
  SEMANTIC_CONFIDENCE,
  SEMANTIC_SOURCE,
  CONVENTIONAL_PORT_CODES,
  LOGISTICS_GATEWAY_CODES,
  EXACT_IDENTITY_RULES,
  classifyExpeditionStop,
  classifyExpeditionStopSemantic,
  enrichExpeditionItineraryStop,
  isExpeditionStopItineraryComplete,
  isExpeditionSemanticEligible,
  portIdentityKey,
  codePrefix
};
