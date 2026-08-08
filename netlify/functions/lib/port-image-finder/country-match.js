/**
 * Country/region mention helpers for port image false-positive protection.
 */

const COUNTRY_GROUPS = [
  { codes: ["AU"], names: ["australia", "australian"], regions: ["nsw", "new south wales", "victoria", "queensland", "western australia", "tasmania", "south australia", "northern territory"] },
  { codes: ["NZ"], names: ["new zealand", "aotearoa"], regions: ["otago", "canterbury", "wellington", "auckland", "south island", "north island"] },
  { codes: ["US", "USA"], names: ["united states", "usa", "u.s.", "america", "american"], regions: ["maine", "oregon", "california", "florida", "new york", "washington", "hawaii", "alaska", "texas"] },
  { codes: ["GB", "UK"], names: ["united kingdom", "uk", "britain", "british", "england", "scotland", "wales", "northern ireland"], regions: ["tyne", "devon", "cornwall", "highlands"] },
  { codes: ["CA"], names: ["canada", "canadian"], regions: ["british columbia", "bc", "ontario", "quebec", "nova scotia", "alberta"] },
  { codes: ["IT"], names: ["italy", "italian"], regions: ["sicily", "tuscany", "lazio", "campania"] },
  { codes: ["ES"], names: ["spain", "spanish"], regions: ["catalonia", "andalusia", "balearic"] },
  { codes: ["GR"], names: ["greece", "greek"], regions: ["aegean", "crete", "santorini"] },
  { codes: ["NO"], names: ["norway", "norwegian"], regions: ["fjord", "bergen", "tromso"] },
  { codes: ["JP"], names: ["japan", "japanese"], regions: ["tokyo", "yokohama", "osaka"] },
  { codes: ["CL"], names: ["chile", "chilean"], regions: ["patagonia", "magallanes", "punta arenas"] },
  { codes: ["MA"], names: ["morocco", "moroccan", "maroc"], regions: ["casablanca"] },
  { codes: ["TN"], names: ["tunisia", "tunisian"], regions: ["tunis", "la goulette"] },
  { codes: ["IS"], names: ["iceland", "icelandic"], regions: ["akureyri", "reykjavik"] }
];
function normalizeCountryKey(country, countryCode) {
  const code = String(countryCode || "").trim().toUpperCase();
  if (code) {
    const group = COUNTRY_GROUPS.find((g) => g.codes.includes(code));
    if (group) return group.codes[0];
  }
  const text = String(country || "").trim().toLowerCase();
  if (!text) return "";
  for (const group of COUNTRY_GROUPS) {
    if (group.names.some((n) => text.includes(n) || n.includes(text))) return group.codes[0];
  }
  return text.slice(0, 40);
}

function groupForKey(key) {
  if (!key) return null;
  const upper = key.toUpperCase();
  return COUNTRY_GROUPS.find((g) => g.codes.includes(upper) || g.names.includes(key)) || null;
}

function textMentionsGroup(text, group) {
  if (!group || !text) return false;
  const hay = String(text).toLowerCase();
  if (group.names.some((n) => hay.includes(n))) return true;
  if (group.regions.some((r) => hay.includes(r))) return true;
  return false;
}

/**
 * Returns true when candidate text strongly suggests a different country/region than the port.
 */
function hasConflictingLocation(text, port) {
  const hay = String(text || "").toLowerCase();
  if (!hay.trim()) return false;

  const portKey = normalizeCountryKey(port?.country, port?.country_code);
  const portGroup = groupForKey(portKey);
  const portRegion = String(port?.region || "").trim().toLowerCase();
  const portName = String(port?.canonical_name || port?.display_name || "").trim().toLowerCase();

  for (const group of COUNTRY_GROUPS) {
    if (portGroup && group.codes[0] === portGroup.codes[0]) continue;
    if (!textMentionsGroup(hay, group)) continue;

    // Ambiguous city names: require region hint when both groups could match partial tokens
    const ambiguousNames = [
      "albany",
      "newcastle",
      "victoria",
      "victoria bc",
      "portland",
      "sydney",
      "birmingham",
      "richmond"
    ];
    const isAmbiguous = ambiguousNames.some((name) => portName === name || portName.startsWith(`${name} `));
    if (isAmbiguous) {
      if (portRegion && hay.includes(portRegion)) return false;
      if (portGroup && textMentionsGroup(hay, portGroup)) return false;
      return true;
    }

    // Port country known and candidate mentions another country explicitly
    if (portGroup) return true;
  }

  return false;
}

function countryMentionScore(text, port) {
  const hay = String(text || "").toLowerCase();
  const portKey = normalizeCountryKey(port?.country, port?.country_code);
  const portGroup = groupForKey(portKey);
  if (!portGroup || !hay) return 0;

  let score = 0;
  if (portGroup.names.some((n) => hay.includes(n))) score += 28;
  const region = String(port?.region || "").trim().toLowerCase();
  if (region && hay.includes(region)) score += 22;
  if (portGroup.regions.some((r) => hay.includes(r))) score += 12;
  return score;
}

module.exports = {
  normalizeCountryKey,
  hasConflictingLocation,
  countryMentionScore
};
