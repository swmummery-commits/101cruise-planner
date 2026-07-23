/**
 * Deterministic geographic projection + viewport for itinerary route maps.
 *
 * Projection: equirectangular (Plate Carrée) with aspect correction at the
 * map centre latitude. Route and coastline share the same project() function.
 *
 * Why not Web Mercator: cruise itineraries are regional; equirectangular +
 * mid-latitude scale factor keeps proportions honest without polar stretch,
 * and stays trivial to invert/debug for SVG layouts.
 */

/**
 * @typedef {{ west: number, east: number, south: number, north: number }} GeoBounds
 * @typedef {{ width: number, height: number, precision?: number }} ViewportSize
 */

/**
 * @param {Array<[number, number]>} points [lon, lat]
 * @returns {GeoBounds|null}
 */
function boundsFromPoints(points) {
  const pts = points || [];
  if (!pts.length) return null;
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const p of pts) {
    const lon = Number(p[0]);
    const lat = Number(p[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  if (!Number.isFinite(west)) return null;
  return { west, east, south, north };
}

/**
 * Expand geographic bounds with balanced padding and minimum spans, then
 * stretch the shorter axis so the projected region matches the SVG aspect.
 *
 * @param {GeoBounds} bounds
 * @param {object} options
 */
function expandBoundsForViewport(bounds, options = {}) {
  const width = Number(options.width) || 1200;
  const height = Number(options.height) || 675;
  const paddingRatio = options.paddingRatio != null ? Number(options.paddingRatio) : 0.12;
  const paddingDegreesMin =
    options.paddingDegreesMin != null ? Number(options.paddingDegreesMin) : 0.85;
  const minLonSpan = options.minLonSpan != null ? Number(options.minLonSpan) : 4.5;
  const minLatSpan = options.minLatSpan != null ? Number(options.minLatSpan) : 3.0;

  let west = bounds.west;
  let east = bounds.east;
  let south = bounds.south;
  let north = bounds.north;

  let lonSpan = Math.max(east - west, 1e-9);
  let latSpan = Math.max(north - south, 1e-9);

  if (lonSpan < minLonSpan) {
    const mid = (west + east) / 2;
    west = mid - minLonSpan / 2;
    east = mid + minLonSpan / 2;
    lonSpan = minLonSpan;
  }
  if (latSpan < minLatSpan) {
    const mid = (south + north) / 2;
    south = mid - minLatSpan / 2;
    north = mid + minLatSpan / 2;
    latSpan = minLatSpan;
  }

  const pad = Math.max(paddingDegreesMin, paddingRatio * Math.max(lonSpan, latSpan));
  west -= pad;
  east += pad;
  south -= pad;
  north += pad;
  lonSpan = east - west;
  latSpan = north - south;

  const midLat = ((south + north) / 2) * (Math.PI / 180);
  const cosLat = Math.max(Math.cos(midLat), 0.2);
  const geoAspect = (lonSpan * cosLat) / latSpan;
  const svgAspect = width / height;

  if (geoAspect > svgAspect) {
    // Too wide — expand latitude
    const targetLatSpan = (lonSpan * cosLat) / svgAspect;
    const extra = (targetLatSpan - latSpan) / 2;
    south -= extra;
    north += extra;
  } else {
    // Too tall — expand longitude
    const targetLonSpan = (latSpan * svgAspect) / cosLat;
    const extra = (targetLonSpan - lonSpan) / 2;
    west -= extra;
    east += extra;
  }

  return {
    west,
    east,
    south,
    north,
    midLatDeg: (south + north) / 2,
    cosLat
  };
}

/**
 * Build a projector from expanded geo bounds into SVG pixel space.
 * @param {GeoBounds & { cosLat?: number }} geo
 * @param {ViewportSize} size
 */
function createProjector(geo, size) {
  const width = Number(size.width) || 1200;
  const height = Number(size.height) || 675;
  const precision = size.precision != null ? Number(size.precision) : 2;
  const lonSpan = geo.east - geo.west;
  const latSpan = geo.north - geo.south;

  function projectRaw(lon, lat) {
    const x = ((lon - geo.west) / lonSpan) * width;
    const y = ((geo.north - lat) / latSpan) * height;
    return [x, y];
  }

  function project(lon, lat) {
    const [x, y] = projectRaw(lon, lat);
    const f = 10 ** precision;
    return [Math.round(x * f) / f, Math.round(y * f) / f];
  }

  function projectPoints(points) {
    return (points || []).map((p) => project(Number(p[0]), Number(p[1])));
  }

  return {
    width,
    height,
    precision,
    geo,
    project,
    projectRaw,
    projectPoints
  };
}

module.exports = {
  boundsFromPoints,
  expandBoundsForViewport,
  createProjector
};
