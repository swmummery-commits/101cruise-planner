/**
 * Deterministic cruise-ship resolution for Client Portal get-ship.
 * Supports terminal Roman ↔ Arabic numeral variants and deliberate cruise-line aliases.
 */

"use strict";

const ROMAN_TO_ARABIC = Object.freeze({
  i: "1",
  ii: "2",
  iii: "3",
  iv: "4",
  v: "5",
  vi: "6",
  vii: "7",
  viii: "8",
  ix: "9",
  x: "10"
});

const ARABIC_TO_ROMAN = Object.freeze({
  1: "i",
  2: "ii",
  3: "iii",
  4: "iv",
  5: "v",
  6: "vi",
  7: "vii",
  8: "viii",
  9: "ix",
  10: "x"
});

/** Deliberate cruise-line aliases only — do not broaden matching globally. */
const CRUISE_LINE_ALIASES = Object.freeze({
  "explora cruises": "explora journeys"
});

/** Display / storage canonical names for known booking-side aliases. */
const CRUISE_LINE_DISPLAY_ALIASES = Object.freeze({
  "explora cruises": "Explora Journeys"
});

function normaliseText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function resolveCruiseLineAlias(cruiseLine) {
  const line = normaliseText(cruiseLine);
  if (!line) return "";
  return CRUISE_LINE_ALIASES[line] || line;
}

/** Returns the preferred display/storage cruise-line name (preserves unknown values). */
function canonicalCruiseLineDisplayName(cruiseLine) {
  const raw = String(cruiseLine || "").trim();
  if (!raw) return "";
  return CRUISE_LINE_DISPLAY_ALIASES[normaliseText(raw)] || raw;
}

/**
 * Expand only the terminal token when it is a Roman or Arabic numeral 1–10.
 * Does not rewrite interior letters (e.g. "Queen Elizabeth" stays unchanged).
 */
function expandTerminalNumeralVariants(name) {
  const soft = normaliseText(name);
  if (!soft) return [];
  const out = new Set([soft]);
  const parts = soft.split(" ");
  const last = parts[parts.length - 1];
  const head = parts.slice(0, -1);

  if (ROMAN_TO_ARABIC[last] && head.length) {
    out.add([...head, ROMAN_TO_ARABIC[last]].join(" "));
  }
  if (ARABIC_TO_ROMAN[last] && head.length) {
    out.add([...head, ARABIC_TO_ROMAN[last]].join(" "));
  }
  return [...out];
}

function nameVariants(name, aliasRows = []) {
  const variants = new Set(expandTerminalNumeralVariants(name));
  for (const row of aliasRows || []) {
    for (const key of [row.raw_alias, row.normalised_alias]) {
      expandTerminalNumeralVariants(key).forEach((v) => variants.add(v));
    }
  }
  return [...variants].filter(Boolean);
}

function dedupeShips(rows) {
  const seen = new Set();
  const result = [];
  rows.forEach((row) => {
    const key = row?.id || `name:${normaliseText(row?.name)}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push(row);
  });
  return result;
}

function resolveUniqueCandidates(candidates) {
  const unique = dedupeShips(candidates);
  if (unique.length === 0) return null;
  if (unique.length === 1) return { status: "matched", ship: unique[0] };
  return { status: "ambiguous" };
}

function linePrefixCompatible(shipPrefix, cruiseLine) {
  const prefix = normaliseText(shipPrefix);
  const line = resolveCruiseLineAlias(cruiseLine);
  if (!prefix || !line) return false;
  if (prefix === line) return true;
  if (line.startsWith(`${prefix} `)) return true;
  if (prefix.startsWith(`${line} `)) return true;
  return false;
}

function shipMatchesAnyVariant(shipName, targetVariants) {
  const shipVariants = expandTerminalNumeralVariants(shipName);
  return shipVariants.some((v) => targetVariants.includes(v));
}

/**
 * @param {Array<object>} ships
 * @param {string} shipName
 * @param {string} cruiseLine
 * @param {Array<{ship_id?:string, raw_alias?:string, normalised_alias?:string}>} [aliases]
 */
function resolveCruiseShip(ships, shipName, cruiseLine, aliases = []) {
  const targetVariants = nameVariants(shipName, []);
  const line = resolveCruiseLineAlias(cruiseLine);

  if (!targetVariants.length) return { status: "not_found" };

  // Alias rows that match the booking ship name (any numeral variant)
  const aliasHits = (aliases || []).filter((row) => {
    const aliasVariants = nameVariants("", [row]);
    return aliasVariants.some((v) => targetVariants.includes(v));
  });
  const aliasShipIds = new Set(aliasHits.map((a) => String(a.ship_id)).filter(Boolean));

  const exact = ships.filter(
    (row) =>
      shipMatchesAnyVariant(row?.name, targetVariants) ||
      (row?.id && aliasShipIds.has(String(row.id)))
  );
  const step1 = resolveUniqueCandidates(exact);
  if (step1) return step1;

  if (line) {
    const composedTargets = targetVariants.map((t) => `${line} ${t}`);
    const composedMatches = ships.filter((row) =>
      composedTargets.includes(normaliseText(row?.name))
    );
    const step2 = resolveUniqueCandidates(composedMatches);
    if (step2) return step2;
  }

  if (line) {
    const suffixMatches = ships.filter((row) => {
      const name = normaliseText(row?.name);
      for (const target of targetVariants) {
        const suffix = ` ${target}`;
        if (!name.endsWith(suffix) || name === target) continue;
        const prefix = name.slice(0, name.length - suffix.length);
        if (linePrefixCompatible(prefix, line)) return true;
      }
      return false;
    });
    const step3 = resolveUniqueCandidates(suffixMatches);
    if (step3) return step3;
  }

  return { status: "not_found" };
}

function filterSupabaseByLine(ships, cruiseLine) {
  const line = resolveCruiseLineAlias(cruiseLine);
  if (!line) return ships;
  return ships.filter((row) => {
    const name = resolveCruiseLineAlias(row.cruise_line_name || row.cruise_line || "");
    if (!name) return true;
    return (
      name === line ||
      name.includes(line) ||
      line.includes(name) ||
      linePrefixCompatible(name, line)
    );
  });
}

module.exports = {
  normaliseText,
  resolveCruiseLineAlias,
  canonicalCruiseLineDisplayName,
  expandTerminalNumeralVariants,
  nameVariants,
  resolveCruiseShip,
  filterSupabaseByLine,
  linePrefixCompatible,
  CRUISE_LINE_ALIASES,
  CRUISE_LINE_DISPLAY_ALIASES,
  ROMAN_TO_ARABIC,
  ARABIC_TO_ROMAN
};
