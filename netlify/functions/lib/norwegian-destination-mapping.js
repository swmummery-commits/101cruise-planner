/**
 * Norwegian Cruise Line — deterministic destination assignment from browse destinationCodes.
 */

const { resolveOperationalDestination } = require("./discovery-destination-resolver");
const { precedenceRank } = require("./destination-classification");

/** Geographic NCL browse codes → operational destination slug */
const NCL_DESTINATION_CODE_SLUG = Object.freeze({
  AUSTRALIA: "australia-new-zealand",
  AUSTRALIA_NEW_ZEALAND: "australia-new-zealand",
  ALASKA: "alaska",
  ASIA: "asia",
  BAHAMAS: "caribbean",
  BERMUDA: "caribbean",
  CANADA_NEW_ENGL: "canada-new-england",
  CARIBBEAN: "caribbean",
  EXTRAORDINARY_JOURNEYS: null,
  GREEK_ISLES: "greek-islands",
  HAWAII: "hawaii",
  MEDITERRANEAN: "mediterranean",
  MEXICAN_RIVIERA: "mexican-riviera",
  NORTHERN_EUROPE: "northern-europe",
  PANAMA_CANAL: "panama-canal",
  PACIFIC_COASTAL: "pacific-coast",
  SOUTH_AMERICA: "south-america",
  SOUTH_PACIFIC: "south-pacific",
  TRANSATLANTIC: "transatlantic",
  WEEKEND: null
});

/** Marketing or non-geographic codes — never used as primary destination */
const NCL_NON_GEOGRAPHIC_CODES = Object.freeze(new Set(["EXTRAORDINARY_JOURNEYS", "WEEKEND"]));

const JAPAN_PORT_TOKENS = /japan|tokyo|yokohama|osaka|kobe|hiroshima|nagasaki|kanazawa|akita|hakodate|shimizu|sakaiminato|aomori|nagoya|sendai|maizuru|incheon|seoul|busan/i;

function normaliseCodes(codes = []) {
  return (Array.isArray(codes) ? codes : [])
    .map((code) => String(code || "").trim().toUpperCase())
    .filter(Boolean);
}

function geographicCodes(codes = []) {
  return normaliseCodes(codes).filter((code) => !NCL_NON_GEOGRAPHIC_CODES.has(code));
}

function pickPrimaryGeographicCode(codes = []) {
  const geo = geographicCodes(codes);
  if (!geo.length) return null;
  return geo.sort((a, b) => precedenceRank(NCL_DESTINATION_CODE_SLUG[a] || "zzz") - precedenceRank(NCL_DESTINATION_CODE_SLUG[b] || "zzz"))[0];
}

function resolveSlugFromCodes(codes = [], context = {}) {
  const geo = geographicCodes(codes);
  const slugs = geo
    .map((code) => ({ code, slug: NCL_DESTINATION_CODE_SLUG[code] ?? null }))
    .filter((row) => row.slug);

  if (slugs.length === 1) return { slug: slugs[0].slug, method: "ncl_single_destination_code", source_code: slugs[0].code, confidence: "high" };

  if (slugs.length > 1) {
    const ranked = slugs.sort(
      (a, b) => precedenceRank(a.slug) - precedenceRank(b.slug) || geo.indexOf(a.code) - geo.indexOf(b.code)
    );
    return {
      slug: ranked[0].slug,
      method: "ncl_multi_code_precedence",
      source_code: ranked[0].code,
      all_codes: geo,
      confidence: "high"
    };
  }

  if (geo.includes("ASIA") && JAPAN_PORT_TOKENS.test(context.port_blob || "")) {
    return { slug: "japan", method: "ncl_asia_japan_port_evidence", source_code: "ASIA", confidence: "high" };
  }

  const medTokens = /ravenna|trieste|venice|barcelona|rome|civitavecchia|piraeus|athens|mediterranean|santorini|mykonos|dubrovnik|split|kotor|valletta|palma|marseille|nice|genoa|livorno|florence|naples|sicily|malta|tarragona|corfu|messina|argostoli|zadar|ancona|catania|palermo/i;
  if (medTokens.test(context.port_blob || "")) {
    return { slug: "mediterranean", method: "ncl_mediterranean_port_evidence", source_code: null, confidence: "medium" };
  }

  return null;
}

function resolveNorwegianDestinationAssignment({ destination_codes = [], dbRow = {}, destinations = [] }) {
  const codes = normaliseCodes(destination_codes.length ? destination_codes : dbRow?.raw_extract?.ncl_destination_codes);
  const portBlob = [
    dbRow.departure_port,
    dbRow.raw_extract?.ncl_disembarkation_port,
    ...(Array.isArray(dbRow.itinerary_ports) ? dbRow.itinerary_ports : [])
  ]
    .filter(Boolean)
    .join(" ");

  const codeHint = resolveSlugFromCodes(codes, {
    port_blob: portBlob,
    nights: dbRow.nights,
    title: dbRow.itinerary
  });

  const operational = resolveOperationalDestination({
    title: dbRow.itinerary,
    itinerary: Array.isArray(dbRow.itinerary_ports) ? dbRow.itinerary_ports.join(", ") : dbRow.itinerary,
    structuredDestination: codeHint?.slug || null,
    departurePort: dbRow.departure_port,
    arrivalPort: dbRow.raw_extract?.ncl_disembarkation_port || null,
    nights: dbRow.nights,
    destinations,
    preferredDestination: codeHint ? { slug: codeHint.slug, score: 95 } : null
  });

  const slug = operational?.destinationKey || codeHint?.slug || null;
  const destination = slug ? destinations.find((d) => d.slug === slug) || null : null;

  return {
    destination_codes: codes,
    geographic_codes: geographicCodes(codes),
    primary_code: pickPrimaryGeographicCode(codes),
    proposed_slug: slug,
    destination_id: destination?.id || null,
    destination_name: destination?.name || null,
    method: operational?.method || codeHint?.method || null,
    confidence: destination?.id ? codeHint?.confidence || operational?.confidence || "medium" : "unresolved",
    code_hint: codeHint,
    operational
  };
}

function auditNorwegianDestinationCodes(records = []) {
  const counts = new Map();
  for (const record of records) {
    for (const code of normaliseCodes(record?.destinationCodes || record?.destination_codes)) {
      counts.set(code, (counts.get(code) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([code, count]) => ({
      code,
      proposed_slug: NCL_DESTINATION_CODE_SLUG[code] ?? null,
      geographic: !NCL_NON_GEOGRAPHIC_CODES.has(code),
      count
    }));
}

module.exports = {
  NCL_DESTINATION_CODE_SLUG,
  NCL_NON_GEOGRAPHIC_CODES,
  normaliseCodes,
  geographicCodes,
  pickPrimaryGeographicCode,
  resolveSlugFromCodes,
  resolveNorwegianDestinationAssignment,
  auditNorwegianDestinationCodes
};
