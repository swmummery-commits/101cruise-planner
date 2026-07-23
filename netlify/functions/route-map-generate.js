/**
 * Sprint 13E Phase 4B — Featured Cruise route map generation workflow.
 *
 * POST /.netlify/functions/route-map-generate
 * Actions:
 *   generate — load/create Route Object → SVG → PNG → Supabase Storage + DB metadata
 *   status   — report whether generated assets exist for a cruise
 *
 * Production assets are stored in bucket featured-cruise-route-maps.
 * Does NOT write to /var/task, generated-assets/, or /tmp.
 * Does NOT modify renderer styling.
 * Does NOT upload to Media Library / WordPress / public pages.
 * Does NOT write route_map_media_id.
 * HOLD DEPLOY.
 */

const { requireAdmin } = require("./admin-auth");
const { loadMarineRouteRow, saveMarineRouteRow } = require("./lib/marine-route-persist");
const { generateMarineRouteForCruise } = require("./lib/marine-route-itinerary");
const { renderRouteMapSvg } = require("./lib/route-map-svg");
const {
  ROUTE_MAP_RENDERER_VERSION,
  DEFAULT_PNG_WIDTH,
  ROUTE_MAP_STORAGE_BUCKET,
  saveRouteMapAssets,
  storageObjectPaths,
  publicObjectUrl
} = require("./lib/route-map-assets");

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    const err = new Error("Supabase credentials are missing. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
    err.code = "supabase_credentials_missing";
    throw err;
  }
  return { url: url.replace(/\/$/, ""), key };
}

