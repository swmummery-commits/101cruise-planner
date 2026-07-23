/**
 * Sprint 13E Phase 4B — persist generated route-map SVG/PNG in Supabase Storage.
 *
 * Bucket: featured-cruise-route-maps (public)
 * Object paths: <featured-cruise-id>/route-map.svg|png
 *
 * Production path NEVER writes to /var/task, generated-assets/, or /tmp.
 * Optional local fallback only when options.localFallback === true (developer tests).
 *
 * Does not modify renderer styling or marine routing.
 */

const fs = require("fs");
const path = require("path");

const ROUTE_MAP_RENDERER_VERSION = "13e-phase3c";
const DEFAULT_PNG_WIDTH = 2000;
const ROUTE_MAP_STORAGE_BUCKET = "featured-cruise-route-maps";
/** Cache-Control for marketing assets that are overwritten in place */
const ROUTE_MAP_CACHE_CONTROL = "public, max-age=3600, must-revalidate";

function projectRoot() {
  return path.resolve(__dirname, "../../..");
}

function storageObjectPaths(featuredCruiseId) {
  const id = String(featuredCruiseId || "").trim();
  if (!id) throw new Error("featured_cruise_id is required");
  return {
    svg_path: `${id}/route-map.svg`,
    png_path: `${id}/route-map.png`
  };
}

/**
 * Public display URL for a Storage object path (not stored in DB).
 * @param {string} objectPath e.g. "<uuid>/route-map.png"
 * @param {{ supabaseUrl?: string, cacheBust?: string|number, bucket?: string }} [options]
 */
