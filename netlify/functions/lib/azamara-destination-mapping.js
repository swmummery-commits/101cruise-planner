/**
 * Azamara GTM destination handling — non-geographic vendor labels and evidence-based inference.
 * COMBO / GRAND VOYAGE are product classifications, not geographic destinations.
 */

const { normaliseName } = require("./cruise-finder-v2/enrichment/match-entities");

/** Vendor GTM labels that must never become a destination match themselves. */
const AZAMARA_NON_GEOGRAPHIC_GTM = Object.freeze(new Set(["COMBO", "GRAND VOYAGE"]));

/**
 * Deterministic geographic GTM label → slug hints (applied only with corroborating title/route evidence).
 */
const AZAMARA_GTM_GEOGRAPHIC_HINTS = Object.freeze({
  "NORTHERN & WESTERN EUROPE": "northern-europe",
  "NORTHERN AND WESTERN EUROPE": "northern-europe",
  CANADA: "canada-new-england",
  AUSTRALIA: "australia-new-zealand",
  "NEW ZEALAND": "australia-new-zealand",
  ARCTIC: "northern-europe",
  "SOUTH AMERICA": "south-america",
  "WESTERN EUROPE": "mediterranean"
});

function normaliseGtmDestination(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}

function isAzamaraNonGeographicGtm(value) {
  return AZAMARA_NON_GEOGRAPHIC_GTM.has(normaliseGtmDestination(value));
}

