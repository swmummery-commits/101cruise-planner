/**
 * Line-aware ship resolution for Discovery automation.
 * Never cross-line fuzzy match. Generic vocabulary never resolves.
 */

const { normaliseName } = require("./cruise-finder-v2/enrichment/match-entities");
const { guessLooksNonSailing, matchesKnownShip, normaliseKnownShipNames } = require("./discovery-non-sailing-filter");

const SHIP_RESOLVER_VERSION = "2026-08-02.auto1";
const AUTO_ALIAS_MIN_CONFIDENCE = 90;
const AUTO_RESOLVE_MIN_CONFIDENCE = 85;
const FUZZY_MIN_CONFIDENCE = 82;

function normaliseShipName(value) {
  return normaliseName(String(value || "").replace(/['']/g, ""))
    .replace(/\b(ms|mv|ss|m\s?s\s?)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripLinePrefix(needle, lineName) {
  const n = normaliseShipName(needle);
  const line = normaliseShipName(lineName);
  if (line && n.startsWith(`${line} `)) return n.slice(line.length).trim();
  return n;
}

function lineShips(ships, cruiseLineId) {
  return (ships || []).filter((s) => s.cruise_line_id === cruiseLineId);
}

function resolveViaExactName(rawName, ships, cruiseLineName) {
  const needle = stripLinePrefix(rawName, cruiseLineName);
  if (!needle || guessLooksNonSailing(needle)) return null;
  for (const ship of ships) {
    const full = normaliseShipName(ship.name);
    if (full === needle) {
      return { ship, method: "exact_name", confidence: 100, raw: rawName };
    }
  }
  return null;
}

function resolveViaAlias(rawName, ships, aliases, cruiseLineName) {
  const hay = ` ${normaliseShipName(rawName)} `;
  if (!hay.trim()) return null;
  for (const alias of aliases || []) {
    const needle = normaliseShipName(alias.normalised_alias || alias.raw_alias);
    if (!needle || guessLooksNonSailing(needle)) continue;
    if (hay.includes(` ${needle} `)) {
      const ship = ships.find((s) => s.id === alias.ship_id);
      if (ship) {
        return { ship, method: "stored_alias", confidence: 98, raw: rawName, alias };
      }
    }
  }
  return resolveViaExactName(rawName, ships, cruiseLineName);
}

function resolveViaStructuredExtract(extract, ships, cruiseLineName) {
  const blob = [extract?.title, extract?.description].filter(Boolean).join("\n");
  if (!blob) return null;
  const strong = blob.match(/\b(?:aboard|onboard|on board|sailing on|ship:?)\s+(?:the\s+)?([A-Z][A-Za-z0-9'’.\-]+(?:\s+[A-Z][A-Za-z0-9'’.\-]+){0,4})/);
  if (strong?.[1]) {
    const hit = resolveViaExactName(strong[1], ships, cruiseLineName);
    if (hit) return { ...hit, method: "structured_phrase" };
  }
  const tagged = blob.match(/<strong>([^<]{3,60})<\/strong>/i);
  if (tagged?.[1]) {
    const hit = resolveViaExactName(tagged[1], ships, cruiseLineName);
    if (hit) return { ...hit, method: "structured_strong_tag" };
  }
  const aboard = blob.match(/\baboard\s+(?:the\s+)?([A-Z][A-Za-z0-9'’.\-]+(?:\s+[A-Z][A-Za-z0-9'’.\-]+){0,4})/);
  if (aboard?.[1]) {
    const hit = resolveViaExactName(aboard[1], ships, cruiseLineName);
    if (hit) return { ...hit, method: "aboard_phrase" };
  }
  return null;
}

