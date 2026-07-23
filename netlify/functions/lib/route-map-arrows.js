/**
 * Deterministic directional arrows along a projected marine route.
 * Sprint 13E Phase 3B — reinforces travel direction without dominating the map.
 */

const { polylineLength, pointAtProgress, segmentLength } = require("./route-map-ship");

/**
 * @param {Array<[number, number]>} points projected route
 * @param {object} options
 * @param {Array<{x:number,y:number,r?:number}>} [options.obstacles]
 * @param {number} [options.spacingPx]
 * @param {number} [options.minCount]
 * @param {number} [options.maxCount]
 * @param {number} [options.clearancePx]
 * @param {number} [options.endPadding]
 */
function placeRouteArrows(points, options = {}) {
  const pts = points || [];
  if (pts.length < 2) return [];

  const totalLen = polylineLength(pts);
  if (totalLen < 40) return [];

  const spacingPx = options.spacingPx != null ? Number(options.spacingPx) : 72;
  const minCount = options.minCount != null ? Number(options.minCount) : 3;
  const maxCount = options.maxCount != null ? Number(options.maxCount) : 18;
  const clearancePx = options.clearancePx != null ? Number(options.clearancePx) : 26;
  const endPadding = options.endPadding != null ? Number(options.endPadding) : 0.06;
  const obstacles = options.obstacles || [];

  let count = Math.round(totalLen / spacingPx);
  count = Math.max(minCount, Math.min(maxCount, count));

  const usable = 1 - endPadding * 2;
  const arrows = [];

  for (let i = 0; i < count; i += 1) {
    const t = endPadding + (usable * (i + 0.5)) / count;
    const pos = pointAtProgress(pts, t);
    if (!pos) continue;

    let blocked = false;
    for (const obs of obstacles) {
      const r = obs.r != null ? obs.r : clearancePx;
      if (Math.hypot(pos.x - obs.x, pos.y - obs.y) < r) {
        blocked = true;
        break;
      }
    }
    if (blocked) {
      // Deterministic micro-nudge along the route
      let rescued = null;
      for (const delta of [0.015, -0.015, 0.03, -0.03, 0.045, -0.045]) {
        const altT = t + delta;
        if (altT <= endPadding || altT >= 1 - endPadding) continue;
        const alt = pointAtProgress(pts, altT);
        if (!alt) continue;
        let ok = true;
        for (const obs of obstacles) {
          const r = obs.r != null ? obs.r : clearancePx;
          if (Math.hypot(alt.x - obs.x, alt.y - obs.y) < r) {
            ok = false;
            break;
          }
        }
        if (ok) {
          rescued = { ...alt, progress: Math.round(altT * 1000) / 1000 };
          break;
        }
      }
      if (!rescued) continue;
      arrows.push(rescued);
      continue;
    }

    arrows.push({ ...pos, progress: Math.round(t * 1000) / 1000 });
  }

  return arrows;
}

/**
 * Small chevron / arrowhead path centred at origin, pointing +X.
 * @param {number} size
 */
function arrowPathD(size = 7.5) {
  const s = Number(size) || 7.5;
  // Compact filled chevron
  return `M ${-s * 0.45} ${-s * 0.55} L ${s * 0.55} 0 L ${-s * 0.45} ${s * 0.55} L ${-s * 0.15} 0 Z`;
}

module.exports = {
  placeRouteArrows,
  arrowPathD,
  segmentLength
};
