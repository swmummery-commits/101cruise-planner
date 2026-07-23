/**
 * Deterministic port-label placement for route-map SVG.
 * Candidate slots around each marker; scored for collisions / clipping.
 * No AI / external services.
 */

const CANDIDATES = Object.freeze([
  { id: "ur", dx: 1, dy: -1, anchor: "start", baseline: "alphabetic" },
  { id: "ul", dx: -1, dy: -1, anchor: "end", baseline: "alphabetic" },
  { id: "lr", dx: 1, dy: 1, anchor: "start", baseline: "hanging" },
  { id: "ll", dx: -1, dy: 1, anchor: "end", baseline: "hanging" },
  { id: "r", dx: 1, dy: 0, anchor: "start", baseline: "middle" },
  { id: "l", dx: -1, dy: 0, anchor: "end", baseline: "middle" }
]);

function estimateTextWidth(text, fontSize) {
  return String(text || "").length * fontSize * 0.58;
}

function labelBox(x, y, text, fontSize, anchor, baseline, padX, padY) {
  const w = estimateTextWidth(text, fontSize) + padX * 2;
  const h = fontSize + padY * 2;
  let left = x;
  if (anchor === "end") left = x - w;
  else if (anchor === "middle") left = x - w / 2;

  let top = y;
  if (baseline === "alphabetic") top = y - h + padY;
  else if (baseline === "middle") top = y - h / 2;
  else if (baseline === "hanging") top = y - padY;

  return { left, top, right: left + w, bottom: top + h, cx: left + w / 2, cy: top + h / 2 };
}

function boxesOverlap(a, b, margin = 2) {
  return !(
    a.right + margin < b.left ||
    a.left - margin > b.right ||
    a.bottom + margin < b.top ||
    a.top - margin > b.bottom
  );
}

function pointNearSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) {
    const ddx = px - x1;
    const ddy = py - y1;
    return Math.sqrt(ddx * ddx + ddy * ddy);
  }
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = x1 + t * dx;
  const qy = y1 + t * dy;
  const ddx = px - qx;
  const ddy = py - qy;
  return Math.sqrt(ddx * ddx + ddy * ddy);
}

function boxRoutePenalty(box, routePoints, clearance) {
  if (!routePoints || routePoints.length < 2) return 0;
  let penalty = 0;
  const samples = [
    [box.cx, box.cy],
    [box.left, box.top],
    [box.right, box.top],
    [box.left, box.bottom],
    [box.right, box.bottom]
  ];
  for (let i = 1; i < routePoints.length; i += 1) {
    const [x1, y1] = routePoints[i - 1];
    const [x2, y2] = routePoints[i];
    for (const [px, py] of samples) {
      const d = pointNearSegment(px, py, x1, y1, x2, y2);
      if (d < clearance) penalty += (clearance - d) * 2;
    }
  }
  return penalty;
}

/**
 * @param {Array<{ id:string, name:string, x:number, y:number, markerRadius:number }>} ports
 * @param {Array<[number, number]>} routePoints projected
 * @param {object} themeLabel
 * @param {{ width:number, height:number }} viewport
 */
function placePortLabels(ports, routePoints, themeLabel, viewport) {
  const fontSize = themeLabel.fontSize;
  const offset = themeLabel.offset;
  const padX = themeLabel.paddingX;
  const padY = themeLabel.paddingY;
  const maxChars = themeLabel.maxChars || 28;
  const placed = [];
  const warnings = [];
  const occupied = [];

  for (const port of ports) {
    const r = port.markerRadius + 2;
    occupied.push({
      left: port.x - r,
      top: port.y - r,
      right: port.x + r,
      bottom: port.y + r,
      kind: "marker"
    });
  }

  for (const port of ports) {
    const rawName = String(port.name || "Port").trim() || "Port";
    const name =
      rawName.length > maxChars ? `${rawName.slice(0, maxChars - 1)}…` : rawName;

    let best = null;
    let bestScore = Infinity;

    for (const cand of CANDIDATES) {
      const lx = port.x + cand.dx * (port.markerRadius + offset);
      const ly = port.y + cand.dy * (port.markerRadius + offset * 0.75);
      const box = labelBox(lx, ly, name, fontSize, cand.anchor, cand.baseline, padX, padY);

      let score = 0;
      if (cand.id === "ur") score -= 4;
      if (cand.id === "r") score -= 2;

      if (box.left < 4 || box.top < 4 || box.right > viewport.width - 4 || box.bottom > viewport.height - 4) {
        score += 80;
        const clipX = Math.max(0, 4 - box.left) + Math.max(0, box.right - (viewport.width - 4));
        const clipY = Math.max(0, 4 - box.top) + Math.max(0, box.bottom - (viewport.height - 4));
        score += (clipX + clipY) * 3;
      }

      for (const other of occupied) {
        if (boxesOverlap(box, other, 3)) {
          score += other.kind === "marker" ? 120 : 90;
        }
      }

      score += boxRoutePenalty(box, routePoints, 10);

      const dist = Math.hypot(lx - port.x, ly - port.y);
      score += dist * 0.15;

      if (score < bestScore) {
        bestScore = score;
        best = {
          portId: port.id,
          name,
          x: Math.round(lx * 100) / 100,
          y: Math.round(ly * 100) / 100,
          anchor: cand.anchor,
          baseline: cand.baseline,
          candidate: cand.id,
          box,
          score: bestScore,
          leader: {
            x1: Math.round(port.x * 100) / 100,
            y1: Math.round(port.y * 100) / 100,
            x2: Math.round(lx * 100) / 100,
            y2: Math.round(ly * 100) / 100
          },
          useLeader: Math.abs(cand.dx) + Math.abs(cand.dy) >= 1
        };
      }
    }

    if (!best || bestScore >= 85) {
      warnings.push({
        code: "label_collision",
        port_id: port.id,
        name,
        message: `Unresolved or weak label placement for "${name}" (score=${best ? best.score.toFixed(1) : "n/a"}).`
      });
    }

    if (best) {
      placed.push(best);
      occupied.push({ ...best.box, kind: "label" });
    }
  }

  return { labels: placed, warnings };
}

module.exports = {
  placePortLabels,
  estimateTextWidth,
  labelBox,
  CANDIDATES
};