function publicObjectUrl(objectPath, options = {}) {
  const raw = String(objectPath || "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) {
    const bust = options.cacheBust != null ? String(options.cacheBust) : "";
    return bust ? `${raw}${raw.includes("?") ? "&" : "?"}t=${encodeURIComponent(bust)}` : raw;
  }
  // Legacy local paths are not durable on Netlify — do not invent a URL.
  if (raw.startsWith("generated-assets/") || raw.startsWith("/generated-assets/")) {
    return null;
  }
  const base = String(options.supabaseUrl || process.env.SUPABASE_URL || "")
    .trim()
    .replace(/\/$/, "");
  if (!base) return null;
  const bucket = options.bucket || ROUTE_MAP_STORAGE_BUCKET;
  const encoded = raw
    .replace(/^\//, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  let url = `${base}/storage/v1/object/public/${bucket}/${encoded}`;
  if (options.cacheBust != null && options.cacheBust !== "") {
    url += `?t=${encodeURIComponent(String(options.cacheBust))}`;
  }
  return url;
}

function displayUrls(featuredCruiseId, options = {}) {
  const paths = storageObjectPaths(featuredCruiseId);
  const bust = options.cacheBust != null ? options.cacheBust : Date.now();
  return {
    svg_path: paths.svg_path,
    png_path: paths.png_path,
    svg_url: publicObjectUrl(paths.svg_path, { ...options, cacheBust: bust }),
    png_url: publicObjectUrl(paths.png_path, { ...options, cacheBust: bust })
  };
}

/**
 * Rasterise SVG string to PNG buffer via @resvg/resvg-js.
 */
function svgToPngBuffer(svg, options = {}) {
  let Resvg;
  try {
    ({ Resvg } = require("@resvg/resvg-js"));
  } catch (error) {
    const detail = error && error.message ? String(error.message) : String(error || "");
    const err = new Error(
      detail
        ? `PNG conversion is unavailable (@resvg/resvg-js): ${detail}`
        : "PNG conversion is unavailable. Install @resvg/resvg-js (and the platform binary)."
    );
    err.code = "png_engine_unavailable";
    err.cause = error;
    throw err;
  }

  const width = Math.max(800, Math.min(2400, Number(options.width) || DEFAULT_PNG_WIDTH));
  const resvg = new Resvg(Buffer.from(String(svg || ""), "utf8"), {
    fitTo: { mode: "width", value: width },
    background: "transparent"
  });
  const rendered = resvg.render();
  return {
    buffer: Buffer.from(rendered.asPng()),
    width: rendered.width,
    height: rendered.height
  };
}

function getSupabaseConfig(overrides = {}) {
  const urlRaw =
    overrides.supabaseUrl !== undefined ? overrides.supabaseUrl : process.env.SUPABASE_URL;
  const keyRaw =
    overrides.serviceRoleKey !== undefined
      ? overrides.serviceRoleKey
      : process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = String(urlRaw || "")
    .trim()
    .replace(/\/$/, "");
  const key = String(keyRaw || "").trim();
  if (!url || !key) {
    const err = new Error(
      "Supabase credentials are missing. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
    );
    err.code = "supabase_credentials_missing";
    throw err;
  }
  return { url, key };
}

/**
 * Upload a binary/text body to Supabase Storage (service role, upsert).
 * @param {object} params
 * @param {string} params.objectPath
 * @param {Buffer|string} params.body
 * @param {string} params.contentType
 * @param {{ supabaseUrl?: string, serviceRoleKey?: string, bucket?: string, fetchImpl?: Function }} [params.options]
 */
async function uploadStorageObject({ objectPath, body, contentType, options = {} }) {
  const { url, key } = getSupabaseConfig(options);
  const bucket = options.bucket || ROUTE_MAP_STORAGE_BUCKET;
  const fetchImpl = options.fetchImpl || fetch;
  const encoded = String(objectPath)
    .replace(/^\//, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const endpoint = `${url}/storage/v1/object/${bucket}/${encoded}`;

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": contentType,
      "x-upsert": "true",
      "cache-control": ROUTE_MAP_CACHE_CONTROL
    },
    body
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
      (data && (data.message || data.error || data.msg || data.statusCode)) ||
      text ||
      `HTTP ${response.status}`;
    const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    err.statusCode = response.status;
    err.body = data;
    if (response.status === 404 || /bucket|not found/i.test(String(msg))) {
      err.code = "bucket_missing";
      err.message =
        `Storage bucket "${bucket}" was not found. Run the featured-cruise-route-maps migration in Supabase.`;
    } else {
      err.code = "storage_upload_failed";
    }
    throw err;
  }

  return { ok: true, objectPath, contentType, response: data };
}

/**
 * Render PNG and upload SVG+PNG to Supabase Storage.
 * @returns {Promise<object>}
 */
async function saveRouteMapAssetsToStorage(featuredCruiseId, svg, options = {}) {
  const svgText = String(svg || "");
  if (!svgText.startsWith("<svg")) {
    const err = new Error("Invalid SVG: expected a complete <svg> document.");
    err.code = "invalid_svg";
    throw err;
  }

  const paths = storageObjectPaths(featuredCruiseId);
  const pngWidth = options.pngWidth || DEFAULT_PNG_WIDTH;

  let png;
  try {
    png = svgToPngBuffer(svgText, { width: pngWidth });
  } catch (error) {
    if (error.code) throw error;
    const err = new Error(error.message || "PNG conversion failed.");
    err.code = "png_render_failed";
    err.cause = error;
    throw err;
  }

  const svgBytes = Buffer.byteLength(svgText, "utf8");
  const pngBytes = png.buffer.length;
  const uploaded = { svg: false, png: false };

  try {
    await uploadStorageObject({
      objectPath: paths.svg_path,
      body: svgText,
      contentType: "image/svg+xml",
      options
    });
    uploaded.svg = true;
  } catch (error) {
    error.partial = uploaded;
    throw error;
  }

  try {
    await uploadStorageObject({
      objectPath: paths.png_path,
      body: png.buffer,
      contentType: "image/png",
      options
    });
    uploaded.png = true;
  } catch (error) {
    error.partial = uploaded;
    error.message = uploaded.svg
      ? `PNG upload failed after SVG uploaded successfully: ${error.message}`
      : error.message;
    throw error;
  }

  const generatedAt = new Date().toISOString();
  const bust = Date.parse(generatedAt) || Date.now();
  const urls = displayUrls(featuredCruiseId, {
    supabaseUrl: options.supabaseUrl || process.env.SUPABASE_URL,
    cacheBust: bust,
    bucket: options.bucket || ROUTE_MAP_STORAGE_BUCKET
  });

  return {
    storage_bucket: options.bucket || ROUTE_MAP_STORAGE_BUCKET,
    svg_path: paths.svg_path,
    png_path: paths.png_path,
    svg_url: urls.svg_url,
    png_url: urls.png_url,
    width: png.width,
    height: png.height,
    svg_bytes: svgBytes,
    png_bytes: pngBytes,
    renderer_version: options.rendererVersion || ROUTE_MAP_RENDERER_VERSION,
    generated_at: generatedAt,
    uploaded
  };
}

