/**
 * Match cruise line / ship / ports against local catalogue snapshots (POC).
 * Never invents missing entities. No production writes.
 */

const fs = require("fs");
const path = require("path");

function normaliseName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normaliseShipName(value) {
  return normaliseName(value)
    .replace(/^(ms|mv|ss|rms)\s+/i, "")
    .replace(/\b(ship|cruise|cruises)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCsv(text) {
  const cleaned = String(text || "").replace(/^\uFEFF/, "");
  const lines = cleaned.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = splitCsvLine(line);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] == null ? "" : cols[i];
    });
    return row;
  });
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function defaultCataloguePaths() {
  const root = path.resolve(__dirname, "../../../../../");
  return {
    portsCsv: path.join(root, "data/ports/ports-catalogue.csv"),
    linesCsv: path.join(root, "data/cruise-finder-v2/ci-cruise-lines-snapshot.csv"),
    shipsCsv: path.join(root, "data/cruise-finder-v2/ci-cruise-ships-snapshot.csv")
  };
}

function loadPortsCatalogue(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return parseCsv(text).map((row, index) => {
    const aliases = String(row.aliases || "")
      .split("|")
      .map((a) => a.trim())
      .filter(Boolean);
    return {
      id: `port-csv-${index + 1}`,
      canonical_name: row.canonical_name,
      display_name: row.display_name || row.canonical_name,
      country: row.country || "",
      aliases,
      match_key: `${normaliseName(row.canonical_name)}|${normaliseName(row.country)}`
    };
  });
}

function loadLinesSnapshot(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return parseCsv(fs.readFileSync(filePath, "utf8")).map((row) => ({
    id: row.id || null,
    name: row.name,
    aliases: String(row.aliases || "")
      .split("|")
      .map((a) => a.trim())
      .filter(Boolean)
  }));
}

function loadShipsSnapshot(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return parseCsv(fs.readFileSync(filePath, "utf8")).map((row) => ({
    id: row.id || null,
    name: row.name,
    cruise_line_id: row.cruise_line_id || null,
    cruise_line_name: row.cruise_line_name || "",
    aliases: String(row.aliases || "")
      .split("|")
      .map((a) => a.trim())
      .filter(Boolean)
  }));
}

function loadLocalCatalogues(options = {}) {
  const paths = { ...defaultCataloguePaths(), ...options };
  return {
    ports: loadPortsCatalogue(paths.portsCsv),
    lines: loadLinesSnapshot(paths.linesCsv),
    ships: loadShipsSnapshot(paths.shipsCsv),
    paths
  };
}

function matchCruiseLine(name, lines) {
  const needle = normaliseName(name);
  if (!needle) return { status: "NOT_FOUND", id: null, matchedName: null, via: null };

  const exact = [];
  const aliasHits = [];
  for (const line of lines || []) {
    const n = normaliseName(line.name);
    if (n === needle) exact.push(line);
    for (const alias of line.aliases || []) {
      if (normaliseName(alias) === needle) aliasHits.push(line);
    }
  }
  // Soft contains for short brands like "Viking" / "Azamara"
  const soft = (lines || []).filter((line) => {
    const n = normaliseName(line.name);
    return n === needle || n.startsWith(needle) || needle.startsWith(n);
  });

  const pool = exact.length ? exact : aliasHits.length ? aliasHits : soft;
  if (!pool.length) return { status: "NOT_FOUND", id: null, matchedName: null, via: null };
  const unique = [...new Map(pool.map((l) => [normaliseName(l.name), l])).values()];
  if (unique.length > 1) {
    return {
      status: "AMBIGUOUS",
      id: null,
      matchedName: null,
      via: exact.length ? "exact" : aliasHits.length ? "alias" : "soft",
      candidates: unique.map((l) => ({ id: l.id, name: l.name }))
    };
  }
  const hit = unique[0];
  return {
    status: "MATCHED",
    id: hit.id,
    matchedName: hit.name,
    via: exact.length ? "exact" : aliasHits.length ? "alias" : "soft"
  };
}

