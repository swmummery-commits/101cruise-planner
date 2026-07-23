/**
 * Ship icon placement along a projected route polyline.
 * Progress is cumulative distance fraction (0..1), not point index.
 * Sprint 13E — multi-layer premium cruise-ship silhouette.
 */

function segmentLength(a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += segmentLength(points[i - 1], points[i]);
  return total;
}

function pointAtProgress(points, progress) {
  const pts = points || [];
  if (pts.length < 2) return null;
  const target = Math.max(0, Math.min(1, Number(progress))) * polylineLength(pts);
  let travelled = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = segmentLength(a, b);
    if (travelled + len >= target || i === pts.length - 1) {
      const remain = Math.max(len, 1e-9);
      const t = Math.max(0, Math.min(1, (target - travelled) / remain));
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t;
      const angleDeg = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
      return {
        x: Math.round(x * 100) / 100,
        y: Math.round(y * 100) / 100,
        angleDeg: Math.round(angleDeg * 100) / 100,
        index: i - 1
      };
    }
    travelled += len;
  }
  return null;
}

function placeShip(points, preferredProgress, obstacles = [], clearancePx = 28) {
  const base = Number(preferredProgress);
  const candidates = [base];
  for (let step = 1; step <= 12; step += 1) {
    const delta = step * 0.02;
    candidates.push(base + delta, base - delta);
  }

  let best = null;
  let bestPenalty = Infinity;

  for (const progress of candidates) {
    if (progress < 0.05 || progress > 0.95) continue;
    const pos = pointAtProgress(points, progress);
    if (!pos) continue;
    let penalty = Math.abs(progress - base) * 40;
    for (const obs of obstacles) {
      const r = obs.r != null ? obs.r : clearancePx;
      const d = Math.hypot(pos.x - obs.x, pos.y - obs.y);
      if (d < r) penalty += (r - d) * 8;
    }
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      best = { ...pos, progress: Math.round(progress * 1000) / 1000, penalty: bestPenalty };
    }
  }

  if (!best) {
    const fallback = pointAtProgress(points, base) || pointAtProgress(points, 0.5);
    if (!fallback) return null;
    return { ...fallback, progress: base, penalty: 0 };
  }
  return best;
}

/**
 * Outer hull path — bow points +X.
 * @deprecated Prefer buildShipLayers for rendering; kept for tests/compat.
 */
function shipPathD(length = 44, beam = 18) {
  const layers = buildShipLayers(length, beam);
  return layers.find((l) => l.id === "hull")?.d || "";
}

function shipFunnelPathD(length = 44, beam = 18) {
  const layers = buildShipLayers(length, beam);
  return layers.find((l) => l.id === "funnel")?.d || "";
}

/**
 * Multi-layer cruise ship for premium rendering.
 * Returns draw order: hull → deck → windows → bridge → stripe → funnel → funnel-cap.
 *
 * @returns {Array<{ id: string, d: string, role: string }>}
 */
