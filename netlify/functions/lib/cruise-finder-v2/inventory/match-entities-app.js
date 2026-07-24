/**
 * Deterministic cruise-line + ship matching against real app catalogues.
 * No fuzzy multi-pick: ambiguous → AMBIGUOUS.
 */

const { normaliseName, normaliseShipName } = require("../enrichment/match-entities");

const COMPANY_DISPLAY = Object.freeze({
  princess: "Princess Cruises",
  ncl: "Norwegian Cruise Line",
  "celebrity-cruises": "Celebrity Cruises",
  "royal-caribbean": "Royal Caribbean International",
  costa: "Costa Cruises",
  carnival: "Carnival Cruise Line",
  "holland-america": "Holland America Line",
  msc: "MSC Cruises",
  "disney-cruise-line": "Disney Cruise Line"
});

function companyDisplayName(company) {
  const key = String(company || "").trim().toLowerCase();
  return COMPANY_DISPLAY[key] || String(company || "").trim();
}

function matchCruiseLineEntity(providerName, lines) {
  const display = companyDisplayName(providerName);
  const needle = normaliseName(display);
  const needleRaw = normaliseName(providerName);
  if (!needle && !needleRaw) {
    return {
      id: null,
      canonicalName: null,
      providerName: String(providerName || ""),
      matchStatus: "NOT_FOUND"
    };
  }

  const exact = [];
  const alias = [];
  for (const line of lines || []) {
    const n = normaliseName(line.name);
    if (n === needle || n === needleRaw) exact.push(line);
    for (const a of line.aliases || []) {
      if (normaliseName(a) === needle || normaliseName(a) === needleRaw) alias.push(line);
    }
  }

  const soft = (lines || []).filter((line) => {
    const n = normaliseName(line.name);
    return (
      n === needle ||
      n === needleRaw ||
      (needle && (n.startsWith(needle) || needle.startsWith(n))) ||
      (needleRaw && (n.startsWith(needleRaw) || needleRaw.startsWith(n)))
    );
  });

  const pool = exact.length ? exact : alias.length ? alias : soft;
  const unique = [...new Map(pool.map((l) => [normaliseName(l.name), l])).values()];
  if (!unique.length) {
    return {
      id: null,
      canonicalName: null,
      providerName: display || String(providerName || ""),
      matchStatus: "NOT_FOUND"
    };
  }
  if (unique.length > 1) {
    return {
      id: null,
      canonicalName: null,
      providerName: display || String(providerName || ""),
      matchStatus: "AMBIGUOUS",
      candidates: unique.map((l) => ({ id: l.id, name: l.name }))
    };
  }
  const hit = unique[0];
  return {
    id: hit.id,
    canonicalName: hit.name,
    providerName: display || String(providerName || ""),
    matchStatus: "MATCHED",
    via: exact.length ? "exact" : alias.length ? "alias" : "soft"
  };
}

/**
 * Exact / alias only within cruise-line scope. Soft contains only when unique.
 */
function matchShipEntity(shipName, cruiseLine, ships) {
  const providerName = String(shipName || "").trim();
  const needle = normaliseShipName(providerName);
  if (!needle) {
    return {
      id: null,
      canonicalName: null,
      providerName,
      matchStatus: "NOT_FOUND"
    };
  }

  const lineId = cruiseLine?.id || null;
  const lineName = normaliseName(cruiseLine?.canonicalName || cruiseLine?.providerName || "");

  const scoped = (ships || []).filter((ship) => {
    if (lineId && ship.cruise_line_id) return ship.cruise_line_id === lineId;
    if (lineName && ship.cruise_line_name) {
      return (
        normaliseName(ship.cruise_line_name) === lineName ||
        normaliseName(ship.cruise_line_name).includes(lineName) ||
        lineName.includes(normaliseName(ship.cruise_line_name))
      );
    }
    return true;
  });

  const exact = [];
  const soft = [];
  for (const ship of scoped) {
    const names = [ship.name, ...(ship.aliases || [])].map(normaliseShipName).filter(Boolean);
    if (names.includes(needle)) {
      exact.push(ship);
      continue;
    }
    // Soft: unique containment only collected; resolved later if single
    if (names.some((n) => n === needle || n.includes(needle) || needle.includes(n))) {
      soft.push(ship);
    }
  }

  const poolExact = [...new Map(exact.map((s) => [normaliseShipName(s.name), s])).values()];
  if (poolExact.length === 1) {
    const hit = poolExact[0];
    return {
      id: hit.id,
      canonicalName: hit.name,
      providerName,
      matchStatus: "MATCHED",
      via: "exact"
    };
  }
  if (poolExact.length > 1) {
    return {
      id: null,
      canonicalName: null,
      providerName,
      matchStatus: "AMBIGUOUS",
      via: "exact",
      candidates: poolExact.map((s) => ({ id: s.id, name: s.name }))
    };
  }

  const poolSoft = [...new Map(soft.map((s) => [normaliseShipName(s.name), s])).values()];
  if (poolSoft.length === 1) {
    const hit = poolSoft[0];
    return {
      id: hit.id,
      canonicalName: hit.name,
      providerName,
      matchStatus: "MATCHED",
      via: "soft"
    };
  }
  if (poolSoft.length > 1) {
    return {
      id: null,
      canonicalName: null,
      providerName,
      matchStatus: "AMBIGUOUS",
      via: "soft",
      candidates: poolSoft.map((s) => ({ id: s.id, name: s.name }))
    };
  }

  return {
    id: null,
    canonicalName: null,
    providerName,
    matchStatus: "NOT_FOUND"
  };
}

module.exports = {
  COMPANY_DISPLAY,
  companyDisplayName,
  matchCruiseLineEntity,
  matchShipEntity
};
