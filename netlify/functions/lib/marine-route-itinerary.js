/**
 * Sprint 13E Phase 2 — Structured itinerary → marine Route Object.
 *
 * Loads featured_cruise_itinerary_stops + ports, normalises routable stops,
 * signatures geometry inputs, calls marine-route.js, simplifies polylines.
 */

const crypto = require("crypto");
const { routeMarineItinerary, nmToKm } = require("./marine-route");
const { simplifyPolyline } = require("./polyline-simplify");

const GEOGRAPHIC_STOP_TYPES = new Set([
  "port_call",
  "embarkation",
  "disembarkation",
  "overnight_port"
]);

const ROUTE_OBJECT_VERSION = 1;

function packageVersion(name, fallback) {
  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const pkg = require(`${name}/package.json`);
    return pkg.version || fallback;
  } catch {
    return fallback;
  }
}

function asFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function coordKey(lat, lon) {
  return `${Number(lat).toFixed(5)},${Number(lon).toFixed(5)}`;
}

function isAtSea(stopType) {
  return String(stopType || "").trim() === "at_sea";
}

function isGeographic(stopType) {
  return GEOGRAPHIC_STOP_TYPES.has(String(stopType || "").trim());
}

/**
 * Map a joined stop+port row into a normalised itinerary record with flags.
 */
function annotateItineraryStop(row, index) {
  const stopType = String(row.stop_type || "").trim() || "port_call";
  const portId = row.port_id || null;
  const lat = asFiniteNumber(row.port_latitude ?? row.latitude);
  const lon = asFiniteNumber(row.port_longitude ?? row.longitude);
  const portStatus = row.port_status || null;
  const flags = [];

  if (isAtSea(stopType)) flags.push("at_sea");
  if (isGeographic(stopType) || stopType === "scenic_cruising") {
    if (!portId) flags.push("missing_canonical_port");
    if (lat == null || lon == null) flags.push("missing_coordinates");
    if (portStatus === "provisional") flags.push("provisional_port");
    if (portStatus === "needs_review") flags.push("needs_review");
    if (!portId && String(row.entered_port_text || "").trim()) flags.push("unresolved_match");
  }

  return {
    itinerary_stop_id: row.id || null,
    display_order: row.display_order != null ? Number(row.display_order) : index + 1,
    day_number: row.day_number == null ? null : Number(row.day_number),
    stop_date: row.stop_date || null,
    stop_type: stopType,
    port_id: portId,
    canonical_name: row.canonical_name || row.port_canonical_name || null,
    display_name: row.display_name || row.port_display_name || null,
    entered_port_text: row.entered_port_text || null,
    entered_country_text: row.entered_country_text || null,
    latitude: lat,
    longitude: lon,
    arrival_time: row.arrival_time || null,
    departure_time: row.departure_time || null,
    is_overnight: Boolean(row.is_overnight) || stopType === "overnight_port",
    port_status: portStatus,
    flags,
    index
  };
}

/**
 * Transform full itinerary into routable geographic stops.
 * Collapses consecutive duplicates (overnight / same port+coords).
 */
function buildRoutableStops(annotatedStops) {
  const warnings = [];
  const errors = [];
  const routable = [];

  for (const stop of annotatedStops || []) {
    if (isAtSea(stop.stop_type)) continue;
    if (!isGeographic(stop.stop_type) && stop.stop_type !== "scenic_cruising") continue;

    if (!stop.port_id) {
      errors.push({
        code: "missing_canonical_port",
        message: `Stop ${stop.display_order}: missing canonical port_id.`,
        itinerary_stop_id: stop.itinerary_stop_id
      });
      continue;
    }
    if (stop.latitude == null || stop.longitude == null) {
      errors.push({
        code: "missing_coordinates",
        message: `Stop ${stop.display_order} (${stop.canonical_name || stop.port_id}): missing coordinates.`,
        itinerary_stop_id: stop.itinerary_stop_id,
        port_id: stop.port_id
      });
      continue;
    }

    const prev = routable[routable.length - 1];
    if (prev) {
      const samePort = prev.port_id && stop.port_id && prev.port_id === stop.port_id;
      const sameCoord =
        coordKey(prev.latitude, prev.longitude) === coordKey(stop.latitude, stop.longitude);
      if (samePort || sameCoord) {
        warnings.push({
          code: "collapsed_consecutive_duplicate",
          message: `Collapsed consecutive duplicate geographic stop at ${stop.canonical_name || stop.port_id} (overnight / same coordinates).`,
          itinerary_stop_id: stop.itinerary_stop_id,
          port_id: stop.port_id
        });
        // Prefer overnight flag if either record is overnight.
        prev.is_overnight = Boolean(prev.is_overnight || stop.is_overnight);
        continue;
      }
    }

    routable.push({
      sequence: routable.length + 1,
      itinerary_stop_id: stop.itinerary_stop_id,
      port_id: stop.port_id,
      name: stop.canonical_name || stop.display_name || stop.entered_port_text || stop.port_id,
      latitude: stop.latitude,
      longitude: stop.longitude,
      stop_type: stop.stop_type,
      is_overnight: stop.is_overnight,
      source_display_order: stop.display_order
    });
  }

  if (routable.length < 2) {
    errors.push({
      code: "insufficient_routable_stops",
      message: `Need at least two distinct routable geographic stops (found ${routable.length}).`
    });
  }

  // Flag non-consecutive duplicate visits (valid — not an error).
  const seen = new Map();
  for (const stop of routable) {
    const count = (seen.get(stop.port_id) || 0) + 1;
    seen.set(stop.port_id, count);
    if (count > 1) {
      warnings.push({
        code: "repeated_port_visit",
        message: `Port ${stop.name} appears more than once in the routable list (valid non-consecutive revisit).`,
        port_id: stop.port_id
      });
    }
  }

  return { routableStops: routable, warnings, errors };
}

