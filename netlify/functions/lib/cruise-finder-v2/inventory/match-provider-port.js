/**
 * Enhanced deterministic port matching for provider strings like
 * "Seattle, Washington" / "Victoria, Canada".
 * Does not write aliases to production. Soft proposals only.
 */

const { normaliseName } = require("../enrichment/match-entities");
const { isSeaDayLabel, isScenicCruisingLabel } = require("./classify-itinerary");

const STATE_ABBREV = Object.freeze({
  alabama: "al",
  alaska: "ak",
  arizona: "az",
  arkansas: "ar",
  california: "ca",
  colorado: "co",
  connecticut: "ct",
  delaware: "de",
  florida: "fl",
  georgia: "ga",
  hawaii: "hi",
  idaho: "id",
  illinois: "il",
  indiana: "in",
  iowa: "ia",
  kansas: "ks",
  kentucky: "ky",
  louisiana: "la",
  maine: "me",
  maryland: "md",
  massachusetts: "ma",
  michigan: "mi",
  minnesota: "mn",
  mississippi: "ms",
  missouri: "mo",
  montana: "mt",
  nebraska: "ne",
  nevada: "nv",
  "new hampshire": "nh",
  "new jersey": "nj",
  "new mexico": "nm",
  "new york": "ny",
  "north carolina": "nc",
  "north dakota": "nd",
  ohio: "oh",
  oklahoma: "ok",
  oregon: "or",
  pennsylvania: "pa",
  "rhode island": "ri",
  "south carolina": "sc",
  "south dakota": "sd",
  tennessee: "tn",
  texas: "tx",
  utah: "ut",
  vermont: "vt",
  virginia: "va",
  washington: "wa",
  "west virginia": "wv",
  wisconsin: "wi",
  wyoming: "wy",
  "british columbia": "bc",
  ontario: "on",
  quebec: "qc",
  alberta: "ab"
});

const COUNTRY_ALIASES = Object.freeze({
  usa: "united states",
  us: "united states",
  "u s": "united states",
  "united states of america": "united states",
  uk: "united kingdom",
  "great britain": "united kingdom",
  britain: "united kingdom",
  ca: "canada",
  can: "canada"
});

function expandRegionToken(token) {
  const n = normaliseName(token);
  if (!n) return [];
  const out = new Set([n]);
  if (COUNTRY_ALIASES[n]) out.add(COUNTRY_ALIASES[n]);
  if (STATE_ABBREV[n]) out.add(STATE_ABBREV[n]);
  for (const [full, abbr] of Object.entries(STATE_ABBREV)) {
    if (abbr === n) out.add(full);
  }
  return [...out];
}

/**
 * Build candidate strings without discarding parenthetical / suffix info until needed.
 * @param {string} raw
 * @returns {string[]}
 */
function buildPortCandidates(raw) {
  const text = String(raw || "")
    .replace(/[™®©]/g, "")
    .trim();
  if (!text) return [];
  const candidates = [text];

  // Ft. / St. expansions
  const expanded = text
    .replace(/\bFt\.?\b/gi, "Fort")
    .replace(/\bSt\.?\b/gi, "Saint");
  if (expanded !== text) candidates.push(expanded);

  // Parenthetical: keep both full, outside, and inside
  const paren = text.match(/^(.+?)\s*\((.+?)\)\s*(?:,\s*(.+))?$/);
  if (paren) {
    candidates.push(paren[1].trim());
    candidates.push(paren[2].trim());
    if (paren[3]) {
      candidates.push(`${paren[1].trim()}, ${paren[3].trim()}`);
      candidates.push(paren[3].trim());
    }
  }

  // City, Region
  const commaParts = text.split(",").map((p) => p.trim()).filter(Boolean);
  if (commaParts.length >= 2) {
    candidates.push(commaParts[0]);
    candidates.push(commaParts.slice(1).join(", "));
    // City without scenic wording
    const cityClean = commaParts[0].replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim();
    if (cityClean) candidates.push(cityClean);
  }

  // Strip trailing country/state for alternate: "Victoria Canada" style
  if (commaParts.length === 2) {
    candidates.push(`${commaParts[0]} ${commaParts[1]}`);
  }

  return [...new Set(candidates.filter(Boolean))];
}

function portIdentityStrings(port) {
  const list = [
    port.canonical_name,
    port.display_name,
    port.city,
    ...(port.aliases || [])
  ];
  // "Victoria BC" → also "Victoria"
  if (port.canonical_name) {
    const withoutBc = String(port.canonical_name).replace(/\s+BC$/i, "").trim();
    if (withoutBc && withoutBc !== port.canonical_name) list.push(withoutBc);
  }
  return list.filter(Boolean);
}

/**
 * @param {string} providerPortName
 * @param {object[]} ports
 * @param {{ proposedAliases?: object[] }} [options]
 */
