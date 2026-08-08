/**
 * Resolve port images from the canonical ports catalogue for public pages.
 */

const { normaliseEntityKey } = require("../research-normalize");

const PORT_IMAGE_SELECT =
  "id,canonical_name,display_name,city,country,country_code,region,aliases,match_key,hero_media_id,image_status,image_source,image_credit,image_license";

const VALID_IMAGE_STATUS = new Set(["MANUAL", "AUTO_APPROVED"]);

function nameKeysForLookup(name) {
  const raw = String(name || "").trim();
  if (!raw) return [];
  const keys = new Set();
  keys.add(normaliseEntityKey(raw));
  const beforeParen = raw.replace(/\([^)]*\)/g, " ").trim();
  if (beforeParen && beforeParen !== raw) keys.add(normaliseEntityKey(beforeParen));
  const parenMatch = raw.match(/\(([^)]+)\)/);
  if (parenMatch?.[1]) keys.add(normaliseEntityKey(parenMatch[1]));
  const slashParts = raw.split(/\s*\/\s*/);
  for (const part of slashParts) {
    const p = part.trim();
    if (p) keys.add(normaliseEntityKey(p));
  }
  return [...keys].filter(Boolean);
}

function portLookupKeys(portRow) {
  const keys = new Set();
  for (const value of [
    portRow?.canonical_name,
    portRow?.display_name,
    portRow?.city,
    ...(Array.isArray(portRow?.aliases) ? portRow.aliases : [])
  ]) {
    for (const key of nameKeysForLookup(value)) keys.add(key);
  }
  return keys;
}

function hasValidPortImage(portRow) {
  return Boolean(
    portRow?.hero_media_id &&
      VALID_IMAGE_STATUS.has(String(portRow?.image_status || "").toUpperCase())
  );
}

/**
 * Build a map of normalised port name → ports row (with hero_media_id).
 * @param {Array<object>} portRows
 */
function indexPortsCatalogue(portRows) {
  const index = new Map();
  for (const row of portRows || []) {
    if (!hasValidPortImage(row)) continue;
    for (const key of portLookupKeys(row)) {
      if (!index.has(key)) index.set(key, row);
    }
  }
  return index;
}

function catalogueRowsFromIndex(catalogueIndex) {
  if (!catalogueIndex) return [];
  const rows = [];
  const seen = new Set();
  for (const row of catalogueIndex.values()) {
    if (!row?.id || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  return rows;
}

function rankCataloguePortMatches(portName, rows) {
  const target = normaliseEntityKey(portName);
  return (rows || [])
    .filter(hasValidPortImage)
    .map((row) => {
      let score = 0;
      if (normaliseEntityKey(row.canonical_name) === target) score += 100;
      if (normaliseEntityKey(row.city) === target) score += 80;
      if (normaliseEntityKey(row.display_name) === target) score += 70;
      if (
        (Array.isArray(row.aliases) ? row.aliases : []).some(
          (alias) => normaliseEntityKey(alias) === target
        )
      ) {
        score += 40;
      }
      for (const key of nameKeysForLookup(portName)) {
        if (portLookupKeys(row).has(key)) score += 20;
      }
      if (score >= 40 && String(row.image_status || "").toUpperCase() === "MANUAL") score += 5;
      return { row, score };
    })
    .filter((entry) => entry.score >= 20)
    .sort((a, b) => b.score - a.score);
}

/**
 * @param {string} portName
 * @param {Map<string, object>} catalogueIndex
 * @param {Array<object>} [catalogueRows]
 */
function lookupCataloguePort(portName, catalogueIndex, catalogueRows) {
  const target = normaliseEntityKey(portName);
  if (!target) return null;

  const rows = Array.isArray(catalogueRows) && catalogueRows.length
    ? catalogueRows.filter(hasValidPortImage)
    : catalogueRowsFromIndex(catalogueIndex);

  const exactCanonical = rows.filter((row) => normaliseEntityKey(row.canonical_name) === target);
  if (exactCanonical.length === 1) return exactCanonical[0];
  if (exactCanonical.length > 1) return rankCataloguePortMatches(portName, exactCanonical)[0]?.row || exactCanonical[0];

  const exactCity = rows.filter((row) => normaliseEntityKey(row.city) === target);
  if (exactCity.length === 1) return exactCity[0];

  const ranked = rankCataloguePortMatches(portName, rows);
  if (ranked.length) return ranked[0].row;

  for (const key of nameKeysForLookup(portName)) {
    const hit = catalogueIndex?.get(key);
    if (hit) return hit;
  }
  return null;
}

/**
 * Prefer approved canonical ports catalogue imagery over legacy destination_ports heroes.
 */
function resolvePublicPortHeroMedia(portRow, catalogueMediaByName) {
  const key = normaliseEntityKey(portRow?.name || "");
  const catalogueId = key ? catalogueMediaByName.get(key) : null;
  if (catalogueId) {
    return {
      hero_media_id: catalogueId,
      source: "ports_catalogue",
      legacy_hero_media_id: portRow?.hero_media_id || null
    };
  }
  if (portRow?.hero_media_id) {
    return {
      hero_media_id: portRow.hero_media_id,
      source: "destination_ports_legacy",
      legacy_hero_media_id: portRow.hero_media_id
    };
  }
  return { hero_media_id: null, source: "none", legacy_hero_media_id: null };
}

/**
 * Resolve media IDs for port names from catalogue.
 * @returns {Promise<Map<string, string>>} normalised name → hero_media_id
 */
async function resolveCatalogueMediaIds(supabaseGet, portNames) {
  const names = [...new Set((portNames || []).map((n) => String(n || "").trim()).filter(Boolean))];
  const out = new Map();
  if (!names.length) return out;

  try {
    const rows = await supabaseGet(
      `ports?hero_media_id=not.is.null&image_status=in.(MANUAL,AUTO_APPROVED)` +
        `&select=${encodeURIComponent(PORT_IMAGE_SELECT)}&limit=2000`
    );
    const catalogueRows = Array.isArray(rows) ? rows : [];
    const index = indexPortsCatalogue(catalogueRows);
    for (const name of names) {
      const hit = lookupCataloguePort(name, index, catalogueRows);
      if (hit?.hero_media_id) {
        out.set(normaliseEntityKey(name), hit.hero_media_id);
      }
    }
  } catch (error) {
    console.warn("catalogue port image resolve skipped", error.message || error);
  }

  return out;
}

module.exports = {
  PORT_IMAGE_SELECT,
  nameKeysForLookup,
  indexPortsCatalogue,
  lookupCataloguePort,
  resolveCatalogueMediaIds,
  resolvePublicPortHeroMedia,
  rankCataloguePortMatches,
  hasValidPortImage
};
