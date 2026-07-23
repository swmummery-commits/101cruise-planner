/**
 * Sprint 13E Phase 3A/3B — Deterministic SVG route-map renderer.
 *
 * Accepts a persisted Route Object and returns a standalone SVG string.
 * Independent of Supabase, Netlify handlers, Media Library, WordPress,
 * Featured Cruise HTML, and Admin UI.
 *
 * Phase 3B: premium branded visual hierarchy (vector-only art direction).
 *
 * Usage:
 *   const { renderRouteMapSvg } = require("./route-map-svg");
 *   const { svg, meta } = renderRouteMapSvg(routeObject, options);
 */

const { ROUTE_MAP_THEME } = require("./route-map-theme");
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
const { placePortLabels } = require("./route-map-labels");
const { placeCountryLabels } = require("./route-map-country-labels");
const { placeShip, shipSvgMarkup } = require("./route-map-ship");
const { placeRouteArrows, arrowPathD } = require("./route-map-arrows");

function escapeXml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function isLonLatPair(value) {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(Number(value[0])) &&
    Number.isFinite(Number(value[1]))
  );
}

function normaliseRouteObject(input) {
  if (!input || typeof input !== "object") {
    return { ok: false, error: { code: "missing_route_object", message: "Route Object is required." } };
  }
  const route =
    input.route_data && typeof input.route_data === "object" && (input.route_data.legs || input.route_data.stops)
      ? input.route_data
      : input;

  const stops = Array.isArray(route.stops) ? route.stops : null;
  const legs = Array.isArray(route.legs) ? route.legs : null;
  if (!stops || !legs) {
    return {
      ok: false,
      error: {
        code: "malformed_route_object",
        message: "Route Object must include stops[] and legs[]."
      }
    };
  }
  return { ok: true, route };
}

function collectSimplifiedRoute(legs) {
  const merged = [];
  const errors = [];
  for (let i = 0; i < legs.length; i += 1) {
    const leg = legs[i] || {};
    const coords = leg.simplified_coordinates;
    if (!Array.isArray(coords) || coords.length < 2) {
      errors.push({
        code: "missing_simplified_coordinates",
        message: `Leg ${i + 1} is missing simplified_coordinates.`,
        leg_index: i
      });
      continue;
    }
    for (let j = 0; j < coords.length; j += 1) {
      if (!isLonLatPair(coords[j])) {
        errors.push({
          code: "invalid_coordinate",
          message: `Leg ${i + 1} has an invalid coordinate at index ${j}.`,
          leg_index: i
        });
        continue;
      }
      const pt = [Number(coords[j][0]), Number(coords[j][1])];
      if (merged.length) {
        const prev = merged[merged.length - 1];
        if (prev[0] === pt[0] && prev[1] === pt[1]) continue;
      }
      merged.push(pt);
    }
  }
  return { coordinates: merged, errors };
}

function orderedStops(stops) {
  return [...stops]
    .map((stop, index) => ({
      sequence: stop.sequence != null ? Number(stop.sequence) : index + 1,
      port_id: stop.port_id || `stop-${index + 1}`,
      name: stop.name || stop.canonical_name || stop.entered_port_text || `Port ${index + 1}`,
      latitude: Number(stop.latitude),
      longitude: Number(stop.longitude)
    }))
    .filter((s) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude))
    .sort((a, b) => a.sequence - b.sequence);
}