/**
 * Deterministic itinerary signature for marine geometry staleness.
 *
 * Inputs (only):
 * - routable sequence index
 * - port_id
 * - latitude (6 dp)
 * - longitude (6 dp)
 *
 * Excludes: pricing, headline, editorial, arrival/departure times,
 * newsletter settings, images, at_sea-only records, overnight notes.
 */
function buildMarineItinerarySignature(routableStops) {
  const parts = (routableStops || []).map((stop, index) => {
    const seq = stop.sequence != null ? stop.sequence : index + 1;
    const portId = stop.port_id || "";
    const lat = Number(stop.latitude).toFixed(6);
    const lon = Number(stop.longitude).toFixed(6);
    return `${seq}|${portId}|${lat}|${lon}`;
  });
  const payload = parts.join(";");
  const hash = crypto.createHash("sha256").update(payload, "utf8").digest("hex");
  return `sha256:${hash}`;
}

function signaturePayloadPreview(routableStops) {
  return (routableStops || []).map((stop, index) => ({
    sequence: stop.sequence != null ? stop.sequence : index + 1,
    port_id: stop.port_id || null,
    latitude: Number(Number(stop.latitude).toFixed(6)),
    longitude: Number(Number(stop.longitude).toFixed(6))
  }));
}

/**
 * Build the full Route Object from routable stops via the marine engine.
 */
function buildMarineRouteObject({
  featuredCruiseId,
  routableStops,
  itinerarySignature,
  simplifyPreset = "final-map",
  warnings = []
}) {
  const engineVersion = packageVersion("@ssroute/typescript", "0.2.0");
  const datasetVersion = packageVersion("@ssroute/data-eurostat", "0.2.1");
  const generatedAt = new Date().toISOString();

  const routeInput = routableStops.map((stop) => ({
    id: stop.port_id,
    port_id: stop.port_id,
    name: stop.name,
    latitude: stop.latitude,
    longitude: stop.longitude
  }));

  const routed = routeMarineItinerary(routeInput);
  const allWarnings = [...warnings];
  if (!routed.ok) {
    return {
      ok: false,
      errors: routed.errors || [],
      warnings: allWarnings,
      routeObject: null,
      routed
    };
  }

  const legs = routed.legs.map((leg, index) => {
    const full = leg.polyline || [];
    const simplified = simplifyPolyline(full, simplifyPreset);
    return {
      sequence: index + 1,
      from_port_id: leg.from_port_id,
      to_port_id: leg.to_port_id,
      from_name: leg.from_name,
      to_name: leg.to_name,
      distance_nm: leg.distance_nm,
      distance_km: leg.distance_km,
      full_coordinates: full,
      simplified_coordinates: simplified,
      full_point_count: full.length,
      simplified_point_count: simplified.length,
      simplify_preset: typeof simplifyPreset === "string" ? simplifyPreset : "custom"
    };
  });

  const totalNm = routed.summary.total_distance_nm;
  const routeObject = {
    version: ROUTE_OBJECT_VERSION,
    featured_cruise_id: featuredCruiseId || null,
    itinerary_signature: itinerarySignature,
    generated_at: generatedAt,
    router: {
      engine: "@ssroute/typescript",
      engine_version: engineVersion,
      dataset: "@ssroute/data-eurostat",
      dataset_version: datasetVersion
    },
    stops: routableStops.map((stop) => ({
      sequence: stop.sequence,
      port_id: stop.port_id,
      name: stop.name,
      latitude: stop.latitude,
      longitude: stop.longitude,
      stop_type: stop.stop_type || null,
      itinerary_stop_id: stop.itinerary_stop_id || null
    })),
    legs,
    totals: {
      distance_nm: totalNm,
      distance_km: totalNm != null ? nmToKm(totalNm) : null,
      port_count: routableStops.length,
      leg_count: legs.length,
      full_point_count: legs.reduce((n, l) => n + l.full_point_count, 0),
      simplified_point_count: legs.reduce((n, l) => n + l.simplified_point_count, 0)
    },
    warnings: allWarnings
  };

  return {
    ok: true,
    errors: [],
    warnings: allWarnings,
    routeObject,
    routed
  };
}

