/**
 * Antimeridian / International Date Line helpers for marine polylines.
 *
 * Architecture: Route Object stores raw WGS84 [lon, lat] only.
 * Drawing-safe unwrapping is a pure transform applied at render time
 * (or by callers that need a continuous stroke across ±180°).
 */

/**
 * True when consecutive longitudes jump more than 180° (antimeridian cut).
 * @param {Array<[number, number]>} coordinates
 */
function crossesAntimeridian(coordinates) {
  const pts = coordinates || [];
  for (let i = 1; i < pts.length; i += 1) {
    const prev = Number(pts[i - 1][0]);
    const lon = Number(pts[i][0]);
    if (!Number.isFinite(prev) || !Number.isFinite(lon)) continue;
    if (Math.abs(lon - prev) > 180) return true;
  }
  return false;
}

/**
 * Unwrap longitudes so successive points differ by ≤ 180°.
 * Returns a new array; does not mutate the input. Latitudes unchanged.
 * Normal Mediterranean / Atlantic itineraries are returned unchanged in shape
 * (values stay within -180..180 when no wrap occurs).
 *
 * @param {Array<[number, number]>} coordinates
 * @returns {Array<[number, number]>}
 */
function unwrapPolylineForDrawing(coordinates) {
  const pts = coordinates || [];
  if (pts.length === 0) return [];
  const out = [];
  let offset = 0;
  let prevLon = Number(pts[0][0]);
  out.push([prevLon, Number(pts[0][1])]);

  for (let i = 1; i < pts.length; i += 1) {
    let lon = Number(pts[i][0]);
    const lat = Number(pts[i][1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      out.push([lon, lat]);
      continue;
    }
    const unwrappedPrev = prevLon + offset;
    let candidate = lon + offset;
    while (candidate - unwrappedPrev > 180) {
      offset -= 360;
      candidate = lon + offset;
    }
    while (candidate - unwrappedPrev < -180) {
      offset += 360;
      candidate = lon + offset;
    }
    out.push([candidate, lat]);
    prevLon = lon;
  }
  return out;
}

module.exports = {
  crossesAntimeridian,
  unwrapPolylineForDrawing
};
