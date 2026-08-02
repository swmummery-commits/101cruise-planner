/**
 * Crystal Cruises voyage URL ship codes and conflict detection.
 * Precedence: structured ship → voyage/product data → URL csy/cse code →
 * labelled page content → title → URL slug text (weak).
 */

const CRYSTAL_SHIP_RESOLVER_VERSION = "2026-08-02.crystal1";

/** Verified Crystal voyage URL product codes (none-csy-*, none-cse-*). */
const CRYSTAL_VOYAGE_SHIP_CODES = Object.freeze({
  csy: "Crystal Symphony",
  cse: "Crystal Serenity"
});

function isCrystalCruisesLine(cruiseLineName) {
  return /\bcrystal\b/i.test(String(cruiseLineName || ""));
}

function parseCrystalVoyageFromUrl(url) {
  try {
    const path = new URL(String(url || "")).pathname || "";
    const m = path.match(/\/cruises\/(?:none-)?(cs[ey])-(\d+)-(\d+)/i);
    if (!m) return null;
    const code = m[1].toLowerCase();
    return {
      code,
      shipName: CRYSTAL_VOYAGE_SHIP_CODES[code] || null,
      productCode: m[2],
      dateCode: m[3],
      voyageSlug: m[0].replace(/^\//, "")
    };
  } catch {
    return null;
  }
}

function extractCrystalTitleShip(title) {
  const m = String(title || "").match(/^\s*(Crystal\s+(?:Serenity|Symphony|Endeavor|Esprit))\b/i);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

function extractCrystalLabelledShip(blob) {
  const text = String(blob || "");
  const labelled = text.match(/\b(Crystal\s+(?:Serenity|Symphony|Endeavor|Esprit))\b/gi);
  if (!labelled?.length) return null;
  const counts = new Map();
  for (const name of labelled) {
    const norm = name.replace(/\s+/g, " ");
    counts.set(norm, (counts.get(norm) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

function findCrystalShipByName(name, ships) {
  const needle = String(name || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!needle) return null;
  return (ships || []).find((s) => String(s.name || "").trim().toLowerCase() === needle) || null;
}

/**
 * Collect ranked ship evidence for a Crystal voyage source.
 * @returns {{ ship: object|null, evidence: Array, voyage: object|null, conflict: object|null }}
 */
function resolveCrystalShipEvidence({
  url,
  title,
  description,
  excerpt,
  structuredVoyage,
  ships,
  cruiseLineName
}) {
  if (!isCrystalCruisesLine(cruiseLineName)) {
    return { ship: null, evidence: [], voyage: null, conflict: null };
  }

  const blob = [title, description, excerpt].filter(Boolean).join("\n");
  const voyage = parseCrystalVoyageFromUrl(url);
  const evidence = [];

  const pushEvidence = (source, shipName, weight) => {
    if (!shipName) return;
    const ship = findCrystalShipByName(shipName, ships);
    evidence.push({ source, shipName, ship, weight });
  };

  if (structuredVoyage?.ship_name) {
    pushEvidence("structured_ship", structuredVoyage.ship_name, 100);
  }
  if (structuredVoyage?.product_ship_name) {
    pushEvidence("structured_product", structuredVoyage.product_ship_name, 95);
  }
  if (voyage?.shipName) {
    pushEvidence("url_voyage_code", voyage.shipName, 90);
  }
  const labelled = extractCrystalLabelledShip(blob);
  if (labelled) pushEvidence("labelled_content", labelled, 70);
  const titleShip = extractCrystalTitleShip(title);
  if (titleShip) pushEvidence("page_title", titleShip, 60);

  // Weak: URL slug tokens like "none csy 008"
  if (voyage?.code) {
    const slugName = CRYSTAL_VOYAGE_SHIP_CODES[voyage.code];
    if (slugName) pushEvidence("url_slug_weak", slugName, 30);
  }

  evidence.sort((a, b) => b.weight - a.weight);

  const strong = evidence.filter((e) => e.weight >= 60 && e.ship);
  const strongNames = new Set(strong.map((e) => e.ship.id));
  let conflict = null;
  if (strongNames.size > 1) {
    conflict = {
      reason: "crystal_ship_evidence_conflict",
      sources: strong.map((e) => ({ source: e.source, shipName: e.shipName, weight: e.weight }))
    };
  }

  const winner = evidence.find((e) => e.ship) || null;
  return {
    ship: winner?.ship || null,
    evidence,
    voyage,
    conflict,
    resolverVersion: CRYSTAL_SHIP_RESOLVER_VERSION
  };
}

/**
 * Returns true when strong Crystal ship sources disagree — record must not activate.
 */
function crystalShipConflictBlocksActivation(resolution) {
  return Boolean(resolution?.conflict);
}

module.exports = {
  CRYSTAL_SHIP_RESOLVER_VERSION,
  CRYSTAL_VOYAGE_SHIP_CODES,
  isCrystalCruisesLine,
  parseCrystalVoyageFromUrl,
  extractCrystalTitleShip,
  extractCrystalLabelledShip,
  resolveCrystalShipEvidence,
  crystalShipConflictBlocksActivation,
  findCrystalShipByName
};