function matchProviderPort(providerPortName, ports, options = {}) {
  const raw = String(providerPortName || "").trim();
  if (!raw) {
    return {
      status: "NOT_FOUND",
      id: null,
      matchedName: null,
      via: null,
      portName: raw,
      latitude: null,
      longitude: null
    };
  }

  if (isSeaDayLabel(raw)) {
    return {
      status: "NOT_APPLICABLE",
      id: null,
      matchedName: null,
      via: "sea",
      portName: raw,
      latitude: null,
      longitude: null
    };
  }

  const scenic = isScenicCruisingLabel(raw);
  const candidates = buildPortCandidates(raw);
  const exact = [];
  const alias = [];
  const commaParts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  const regionTokens =
    commaParts.length >= 2 ? expandRegionToken(commaParts[commaParts.length - 1]) : [];

  function regionAligned(port) {
    if (!regionTokens.length) return true;
    const regionPool = [
      normaliseName(port.country),
      normaliseName(port.country_code),
      normaliseName(port.region),
      ...((port.aliases || []).map(normaliseName))
    ];
    const display = normaliseName(port.display_name);
    return regionTokens.some(
      (t) =>
        regionPool.includes(t) ||
        display.includes(t) ||
        regionPool.some((r) => r && (r.includes(t) || t.includes(r)))
    );
  }

  for (const port of ports || []) {
    const identities = portIdentityStrings(port).map(normaliseName);
    for (const cand of candidates) {
      const needle = normaliseName(cand);
      if (!needle) continue;
      if (identities.includes(needle)) {
        // When provider includes a country/region suffix, reject cross-country city collisions
        // (e.g. Sydney, Australia vs Sydney Nova Scotia).
        if (regionTokens.length && !regionAligned(port)) continue;
        const canonHit =
          normaliseName(port.canonical_name) === needle ||
          normaliseName(port.display_name) === needle ||
          normaliseName(port.city) === needle;
        if (canonHit) exact.push(port);
        else alias.push(port);
      }
    }

    // City + region: city matches AND region token aligns with country/code/alias/display
    if (commaParts.length === 2) {
      const cityNeedle = normaliseName(commaParts[0].replace(/\s*\(.*?\)\s*/g, " "));
      const cityOk =
        normaliseName(port.city) === cityNeedle ||
        normaliseName(port.canonical_name) === cityNeedle ||
        normaliseName(String(port.canonical_name).replace(/\s+BC$/i, "")) === cityNeedle;
      if (cityOk && regionAligned(port)) exact.push(port);
    }
  }

  // Proposed alias table (POC review list) — treat as alias match when target resolves uniquely
  for (const proposal of options.proposedAliases || []) {
    if (!proposal?.proposedAlias || !proposal.targetCanonicalName) continue;
    if (normaliseName(proposal.providerExample) !== normaliseName(raw) &&
        normaliseName(proposal.proposedAlias) !== normaliseName(raw)) {
      continue;
    }
    const target = (ports || []).filter(
      (p) => normaliseName(p.canonical_name) === normaliseName(proposal.targetCanonicalName)
    );
    if (target.length === 1 && (!regionTokens.length || regionAligned(target[0]))) {
      alias.push(target[0]);
    }
  }

  let poolExact = [...new Map(exact.map((p) => [p.match_key || p.id, p])).values()];
  let poolAlias = [...new Map(alias.map((p) => [p.match_key || p.id, p])).values()];
  if (regionTokens.length) {
    const filteredExact = poolExact.filter(regionAligned);
    const filteredAlias = poolAlias.filter(regionAligned);
    if (filteredExact.length || filteredAlias.length) {
      poolExact = filteredExact;
      poolAlias = filteredAlias;
    }
  }
  const pool = poolExact.length ? poolExact : poolAlias;

  if (!pool.length) {
    return {
      status: scenic ? "NOT_FOUND" : "NOT_FOUND",
      id: null,
      matchedName: null,
      via: scenic ? "scenic_unmatched" : null,
      portName: raw,
      latitude: null,
      longitude: null,
      scenic
    };
  }
  if (pool.length > 1) {
    return {
      status: "AMBIGUOUS",
      id: null,
      matchedName: null,
      via: poolExact.length ? "exact" : "alias",
      portName: raw,
      latitude: null,
      longitude: null,
      candidates: pool.map((p) => ({ id: p.id, name: p.canonical_name })),
      scenic
    };
  }

  const hit = pool[0];
  const viaAlias = !poolExact.length;
  return {
    status: viaAlias ? "ALIAS_MATCH" : "MATCHED",
    id: hit.id,
    matchedName: hit.canonical_name,
    via: viaAlias ? "alias" : "exact",
    portName: raw,
    latitude: Number.isFinite(hit.latitude) ? hit.latitude : null,
    longitude: Number.isFinite(hit.longitude) ? hit.longitude : null,
    scenic
  };
}

module.exports = {
  matchProviderPort,
  buildPortCandidates,
  expandRegionToken,
  STATE_ABBREV,
  COUNTRY_ALIASES
};