/**
 * Developer-only local disk save. Never used by the Netlify production handler.
 */
function saveRouteMapAssetsLocal(featuredCruiseId, svg, options = {}) {
  const root = options.rootDir || projectRoot();
  const id = String(featuredCruiseId || "").trim();
  const dir = path.join(root, "generated-assets", id);
  fs.mkdirSync(dir, { recursive: true });

  const svgAbs = path.join(dir, "route-map.svg");
  const pngAbs = path.join(dir, "route-map.png");
  const svgText = String(svg || "");
  if (!svgText.startsWith("<svg")) {
    const err = new Error("Invalid SVG: expected a complete <svg> document.");
    err.code = "invalid_svg";
    throw err;
  }

  fs.writeFileSync(svgAbs, svgText, "utf8");
  const { buffer, width, height } = svgToPngBuffer(svgText, {
    width: options.pngWidth || DEFAULT_PNG_WIDTH
  });
  fs.writeFileSync(pngAbs, buffer);

  const generatedAt = new Date().toISOString();
  return {
    storage_bucket: null,
    svg_path: `generated-assets/${id}/route-map.svg`,
    png_path: `generated-assets/${id}/route-map.png`,
    svg_url: `/generated-assets/${id}/route-map.svg?t=${Date.parse(generatedAt) || Date.now()}`,
    png_url: `/generated-assets/${id}/route-map.png?t=${Date.parse(generatedAt) || Date.now()}`,
    svg_abs: svgAbs,
    png_abs: pngAbs,
    width,
    height,
    svg_bytes: Buffer.byteLength(svgText, "utf8"),
    png_bytes: buffer.length,
    renderer_version: options.rendererVersion || ROUTE_MAP_RENDERER_VERSION,
    generated_at: generatedAt,
    local_fallback: true
  };
}

/**
 * Primary save entry used by the generate function.
 * Defaults to Supabase Storage. Set options.localFallback=true for offline tests only.
 */
async function saveRouteMapAssets(featuredCruiseId, svg, options = {}) {
  if (options.localFallback === true) {
    return saveRouteMapAssetsLocal(featuredCruiseId, svg, options);
  }
  return saveRouteMapAssetsToStorage(featuredCruiseId, svg, options);
}

module.exports = {
  ROUTE_MAP_RENDERER_VERSION,
  DEFAULT_PNG_WIDTH,
  ROUTE_MAP_STORAGE_BUCKET,
  ROUTE_MAP_CACHE_CONTROL,
  projectRoot,
  storageObjectPaths,
  publicObjectUrl,
  displayUrls,
  svgToPngBuffer,
  uploadStorageObject,
  saveRouteMapAssetsToStorage,
  saveRouteMapAssetsLocal,
  saveRouteMapAssets,
  /** @deprecated use storageObjectPaths */
  relativeAssetPaths: storageObjectPaths
};