function sanitiseAzamaraDestinationBlob({ title, description, excerpt, gtmDestination } = {}) {
  const stripVendor = (text) =>
    String(text || "")
      .replace(/destination:\s*(combo|grand voyage)\b/gi, " ")
      .replace(/\b(?:asia|europe|africa|mediterranean|caribbean|alaska)\s+combination\b/gi, " ")
      .replace(/\bcombo\b/gi, " ")
      .replace(/\bgrand voyage\b/gi, " ");

  return [title, description, excerpt]
    .filter(Boolean)
    .map(stripVendor)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitiseAzamaraTitleForMatching(title) {
  return String(title || "")
    .replace(/&amp;/g, "&")
    .replace(/\b(?:asia|europe|africa|mediterranean|caribbean|alaska|northern europe|western europe)\s+combination\b/gi, " ")
    .replace(/\bcombination cruise\b/gi, " ")
    .replace(/\bgrand voyage\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleSupportsSlug(slug, titleNorm) {
  const t = titleNorm;
  switch (slug) {
    case "canada-new-england":
      return /canada|new england|halifax|quebec|montreal|charlottetown|newport|bar harbor|saint john|sydney ns/i.test(t);
    case "australia-new-zealand":
      return /australia|new zealand|auckland|sydney|melbourne|brisbane|wellington|christchurch|tasmania/i.test(t);
    case "northern-europe":
      return /iceland|greenland|\barctic\b|reykjavik|qaqortoq|northern europe|scandinavia|baltic|norway|sweden|denmark|amsterdam|hamburg|portsmouth|liverpool|edinburgh|dublin|british isles|ireland|scotland|norway/i.test(
        t
      );
    case "mediterranean":
      return /mediterranean|barcelona|venice|rome|civitavecchia|lisbon|piraeus|athens|monte carlo|sorrento|adriatic|aegean|malta|santorini|mykonos|dubrovnik|valletta|palma|marseille|genoa|naples|sicily|corfu|turkey|ephesus|alexandria|amalfi|nice|trapani|algiers|algeria|granada|cadiz|seville|malaga|valencia|florence|rhodes|thessaloniki|delphi|portofino|saint-tropez|morocco|casablanca|canary|madeira|lanzarote/i.test(
        t
      );
    case "caribbean":
      return /caribbean|san juan|bridgetown|barbados|st\.?\s*thomas|antigua|aruba|curacao|nassau|bahamas|martinique|st\.?\s*kitts|dominica|grenada|trinidad|bonaire|st\.?\s*maarten/i.test(
        t
      );
    case "japan":
      return /japan|tokyo|yokohama|hiroshima|kobe|nagasaki|osaka|akita|kanazawa|shimizu|incheon|seoul|busan/i.test(t);
    case "asia":
      return /asia|china|shanghai|beijing|hong kong|vietnam|thailand|singapore|malaysia|indonesia|philippines|taiwan|korea/i.test(
        t
      );
    case "transatlantic":
      return /transatlantic|miami to barcelona|barcelona to miami|new york to.*(southampton|lisbon|barcelona)|crossing the atlantic|atlantic crossing/i.test(
        t
      );
    case "transpacific":
      return /transpacific|san francisco to sydney|sydney to san francisco|tokyo to auckland|japan to new zealand|new zealand grand voyage|pacific crossing|crossing the pacific/i.test(
        t
      );
    case "south-pacific":
      return /south pacific|fiji|tahiti|polynesia|new caledonia|vanuatu|samoa|tonga|auckland|sydney|melbourne|brisbane|cairns|bali|darwin|perth|fremantle|adelaide|hobart/i.test(
        t
      );
    case "south-america":
      return /south america|brazil|argentina|chile|uruguay|buenos aires|rio de janeiro|montevideo|patagonia|amazon|panama|manta|lima|callao|valparaiso|ushuaia|puerto montt|castro|punta arenas|sao paulo|salvador|natal|belem|ecuador|peru|falkland|montevideo/i.test(
        t
      );
    case "british-isles":
      return /british isles|ireland|scotland|england|wales|dublin|edinburgh|liverpool|portsmouth|belfast|guernsey|jersey|orkney|hebrides/i.test(
        t
      );
    case "alaska":
      return /alaska|juneau|ketchikan|sitka|skagway|hubbard|inside passage|seward|whittier/i.test(t);
    case "africa":
      return /africa|south africa|cape town|durban|mauritius|seychelles|madagascar|mozambique|richards bay|colombo|sri lanka/i.test(t);
    case "antarctica":
      return /antarctica|antarctic|falkland|drake passage|ushuaia|punta arenas|chilean fjord/i.test(t);
    default:
      return false;
  }
}

function inferAzamaraDestinationSlug({ title, gtmDestination, routeFrom, routeTo } = {}) {
  const titleNorm = normaliseName(String(title || "").replace(/&amp;/g, "&"));
  const gtm = normaliseGtmDestination(gtmDestination);
  const fromNorm = normaliseName(routeFrom || "");
  const toNorm = normaliseName(routeTo || "");

  const routePair = [fromNorm, toNorm].filter(Boolean).join(" ");

  const trySlug = (slug, method) => {
    if (titleSupportsSlug(slug, `${titleNorm} ${routePair}`)) return { slug, method };
    return null;
  };

  if (/grand voyage|combination cruise|circle south america|circle pacific/i.test(titleNorm)) {
    if (/antarctica|falkland|drake passage|chilean fjord/i.test(titleNorm)) {
      const ant = trySlug("antarctica", "azamara_combination_antarctica");
      if (ant) return ant;
    }
    if (/iceland|greenland|\barctic\b|reykjavik|qaqortoq/i.test(titleNorm)) {
      const arctic = trySlug("northern-europe", "azamara_combination_iceland_arctic");
      if (arctic) return arctic;
    }
    if (/grand voyage/i.test(titleNorm) && fromNorm && toNorm) {
      if (
        (/australia|sydney|melbourne|brisbane|cairns|auckland/.test(fromNorm) &&
          /japan|tokyo|yokohama|osaka|kobe|nagasaki|hiroshima/.test(toNorm)) ||
        (/japan|tokyo|yokohama|osaka|kobe|nagasaki|hiroshima/.test(fromNorm) &&
          /new zealand|australia|sydney|auckland|melbourne/.test(toNorm))
      ) {
        return { slug: "transpacific", method: "azamara_grand_voyage_aus_jp_nz" };
      }
      if (/san francisco|los angeles|san diego|vancouver|seattle|tokyo|yokohama|sydney|auckland|honolulu|london|southampton/.test(`${fromNorm} ${toNorm}`)) {
        const tp = trySlug("transpacific", "azamara_grand_voyage_transpacific");
        if (tp) return tp;
        const ta = trySlug("transatlantic", "azamara_grand_voyage_transatlantic");
        if (ta) return ta;
      }
      if (/valparaiso|buenos aires|rio de janeiro|montevideo/.test(fromNorm) && /miami|fort lauderdale|new york|barcelona|lisbon/.test(toNorm)) {
        const ta = trySlug("transatlantic", "azamara_grand_voyage_sa_transatlantic");
        if (ta) return ta;
      }
    }
    if (/combination cruise/i.test(titleNorm) && /japan|tokyo|yokohama|hiroshima|kobe|nagasaki|osaka/i.test(titleNorm)) {
      const jp = trySlug("japan", "azamara_combination_japan_ports");
      if (jp) return jp;
    }
    if (
      /combination cruise/i.test(titleNorm) &&
      /australia|new zealand|sydney|auckland|melbourne|cairns|bali|hong kong|darwin|perth|fremantle|adelaide|hobart/.test(titleNorm)
    ) {
      const sp = trySlug("south-pacific", "azamara_combination_south_pacific");
      if (sp) return sp;
    }
    if (/combination cruise/i.test(titleNorm) && /turkey|egypt|greece|italy|algeria|spain|france|morocco|canary|madeira|seville|malaga|valencia|florence|rhodes|alexandria|ephesus|amalfi|trapani|nice|granada|cadiz|portofino|saint-tropez/i.test(titleNorm)) {
      const med = trySlug("mediterranean", "azamara_combination_mediterranean");
      if (med) return med;
    }
    if (/combination cruise/i.test(titleNorm) && /caribbean|bermuda|barbados|aruba|panama|peru|central america|miami|bridgetown|sint maarten|antigua|tobago|tortola|saint kitts/i.test(titleNorm)) {
      const car = trySlug("caribbean", "azamara_combination_caribbean");
      if (car) return car;
    }
    if (/combination cruise/i.test(titleNorm) && /alaska|kodiak|victoria|transpacific/i.test(titleNorm)) {
      const tp = trySlug("transpacific", "azamara_combination_transpacific");
      if (tp) return tp;
      const jp = trySlug("japan", "azamara_combination_japan_alaska");
      if (jp) return jp;
    }
    if (/combination cruise/i.test(titleNorm) && /singapore|sri lanka|south africa|africa|colombo|richards bay|mauritius|madagascar/i.test(titleNorm)) {
      const af = trySlug("africa", "azamara_combination_africa");
      if (af) return af;
      const as = trySlug("asia", "azamara_combination_asia_africa");
      if (as) return as;
    }
    const routeHit =
      trySlug("transpacific", "azamara_route_transpacific") ||
      trySlug("transatlantic", "azamara_route_transatlantic") ||
      trySlug("mediterranean", "azamara_route_mediterranean") ||
      trySlug("south-pacific", "azamara_route_south_pacific") ||
      trySlug("south-america", "azamara_route_south_america") ||
      trySlug("asia", "azamara_route_asia");
    if (routeHit) return routeHit;
  }

  if (fromNorm && toNorm) {
    if (/san diego|los angeles|san francisco|miami|new york|fort lauderdale/.test(fromNorm) && /london|southampton|lisbon|barcelona|rome|civitavecchia|piraeus|athens|venice|genoa|marseille|nice|florence|naples|malaga|cadiz|seville|valencia|palma|dubrovnik|istanbul|alexandria|casablanca|canary|lanzarote|gran canaria|las palmas|madeira|funchal|malta|valletta|corfu|mykonos|santorini/.test(toNorm)) {
      return { slug: "transatlantic", method: "azamara_route_transatlantic_endpoints" };
    }
    if (/valparaiso|buenos aires|rio de janeiro|montevideo|ushuaia|punta arenas/.test(fromNorm) && /miami|fort lauderdale|new york|barcelona|lisbon|london|southampton/.test(toNorm)) {
      return { slug: "transatlantic", method: "azamara_route_transatlantic_sa" };
    }
    if (/san francisco|los angeles|san diego|vancouver|seattle|tokyo|yokohama|sydney|auckland|london|southampton|miami|new york/.test(fromNorm + toNorm)) {
      const tp = trySlug("transpacific", "azamara_route_endpoints_transpacific");
      if (tp) return tp;
      const ta = trySlug("transatlantic", "azamara_route_endpoints_transatlantic");
      if (ta) return ta;
    }
    if (/venice|barcelona|lisbon|rome|civitavecchia|miami|southampton|new york/.test(fromNorm + toNorm)) {
      const med = trySlug("mediterranean", "azamara_route_endpoints_mediterranean");
      if (med) return med;
      const ta = trySlug("transatlantic", "azamara_route_endpoints_transatlantic");
      if (ta) return ta;
    }
    if (/san juan|bridgetown|miami|fort lauderdale/.test(fromNorm + toNorm)) {
      const car = trySlug("caribbean", "azamara_route_endpoints_caribbean");
      if (car) return car;
    }
    if (/tokyo|yokohama|hong kong|shanghai|incheon|seoul|beijing/.test(fromNorm + toNorm)) {
      const jp = trySlug("japan", "azamara_route_endpoints_japan");
      if (jp) return jp;
      const as = trySlug("asia", "azamara_route_endpoints_asia");
      if (as) return as;
    }
  }

  if (gtm && !isAzamaraNonGeographicGtm(gtm)) {
    const hintSlug = AZAMARA_GTM_GEOGRAPHIC_HINTS[gtm];
    if (hintSlug === "northern-europe" && gtm === "WESTERN EUROPE") {
      const med = trySlug("mediterranean", "azamara_gtm_western_europe_med");
      if (med) return med;
      const ne = trySlug("northern-europe", "azamara_gtm_western_europe_north");
      if (ne) return ne;
      return null;
    }
    if (hintSlug && titleSupportsSlug(hintSlug, titleNorm)) {
      return { slug: hintSlug, method: `azamara_gtm_hint_${gtm.toLowerCase().replace(/\s+/g, "_")}` };
    }
    if (gtm === "WESTERN EUROPE") {
      const med = trySlug("mediterranean", "azamara_gtm_western_europe_title");
      if (med) return med;
      const ne = trySlug("northern-europe", "azamara_gtm_western_europe_title");
      if (ne) return ne;
    }
  }

  const titleOrder = [
    ["antarctica", "azamara_title_antarctica"],
    ["japan", "azamara_title_japan"],
    ["british-isles", "azamara_title_british_isles"],
    ["canada-new-england", "azamara_title_canada"],
    ["caribbean", "azamara_title_caribbean"],
    ["mediterranean", "azamara_title_mediterranean"],
    ["northern-europe", "azamara_title_northern_europe"],
    ["alaska", "azamara_title_alaska"],
    ["south-america", "azamara_title_south_america"],
    ["south-pacific", "azamara_title_south_pacific"],
    ["transpacific", "azamara_title_transpacific"],
    ["transatlantic", "azamara_title_transatlantic"],
    ["asia", "azamara_title_asia"],
    ["australia-new-zealand", "azamara_title_anz"],
    ["africa", "azamara_title_africa"]
  ];
  for (const [slug, method] of titleOrder) {
    if (titleSupportsSlug(slug, titleNorm)) return { slug, method };
  }

  return null;
}

function findDestinationBySlug(slug, destinations = []) {
  const key = normaliseName(slug).replace(/\s+/g, "-");
  return (destinations || []).find((d) => d.slug === key || normaliseName(d.slug) === normaliseName(slug)) || null;
}

function preferAzamaraDestinationHits(destHits, title, gtmDestination) {
  if (!destHits?.length) return destHits;
  const titleNorm = normaliseName(String(title || "").replace(/&amp;/g, "&"));
  if (/galapagos|galapagos islands|puerto ayora|baltra/i.test(titleNorm)) return destHits;
  if (
    titleSupportsSlug("south-america", titleNorm) ||
    normaliseGtmDestination(gtmDestination) === "SOUTH AMERICA"
  ) {
    const filtered = destHits.filter((h) => h.dest.slug !== "galapagos");
    if (filtered.length) return filtered;
  }
  return destHits;
}

function resolveAzamaraDestination({
  title,
  description,
  excerpt,
  gtmDestination,
  routeFrom,
  routeTo,
  destinations,
  destinationAliases,
  matchDestination,
  pickDestinationFromHits
}) {
  const gtmIsNonGeo = isAzamaraNonGeographicGtm(gtmDestination);

  if (gtmIsNonGeo || gtmDestination) {
    const inferredFirst = inferAzamaraDestinationSlug({ title, gtmDestination, routeFrom, routeTo });
    if (inferredFirst?.slug) {
      const dest = findDestinationBySlug(inferredFirst.slug, destinations);
      if (dest) {
        return {
          destination: dest,
          destHits: [{ dest, evidence: inferredFirst.method }],
          method: inferredFirst.method
        };
      }
    }
  }

  const sanitisedTitle = sanitiseAzamaraTitleForMatching(title);
  let destHits = preferAzamaraDestinationHits(
    matchDestination(sanitisedTitle, destinations, destinationAliases),
    title,
    gtmDestination
  );
  let destination = pickDestinationFromHits(destHits, title);
  if (destination) {
    return { destination, destHits, method: "title_only" };
  }

  const sanitisedBlob = sanitiseAzamaraDestinationBlob({ title, description, excerpt, gtmDestination });
  destHits = preferAzamaraDestinationHits(
    matchDestination(sanitisedBlob, destinations, destinationAliases),
    title,
    gtmDestination
  );
  destination = pickDestinationFromHits(destHits, title);
  if (destination) {
    return { destination, destHits, method: "sanitised_blob" };
  }

  if (!gtmIsNonGeo && gtmDestination) {
    const hint = inferAzamaraDestinationSlug({ title, gtmDestination, routeFrom, routeTo });
    if (hint?.slug) {
      const dest = findDestinationBySlug(hint.slug, destinations);
      if (dest) {
        return {
          destination: dest,
          destHits: [{ dest, evidence: hint.method }],
          method: hint.method
        };
      }
    }
  }

  const inferred = inferAzamaraDestinationSlug({ title, gtmDestination, routeFrom, routeTo });
  if (inferred?.slug) {
    const dest = findDestinationBySlug(inferred.slug, destinations);
    if (dest) {
      return {
        destination: dest,
        destHits: [{ dest, evidence: inferred.method }],
        method: inferred.method
      };
    }
  }

  return { destination: null, destHits: [], method: null };
}

module.exports = {
  AZAMARA_NON_GEOGRAPHIC_GTM,
  AZAMARA_GTM_GEOGRAPHIC_HINTS,
  isAzamaraNonGeographicGtm,
  sanitiseAzamaraDestinationBlob,
  sanitiseAzamaraTitleForMatching,
  inferAzamaraDestinationSlug,
  preferAzamaraDestinationHits,
  resolveAzamaraDestination,
  titleSupportsSlug
};