function buildShipLayers(length = 44, beam = 18) {
  const L = Number(length) || 44;
  const B = Number(beam) || 18;
  const hx = L / 2;
  const hy = B / 2;
  const r = (n) => Math.round(n * 100) / 100;

  const hull = [
    `M ${r(-hx * 0.95)} ${r(hy * 0.4)}`,
    `L ${r(-hx * 0.7)} ${r(hy * 0.9)}`,
    `L ${r(hx * 0.5)} ${r(hy * 0.9)}`,
    `L ${r(hx * 0.84)} ${r(hy * 0.3)}`,
    `L ${r(hx)} ${r(hy * 0.02)}`,
    `L ${r(hx * 0.8)} ${r(-hy * 0.08)}`,
    `L ${r(hx * 0.45)} ${r(-hy * 0.16)}`,
    `L ${r(-hx * 0.55)} ${r(-hy * 0.12)}`,
    `L ${r(-hx * 0.9)} ${r(hy * 0.02)}`,
    "Z"
  ].join(" ");

  const deck = [
    `M ${r(-hx * 0.55)} ${r(-hy * 0.12)}`,
    `L ${r(hx * 0.45)} ${r(-hy * 0.16)}`,
    `L ${r(hx * 0.32)} ${r(-hy * 0.4)}`,
    `L ${r(hx * 0.08)} ${r(-hy * 0.4)}`,
    `L ${r(-hx * 0.02)} ${r(-hy * 0.58)}`,
    `L ${r(-hx * 0.32)} ${r(-hy * 0.58)}`,
    `L ${r(-hx * 0.42)} ${r(-hy * 0.4)}`,
    "Z"
  ].join(" ");

  // Distinct cabin window band (light) — reads clearly at map scale
  const windows = [
    `M ${r(-hx * 0.5)} ${r(-hy * 0.06)}`,
    `L ${r(hx * 0.4)} ${r(-hy * 0.1)}`,
    `L ${r(hx * 0.38)} ${r(hy * 0.14)}`,
    `L ${r(-hx * 0.48)} ${r(hy * 0.16)}`,
    "Z"
  ].join(" ");

  const bridge = [
    `M ${r(-hx * 0.1)} ${r(-hy * 0.58)}`,
    `L ${r(hx * 0.14)} ${r(-hy * 0.58)}`,
    `L ${r(hx * 0.14)} ${r(-hy * 0.78)}`,
    `L ${r(-hx * 0.04)} ${r(-hy * 0.78)}`,
    "Z"
  ].join(" ");

  // Brand-green hull stripe for signature recognition
  const stripe = [
    `M ${r(-hx * 0.7)} ${r(hy * 0.48)}`,
    `L ${r(hx * 0.45)} ${r(hy * 0.48)}`,
    `L ${r(hx * 0.43)} ${r(hy * 0.64)}`,
    `L ${r(-hx * 0.68)} ${r(hy * 0.64)}`,
    "Z"
  ].join(" ");

  const funnel = [
    `M ${r(-hx * 0.14)} ${r(-hy * 0.58)}`,
    `L ${r(-hx * 0.14)} ${r(-hy * 0.92)}`,
    `L ${r(hx * 0.06)} ${r(-hy * 0.92)}`,
    `L ${r(hx * 0.08)} ${r(-hy * 0.78)}`,
    `L ${r(hx * 0.08)} ${r(-hy * 0.58)}`,
    "Z"
  ].join(" ");

  const funnelCap = [
    `M ${r(-hx * 0.15)} ${r(-hy * 0.92)}`,
    `L ${r(-hx * 0.15)} ${r(-hy * 1.02)}`,
    `L ${r(hx * 0.07)} ${r(-hy * 1.02)}`,
    `L ${r(hx * 0.07)} ${r(-hy * 0.92)}`,
    "Z"
  ].join(" ");

  return [
    { id: "hull", d: hull, role: "hull" },
    { id: "deck", d: deck, role: "deck" },
    { id: "windows", d: windows, role: "window" },
    { id: "bridge", d: bridge, role: "deck" },
    { id: "stripe", d: stripe, role: "accent" },
    { id: "funnel", d: funnel, role: "accent" },
    { id: "funnel-cap", d: funnelCap, role: "stripe" }
  ];
}

/**
 * Build SVG markup for the ship at origin (caller applies translate/rotate).
 */
function shipSvgMarkup(theme) {
  const length = theme.length != null ? theme.length : 44;
  const beam = theme.beam != null ? theme.beam : 18;
  const layers = buildShipLayers(length, beam);
  const colors = {
    hull: theme.hull || theme.fill || "#1A2630",
    deck: theme.deck || "#3D4F5C",
    window: theme.window || "#E8EEF2",
    stripe: theme.stripe || "#FFFFFF",
    accent: theme.accent || "#8DD9BF",
    stroke: theme.stroke || "#0F171C",
    strokeWidth: theme.strokeWidth != null ? theme.strokeWidth : 0.7
  };
  const roleFill = {
    hull: colors.hull,
    deck: colors.deck,
    window: colors.window,
    stripe: colors.stripe,
    accent: colors.accent
  };

  return layers
    .map((layer) => {
      const fill = roleFill[layer.role] || colors.hull;
      const stroke =
        layer.role === "hull" || layer.role === "deck"
          ? ` stroke="${colors.stroke}" stroke-width="${colors.strokeWidth}" stroke-linejoin="round"`
          : "";
      return `<path data-ship="${layer.id}" d="${layer.d}" fill="${fill}"${stroke}/>`;
    })
    .join("");
}

module.exports = {
  polylineLength,
  pointAtProgress,
  placeShip,
  shipPathD,
  shipFunnelPathD,
  buildShipLayers,
  shipSvgMarkup,
  segmentLength
};
