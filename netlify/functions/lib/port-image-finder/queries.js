/**
 * Generate port-specific image search query variants.
 */

const REGION_CONFLICTS = {
  CA: ["alaska", "hawaii", "florida", "california"],
  AU: ["alaska", "england", "scotland", "texas", "california"],
  NZ: ["alaska", "australia", "england"],
  US: ["british columbia", "ontario", "quebec", "scotland", "england"],
  GB: ["australia", "new zealand", "alaska", "british columbia"]
};

function cleanPart(value) {
  return String(value || "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function primaryName(port) {
  return cleanPart(port?.canonical_name || port?.display_name || port?.city || "");
}

/** Port identity used for image search — keeps terminal/port wording when modelled as aliases. */
function searchIdentityName(port) {
  const canonical = cleanPart(port?.canonical_name);
  const city = cleanPart(port?.city);
  const aliases = Array.isArray(port?.aliases) ? port.aliases.map((a) => cleanPart(a)).filter(Boolean) : [];

  if (/^port\s+/i.test(canonical)) return canonical;
  const portAlias = aliases.find((a) => /^port\s+/i.test(a));
  if (portAlias) return portAlias;

  if (city && city.toLowerCase() !== canonical.toLowerCase() && /^port\s+/i.test(city)) {
    return city;
  }

  return canonical || city || "";
}

function regionIsCompatible(countryCode, region) {
  const code = String(countryCode || "").trim().toUpperCase();
  const regionLower = String(region || "").trim().toLowerCase();
  if (!code || !regionLower) return true;
  const conflicts = REGION_CONFLICTS[code] || [];
  if (conflicts.some((token) => regionLower.includes(token))) return false;
  if (code === "CA" && regionLower === "alaska") return false;
  if (code === "AU" && (regionLower === "alaska" || regionLower === "victoria bc")) return false;
  return true;
}

function locationParts(port) {
  const parts = [];
  const city = cleanPart(port?.city);
  const region = cleanPart(port?.region);
  const country = cleanPart(port?.country);
  const name = searchIdentityName(port);

  if (city && city.toLowerCase() !== name.toLowerCase()) parts.push(city);
  if (region && regionIsCompatible(port?.country_code, region)) parts.push(region);
  if (country) parts.push(country);
  return parts;
}

function normalizeQuery(query) {
  return String(query || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function addQuery(set, query) {
  const cleaned = String(query || "").replace(/\s+/g, " ").trim();
  if (cleaned.length < 4) return;
  const key = normalizeQuery(cleaned);
  if (!key) return;
  if ([...set].some((existing) => normalizeQuery(existing) === key)) return;
  set.add(cleaned);
}

/**
 * @param {object} port
 * @returns {string[]}
 */
function buildPortImageQueries(port) {
  const name = searchIdentityName(port);
  if (!name) return [];

  const loc = locationParts(port);
  const country = cleanPart(port?.country);
  const queries = new Set();

  if (country) {
    addQuery(queries, `${name} ${country} harbour`);
    addQuery(queries, `${name} ${country} waterfront`);
    addQuery(queries, `${name} cruise port ${country}`);
  }

  if (loc.length) {
    const locTail = loc.slice(-2).join(" ");
    addQuery(queries, `${name} ${locTail} harbour`);
  }

  addQuery(queries, `${name} harbour`);
  addQuery(queries, `${name} waterfront`);

  return [...queries].slice(0, 4);
}

module.exports = {
  buildPortImageQueries,
  primaryName,
  searchIdentityName,
  locationParts,
  regionIsCompatible
};
