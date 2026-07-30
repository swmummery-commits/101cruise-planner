/**
 * Deterministic polyline simplification (Douglas–Peucker).
 * Coordinates are [longitude, latitude] pairs. First and last points always kept.
 */

const { segmentCrossesLand, polylineCrossesLand } = require("./route-map-land-check");

const MIN_LAND_FIX_NM = 40;

function haversineNm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (Number(d) * Math.PI) / 180;
  const rLat1 = toRad(lat1);
  const rLat2 = toRad(lat2);
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return 3440.065 * c;
}

function squareDistancePointToSegment(p, a, b) {
  const x = p[0];
  const y = p[1];
  const x1 = a[0];
  const y1 = a[1];
  const x2 = b[0];
  const y2 = b[1];
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) {
    const ex = x - x1;
    const ey = y - y1;
    return ex * ex + ey * ey;
  }
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  const ex = x - projX;
  const ey = y - projY;
  return ex * ex + ey * ey;
}

function douglasPeucker(points, toleranceDegrees) {
  if (!Array.isArray(points) || points.length <= 2) {
    return Array.isArray(points) ? points.map((p) => [Number(p[0]), Number(p[1])]) : [];
  }
  const tol = Math.max(0, Number(toleranceDegrees) || 0);
  const tolSq = tol * tol;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    let maxDist = -1;
    let index = -1;
    const a = points[start];
    const b = points[end];
    for (let i = start + 1; i < end; i += 1) {
      const d = squareDistancePointToSegment(points[i], a, b);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index >= 0 && maxDist > tolSq) {
      keep[index] = 1;
      if (index - start > 1) stack.push([start, index]);
      if (end - index > 1) stack.push([index, end]);
    }
  }

  const out = [];
  for (let i = 0; i < points.length; i += 1) {
    if (!keep[i]) continue;
    out.push([Number(points[i][0]), Number(points[i][1])]);
  }
  return out;
}

/** Presets for future SVG renderer. Degrees ≈ geographic tolerance. */
const SIMPLIFY_PRESETS = {
  /** Dense enough for admin preview canvases */
  preview: { toleranceDegrees: 0.035, minPoints: 4 },
  /** Retains coastal / canal character for newsletter maps */
  "final-map": { toleranceDegrees: 0.012, minPoints: 6 }
};

/**
 * @param {Array<[number, number]>} coordinates
 * @param {'preview'|'final-map'|{toleranceDegrees?: number, minPoints?: number}} presetOrOptions
 */
function simplifyPolyline(coordinates, presetOrOptions = "final-map") {
  const opts =
    typeof presetOrOptions === "string"
      ? SIMPLIFY_PRESETS[presetOrOptions] || SIMPLIFY_PRESETS["final-map"]
      : { ...SIMPLIFY_PRESETS["final-map"], ...(presetOrOptions || {}) };

  const input = (coordinates || []).map((p) => [Number(p[0]), Number(p[1])]);
  if (input.length <= 2) return input;

  let simplified = douglasPeucker(input, opts.toleranceDegrees);
  const minPoints = Math.max(2, Number(opts.minPoints) || 2);

  // If over-simplified, tighten tolerance until minPoints or original length.
  let guard = 0;
  let tol = opts.toleranceDegrees;
  while (simplified.length < Math.min(minPoints, input.length) && guard < 8) {
    tol *= 0.5;
    simplified = douglasPeucker(input, tol);
    guard += 1;
  }

  // Guarantee endpoints identical to source.
  if (simplified.length) {
    simplified[0] = [input[0][0], input[0][1]];
    simplified[simplified.length - 1] = [input[input.length - 1][0], input[input.length - 1][1]];
  }
  return simplified;
}

function coordKey(p) {
  return `${Number(p[0]).toFixed(6)},${Number(p[1]).toFixed(6)}`;
}

function nearestIndex(full, target) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < full.length; i += 1) {
    const dx = full[i][0] - target[0];
    const dy = full[i][1] - target[1];
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Ensure simplified map segments do not cut across land when rendered as
 * equirectangular SVG chords. Re-inserts waypoints from the full marine polyline.
 */
function ensureSeaSafePolyline(full, simplified) {
  const source = (full || []).map((p) => [Number(p[0]), Number(p[1])]);
  let line = (simplified || []).map((p) => [Number(p[0]), Number(p[1])]);
  if (line.length < 2) return line.length ? line : source;
  if (source.length < 2) return line;

  let guard = 0;
  while (guard < 12) {
    let changed = false;
    const out = [[...line[0]]];
    for (let i = 1; i < line.length; i += 1) {
      const a = out[out.length - 1];
      const b = line[i];
      const segNm = haversineNm(a[1], a[0], b[1], b[0]);
      if (!segmentCrossesLand(a[0], a[1], b[0], b[1]) || segNm < MIN_LAND_FIX_NM) {
        if (coordKey(a) !== coordKey(b)) out.push([...b]);
        continue;
      }
      const ia = nearestIndex(source, a);
      const ib = nearestIndex(source, b);
      if (ia === ib) {
        out.push([...b]);
        changed = true;
        continue;
      }
      const slice = ia < ib ? source.slice(ia, ib + 1) : source.slice(ib, ia + 1).reverse();
      for (let j = 1; j < slice.length - 1; j += 1) {
        out.push([...slice[j]]);
      }
      out.push([...b]);
      changed = true;
    }
    line = out;
    if (!changed) break;
    if (!polylineCrossesLand(line).crosses) break;
    guard += 1;
  }

  if (polylineCrossesLand(line).crosses) {
    const hasLongLandChord = line.slice(1).some((b, i) => {
      const a = line[i];
      return (
        haversineNm(a[1], a[0], b[1], b[0]) >= MIN_LAND_FIX_NM &&
        segmentCrossesLand(a[0], a[1], b[0], b[1])
      );
    });
    if (hasLongLandChord && !polylineCrossesLand(source).crosses) {
      return source;
    }
  }
  return line;
}

/**
 * Simplify a marine polyline, then restore waypoints where chords would cross land.
 */
function simplifyPolylineForSeaRoute(coordinates, presetOrOptions = "final-map") {
  const simplified = simplifyPolyline(coordinates, presetOrOptions);
  return ensureSeaSafePolyline(coordinates, simplified);
}

module.exports = {
  SIMPLIFY_PRESETS,
  douglasPeucker,
  simplifyPolyline,
  ensureSeaSafePolyline,
  simplifyPolylineForSeaRoute
};
