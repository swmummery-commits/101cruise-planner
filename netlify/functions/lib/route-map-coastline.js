/**
 * Offline coastline / land polygons for route-map SVG rendering.
 *
 * Dataset: Natural Earth land boundaries redistributed via `world-atlas`
 * (TopoJSON → GeoJSON via topojson-client).
 *
 * - Source: Natural Earth (public domain) — https://www.naturalearthdata.com/
 * - Package: world-atlas@2 (ISC) — https://github.com/topojson/world-atlas
 * - Default resolution: land-50m.json (~533 KB) — 1:50m scale
 * - Fallback: land-110m.json (~54 KB) — 1:110m scale
 *
 * Attribution is documented here; Natural Earth public-domain terms do not
 * require on-map credit. Do not render attribution inside the SVG artwork.
 *
 * Loaded once per process and cached. No network access at render time.
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

function resolveLandPath(resolution) {
  const res = resolution === "110m" || resolution === "10m" ? resolution : "50m";
  const file = `land-${res}.json`;
  const candidates = [
    path.join(__dirname, "../../../node_modules/world-atlas", file),
    path.join(process.cwd(), "node_modules/world-atlas", file)
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { resolution: res, filePath: candidate };
  }
  throw new Error(
    `world-atlas ${file} not found. Install dependency: npm install world-atlas topojson-client`
  );
}

/**
 * @param {"50m"|"110m"|"10m"} [resolution]
 * @returns {GeoJSON.FeatureCollection}
 */
function loadLandFeatureCollection(resolution = "50m") {
  const { resolution: res, filePath } = resolveLandPath(resolution);
  const cacheKey = filePath;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const topo = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!topo || !topo.objects || !topo.objects.land) {
    throw new Error(`Invalid world-atlas topology in ${filePath}`);
  }
  const client = loadTopojsonClient();
  const fc = client.feature(topo, topo.objects.land);
  const normalised =
    fc.type === "FeatureCollection"
      ? fc
      : { type: "FeatureCollection", features: [fc] };
  cache.set(cacheKey, normalised);
  normalised.__resolution = res;
  normalised.__source = "world-atlas/natural-earth";
  return normalised;
}

function ringIntersectsBBox(ring, bbox) {
  // Quick reject / accept via point-in or edge overlap heuristics
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const c of ring) {
    const lon = c[0];
    const lat = c[1];
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  if (maxLon < bbox.west || minLon > bbox.east || maxLat < bbox.south || minLat > bbox.north) {
    return false;
  }
  return true;
}

function shiftRing(ring, lonOffset) {
  if (!lonOffset) return ring;
  return ring.map((c) => [c[0] + lonOffset, c[1]]);
}

/**
 * Collect polygon rings that intersect the (possibly unwrapped) drawing bbox.
 * Duplicates rings shifted by ±360° when the viewport spans outside [-180,180].
 *
 * @param {GeoJSON.FeatureCollection} land
 * @param {{west:number,east:number,south:number,north:number}} bbox
 * @returns {Array<Array<[number, number]>>} outer rings (and holes as separate closed rings)
 */
function extractLandRingsForBBox(land, bbox) {
  const offsets = [0];
  if (bbox.west < -180 || bbox.east > 180) {
    offsets.push(-360, 360);
  }
  // Also cover cases where unwrap pushed route into 180..540 etc.
  if (bbox.east > 180) offsets.push(360);
  if (bbox.west < -180) offsets.push(-360);
  if (bbox.east > 540) offsets.push(720);
  if (bbox.west < -540) offsets.push(-720);

  const uniqueOffsets = [...new Set(offsets)];
  const rings = [];

  for (const feature of land.features || []) {
    const geom = feature.geometry;
    if (!geom) continue;
    const polys =
      geom.type === "Polygon"
        ? [geom.coordinates]
        : geom.type === "MultiPolygon"
          ? geom.coordinates
          : [];

    for (const poly of polys) {
      for (const offset of uniqueOffsets) {
        for (const ring of poly) {
          const shifted = shiftRing(ring, offset);
          if (ringIntersectsBBox(shifted, bbox)) {
            rings.push(shifted);
          }
        }
      }
    }
  }
  return rings;
}

/**
 * Convert a closed [lon,lat] ring to an SVG path using projector.project.
 * @param {Array<[number, number]>} ring
 * @param {{ project: (lon:number, lat:number) => [number, number] }} projector
 */
function ringToSvgPath(ring, projector) {
  if (!ring || ring.length < 2) return "";
  const parts = [];
  for (let i = 0; i < ring.length; i += 1) {
    const [x, y] = projector.project(ring[i][0], ring[i][1]);
    parts.push(`${i === 0 ? "M" : "L"}${x} ${y}`);
  }
  parts.push("Z");
  return parts.join("");
}

module.exports = {
  loadLandFeatureCollection,
  extractLandRingsForBBox,
  ringToSvgPath,
  resolveLandPath
};
