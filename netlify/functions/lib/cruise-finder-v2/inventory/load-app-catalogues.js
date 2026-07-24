/**
 * Read-only loaders for real application catalogue exports (not tiny POC snapshots).
 * Sources: import-data/CruiseLine_export.csv, CruiseShip_export.csv, data/ports/ports-catalogue.csv
 */

const fs = require("fs");
const path = require("path");
const { parseCsv, normaliseName, normaliseShipName } = require("../enrichment/match-entities");

function defaultPaths(root) {
  const base = root || path.resolve(__dirname, "../../../../../");
  return {
    linesCsv: path.join(base, "import-data/CruiseLine_export.csv"),
    shipsCsv: path.join(base, "import-data/CruiseShip_export.csv"),
    portsCsv: path.join(base, "data/ports/ports-catalogue.csv"),
    proposedAliasesJson: path.join(base, "tmp/track-cruises-importer/proposed-port-aliases.json")
  };
}

const LINE_ALIAS_HINTS = Object.freeze({
  "princess cruises": ["Princess", "princess"],
  "norwegian cruise line": ["NCL", "Norwegian", "ncl"],
  "royal caribbean international": ["Royal Caribbean", "RCI", "RCCL", "royal-caribbean"],
  "celebrity cruises": ["Celebrity", "celebrity-cruises"],
  "holland america line": ["Holland America", "HAL", "holland-america"],
  "msc cruises": ["MSC", "msc"],
  "carnival cruise line": ["Carnival", "carnival"],
  "costa cruises": ["Costa", "costa"],
  "disney cruise line": ["Disney", "disney-cruise-line"]
});

function loadAppLines(filePath) {
  const rows = parseCsv(fs.readFileSync(filePath, "utf8"));
  return rows.map((row) => {
    const name = String(row.name || "").trim();
    const hints = LINE_ALIAS_HINTS[normaliseName(name)] || [];
    return {
      id: row.id || null,
      name,
      code: row.code || "",
      aliases: hints
    };
  });
}

function loadAppShips(filePath, lines) {
  const byId = new Map((lines || []).map((l) => [l.id, l]));
  const rows = parseCsv(fs.readFileSync(filePath, "utf8"));
  return rows.map((row) => {
    const line = byId.get(row.cruise_line_id) || null;
    return {
      id: row.id || null,
      name: String(row.name || "").trim(),
      cruise_line_id: row.cruise_line_id || null,
      cruise_line_name: line ? line.name : "",
      aliases: [],
      status: row.current_status || ""
    };
  });
}

function loadAppPorts(filePath) {
  const rows = parseCsv(fs.readFileSync(filePath, "utf8"));
  return rows.map((row, index) => {
    const aliases = String(row.aliases || "")
      .split("|")
      .map((a) => a.trim())
      .filter(Boolean);
    return {
      id: `port-csv-${index + 1}`,
      canonical_name: row.canonical_name,
      display_name: row.display_name || row.canonical_name,
      city: row.city || "",
      country: row.country || "",
      country_code: row.country_code || "",
      region: row.region || "",
      latitude: row.latitude === "" || row.latitude == null ? null : Number(row.latitude),
      longitude: row.longitude === "" || row.longitude == null ? null : Number(row.longitude),
      aliases,
      match_key: `${normaliseName(row.canonical_name)}|${normaliseName(row.country)}`
    };
  });
}

/**
 * POC-only proposed aliases (not written to production catalogue).
 * Unambiguous Track.cruises → catalogue mappings for review.
 */
const PROPOSED_PORT_ALIASES = Object.freeze([
  {
    providerExample: "Victoria, Canada",
    proposedAlias: "Victoria, Canada",
    targetCanonicalName: "Victoria BC",
    reason: "Provider uses country; catalogue uses Victoria BC / British Columbia.",
    unambiguous: true
  },
  {
    providerExample: "Seattle, Washington",
    proposedAlias: "Seattle, Washington",
    targetCanonicalName: "Seattle",
    reason: "City + US state form already matches via city extraction; alias documents provider form.",
    unambiguous: true
  },
  {
    providerExample: "Juneau, Alaska",
    proposedAlias: "Juneau, Alaska",
    targetCanonicalName: "Juneau",
    reason: "City + state; catalogue has Juneau.",
    unambiguous: true
  },
  {
    providerExample: "Skagway, Alaska",
    proposedAlias: "Skagway, Alaska",
    targetCanonicalName: "Skagway",
    reason: "City + state; catalogue has Skagway.",
    unambiguous: true
  },
  {
    providerExample: "Ketchikan, Alaska",
    proposedAlias: "Ketchikan, Alaska",
    targetCanonicalName: "Ketchikan",
    reason: "City + state; catalogue has Ketchikan.",
    unambiguous: true
  },
  {
    providerExample: "Ft. Lauderdale, Florida",
    proposedAlias: "Ft. Lauderdale, Florida",
    targetCanonicalName: "Fort Lauderdale",
    reason: "Provider abbreviation Ft. vs catalogue Fort Lauderdale.",
    unambiguous: true
  },
  {
    providerExample: "Athens (Piraeus), Greece",
    proposedAlias: "Athens (Piraeus), Greece",
    targetCanonicalName: "Piraeus",
    reason: "Common cruise form; confirm catalogue has Piraeus or Athens.",
    unambiguous: false,
    review: "Add only if a single Piraeus/Athens port exists in catalogue"
  },
  {
    providerExample: "Glacier Bay National Park (scenic Cruising), Alaska",
    proposedAlias: null,
    targetCanonicalName: null,
    reason: "Scenic cruising — do not force ordinary port alias; keep typed scenic_cruising.",
    unambiguous: false,
    review: "optional geographic link if Glacier Bay added later"
  }
]);

function loadAppCatalogues(options = {}) {
  const paths = { ...defaultPaths(options.root), ...options };
  const lines = loadAppLines(paths.linesCsv);
  const ships = loadAppShips(paths.shipsCsv, lines);
  const ports = loadAppPorts(paths.portsCsv);
  return {
    lines,
    ships,
    ports,
    paths,
    proposedPortAliases: PROPOSED_PORT_ALIASES,
    meta: {
      lineCount: lines.length,
      shipCount: ships.length,
      portCount: ports.length,
      source: "import-data + ports-catalogue (read-only)"
    }
  };
}

module.exports = {
  loadAppCatalogues,
  loadAppLines,
  loadAppShips,
  loadAppPorts,
  PROPOSED_PORT_ALIASES,
  defaultPaths,
  normaliseName,
  normaliseShipName
};
