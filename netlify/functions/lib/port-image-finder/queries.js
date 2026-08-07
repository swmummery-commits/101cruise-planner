/**
 * Generate port-specific image search query variants.
 */

function cleanPart(value) {
  return String(value || "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function primaryName(port) {
  return cleanPart(port?.canonical_name || port?.display_name || port?.city || "");
}

function locationParts(port) {
  const parts = [];
  const city = cleanPart(port?.city);
  const region = cleanPart(port?.region);
  const country = cleanPart(port?.country);
  const name = primaryName(port);

  if (city && city.toLowerCase() !== name.toLowerCase()) parts.push(city);
  if (region) parts.push(region);
  if (country) parts.push(country);
  return parts;
}

function suffixVariants() {
  return ["cruise port", "harbour", "harbor", "port", "waterfront"];
}

/**
 * @param {object} port
 * @returns {string[]}
 */
function buildPortImageQueries(port) {
  const name = primaryName(port);
  if (!name) return [];

  const loc = locationParts(port);
  const locStr = loc.join(" ");
  const queries = new Set();

  for (const suffix of suffixVariants()) {
    if (locStr) queries.add(`${name} ${suffix} ${locStr}`.replace(/\s+/g, " ").trim());
    queries.add(`${name} ${suffix}`.replace(/\s+/g, " ").trim());
  }

  if (loc.length >= 2) {
    queries.add(`${name} ${loc[0]} ${loc[loc.length - 1]}`.replace(/\s+/g, " ").trim());
  }
  if (locStr) {
    queries.add(`${name} ${locStr}`.replace(/\s+/g, " ").trim());
  }

  return [...queries].filter((q) => q.length >= 4).slice(0, 8);
}

module.exports = {
  buildPortImageQueries,
  primaryName,
  locationParts
};