function matchShip(shipName, cruiseLineName, ships) {
  const needle = normaliseShipName(shipName);
  if (!needle) return { status: "NOT_FOUND", id: null, matchedName: null, via: null };
  const lineNeedle = normaliseName(cruiseLineName);

  const scored = [];
  for (const ship of ships || []) {
    const names = [ship.name, ...(ship.aliases || [])].map(normaliseShipName).filter(Boolean);
    if (!names.includes(needle) && !names.some((n) => n === needle || needle.includes(n) || n.includes(needle))) {
      continue;
    }
    const lineOk =
      !lineNeedle ||
      !ship.cruise_line_name ||
      normaliseName(ship.cruise_line_name).includes(lineNeedle) ||
      lineNeedle.includes(normaliseName(ship.cruise_line_name));
    if (!lineOk) continue;
    const exact = names.includes(needle);
    scored.push({ ship, exact });
  }

  if (!scored.length) return { status: "NOT_FOUND", id: null, matchedName: null, via: null };
  const exacts = scored.filter((s) => s.exact);
  const pool = exacts.length ? exacts : scored;
  const unique = [...new Map(pool.map((s) => [normaliseShipName(s.ship.name), s.ship])).values()];
  if (unique.length > 1) {
    return {
      status: "AMBIGUOUS",
      id: null,
      matchedName: null,
      via: exacts.length ? "exact" : "soft",
      candidates: unique.map((s) => ({ id: s.id, name: s.name }))
    };
  }
  const hit = unique[0];
  return {
    status: "MATCHED",
    id: hit.id,
    matchedName: hit.name,
    via: exacts.length ? "exact" : "soft"
  };
}

function matchPort(portName, ports) {
  const raw = String(portName || "").trim();
  if (!raw) return { status: "NOT_FOUND", id: null, matchedName: null, via: null, portName: raw };

  // Strip parenthetical city hints: "Rome (Civitavecchia)" → try both
  const candidates = [raw];
  const paren = raw.match(/^(.+?)\s*\((.+?)\)\s*$/);
  if (paren) {
    candidates.push(paren[1].trim(), paren[2].trim());
  }
  // Common "Athens (Piraeus)" style already covered; also "City, Country"
  const comma = raw.split(",")[0];
  if (comma && comma !== raw) candidates.push(comma.trim());

  const exact = [];
  const alias = [];
  for (const port of ports || []) {
    for (const cand of candidates) {
      const needle = normaliseName(cand);
      if (!needle) continue;
      if (normaliseName(port.canonical_name) === needle || normaliseName(port.display_name) === needle) {
        exact.push(port);
      }
      for (const a of port.aliases || []) {
        if (normaliseName(a) === needle) alias.push(port);
      }
    }
  }

  const pool = exact.length ? exact : alias;
  const unique = [...new Map(pool.map((p) => [p.match_key || p.canonical_name, p])).values()];
  if (!unique.length) {
    return { status: "NOT_FOUND", id: null, matchedName: null, via: null, portName: raw };
  }
  if (unique.length > 1) {
    return {
      status: "AMBIGUOUS",
      id: null,
      matchedName: null,
      via: exact.length ? "exact" : "alias",
      portName: raw,
      candidates: unique.map((p) => ({ id: p.id, name: p.canonical_name }))
    };
  }
  const hit = unique[0];
  return {
    status: "MATCHED",
    id: hit.id,
    matchedName: hit.canonical_name,
    via: exact.length ? "exact" : "alias",
    portName: raw
  };
}

/**
 * @param {import("../contracts").CandidateCruise} cruise
 * @param {{ ports: any[], lines: any[], ships: any[] }} catalogues
 */
function enrichCandidate(cruise, catalogues) {
  const cruiseLineMatch = matchCruiseLine(cruise.cruiseLineName, catalogues.lines);
  const shipMatch = matchShip(cruise.shipName, cruise.cruiseLineName, catalogues.ships);

  const portNames = [];
  if (cruise.departurePortName) portNames.push(cruise.departurePortName);
  if (cruise.arrivalPortName) portNames.push(cruise.arrivalPortName);
  for (const stop of cruise.itinerary || []) {
    if (stop.portName) portNames.push(stop.portName);
  }
  const seen = new Set();
  const portMatches = [];
  for (const name of portNames) {
    const key = normaliseName(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    portMatches.push(matchPort(name, catalogues.ports));
  }

  return { cruiseLineMatch, shipMatch, portMatches };
}

module.exports = {
  normaliseName,
  normaliseShipName,
  loadLocalCatalogues,
  matchCruiseLine,
  matchShip,
  matchPort,
  enrichCandidate,
  parseCsv
};