/**
 * Load structured itinerary from Supabase REST (service role or admin client).
 * @param {(path: string) => Promise<any>} supabaseGet
 * @param {string} featuredCruiseId
 */
async function loadStructuredItinerary(supabaseGet, featuredCruiseId) {
  const id = String(featuredCruiseId || "").trim();
  if (!id) {
    return {
      ok: false,
      errors: [{ code: "missing_featured_cruise_id", message: "featured_cruise_id is required." }],
      itinerary: [],
      annotated: []
    };
  }

  const select = [
    "id",
    "featured_cruise_id",
    "display_order",
    "day_number",
    "stop_date",
    "stop_type",
    "port_id",
    "entered_port_text",
    "entered_country_text",
    "arrival_time",
    "departure_time",
    "is_overnight",
    "notes",
    "ports(id,canonical_name,display_name,latitude,longitude,status,match_key)"
  ].join(",");

  let rows;
  try {
    rows = await supabaseGet(
      `featured_cruise_itinerary_stops?featured_cruise_id=eq.${encodeURIComponent(id)}` +
        `&select=${encodeURIComponent(select)}` +
        `&order=display_order.asc`
    );
  } catch (error) {
    const message = String(error?.message || error);
    const schemaMissing = /does not exist|PGRST205|schema cache/i.test(message);
    return {
      ok: false,
      errors: [
        {
          code: schemaMissing ? "schema_missing" : "load_failed",
          message: schemaMissing
            ? "Sprint 13D schema is not applied (featured_cruise_itinerary_stops / ports missing). Apply supabase/migrations/20260728_structured_itinerary_ports.sql first."
            : `Failed to load itinerary: ${message}`
        }
      ],
      itinerary: [],
      annotated: []
    };
  }

  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return {
      ok: false,
      errors: [
        {
          code: "empty_itinerary",
          message:
            "No structured itinerary stops found for this Featured Cruise. itinerary_summary text is not used as an authoritative source."
        }
      ],
      itinerary: [],
      annotated: [],
      compatibility_note:
        "Legacy itinerary_summary may exist but is not silently parsed into port matches."
    };
  }

  const flattened = list.map((row) => {
    const port = row.ports || {};
    return {
      ...row,
      canonical_name: port.canonical_name || null,
      display_name: port.display_name || null,
      port_latitude: port.latitude,
      port_longitude: port.longitude,
      port_status: port.status || null
    };
  });

  const annotated = flattened.map((row, index) => annotateItineraryStop(row, index));
  return {
    ok: true,
    errors: [],
    itinerary: flattened,
    annotated,
    compatibility_note: null
  };
}

/**
 * End-to-end: load → validate → normalise → signature → route object.
 * Does not persist.
 */
async function generateMarineRouteForCruise(supabaseGet, featuredCruiseId, options = {}) {
  const loaded = await loadStructuredItinerary(supabaseGet, featuredCruiseId);
  if (!loaded.ok) {
    return {
      ok: false,
      featured_cruise_id: featuredCruiseId,
      errors: loaded.errors,
      warnings: [],
      itinerary_signature: null,
      routeObject: null,
      annotated: loaded.annotated || [],
      routableStops: [],
      compatibility_note: loaded.compatibility_note || null
    };
  }

  const normalised = buildRoutableStops(loaded.annotated);
  if (normalised.errors.length) {
    return {
      ok: false,
      featured_cruise_id: featuredCruiseId,
      errors: normalised.errors,
      warnings: normalised.warnings,
      itinerary_signature: null,
      routeObject: null,
      annotated: loaded.annotated,
      routableStops: normalised.routableStops,
      compatibility_note: null
    };
  }

  const itinerarySignature = buildMarineItinerarySignature(normalised.routableStops);
  const built = buildMarineRouteObject({
    featuredCruiseId,
    routableStops: normalised.routableStops,
    itinerarySignature,
    simplifyPreset: options.simplifyPreset || "final-map",
    warnings: normalised.warnings
  });

  return {
    ok: built.ok,
    featured_cruise_id: featuredCruiseId,
    errors: built.errors,
    warnings: built.warnings,
    itinerary_signature: itinerarySignature,
    signature_inputs: signaturePayloadPreview(normalised.routableStops),
    routeObject: built.routeObject,
    annotated: loaded.annotated,
    routableStops: normalised.routableStops,
    compatibility_note: null
  };
}

module.exports = {
  ROUTE_OBJECT_VERSION,
  GEOGRAPHIC_STOP_TYPES,
  annotateItineraryStop,
  buildRoutableStops,
  buildMarineItinerarySignature,
  signaturePayloadPreview,
  buildMarineRouteObject,
  loadStructuredItinerary,
  generateMarineRouteForCruise,
  packageVersion
};
