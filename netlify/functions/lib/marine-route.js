/**
 * Sprint 13E Phase 1 — Offline marine routing (MARNET / Eurostat SeaRoute).
 *
 * Calculates navigable sea polylines between ordered itinerary ports.
 * Does NOT render SVG/PNG, upload media, or touch newsletter/public pages.
 *
 * Engine: @ssroute/typescript + @ssroute/data-eurostat (A* on MARNET graph).
 */

const { findRoute } = require("@ssroute/typescript");

const ERROR_CODES = {
  MISSING_COORDINATES: "missing_coordinates",
  INVALID_COORDINATES: "invalid_coordinates",
  INSUFFICIENT_PORTS: "insufficient_ports",
  ROUTING_FAILED: "routing_failed",
  ENGINE_UNAVAILABLE: "engine_unavailable"
};

/**
 * @typedef {object} RoutePortInput
 * @property {string} [id]
 * @property {string} [port_id]
 * @property {string} [name]
 * @property {number|string|null} [latitude]
 * @property {number|string|null} [longitude]
 * @property {number|string|null} [lat]
 * @property {number|string|null} [lon]
 * @property {number|string|null} [lng]
 */

/**
 * @typedef {object} MarineRouteLeg
 * @property {string|null} from_port_id
 * @property {string|null} to_port_id
 * @property {string|null} from_name
 * @property {string|null} to_name
 * @property {number} from_index
 * @property {number} to_index
 * @property {number|null} distance_nm
 * @property {number|null} distance_km
 * @property {number|null} waypoints
 * @property {Array<[number, number]>} polyline  GeoJSON order: [longitude, latitude]
 */

/**
 * @typedef {object} MarineRouteError
 * @property {string} code
 * @property {string} message
 * @property {string|null} [port_id]
 * @property {string|null} [port_name]
 * @property {number|null} [port_index]
 * @property {number|null} [leg_index]
 * @property {string|null} [from_port_id]
 * @property {string|null} [to_port_id]
 */

function asFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function nmToKm(nm) {
  if (nm == null || !Number.isFinite(nm)) return null;
  return nm * 1.852;
}

/** Great-circle distance in nautical miles (WGS84 sphere approximation). */
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
  // Earth mean radius in nautical miles
  return (3440.065 * c);
}

function portIdOf(port) {
  if (!port) return null;
  const raw = port.id ?? port.port_id ?? null;
  if (raw == null) return null;
  const s = String(raw).trim();
  return s || null;
}

function portNameOf(port) {
  if (!port) return null;
  const raw = port.name ?? port.canonical_name ?? port.display_name ?? null;
  if (raw == null) return null;
  const s = String(raw).trim();
  return s || null;
}

/**
 * Normalize a port input to validated lat/lon or an error.
 * @param {RoutePortInput} port
 * @param {number} index
 */
function normalizePort(port, index) {
  const id = portIdOf(port);
  const name = portNameOf(port);
  const label = name || id || `port[${index}]`;

  if (!port || typeof port !== "object") {
    return {
      ok: false,
      error: {
        code: ERROR_CODES.MISSING_COORDINATES,
        message: `Stop ${index + 1}: port payload is missing.`,
        port_id: id,
        port_name: name,
        port_index: index
      }
    };
  }

  const lat = asFiniteNumber(port.latitude ?? port.lat);
  const lon = asFiniteNumber(port.longitude ?? port.lon ?? port.lng);

  if (lat == null || lon == null) {
    return {
      ok: false,
      error: {
        code: ERROR_CODES.MISSING_COORDINATES,
        message: `Stop ${index + 1} (${label}): latitude and longitude are required.`,
        port_id: id,
        port_name: name,
        port_index: index
      }
    };
  }

  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return {
      ok: false,
      error: {
        code: ERROR_CODES.INVALID_COORDINATES,
        message: `Stop ${index + 1} (${label}): coordinates out of range (lat ${lat}, lon ${lon}).`,
        port_id: id,
        port_name: name,
        port_index: index
      }
    };
  }

  return {
    ok: true,
    port: {
      id,
      name,
      latitude: lat,
      longitude: lon,
      index
    }
  };
}

/**
 * Route a single sea leg between two normalized ports.
 * @returns {{ ok: true, leg: MarineRouteLeg } | { ok: false, error: MarineRouteError }}
 */
