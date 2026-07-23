/**
 * Country name labels for route-map SVG (Natural Earth via world-atlas).
 * Places a few muted labels on land inside the current map viewport.
 */

const fs = require("fs");
const path = require("path");

let topojsonClient = null;
const cache = new Map();

function loadTopojsonClient() {
  if (topojsonClient) return topojsonClient;
  // eslint-disable-next-line global-require
  topojsonClient = require("topojson-client");
  return topojsonClient;
}

function resolveCountriesPath(resolution = "110m") {
  const res = resolution === "50m" || resolution === "10m" ? resolution : "110m";
  const file = `countries-${res}.json`;
  const candidates = [
    path.join(__dirname, "../../../node_modules/world-atlas", file),
    path.join(process.cwd(), "node_modules/world-atlas", file)
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { resolution: res, filePath: candidate };
  }
  return null;
}

function loadCountriesFeatureCollection(resolution = "110m") {
  const resolved = resolveCountriesPath(resolution);
  if (!resolved) return null;
  const cacheKey = resolved.filePath;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const topo = JSON.parse(fs.readFileSync(resolved.filePath, "utf8"));
  if (!topo?.objects?.countries) return null;
  const client = loadTopojsonClient();
  const fc = client.feature(topo, topo.objects.countries);
  const normalised =
    fc.type === "FeatureCollection" ? fc : { type: "FeatureCollection", features: [fc] };
  normalised.__resolution = resolved.resolution;
  cache.set(cacheKey, normalised);
  return normalised;
}

function eachPolygonRing(geometry, visit) {
  if (!geometry) return;
  if (geometry.type === "Polygon") {
    const outer = geometry.coordinates?.[0];
    if (outer) visit(outer);
    return;
  }
  if (geometry.type === "MultiPolygon") {
    for (const poly of geometry.coordinates || []) {
      const outer = poly?.[0];
      if (outer) visit(outer);
    }
  }
}

function pointInBBox(lon, lat, bbox) {
  return lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;
}

function ringIntersectsBBox(ring, bbox) {
  for (const c of ring) {
    if (pointInBBox(c[0], c[1], bbox)) return true;
  }
  return false;
}

function shortCountryName(name) {
  const raw = String(name || "").trim();
  if (!raw) return "";
  const aliases = {
    "United States of America": "USA",
    "United Kingdom": "UK",
    "United Arab Emirates": "UAE",
    "Dominican Rep.": "Dominican Rep.",
    "Central African Rep.": "Cent. African Rep.",
    "Dem. Rep. Congo": "DR Congo",
    "Bosnia and Herz.": "Bosnia",
    "S. Sudan": "South Sudan",
    "Eq. Guinea": "Eq. Guinea",
    "W. Sahara": "W. Sahara",
    "Solomon Is.": "Solomon Is.",
    "Czechia": "Czechia"
  };
  return aliases[raw] || raw;
}

/**
 * Label position from land that is actually visible in the map viewport.
 * Whole-country centroids often fall outside a regional cruise frame (e.g. Spain/France on a Med map).
 */
function visibleRingStats(ring, bbox) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const visible = [];
  for (const c of ring) {
    if (pointInBBox(c[0], c[1], bbox)) visible.push(c);
  }
  if (visible.length < 3) return null;

  // Always place on the visible strip. Whole-country centroids often sit just
  // inside the geo frame but project onto the padded edge (e.g. France on Med maps).
  let sx = 0;
  let sy = 0;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const c of visible) {
    sx += c[0];
    sy += c[1];
    if (c[0] < minLon) minLon = c[0];
    if (c[0] > maxLon) maxLon = c[0];
    if (c[1] < minLat) minLat = c[1];
    if (c[1] > maxLat) maxLat = c[1];
  }
  const visibleSpan = Math.max(0, maxLon - minLon) * Math.max(0, maxLat - minLat);
  return {
    lon: sx / visible.length,
    lat: sy / visible.length,
    visibleSpan,
    visiblePoints: visible.length
  };
}

/**
 * @param {{ west:number, east:number, south:number, north:number }} geo
 * @param {{ project: Function }} projector
 * @param {{ width:number, height:number }} viewport
 * @param {{ maxLabels?: number, padPx?: number, obstacles?: Array<{left,top,right,bottom}>, nearPoints?: Array<{x:number,y:number}> }} [options]
 */
function placeCountryLabels(geo, projector, viewport, options = {}) {
  const maxLabels = options.maxLabels != null ? options.maxLabels : 8;
  const padPx = options.padPx != null ? options.padPx : 28;
  const obstacles = options.obstacles || [];
  const nearPoints = options.nearPoints || [];
  const fc = loadCountriesFeatureCollection("110m");
  if (!fc?.features?.length) return [];

  const candidates = [];
  for (const feature of fc.features) {
    const name = shortCountryName(feature.properties?.name);
    if (!name) continue;

    let best = null;
    eachPolygonRing(feature.geometry, (ring) => {
      if (!ringIntersectsBBox(ring, geo)) return;
      const stats = visibleRingStats(ring, geo);
      if (!stats) return;
      if (!best || stats.visibleSpan > best.visibleSpan) best = stats;
    });
    if (!best || best.visibleSpan < 0.35) continue;

    const [x, y] = projector.project(best.lon, best.lat);
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < padPx ||
      y < padPx ||
      x > viewport.width - padPx ||
      y > viewport.height - padPx
    ) {
      continue;
    }

    let score = best.visibleSpan;
    // Boost countries that sit near an itinerary stop so coastal nations win over inland fill.
    for (const pt of nearPoints) {
      const d = Math.hypot(pt.x - x, pt.y - y);
      if (d < 140) score *= 2.4;
      else if (d < 220) score *= 1.35;
    }

    candidates.push({
      name,
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      area: score
    });
  }

  candidates.sort((a, b) => b.area - a.area);

  const placed = [];
  const boxes = obstacles.map((o) => ({ ...o }));

  for (const cand of candidates) {
    if (placed.length >= maxLabels) break;
    const fontSize = 10;
    const w = cand.name.length * fontSize * 0.55;
    const h = fontSize + 4;
    const box = {
      left: cand.x - w / 2,
      right: cand.x + w / 2,
      top: cand.y - h / 2,
      bottom: cand.y + h / 2
    };

    let hits = false;
    for (const other of boxes) {
      if (
        !(
          box.right + 8 < other.left ||
          box.left - 8 > other.right ||
          box.bottom + 6 < other.top ||
          box.top - 6 > other.bottom
        )
      ) {
        hits = true;
        break;
      }
    }
    if (hits) continue;

    placed.push(cand);
    boxes.push(box);
  }

  return placed;
}

module.exports = {
  loadCountriesFeatureCollection,
  placeCountryLabels,
  shortCountryName
};
