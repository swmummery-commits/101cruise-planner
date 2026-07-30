/**
 * Detect when route segments cross land (Natural Earth via world-atlas).
 * Matches equirectangular SVG rendering: straight segments in [lon, lat] space.
 */

const { loadLandFeatureCollection } = require("./route-map-coastline");

let landIndex = null;

function featureBBox(feature) {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  const geom = feature?.geometry;
  if (!geom) return null;

  const polys =
    geom.type === "Polygon"
      ? [geom.coordinates]
      : geom.type === "MultiPolygon"
        ? geom.coordinates
        : [];

  for (const poly of polys) {
    for (const ring of poly) {
      for (const c of ring) {
        const lon = c[0];
        const lat = c[1];
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }
  if (!Number.isFinite(minLon)) return null;
  return { minLon, maxLon, minLat, maxLat };
}

function getLandIndex(resolution = "50m") {
  if (landIndex && landIndex.resolution === resolution) return landIndex;
  const fc = loadLandFeatureCollection(resolution);
  const entries = (fc.features || [])
    .map((feature) => {
      const bbox = featureBBox(feature);
      if (!bbox) return null;
      return { feature, bbox };
    })
    .filter(Boolean);
  landIndex = { resolution, entries };
  return landIndex;
}

function orient(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function onSegment(ax, ay, bx, by, cx, cy) {
  return (
    Math.min(ax, cx) <= bx &&
    bx <= Math.max(ax, cx) &&
    Math.min(ay, cy) <= by &&
    by <= Math.max(ay, cy)
  );
}

function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = orient(cx, cy, dx, dy, ax, ay);
  const d2 = orient(cx, cy, dx, dy, bx, by);
  const d3 = orient(ax, ay, bx, by, cx, cy);
  const d4 = orient(ax, ay, bx, by, dx, dy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  if (d1 === 0 && onSegment(cx, cy, ax, ay, dx, dy)) return true;
  if (d2 === 0 && onSegment(cx, cy, bx, by, dx, dy)) return true;
  if (d3 === 0 && onSegment(ax, ay, cx, cy, bx, by)) return true;
  if (d4 === 0 && onSegment(ax, ay, dx, dy, bx, by)) return true;
  return false;
}

/** Ray-casting point-in-ring test for [lon, lat] rings. */
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + 0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygonRings(lon, lat, rings) {
  if (!rings?.length) return false;
  if (!pointInRing(lon, lat, rings[0])) return false;
  for (let h = 1; h < rings.length; h += 1) {
    if (pointInRing(lon, lat, rings[h])) return false;
  }
  return true;
}

function pointInFeature(lon, lat, feature) {
  const geom = feature?.geometry;
  if (!geom) return false;
  if (geom.type === "Polygon") {
    return pointInPolygonRings(lon, lat, geom.coordinates);
  }
  if (geom.type === "MultiPolygon") {
    for (const poly of geom.coordinates) {
      if (pointInPolygonRings(lon, lat, poly)) return true;
    }
  }
  return false;
}

function segmentBBox(lon1, lat1, lon2, lat2) {
  return {
    minLon: Math.min(lon1, lon2),
    maxLon: Math.max(lon1, lon2),
    minLat: Math.min(lat1, lat2),
    maxLat: Math.max(lat1, lat2)
  };
}

function bboxOverlap(a, b) {
  return !(a.maxLon < b.minLon || a.minLon > b.maxLon || a.maxLat < b.minLat || a.minLat > b.maxLat);
}

function candidatesForSegment(lon1, lat1, lon2, lat2, index) {
  const box = segmentBBox(lon1, lat1, lon2, lat2);
  return index.entries.filter(({ bbox }) => bboxOverlap(box, bbox));
}

function segmentIntersectsLandEdges(lon1, lat1, lon2, lat2, options = {}) {
  const index = getLandIndex(options.resolution || "50m");
  const hits = candidatesForSegment(lon1, lat1, lon2, lat2, index);
  if (!hits.length) return false;

  for (const { feature } of hits) {
    const geom = feature.geometry;
    const polys =
      geom.type === "Polygon"
        ? [geom.coordinates]
        : geom.type === "MultiPolygon"
          ? geom.coordinates
          : [];
    for (const poly of polys) {
      for (const ring of poly) {
        for (let i = 0; i < ring.length - 1; i += 1) {
          const [x1, y1] = ring[i];
          const [x2, y2] = ring[i + 1];
          if (segmentsIntersect(lon1, lat1, lon2, lat2, x1, y1, x2, y2)) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

function segmentInteriorOnLand(lon1, lat1, lon2, lat2, options = {}) {
  const samples = Math.max(4, Number(options.samples) || 24);
  const index = getLandIndex(options.resolution || "50m");
  const hits = candidatesForSegment(lon1, lat1, lon2, lat2, index);
  if (!hits.length) return false;

  for (let i = 1; i < samples; i += 1) {
    const t = i / samples;
    const lon = lon1 + t * (lon2 - lon1);
    const lat = lat1 + t * (lat2 - lat1);
    for (const { feature } of hits) {
      if (pointInFeature(lon, lat, feature)) return true;
    }
  }
  return false;
}

/**
 * True when a map segment between two lon/lat points crosses land.
 * Uses polygon-edge intersection (matches equirectangular SVG chords) plus
 * interior sampling for narrow gaps edge tests can miss.
 */
function segmentCrossesLand(lon1, lat1, lon2, lat2, options = {}) {
  if (
    segmentIntersectsLandEdges(lon1, lat1, lon2, lat2, options) ||
    segmentInteriorOnLand(lon1, lat1, lon2, lat2, options)
  ) {
    return true;
  }
  return false;
}

/**
 * @param {Array<[number, number]>} coordinates GeoJSON order [lon, lat]
 * @returns {{ crosses: boolean, segment_index: number|null }}
 */
function polylineCrossesLand(coordinates, options = {}) {
  const pts = (coordinates || [])
    .map((p) => [Number(p[0]), Number(p[1])])
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    if (segmentCrossesLand(a[0], a[1], b[0], b[1], options)) {
      return { crosses: true, segment_index: i - 1 };
    }
  }
  return { crosses: false, segment_index: null };
}

function resetLandIndexCache() {
  landIndex = null;
}

module.exports = {
  segmentCrossesLand,
  segmentIntersectsLandEdges,
  segmentInteriorOnLand,
  polylineCrossesLand,
  resetLandIndexCache
};