function diceCoefficient(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;
  const bigrams = new Map();
  for (let i = 0; i < x.length - 1; i += 1) {
    const bg = x.slice(i, i + 2);
    bigrams.set(bg, (bigrams.get(bg) || 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < y.length - 1; i += 1) {
    const bg = y.slice(i, i + 2);
    const count = bigrams.get(bg) || 0;
    if (count > 0) {
      overlap += 1;
      bigrams.set(bg, count - 1);
    }
  }
  return (2 * overlap) / (x.length - 1 + (y.length - 1));
}

function resolveViaUniqueFuzzy(rawName, ships, cruiseLineName) {
  const needle = stripLinePrefix(rawName, cruiseLineName);
  if (!needle || guessLooksNonSailing(needle) || needle.length < 4) return null;

  const candidates = [];
  for (const ship of ships) {
    const full = normaliseShipName(ship.name);
    let score = 0;
    if (full === needle) score = 100;
    else if (full.includes(needle) || needle.includes(full)) {
      score = Math.round(75 + (Math.min(full.length, needle.length) / Math.max(full.length, needle.length)) * 20);
    } else {
      score = Math.round(diceCoefficient(full, needle) * 100);
    }
    if (score >= FUZZY_MIN_CONFIDENCE) {
      candidates.push({ ship, score, normalised_db: full });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length) return null;
  if (candidates.length > 1 && candidates[0].score - candidates[1].score < 8) return null;
  return {
    ship: candidates[0].ship,
    method: "unique_fuzzy",
    confidence: candidates[0].score,
    raw: rawName,
    competing: candidates.length > 1 ? candidates[1].ship.name : null
  };
}

/**
 * Full resolution sequence for one raw ship name within a cruise line.
 */
function resolveShipForLine({
  rawShipName,
  cruiseLineId,
  cruiseLineName,
  ships,
  aliases,
  extract,
  suggestedMatch
}) {
  const lineScopedShips = lineShips(ships, cruiseLineId);
  if (!lineScopedShips.length) {
    return { resolved: false, reason: "no_ships_for_line", resolverVersion: SHIP_RESOLVER_VERSION };
  }

  const sources = [
    rawShipName,
    extract?.title,
    extract?.description,
    suggestedMatch?.normalised_raw
  ].filter(Boolean);

  for (const raw of sources) {
    if (raw === rawShipName && guessLooksNonSailing(stripLinePrefix(raw, cruiseLineName))) {
      continue;
    }
    const viaAlias = resolveViaAlias(raw, lineScopedShips, aliases, cruiseLineName);
    if (viaAlias) return { resolved: true, ...viaAlias, resolverVersion: SHIP_RESOLVER_VERSION };

    const viaStructured = resolveViaStructuredExtract(extract, lineScopedShips, cruiseLineName);
    if (viaStructured) return { resolved: true, ...viaStructured, resolverVersion: SHIP_RESOLVER_VERSION };

    const viaFuzzy = resolveViaUniqueFuzzy(raw, lineScopedShips, cruiseLineName);
    if (viaFuzzy) return { resolved: true, ...viaFuzzy, resolverVersion: SHIP_RESOLVER_VERSION };
  }

  if (suggestedMatch?.ship_id && suggestedMatch.confidence >= AUTO_RESOLVE_MIN_CONFIDENCE) {
    const ship = lineScopedShips.find((s) => s.id === suggestedMatch.ship_id);
    if (ship) {
      return {
        resolved: true,
        ship,
        method: "review_suggestion",
        confidence: suggestedMatch.confidence,
        raw: rawShipName,
        resolverVersion: SHIP_RESOLVER_VERSION
      };
    }
  }

  return {
    resolved: false,
    reason: "no_unique_match",
    resolverVersion: SHIP_RESOLVER_VERSION,
    candidates: lineScopedShips.slice(0, 3).map((s) => s.name)
  };
}

function canAutoPromoteAlias(resolution) {
  if (!resolution?.resolved) return false;
  if (resolution.method === "stored_alias" || resolution.method === "exact_name") return false;
  if (resolution.confidence < AUTO_ALIAS_MIN_CONFIDENCE) return false;
  if (guessLooksNonSailing(resolution.raw)) return false;
  if (resolution.competing) return false;
  return true;
}

function buildAliasProposal(resolution, { sourceUrl, evidenceType = "automation" } = {}) {
  if (!canAutoPromoteAlias(resolution)) return null;
  return {
    ship_id: resolution.ship.id,
    raw_alias: resolution.raw,
    normalised_alias: normaliseShipName(resolution.raw),
    source: "discovery_automation",
    source_url: sourceUrl || null,
    evidence_type: evidenceType,
    confidence: resolution.confidence,
    resolver_version: SHIP_RESOLVER_VERSION,
    created_by: "automation"
  };
}

const AUTO_ALIAS_WRITES_ENABLED = false;

module.exports = {
  SHIP_RESOLVER_VERSION,
  AUTO_ALIAS_WRITES_ENABLED,
  AUTO_ALIAS_MIN_CONFIDENCE,
  AUTO_RESOLVE_MIN_CONFIDENCE,
  resolveShipForLine,
  canAutoPromoteAlias,
  buildAliasProposal,
  normaliseShipName,
  stripLinePrefix
};
