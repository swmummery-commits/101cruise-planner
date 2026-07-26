/**
 * Client Portal dashboard journey map — geographic projection + land layer.
 *
 * Projection: aspect-corrected equirectangular (Plate Carrée), shared with
 * featured route-map helpers. Land: Natural Earth via world-atlas (offline).
 */

"use strict";

const { unwrapPolylineForDrawing } = require("./antimeridian");
const {
  boundsFromPoints,
  expandBoundsForViewport,
  createProjector
} = require("./route-map-projection");
const {
  loadLandFeatureCollection,
  extractLandRingsForBBox,
  ringToSvgPath
} = require("./route-map-coastline");

const DEFAULT_WIDTH = 620;
const DEFAULT_HEIGHT = 350;
const DEFAULT_PAD_PX = 36;

function isSeaDay(stop) {
  const type = String(stop?.type || stop?.entry_type || "").toLowerCase();
  const name = String(stop?.name || "").toLowerCase();
  return type === "sea_day" || name === "at sea" || name.includes("at sea");
}

function hasCoordinates(stop) {
  const lat = Number(stop?.lat ?? stop?.latitude);
  const lng = Number(stop?.lng ?? stop?.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng);
}

function shortPortLabel(name) {
  const text = String(name || "").trim();
  const paren = text.match(/^(.+?)\s*\((.+?)\)\s*$/);
  if (paren) return paren[1].trim();
  return text.length > 18 ? `${text.slice(0, 16)}…` : text;
}

function buildSmoothPath(points) {
  if (!points.length) return "";
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x} ${p2.y}`;
  }
  return d;
}

function collectRoutePoints(journey) {
  return (journey?.stops || [])
    .filter((s) => !isSeaDay(s) && hasCoordinates(s))
    .filter((s, i, arr) => {
      if (i === 0) return true;
      const prev = arr[i - 1];
      return !(Number(prev.lat) === Number(s.lat) && Number(prev.lng) === Number(s.lng));
    })
    .map((s) => ({
      ...s,
      lat: Number(s.lat ?? s.latitude),
      lng: Number(s.lng ?? s.longitude)
    }));
}

/**
 * Project a dashboard journey into SVG space with geographic padding.
 * Returns the same projector used for land rings and ship path.
 */
function projectJourneyMap(journey, options = {}) {
  const width = options.width || DEFAULT_WIDTH;
  const height = options.height || DEFAULT_HEIGHT;
  const padPx = options.padPx != null ? Number(options.padPx) : DEFAULT_PAD_PX;

  const points = collectRoutePoints(journey);
  if (points.length < 2) {
    return { ok: false, reason: "insufficient_coordinates" };
  }

  const rawLonLat = points.map((p) => [p.lng, p.lat]);
  const unwrapped = unwrapPolylineForDrawing(rawLonLat);
  const routeBounds = boundsFromPoints(unwrapped);
  if (!routeBounds) {
    return { ok: false, reason: "insufficient_coordinates" };
  }

  const geo = expandBoundsForViewport(routeBounds, {
    width: width - padPx * 2,
    height: height - padPx * 2,
    paddingRatio: options.paddingRatio != null ? options.paddingRatio : 0.18,
    paddingDegreesMin: options.paddingDegreesMin != null ? options.paddingDegreesMin : 1.2,
    minLonSpan: options.minLonSpan != null ? options.minLonSpan : 6,
    minLatSpan: options.minLatSpan != null ? options.minLatSpan : 4
  });

  // Inner drawable area keeps labels/ship clear of the rounded SVG edge.
  const inner = createProjector(geo, {
    width: width - padPx * 2,
    height: height - padPx * 2,
    precision: 1
  });

  const projectLonLat = (lon, lat) => {
    const [x, y] = inner.project(lon, lat);
    return {
      x: Number((x + padPx).toFixed(1)),
      y: Number((y + padPx).toFixed(1))
    };
  };

  const projected = points.map((p, index) => {
    const [lon] = unwrapped[index];
    const { x, y } = projectLonLat(lon, p.lat);
    const clampedX = Math.min(width - 8, Math.max(8, x));
    const clampedY = Math.min(height - 8, Math.max(8, y));
    return {
      ...p,
      drawLng: lon,
      x: clampedX,
      y: clampedY,
      number: index + 1,
      label: shortPortLabel(p.name)
    };
  });

  const pathD = buildSmoothPath(projected);
  const projector = {
    width,
    height,
    padPx,
    geo,
    project(lon, lat) {
      const pt = projectLonLat(lon, lat);
      return [pt.x, pt.y];
    }
  };

  return {
    ok: true,
    width,
    height,
    padPx,
    pathD,
    ports: projected,
    geo,
    projector,
    routeBounds,
    reason: "ok"
  };
}

/**
 * Build SVG path `d` strings for land intersecting the projected viewport.
 * Failures return [] so callers can fall back to water-only rendering.
 */
function buildLandPathDList(projection, options = {}) {
  if (!projection?.ok || !projection.geo || !projection.projector) return [];
  try {
    const resolution = options.resolution || "50m";
    const land = loadLandFeatureCollection(resolution);
    const rings = extractLandRingsForBBox(land, projection.geo);
    return rings
      .map((ring) => ringToSvgPath(ring, projection.projector))
      .filter((d) => d && d.length > 8);
  } catch (error) {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[dashboard-journey-map] land layer unavailable", error?.message || error);
    }
    return [];
  }
}

function landPathsToSvgMarkup(pathDList, className = "dashboard-map-land-shape") {
  return (pathDList || [])
    .map(
      (d) =>
        `<path class="${className}" d="${d}" fill-rule="evenodd"/>`
    )
    .join("");
}

/**
 * True when a Mediterranean-style bbox includes southern Europe / N. Africa.
 * Used by tests — not hardcoded into the renderer viewport.
 */
function bboxTouchesMediterraneanContext(geo) {
  if (!geo) return false;
  const crossesLon = geo.west < 15 && geo.east > 0;
  const crossesLat = geo.south < 42 && geo.north > 35;
  return crossesLon && crossesLat;
}

module.exports = {
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  collectRoutePoints,
  projectJourneyMap,
  buildLandPathDList,
  landPathsToSvgMarkup,
  buildSmoothPath,
  shortPortLabel,
  bboxTouchesMediterraneanContext
};
