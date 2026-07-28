/**
 * Deterministic cruise-ship resolution for Client Portal get-ship / linked bookings.
 * Supports terminal Roman ↔ Arabic numeral variants, deliberate cruise-line aliases,
 * and safe line-aware prefix/suffix variants (e.g. Sapphire → Sapphire Princess).
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
  "explora cruises": "explora journeys",
  "norwegian cruise lines": "norwegian cruise line",
  "ncl": "norwegian cruise line"
});

/** Display / storage canonical names for known booking-side aliases. */
const CRUISE_LINE_DISPLAY_ALIASES = Object.freeze({
  "explora cruises": "Explora Journeys"
});

/**
 * Safe line-aware ship name affixes. Only applied when cruise line is known.
 * Never used for cross-line guessing.
 */
const LINE_SHIP_AFFIXES = Object.freeze([
  {
    lineIncludes: ["princess"],
    suffixes: ["princess"],
    prefixes: []
  },
  {
    lineIncludes: ["celebrity"],
    suffixes: [],
    prefixes: ["celebrity"]
  },
  {
    lineIncludes: ["norwegian"],
    suffixes: [],
    prefixes: ["norwegian"]
  },
  {
    lineIncludes: ["holland america"],
    suffixes: [],
    prefixes: ["ms"]
  }
]);

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

/**
 * Build safe line-aware name variants (Sapphire + Princess → sapphire princess).
 * Requires a cruise line. Does not invent cross-line matches.
 */
function expandLineAwareNameVariants(shipName, cruiseLine) {
  const line = resolveCruiseLineAlias(cruiseLine);
  const bases = nameVariants(shipName, []);
  const out = new Set(bases);
  if (!line || !bases.length) return [...out];

  for (const rule of LINE_SHIP_AFFIXES) {
    if (!rule.lineIncludes.some((token) => line.includes(token))) continue;
    for (const base of bases) {
      for (const suffix of rule.suffixes || []) {
        if (!base.endsWith(` ${suffix}`) && base !== suffix) {
          out.add(`${base} ${suffix}`);
        }
      }
      for (const prefix of rule.prefixes || []) {
        if (!base.startsWith(`${prefix} `) && base !== prefix) {
          out.add(`${prefix} ${base}`);
        }
      }
    }
  }

  // Also try "<line brand token> <ship>" using the first significant line word when useful
  // (already covered by LINE_SHIP_AFFIXES for known brands).
  return [...out].filter(Boolean);
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

function shipRowLineName(row) {
  return (
    row?.cruise_line_name ||
    row?.cruise_line ||
    row?.ci_cruise_lines?.name ||
    ""
  );
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
  const lineAwareVariants = expandLineAwareNameVariants(shipName, cruiseLine);
  const allTargetVariants = [...new Set([...targetVariants, ...lineAwareVariants])];

  if (!targetVariants.length) return { status: "not_found" };

  // Alias rows that match the booking ship name (any numeral variant)
  const aliasHits = (aliases || []).filter((row) => {
    const aliasVariants = nameVariants("", [row]);
    return aliasVariants.some((v) => targetVariants.includes(v));
  });
  const aliasShipIds = new Set(aliasHits.map((a) => String(a.ship_id)).filter(Boolean));

  // 1. Exact normalised ship name (+ numeral / alias variants)
  const exact = ships.filter(
    (row) =>
      shipMatchesAnyVariant(row?.name, targetVariants) ||
      (row?.id && aliasShipIds.has(String(row.id)))
  );
  const step1 = resolveUniqueCandidates(exact);
  if (step1) return step1;

  // 2. Line-aware affix / composed variants (Sapphire Princess, Norwegian Star, …)
  if (line && lineAwareVariants.length) {
    const affixMatches = ships.filter((row) => {
      const name = normaliseText(row?.name);
      return lineAwareVariants.includes(name);
    });
    // Prefer same-line when available
    const sameLineAffix = affixMatches.filter((row) => {
      const rowLine = resolveCruiseLineAlias(shipRowLineName(row));
      if (!rowLine) return true;
      return (
        rowLine === line ||
        rowLine.includes(line) ||
        line.includes(rowLine) ||
        linePrefixCompatible(rowLine, line)
      );
    });
    const step2a = resolveUniqueCandidates(sameLineAffix.length ? sameLineAffix : affixMatches);
    if (step2a) return step2a;
  }

  if (line) {
    const composedTargets = targetVariants.map((t) => `${line} ${t}`);
    const composedMatches = ships.filter((row) =>
      composedTargets.includes(normaliseText(row?.name))
    );
    const step2b = resolveUniqueCandidates(composedMatches);
    if (step2b) return step2b;
  }

  // 3. Existing suffix-with-line-prefix rule (Celebrity Millennium style)
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

  // 4. Unique normalised candidate within the same cruise line only
  if (line) {
    const sameLine = ships.filter((row) => {
      const rowLine = resolveCruiseLineAlias(shipRowLineName(row));
      if (!rowLine) return false;
      return (
        rowLine === line ||
        rowLine.includes(line) ||
        line.includes(rowLine) ||
        linePrefixCompatible(rowLine, line)
      );
    });

    const uniqueLineHits = sameLine.filter((row) => {
      const name = normaliseText(row?.name);
      return allTargetVariants.some(
        (t) => name === t || name.startsWith(`${t} `) || name.endsWith(` ${t}`)
      );
    });
    const step4 = resolveUniqueCandidates(uniqueLineHits);
    if (step4) return step4;
  }

  return { status: "not_found" };
}

function filterSupabaseByLine(ships, cruiseLine) {
  const line = resolveCruiseLineAlias(cruiseLine);
  if (!line) return ships;
  return ships.filter((row) => {
    const name = resolveCruiseLineAlias(shipRowLineName(row));
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
  expandLineAwareNameVariants,
  nameVariants,
  resolveCruiseShip,
  filterSupabaseByLine,
  linePrefixCompatible,
  CRUISE_LINE_ALIASES,
  CRUISE_LINE_DISPLAY_ALIASES,
  LINE_SHIP_AFFIXES,
  ROMAN_TO_ARABIC,
  ARABIC_TO_ROMAN
};