function routeLeg(from, to, legIndex) {
  try {
    const result = findRoute(
      { lat: from.latitude, lon: from.longitude },
      { lat: to.latitude, lon: to.longitude }
    );

    const coords = Array.isArray(result?.route?.coordinates) ? result.route.coordinates : [];
    if (coords.length < 2) {
      // Degenerate/empty graph result (common outside Eurostat coverage) —
      // fall back to a straight sea segment between the two port positions.
      const polyline = [
        [from.longitude, from.latitude],
        [to.longitude, to.latitude]
      ];
      const distanceNm = haversineNm(from.latitude, from.longitude, to.latitude, to.longitude);
      return {
        ok: true,
        leg: {
          from_port_id: from.id,
          to_port_id: to.id,
          from_name: from.name,
          to_name: to.name,
          from_index: from.index,
          to_index: to.index,
          distance_nm: distanceNm,
          distance_km: nmToKm(distanceNm),
          waypoints: 2,
          polyline,
          fallback: "straight_line",
          warning: `Leg ${legIndex + 1}: marine graph returned a degenerate route; used straight line (${from.name || from.id} → ${to.name || to.id}).`
        }
      };
    }

    /** @type {Array<[number, number]>} */
    const polyline = coords.map((pair) => {
      const lon = Number(pair[0]);
      const lat = Number(pair[1]);
      return [lon, lat];
    });

    const distanceNm =
      result.distance != null && Number.isFinite(Number(result.distance))
        ? Number(result.distance)
        : null;

    return {
      ok: true,
      leg: {
        from_port_id: from.id,
        to_port_id: to.id,
        from_name: from.name,
        to_name: to.name,
        from_index: from.index,
        to_index: to.index,
        distance_nm: distanceNm,
        distance_km: nmToKm(distanceNm),
        waypoints: result.waypoints != null ? Number(result.waypoints) : polyline.length,
        polyline
      }
    };
  } catch (error) {
    const detail = String(error?.message || error || "unknown routing error");
    return {
      ok: false,
      error: {
        code: ERROR_CODES.ROUTING_FAILED,
        message: `Leg ${legIndex + 1}: routing failed (${from.name || from.id} → ${to.name || to.id}): ${detail}`,
        leg_index: legIndex,
        from_port_id: from.id,
        to_port_id: to.id,
        port_id: null,
        port_name: null,
        port_index: null
      }
    };
  }
}

/**
 * Calculate marine route polylines for an ordered list of ports.
 *
 * @param {RoutePortInput[]} portsOrdered
 * @param {{ continueOnLegError?: boolean }} [options]
 * @returns {{
 *   ok: boolean,
 *   legs: MarineRouteLeg[],
 *   errors: MarineRouteError[],
 *   summary: {
 *     port_count: number,
 *     leg_count: number,
 *     routed_leg_count: number,
 *     total_distance_nm: number|null,
 *     total_distance_km: number|null,
 *     engine: string
 *   }
 * }}
 */
function routeMarineItinerary(portsOrdered, options = {}) {
  const continueOnLegError = Boolean(options.continueOnLegError);
  /** @type {MarineRouteError[]} */
  const errors = [];
  /** @type {MarineRouteLeg[]} */
  const legs = [];

  if (!Array.isArray(portsOrdered) || portsOrdered.length < 2) {
    errors.push({
      code: ERROR_CODES.INSUFFICIENT_PORTS,
      message: "At least two ports with coordinates are required to build a marine route.",
      port_id: null,
      port_name: null,
      port_index: null,
      leg_index: null,
      from_port_id: null,
      to_port_id: null
    });
    return {
      ok: false,
      legs,
      errors,
      summary: {
        port_count: Array.isArray(portsOrdered) ? portsOrdered.length : 0,
        leg_count: 0,
        routed_leg_count: 0,
        total_distance_nm: null,
        total_distance_km: null,
        engine: "@ssroute/typescript"
      }
    };
  }

  if (typeof findRoute !== "function") {
    errors.push({
      code: ERROR_CODES.ENGINE_UNAVAILABLE,
      message: "Marine routing engine (@ssroute/typescript) is not available.",
      port_id: null,
      port_name: null,
      port_index: null,
      leg_index: null,
      from_port_id: null,
      to_port_id: null
    });
    return {
      ok: false,
      legs,
      errors,
      summary: {
        port_count: portsOrdered.length,
        leg_count: 0,
        routed_leg_count: 0,
        total_distance_nm: null,
        total_distance_km: null,
        engine: "@ssroute/typescript"
      }
    };
  }

  const normalized = [];
  for (let i = 0; i < portsOrdered.length; i += 1) {
    const result = normalizePort(portsOrdered[i], i);
    if (!result.ok) {
      errors.push({
        ...result.error,
        leg_index: null,
        from_port_id: null,
        to_port_id: null
      });
      continue;
    }
    normalized.push(result.port);
  }

  // Only route between consecutive successfully normalized ports that
  // preserve original itinerary adjacency (no skipping failed stops).
  for (let i = 0; i < portsOrdered.length - 1; i += 1) {
    const fromNorm = normalized.find((p) => p.index === i);
    const toNorm = normalized.find((p) => p.index === i + 1);
    if (!fromNorm || !toNorm) {
      // Missing coords on either endpoint already recorded; skip this leg.
      continue;
    }

    const legResult = routeLeg(fromNorm, toNorm, i);
    if (!legResult.ok) {
      errors.push(legResult.error);
      if (!continueOnLegError) break;
      continue;
    }
    legs.push(legResult.leg);
    if (legResult.leg.warning) {
      // Surface as a top-level warning via callers that read leg.warning
    }
  }

  const totalNm = legs.reduce((sum, leg) => {
    if (leg.distance_nm == null) return sum;
    return sum + leg.distance_nm;
  }, 0);
  const hasDistance = legs.some((leg) => leg.distance_nm != null);

  const expectedLegs = Math.max(0, portsOrdered.length - 1);
  const ok = errors.length === 0 && legs.length === expectedLegs;

  return {
    ok,
    legs,
    errors,
    summary: {
      port_count: portsOrdered.length,
      leg_count: expectedLegs,
      routed_leg_count: legs.length,
      total_distance_nm: hasDistance ? totalNm : null,
      total_distance_km: hasDistance ? nmToKm(totalNm) : null,
      engine: "@ssroute/typescript + @ssroute/data-eurostat (MARNET)"
    }
  };
}

module.exports = {
  ERROR_CODES,
  routeMarineItinerary,
  routeLeg,
  normalizePort,
  nmToKm,
  haversineNm
};