async function supabase(restPath, options = {}) {
  const { url, key } = config();
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    Prefer: options.prefer || "return=representation",
    ...(options.headers || {})
  };
  if (options.body !== undefined && options.body !== null) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${url}/rest/v1/${restPath}`, {
    method: options.method || "GET",
    headers,
    body: options.body != null ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const msg =
      (data && (data.message || data.error || data.hint)) ||
      text ||
      `HTTP ${response.status}`;
    const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    err.statusCode = response.status;
    err.body = data;
    throw err;
  }
  return data;
}

async function supabaseGet(restPath) {
  return supabase(restPath, { method: "GET", prefer: "return=representation" });
}

async function supabaseRequest(restPath, options = {}) {
  return supabase(restPath, options);
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    return {};
  }
}

function isLegacyLocalPath(value) {
  const p = String(value || "");
  return p.startsWith("generated-assets/") || p.startsWith("/generated-assets/");
}

function assetUrlsFromCruise(cruise) {
  const svgPath = cruise?.route_map_svg_path || null;
  const pngPath = cruise?.route_map_png_path || null;
  const hasDurable =
    Boolean(svgPath && pngPath) && !isLegacyLocalPath(svgPath) && !isLegacyLocalPath(pngPath);
  if (!hasDurable) {
    return {
      has_assets: false,
      svg_path: svgPath,
      png_path: pngPath,
      svg_url: null,
      png_url: null,
      legacy_local_paths: Boolean(svgPath || pngPath)
    };
  }
  const bust = Date.parse(cruise.route_map_generated_at || "") || Date.now();
  return {
    has_assets: true,
    svg_path: svgPath,
    png_path: pngPath,
    svg_url: publicObjectUrl(svgPath, { cacheBust: bust }),
    png_url: publicObjectUrl(pngPath, { cacheBust: bust }),
    legacy_local_paths: false
  };
}

async function loadCruiseRow(featuredCruiseId) {
  const rows = await supabaseGet(
    `featured_cruises?id=eq.${encodeURIComponent(featuredCruiseId)}` +
      `&select=id,headline,route_map_svg_path,route_map_png_path,route_map_generated_at,route_map_renderer_version,route_map_width,route_map_height,route_map_status,route_map_itinerary_signature` +
      `&limit=1`
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function updateCruiseAssetMetadata(featuredCruiseId, meta) {
  const payload = {
    route_map_svg_path: meta.svg_path,
    route_map_png_path: meta.png_path,
    route_map_generated_at: meta.generated_at,
    route_map_renderer_version: meta.renderer_version,
    route_map_width: meta.width,
    route_map_height: meta.height,
    updated_at: new Date().toISOString()
  };
  // Do not force route_map_status away from manual media selection;
  // generated workflow assets are separate from Media Library picks.
  const updated = await supabase(
    `featured_cruises?id=eq.${encodeURIComponent(featuredCruiseId)}`,
    { method: "PATCH", body: payload, prefer: "return=representation" }
  );
  return Array.isArray(updated) ? updated[0] : updated;
}

async function ensureRouteObject(featuredCruiseId, forceReroute = false) {
  const timings = {};
  const t0 = Date.now();

  if (!forceReroute) {
    const existing = await loadMarineRouteRow(supabaseRequest, featuredCruiseId);
    timings.load_route_ms = Date.now() - t0;
    if (existing?.route_data?.legs?.length && existing?.route_data?.stops?.length) {
      return {
        ok: true,
        reused_existing: true,
        routeObject: existing.route_data,
        itinerary_signature: existing.itinerary_signature || existing.route_data.itinerary_signature,
        timings,
        errors: [],
        warnings: Array.isArray(existing.warnings) ? existing.warnings : []
      };
    }
  }

  const t1 = Date.now();
  const generated = await generateMarineRouteForCruise(supabaseGet, featuredCruiseId, {
    simplifyPreset: "final-map"
  });
  timings.generate_route_ms = Date.now() - t1;

  if (!generated.ok || !generated.routeObject) {
    return {
      ok: false,
      reused_existing: false,
      routeObject: null,
      itinerary_signature: generated.itinerary_signature || null,
      timings,
      errors: generated.errors?.length
        ? generated.errors
        : [{ code: "routing_failed", message: "Could not build a marine Route Object." }],
      warnings: generated.warnings || []
    };
  }

  const t2 = Date.now();
  await saveMarineRouteRow(supabaseRequest, {
    featuredCruiseId,
    routeObject: generated.routeObject,
    status: "current"
  });
  timings.persist_route_ms = Date.now() - t2;

  return {
    ok: true,
    reused_existing: false,
    routeObject: generated.routeObject,
    itinerary_signature: generated.itinerary_signature,
    timings,
    errors: [],
    warnings: generated.warnings || []
  };
}

function mapAssetError(error) {
  const code = error.code || "asset_save_failed";
  const partial = error.partial || null;
  const messages = {
    supabase_credentials_missing:
      "Supabase credentials are missing. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the Netlify Function.",
    bucket_missing: `Storage bucket "${ROUTE_MAP_STORAGE_BUCKET}" was not found. Run migration 20260731_featured_cruise_route_maps_bucket.sql in Supabase.`,
    storage_upload_failed: `Storage upload failed: ${error.message || error}`,
    png_engine_unavailable: `PNG conversion failed — ${error.message || "@resvg/resvg-js is not available on this host."}`,
    png_render_failed: `PNG conversion failed: ${error.message || error}`,
    invalid_svg: "SVG output was invalid.",
    invalid_svg_document: "SVG output was invalid."
  };
  let message = messages[code] || `Could not save route map assets: ${error.message || error}`;
  if (partial && (partial.svg || partial.png) && !partial.png) {
    message = `Partial failure — SVG uploaded but PNG did not: ${error.message || error}`;
  }
  return { code, message, partial };
}

async function handleStatus(featuredCruiseId) {
  const cruise = await loadCruiseRow(featuredCruiseId);
  if (!cruise) {
    return jsonResponse(404, {
      ok: false,
      errors: [{ code: "cruise_not_found", message: "Featured Cruise not found." }]
    });
  }
  const urls = assetUrlsFromCruise(cruise);
  const expected = storageObjectPaths(featuredCruiseId);
  return jsonResponse(200, {
    ok: true,
    featured_cruise_id: featuredCruiseId,
    storage_bucket: ROUTE_MAP_STORAGE_BUCKET,
    has_assets: urls.has_assets,
    legacy_local_paths: urls.legacy_local_paths,
    expected_svg_path: expected.svg_path,
    expected_png_path: expected.png_path,
    svg_path: urls.svg_path,
    png_path: urls.png_path,
    svg_url: urls.svg_url,
    png_url: urls.png_url,
    generated_at: cruise.route_map_generated_at || null,
    renderer_version: cruise.route_map_renderer_version || null,
    width: cruise.route_map_width || null,
    height: cruise.route_map_height || null
  });
}

async function handleGenerate(featuredCruiseId, body) {
  const started = Date.now();
  const stages = [];
  const mark = (stage) => {
    stages.push({ stage, at_ms: Date.now() - started });
  };

  // Fail fast on missing credentials before spending time on routing/render.
  try {
    config();
  } catch (error) {
    const mapped = mapAssetError(error);
    return jsonResponse(500, {
      ok: false,
      stages,
      errors: [{ code: mapped.code, message: mapped.message }]
    });
  }

  const cruise = await loadCruiseRow(featuredCruiseId);
  if (!cruise) {
    return jsonResponse(404, {
      ok: false,
      stages,
      errors: [{ code: "cruise_not_found", message: "Featured Cruise not found." }]
    });
  }

  mark("loading_route_object");
  const routeResult = await ensureRouteObject(featuredCruiseId, Boolean(body.force_reroute));
  if (!routeResult.ok) {
    const first = routeResult.errors?.[0] || {};
    const code = first.code || "missing_route_object";
    let message = first.message || "Route Object is missing or incomplete.";
    if (code === "empty_itinerary" || /itinerary/i.test(String(message))) {
      message = "This Featured Cruise does not have a valid structured itinerary yet.";
    }
    return jsonResponse(400, {
      ok: false,
      stages,
      errors: [{ code, message, details: routeResult.errors }],
      warnings: routeResult.warnings || []
    });
  }

  mark("rendering_svg");
  const tSvg = Date.now();
  let rendered;
  try {
    rendered = renderRouteMapSvg(routeResult.routeObject, {});
  } catch (error) {
    return jsonResponse(500, {
      ok: false,
      stages,
      errors: [
        {
          code: "svg_render_failed",
          message: `SVG render failed: ${error.message || error}`
        }
      ]
    });
  }
  const svgMs = Date.now() - tSvg;
  if (!rendered.ok || !rendered.svg) {
    return jsonResponse(500, {
      ok: false,
      stages,
      errors: rendered.errors?.length
        ? rendered.errors.map((e) => ({
            code: e.code || "svg_render_failed",
            message: e.message || "SVG renderer failed."
          }))
        : [{ code: "svg_render_failed", message: "SVG renderer failed." }],
      warnings: rendered.warnings || []
    });
  }

  mark("uploading_storage");
  let saved;
  const tSave = Date.now();
  try {
    saved = await saveRouteMapAssets(featuredCruiseId, rendered.svg, {
      pngWidth: Number(body.png_width) || DEFAULT_PNG_WIDTH,
      rendererVersion: ROUTE_MAP_RENDERER_VERSION
      // Production: Supabase Storage only — no localFallback
    });
  } catch (error) {
    const mapped = mapAssetError(error);
    return jsonResponse(500, {
      ok: false,
      stages,
      errors: [{ code: mapped.code, message: mapped.message, partial: mapped.partial }],
      warnings: rendered.warnings || []
    });
  }
  const saveMs = Date.now() - tSave;

  mark("updating_database");
  let cruiseRow;
  try {
    cruiseRow = await updateCruiseAssetMetadata(featuredCruiseId, saved);
  } catch (error) {
    return jsonResponse(500, {
      ok: false,
      stages,
      errors: [
        {
          code: "database_update_failed",
          message: `Both assets uploaded to Storage but the database could not be updated: ${error.message || error}`
        }
      ],
      assets: {
        storage_bucket: saved.storage_bucket,
        svg_path: saved.svg_path,
        png_path: saved.png_path,
        svg_url: saved.svg_url,
        png_url: saved.png_url
      }
    });
  }

  mark("complete");

  return jsonResponse(200, {
    ok: true,
    message: "Generated successfully",
    featured_cruise_id: featuredCruiseId,
    storage_bucket: saved.storage_bucket || ROUTE_MAP_STORAGE_BUCKET,
    reused_existing_route: routeResult.reused_existing,
    itinerary_signature: routeResult.itinerary_signature,
    renderer_version: saved.renderer_version,
    generated_at: saved.generated_at,
    svg_path: saved.svg_path,
    png_path: saved.png_path,
    svg_url: saved.svg_url,
    png_url: saved.png_url,
    width: saved.width,
    height: saved.height,
    svg_bytes: saved.svg_bytes,
    png_bytes: saved.png_bytes,
    timings: {
      total_ms: Date.now() - started,
      svg_ms: svgMs,
      png_and_upload_ms: saveMs,
      ...(routeResult.timings || {})
    },
    stages,
    warnings: [...(routeResult.warnings || []), ...(rendered.warnings || [])],
    cruise: cruiseRow
      ? {
          id: cruiseRow.id,
          route_map_svg_path: cruiseRow.route_map_svg_path,
          route_map_png_path: cruiseRow.route_map_png_path,
          route_map_generated_at: cruiseRow.route_map_generated_at,
          route_map_renderer_version: cruiseRow.route_map_renderer_version,
          route_map_width: cruiseRow.route_map_width,
          route_map_height: cruiseRow.route_map_height
        }
      : null
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(204, {});
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, errors: [{ code: "method_not_allowed", message: "POST required." }] });
  }

  try {
    await requireAdmin(event);
  } catch (error) {
    return jsonResponse(error.statusCode || 401, {
      ok: false,
      errors: [{ code: "unauthorized", message: error.message || "Admin authentication required." }]
    });
  }

  const body = parseBody(event);
  const action = String(body.action || "generate").trim();
  const featuredCruiseId = String(body.featured_cruise_id || "").trim();
  if (!featuredCruiseId) {
    return jsonResponse(400, {
      ok: false,
      errors: [{ code: "missing_featured_cruise_id", message: "featured_cruise_id is required." }]
    });
  }

  try {
    if (action === "status") return await handleStatus(featuredCruiseId);
    if (action === "generate") return await handleGenerate(featuredCruiseId, body);
    return jsonResponse(400, {
      ok: false,
      errors: [{ code: "unknown_action", message: `Unknown action: ${action}` }]
    });
  } catch (error) {
    console.error("route-map-generate error", error && error.code ? error.code : "unexpected");
    const mapped =
      error.code === "supabase_credentials_missing" ? mapAssetError(error) : null;
    return jsonResponse(500, {
      ok: false,
      errors: [
        {
          code: mapped?.code || "unexpected_error",
          message: mapped?.message || error.message || "Unexpected route map generation failure."
        }
      ]
    });
  }
};