function pointsToPath(points) {
  if (!points.length) return "";
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p[0]} ${p[1]}`)
    .join(" ");
}

/** Rough projected span of an SVG path (max(dx,dy)) for coastal-band filtering. */
function approximatePathSpan(pathD) {
  const nums = String(pathD || "").match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 4) return 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const x = Number(nums[i]);
    const y = Number(nums[i + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return 0;
  return Math.max(maxX - minX, maxY - minY);
}

function deepMergeTheme(base, overrides) {
  if (!overrides) return base;
  const out = { ...base };
  for (const key of Object.keys(overrides)) {
    const v = overrides[key];
    if (v && typeof v === "object" && !Array.isArray(v) && base[key] && typeof base[key] === "object") {
      out[key] = { ...base[key], ...v };
    } else if (v !== undefined) {
      out[key] = v;
    }
  }
  return out;
}

function buildSeaDefs(theme, width, height) {
  const stops = (theme.sea.stops || [])
    .map((s) => `<stop offset="${s.offset}" stop-color="${s.color}"/>`)
    .join("");
  return [
    `<linearGradient id="${theme.sea.gradientId}" x1="0%" y1="0%" x2="100%" y2="100%">`,
    stops,
    "</linearGradient>",
    `<radialGradient id="${theme.sea.vignetteId}" cx="50%" cy="48%" r="72%">`,
    `<stop offset="55%" stop-color="${theme.sea.vignetteColor}" stop-opacity="0"/>`,
    `<stop offset="100%" stop-color="${theme.sea.vignetteColor}" stop-opacity="${theme.sea.vignetteOpacity}"/>`,
    "</radialGradient>",
    // Soft filter for route polish (native SVG; no external assets)
    `<filter id="route-soft" x="-20%" y="-20%" width="140%" height="140%">`,
    `<feGaussianBlur in="SourceGraphic" stdDeviation="0.35" result="blur"/>`,
    `<feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>`,
    "</filter>",
    // Elegant green glow under the hero route (blur only the glow layer)
    `<filter id="route-glow" x="-40%" y="-40%" width="180%" height="180%">`,
    `<feGaussianBlur in="SourceGraphic" stdDeviation="2.4"/>`,
    "</filter>",
    // Soften stepped coastal bands into a smoother depth fade
    `<filter id="coastal-soft" x="-8%" y="-8%" width="116%" height="116%">`,
    `<feGaussianBlur in="SourceGraphic" stdDeviation="3.2"/>`,
    "</filter>"
  ].join("");
}

function buildSeaDepthEllipses(theme, width, height) {
  // Deterministic soft depth — a few large ellipses only (lightweight)
  const cx = Math.round(width * 0.52);
  const cy = Math.round(height * 0.55);
  const parts = [];
  const layers = [
    { rx: width * 0.38, ry: height * 0.28, op: theme.sea.depthOpacity },
    { rx: width * 0.22, ry: height * 0.16, op: theme.sea.depthOpacity * 0.85 },
    { rx: width * 0.55, ry: height * 0.4, op: theme.sea.depthOpacity * 0.55 }
  ];
  for (const layer of layers) {
    parts.push(
      `<ellipse cx="${cx}" cy="${cy}" rx="${Math.round(layer.rx)}" ry="${Math.round(layer.ry)}" fill="${theme.sea.depthColor}" fill-opacity="${layer.op}"/>`
    );
  }
  return parts.join("");
}

/**
 * Render a deterministic standalone SVG from a Route Object.
 */
function renderRouteMapSvg(routeObject, options = {}) {
  const started = Date.now();
  const normalised = normaliseRouteObject(routeObject);
  if (!normalised.ok) {
    return {
      ok: false,
      svg: null,
      meta: {},
      warnings: [],
      errors: [normalised.error]
    };
  }

  const route = normalised.route;
  const theme = deepMergeTheme(ROUTE_MAP_THEME, options.theme);
  const width = Number(options.width) || theme.layout.width;
  const height = Number(options.height) || theme.layout.height;
  const shipProgress =
    options.shipProgress != null ? Number(options.shipProgress) : theme.layout.shipProgress;
  const coastlineResolution =
    options.coastlineResolution || theme.layout.coastlineResolution || "50m";

  const stops = orderedStops(route.stops);
  const { coordinates: rawRoute, errors: geomErrors } = collectSimplifiedRoute(route.legs);
  if (geomErrors.length || rawRoute.length < 2 || stops.length < 2) {
    return {
      ok: false,
      svg: null,
      meta: {
        width,
        height,
        stop_count: stops.length,
        leg_count: Array.isArray(route.legs) ? route.legs.length : 0
      },
      warnings: [],
      errors: geomErrors.length
        ? geomErrors
        : [
            {
              code: "insufficient_geometry",
              message: "Need at least two stops and a continuous simplified route polyline."
            }
          ]
    };
  }

  const drawRoute = unwrapPolylineForDrawing(rawRoute);
  const stopLonLat = stops.map((s) => [s.longitude, s.latitude]);
  const unwrappedStops = unwrapPolylineForDrawing([drawRoute[0], ...stopLonLat]).slice(1);

  const boundPoints = [...drawRoute, ...unwrappedStops];
  const rawBounds = boundsFromPoints(boundPoints);
  const geo = expandBoundsForViewport(rawBounds, {
    width,
    height,
    paddingRatio: options.paddingRatio != null ? options.paddingRatio : theme.layout.paddingRatio,
    paddingDegreesMin: theme.layout.paddingDegreesMin,
    minLonSpan: theme.layout.minLonSpan,
    minLatSpan: theme.layout.minLatSpan
  });
  const projector = createProjector(geo, {
    width,
    height,
    precision: theme.layout.coordPrecision
  });

  const projectedRoute = projector.projectPoints(drawRoute);
  const projectedStops = stops.map((stop, index) => {
    const lonLat = unwrappedStops[index];
    const [x, y] = projector.project(lonLat[0], lonLat[1]);
    return {
      id: stop.port_id,
      sequence: index + 1,
      name: stop.name,
      x,
      y,
      markerRadius: theme.marker.radius,
      longitude: lonLat[0],
      latitude: lonLat[1]
    };
  });

  let landPaths = [];
  let coastlineMeta = { resolution: coastlineResolution, ring_count: 0 };
  try {
    const land = loadLandFeatureCollection(coastlineResolution);
    const rings = extractLandRingsForBBox(land, geo);
    landPaths = rings.map((ring) => ringToSvgPath(ring, projector)).filter(Boolean);
    coastlineMeta = {
      resolution: land.__resolution || coastlineResolution,
      source: land.__source || "world-atlas/natural-earth",
      ring_count: landPaths.length
    };
  } catch (error) {
    return {
      ok: false,
      svg: null,
      meta: { width, height },
      warnings: [],
      errors: [
        {
          code: "coastline_unavailable",
          message: String(error.message || error)
        }
      ]
    };
  }

  const { labels, warnings: labelWarnings } = placePortLabels(
    projectedStops,
    projectedRoute,
    theme.label,
    { width, height }
  );

  const countryObstacles = projectedStops.map((stop) => {
    const r = theme.marker.radius + 10;
    return {
      left: stop.x - r,
      top: stop.y - r,
      right: stop.x + r,
      bottom: stop.y + r
    };
  });

  const countryLabels = placeCountryLabels(geo, projector, { width, height }, {
    maxLabels: theme.countryLabel?.maxLabels ?? 8,
    padPx: theme.countryLabel?.padPx ?? 22,
    // Markers only — port name boxes shouldn't push coastal countries off the map.
    obstacles: countryObstacles,
    nearPoints: projectedStops.map((s) => ({ x: s.x, y: s.y }))
  });

  const shipObstacles = [
    ...projectedStops.map((s) => ({ x: s.x, y: s.y, r: theme.layout.shipMarkerClearancePx })),
    ...labels.map((l) => ({
      x: (l.box.left + l.box.right) / 2,
      y: (l.box.top + l.box.bottom) / 2,
      r: Math.max(18, Math.hypot(l.box.right - l.box.left, l.box.bottom - l.box.top) * 0.45)
    }))
  ];

  const ship = placeShip(
    projectedRoute,
    shipProgress,
    shipObstacles,
    theme.layout.shipMarkerClearancePx
  );

  const arrowObstacles = [
    ...projectedStops.map((s) => ({
      x: s.x,
      y: s.y,
      r: theme.marker.radius + theme.arrows.clearancePx * 0.55
    })),
    ...labels.map((l) => ({
      x: (l.box.left + l.box.right) / 2,
      y: (l.box.top + l.box.bottom) / 2,
      r: Math.max(16, Math.hypot(l.box.right - l.box.left, l.box.bottom - l.box.top) * 0.4)
    }))
  ];
  if (ship) {
    arrowObstacles.push({
      x: ship.x,
      y: ship.y,
      r: Math.max(theme.ship.length, theme.ship.beam) * 0.85
    });
  }

  const arrows =
    theme.arrows.enabled === false
      ? []
      : placeRouteArrows(projectedRoute, {
          spacingPx: theme.arrows.spacingPx,
          minCount: theme.arrows.minCount,
          maxCount: theme.arrows.maxCount,
          clearancePx: theme.arrows.clearancePx,
          endPadding: theme.arrows.endPadding,
          obstacles: arrowObstacles
        });

  const routePath = pointsToPath(projectedRoute);
  const shipMarkup = shipSvgMarkup(theme.ship);
  const arrowD = arrowPathD(theme.arrows.size);

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Cruise itinerary route map">`
  );
  parts.push("<defs>");
  parts.push(buildSeaDefs(theme, width, height));
  parts.push(
    `<symbol id="route-arrow" overflow="visible"><path d="${arrowD}" fill="${theme.arrows.fill}" stroke="${theme.arrows.stroke}" stroke-width="${theme.arrows.strokeWidth}" stroke-opacity="${theme.arrows.strokeOpacity}" stroke-linejoin="round"/></symbol>`
  );
  parts.push("</defs>");

  // --- Ocean (richest background, lowest hierarchy) ---
  parts.push('<g id="ocean">');
  parts.push(
    `<rect id="sea-background" x="0" y="0" width="${width}" height="${height}" fill="url(#${theme.sea.gradientId})"/>`
  );
  parts.push(buildSeaDepthEllipses(theme, width, height));
  parts.push(
    `<rect x="0" y="0" width="${width}" height="${height}" fill="url(#${theme.sea.vignetteId})"/>`
  );
  parts.push("</g>");

  // --- Shallow coastal water: wide→narrow bands fade into deep blue ---
  // Apply only to larger land rings (tiny islets skip) to keep SVG weight practical.
  const coastalBands = Array.isArray(theme.sea.coastalBands) ? theme.sea.coastalBands : [];
  const coastalPaths = landPaths.filter((d) => approximatePathSpan(d) >= 90);
  if (coastalBands.length && coastalPaths.length) {
    parts.push('<g id="coastal-waters" fill="none" filter="url(#coastal-soft)">');
    for (const band of coastalBands) {
      for (const d of coastalPaths) {
        parts.push(
          `<path d="${d}" stroke="${band.color}" stroke-width="${band.width}" stroke-opacity="${band.opacity}" stroke-linejoin="round"/>`
        );
      }
    }
    parts.push("</g>");
  }

  // --- Land + delicate coastline ---
  // No SVG filters on land — Safari was rendering filtered land as invisible.
  parts.push('<g id="land">');
  for (const d of landPaths) {
    parts.push(
      `<path d="${d}" fill="${theme.land.fill}" fill-rule="evenodd" stroke="${theme.land.stroke}" stroke-width="${theme.land.strokeWidth}" stroke-opacity="${theme.land.strokeOpacity}" stroke-linejoin="round"/>`
    );
  }
  parts.push("</g>");

  // --- Country names (muted geography under the route) ---
  parts.push('<g id="country-labels">');
  const countryTheme = theme.countryLabel || {};
  for (const c of countryLabels) {
    const halo =
      countryTheme.haloFill && countryTheme.haloWidth
        ? ` stroke="${countryTheme.haloFill}" stroke-width="${countryTheme.haloWidth}" paint-order="stroke fill"`
        : "";
    parts.push(
      `<text x="${c.x}" y="${c.y}" text-anchor="middle" dominant-baseline="middle" font-family="${escapeXml(
        countryTheme.fontFamily || theme.label.fontFamily
      )}" font-size="${countryTheme.fontSize || 10}" font-weight="${
        countryTheme.fontWeight || 600
      }" letter-spacing="${countryTheme.letterSpacing != null ? countryTheme.letterSpacing : 0.6}" fill="${
        countryTheme.fill || "#8A7B68"
      }"${halo}>${escapeXml(String(c.name).toUpperCase())}</text>`
    );
  }
  parts.push("</g>");

  // --- Route (hero) ---
  parts.push('<g id="route" fill="none">');
  if (theme.route.glowStroke) {
    parts.push(
      `<path d="${routePath}" stroke="${theme.route.glowStroke}" stroke-width="${theme.route.glowWidth}" stroke-opacity="${theme.route.glowOpacity}" stroke-linecap="${theme.route.linecap}" stroke-linejoin="${theme.route.linejoin}" filter="url(#route-glow)"/>`
    );
  }
  parts.push(
    `<g filter="url(#route-soft)">` +
      `<path d="${routePath}" stroke="${theme.route.underlayStroke}" stroke-width="${theme.route.underlayWidth}" stroke-opacity="${theme.route.underlayOpacity}" stroke-linecap="${theme.route.linecap}" stroke-linejoin="${theme.route.linejoin}"/>` +
      `<path id="marine-route" d="${routePath}" stroke="${theme.route.stroke}" stroke-width="${theme.route.strokeWidth}" stroke-linecap="${theme.route.linecap}" stroke-linejoin="${theme.route.linejoin}"/>` +
      `<path d="${routePath}" stroke="${theme.route.highlightStroke}" stroke-width="${theme.route.highlightWidth}" stroke-opacity="${theme.route.highlightOpacity}" stroke-linecap="${theme.route.linecap}" stroke-linejoin="${theme.route.linejoin}"/>` +
      `</g>`
  );
  parts.push("</g>");

  // --- Directional arrows ---
  parts.push('<g id="route-arrows">');
  for (const arrow of arrows) {
    parts.push(
      `<g transform="translate(${arrow.x} ${arrow.y}) rotate(${arrow.angleDeg})">` +
        `<path d="${arrowD}" fill="${theme.arrows.fill}" stroke="${theme.arrows.stroke}" stroke-width="${theme.arrows.strokeWidth}" stroke-opacity="${theme.arrows.strokeOpacity}" stroke-linejoin="round"/>` +
        `</g>`
    );
  }
  parts.push("</g>");

  // --- Ship ---
  if (ship) {
    parts.push('<g id="ship">');
    parts.push(
      `<g transform="translate(${ship.x} ${ship.y}) rotate(${ship.angleDeg})">${shipMarkup}</g>`
    );
    parts.push("</g>");
  } else {
    parts.push('<g id="ship"></g>');
  }

  // --- Port markers ---
  parts.push('<g id="port-markers">');
  for (const stop of projectedStops) {
    const shadow = theme.marker.shadowOpacity
      ? `<circle cx="0.6" cy="0.9" r="${theme.marker.radius}" fill="#0F1720" fill-opacity="${theme.marker.shadowOpacity}"/>`
      : "";
    parts.push(
      `<g class="port-marker" data-sequence="${stop.sequence}" transform="translate(${stop.x} ${stop.y})">` +
        shadow +
        `<circle r="${theme.marker.radius}" fill="${theme.marker.fill}" stroke="${theme.marker.stroke}" stroke-width="${theme.marker.strokeWidth}"/>` +
        `<circle r="${Math.max(1, theme.marker.radius - theme.marker.strokeWidth - 0.8)}" fill="none" stroke="${theme.marker.innerStroke}" stroke-width="${theme.marker.innerStrokeWidth}" stroke-opacity="0.35"/>` +
        // dominant-baseline middle — more reliable in resvg PNG than "central"
        `<text text-anchor="middle" dominant-baseline="middle" dy="0.35" font-family="${escapeXml(theme.marker.fontFamily)}" font-size="${theme.marker.fontSize}" font-weight="${theme.marker.fontWeight}" fill="${theme.marker.numberFill}">${stop.sequence}</text>` +
        `</g>`
    );
  }
  parts.push("</g>");

  // --- Labels (secondary) ---
  parts.push('<g id="port-labels">');
  for (const label of labels) {
    if (label.useLeader) {
      parts.push(
        `<line x1="${label.leader.x1}" y1="${label.leader.y1}" x2="${label.leader.x2}" y2="${label.leader.y2}" stroke="${theme.label.leaderStroke}" stroke-width="${theme.label.leaderWidth}" stroke-opacity="${theme.label.leaderOpacity}"/>`
      );
    }
    const halo =
      theme.label.haloFill && theme.label.haloWidth
        ? ` stroke="${theme.label.haloFill}" stroke-width="${theme.label.haloWidth}" paint-order="stroke fill"`
        : "";
    parts.push(
      `<text x="${label.x}" y="${label.y}" text-anchor="${label.anchor}" dominant-baseline="${label.baseline}" font-family="${escapeXml(theme.label.fontFamily)}" font-size="${theme.label.fontSize}" font-weight="${theme.label.fontWeight}" fill="${theme.label.fill}"${halo}>${escapeXml(label.name)}</text>`
    );
  }
  parts.push("</g>");

  parts.push("</svg>");
  const svg = parts.join("");

  const clipWarnings = [];
  for (const label of labels) {
    const b = label.box;
    if (b.left < 0 || b.top < 0 || b.right > width || b.bottom > height) {
      clipWarnings.push({
        code: "label_clipped",
        port_id: label.portId,
        name: label.name,
        message: `Label "${label.name}" extends outside the viewBox.`
      });
    }
  }

  const warnings = [...labelWarnings, ...clipWarnings];
  const meta = {
    width,
    height,
    projection: "equirectangular_aspect_corrected",
    coastline: coastlineMeta,
    itinerary_signature: route.itinerary_signature || null,
    featured_cruise_id: route.featured_cruise_id || null,
    stop_count: projectedStops.length,
    leg_count: route.legs.length,
    route_point_count: projectedRoute.length,
    arrow_count: arrows.length,
    ship_progress: ship ? ship.progress : null,
    ship_angle_deg: ship ? ship.angleDeg : null,
    label_count: labels.length,
    country_label_count: countryLabels.length,
    runtime_ms: Date.now() - started,
    theme_phase: "3c"
  };

  return {
    ok: true,
    svg,
    meta,
    warnings,
    errors: []
  };
}

module.exports = {
  renderRouteMapSvg,
  normaliseRouteObject,
  collectSimplifiedRoute,
  orderedStops,
  escapeXml
};
