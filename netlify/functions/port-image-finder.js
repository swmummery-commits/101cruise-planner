/**
 * Port Image Finder — admin-only image discovery and enrichment.
 *
 * POST /.netlify/functions/port-image-finder
 * Actions:
 *   find_candidates   { port_id, force? }
 *   apply_candidate   { port_id, candidate, image_status? }
 *   bulk_missing      { offset?, limit?, force?, auto_apply? }
 */

const { requireAdmin } = require("./admin-auth");
const { findPortImageCandidates, RECHECK_DAYS } = require("./lib/port-image-finder/search");
const { applyPortImageCandidate } = require("./lib/port-image-finder/apply");
const { PORT_IMAGE_SELECT } = require("./lib/port-image-finder/resolve-public");

const PORT_SELECT =
  `${PORT_IMAGE_SELECT},image_source_url,image_search_query,image_confidence,image_last_checked_at,image_candidates`;

const PORT_SELECT_BASIC =
  "id,canonical_name,display_name,city,country,country_code,region,latitude,longitude,aliases,status,match_key";

const BULK_BATCH_DEFAULT = 5;

function isMissingImageSchemaError(error) {
  const msg = String(error?.message || "");
  return /hero_media_id|image_status|image_candidates|image_last_checked_at|schema cache/i.test(msg);
}

function withImageDefaults(port, { schemaWarning = false } = {}) {
  if (!port || typeof port !== "object") return port;
  return {
    ...port,
    hero_media_id: port.hero_media_id ?? null,
    image_status: port.image_status ?? null,
    image_source: port.image_source ?? null,
    image_source_url: port.image_source_url ?? null,
    image_credit: port.image_credit ?? null,
    image_license: port.image_license ?? null,
    image_search_query: port.image_search_query ?? null,
    image_confidence: port.image_confidence ?? null,
    image_last_checked_at: port.image_last_checked_at ?? null,
    image_candidates: Array.isArray(port.image_candidates) ? port.image_candidates : [],
    ...(schemaWarning
      ? {
          image_schema_warning:
            "Port Image Finder migration is not applied yet. Run supabase/migrations/20260807_ports_image_finder.sql before saving image metadata."
        }
      : {})
  };
}

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
  if (!url || !key) throw new Error("Supabase credentials are missing.");
  return { url: url.replace(/\/$/, ""), key };
}

function makeSupabaseClient() {
  const { url, key } = config();

  async function fetchRest(restPath, options = {}) {
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
      const detail =
        (data && (data.message || data.error || data.hint || data.details)) ||
        text ||
        `Supabase HTTP ${response.status}`;
      const err = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
      err.statusCode = response.status;
      throw err;
    }
    return data;
  }

  function publicObjectUrl(storagePath) {
    return `${url}/storage/v1/object/public/cruise-media/${storagePath
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
  }

  async function uploadObject(bucket, storagePath, buffer, contentType) {
    const response = await fetch(
      `${url}/storage/v1/object/${bucket}/${storagePath.split("/").map(encodeURIComponent).join("/")}`,
      {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": contentType || "application/octet-stream",
          "x-upsert": "true"
        },
        body: buffer
      }
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Storage upload failed: ${text || response.status}`);
    }
  }

  return { fetchRest, publicObjectUrl, uploadObject };
}

async function loadPortById(supabase, portId) {
  try {
    const rows = await supabase.fetchRest(
      `ports?select=${encodeURIComponent(PORT_SELECT)}&id=eq.${encodeURIComponent(portId)}&limit=1`
    );
    const port = Array.isArray(rows) ? rows[0] || null : null;
    return port ? withImageDefaults(port) : null;
  } catch (error) {
    if (!isMissingImageSchemaError(error)) throw error;
    const rows = await supabase.fetchRest(
      `ports?select=${encodeURIComponent(PORT_SELECT_BASIC)}&id=eq.${encodeURIComponent(portId)}&limit=1`
    );
    const port = Array.isArray(rows) ? rows[0] || null : null;
    return port ? withImageDefaults(port, { schemaWarning: true }) : null;
  }
}

async function patchPortSearchState(supabase, portId, payload) {
  try {
    const rows = await supabase.fetchRest(`ports?id=eq.${encodeURIComponent(portId)}`, {
      method: "PATCH",
      prefer: "return=representation",
      body: payload
    });
    return Array.isArray(rows) ? rows[0] || null : rows;
  } catch (error) {
    if (!isMissingImageSchemaError(error)) throw error;
    const err = new Error(
      "Port Image Finder database migration is not applied. Run supabase/migrations/20260807_ports_image_finder.sql in Supabase SQL Editor."
    );
    err.statusCode = 503;
    err.calm = true;
    throw err;
  }
}

async function actionFindCandidates(body) {
  const portId = String(body.port_id || "").trim();
  if (!portId) {
    const err = new Error("port_id is required");
    err.statusCode = 400;
    err.calm = true;
    throw err;
  }

  const supabase = makeSupabaseClient();
  const port = await loadPortById(supabase, portId);
  if (!port) {
    const err = new Error("Port not found");
    err.statusCode = 404;
    err.calm = true;
    throw err;
  }

  const force = Boolean(body.force);
  const result = await findPortImageCandidates(port, { force, autoApply: false });

  if (result.skipped) {
    return {
      success: true,
      port,
      skipped: true,
      reason: result.reason,
      candidates: result.candidates || [],
      recheck_days: RECHECK_DAYS
    };
  }

  let updatedPort = port;
  let schemaWarning = port.image_schema_warning || null;
  const patch = {
    image_candidates: result.candidates || [],
    image_search_query: result.primaryQuery || null,
    image_last_checked_at: new Date().toISOString()
  };

  if (!port.hero_media_id && result.suggestedStatus === "NO_IMAGE") {
    patch.image_status = "NO_IMAGE";
    patch.image_confidence = result.bestConfidence || null;
  } else if (!port.hero_media_id && result.suggestedStatus === "NEEDS_REVIEW") {
    patch.image_status = "NEEDS_REVIEW";
    patch.image_confidence = result.bestConfidence || null;
  }

  if (!schemaWarning) {
    updatedPort = await patchPortSearchState(supabase, portId, patch);
  }

  return {
    success: true,
    port: updatedPort,
    skipped: false,
    queries: result.queries,
    primary_query: result.primaryQuery,
    candidates: result.candidates,
    suggested_status: result.suggestedStatus,
    best_confidence: result.bestConfidence,
    best_geographic: result.bestGeographic,
    best_suitability: result.bestSuitability,
    ...(schemaWarning ? { image_schema_warning: schemaWarning, candidates_persisted: false } : { candidates_persisted: true }),
    recheck_days: RECHECK_DAYS
  };
}

async function actionApplyCandidate(body) {
  const portId = String(body.port_id || "").trim();
  const candidate = body.candidate && typeof body.candidate === "object" ? body.candidate : null;
  if (!portId || !candidate) {
    const err = new Error("port_id and candidate are required");
    err.statusCode = 400;
    err.calm = true;
    throw err;
  }

  const supabase = makeSupabaseClient();
  const port = await loadPortById(supabase, portId);
  if (!port) {
    const err = new Error("Port not found");
    err.statusCode = 404;
    err.calm = true;
    throw err;
  }

  const imageStatus = String(body.image_status || "MANUAL").trim().toUpperCase();
  const applied = await applyPortImageCandidate(supabase, port, candidate, {
    imageStatus,
    searchQuery: body.search_query || port.image_search_query || null,
    confidence: candidate.confidence
  });

  return {
    success: true,
    port: applied.port,
    media: applied.media
  };
}

async function listMissingPorts(supabase, { offset = 0, limit = BULK_BATCH_DEFAULT, force = false } = {}) {
  let rows;
  try {
    rows = await supabase.fetchRest(
      `ports?select=${encodeURIComponent(PORT_SELECT)}` +
        `&or=(hero_media_id.is.null,image_status.eq.NO_IMAGE,image_status.eq.NEEDS_REVIEW)` +
        `&order=canonical_name.asc&offset=${offset}&limit=${limit + 50}`
    );
  } catch (error) {
    if (!isMissingImageSchemaError(error)) throw error;
    const err = new Error(
      "Port Image Finder database migration is not applied. Bulk enrichment requires supabase/migrations/20260807_ports_image_finder.sql."
    );
    err.statusCode = 503;
    err.calm = true;
    throw err;
  }
  const all = Array.isArray(rows) ? rows : [];
  const filtered = all.filter((port) => {
    if (port.image_status === "MANUAL" && port.hero_media_id) return false;
    if (port.image_status === "AUTO_APPROVED" && port.hero_media_id) return false;
    if (!force && port.image_last_checked_at) {
      const age = Date.now() - Date.parse(port.image_last_checked_at);
      if (age < RECHECK_DAYS * 24 * 60 * 60 * 1000) return false;
    }
    return true;
  });
  return filtered.slice(0, limit);
}

async function actionBulkMissing(body) {
  const offset = Math.max(0, Number(body.offset) || 0);
  const limit = Math.min(10, Math.max(1, Number(body.limit) || BULK_BATCH_DEFAULT));
  const force = Boolean(body.force);
  const autoApply = Boolean(body.auto_apply);

  const supabase = makeSupabaseClient();
  const batch = await listMissingPorts(supabase, { offset, limit, force });

  const summary = {
    processed: 0,
    auto_approved: 0,
    needs_review: 0,
    no_image: 0,
    skipped: 0,
    errors: 0
  };
  const results = [];

  for (const port of batch) {
    try {
      const search = await findPortImageCandidates(port, { force, autoApply });
      if (search.skipped) {
        summary.skipped += 1;
        results.push({ port_id: port.id, name: port.canonical_name, outcome: "skipped", reason: search.reason });
        continue;
      }

      let updatedPort = port;
      const patch = {
        image_candidates: search.candidates || [],
        image_search_query: search.primaryQuery || null,
        image_last_checked_at: new Date().toISOString(),
        image_confidence: search.bestConfidence || null
      };

      if (search.autoApply?.candidate) {
        const applied = await applyPortImageCandidate(supabase, port, search.autoApply.candidate, {
          imageStatus: "AUTO_APPROVED",
          searchQuery: search.primaryQuery,
          confidence: search.autoApply.confidence
        });
        updatedPort = applied.port;
        summary.auto_approved += 1;
        results.push({
          port_id: port.id,
          name: port.canonical_name,
          outcome: "auto_approved",
          confidence: search.autoApply.confidence
        });
      } else if (search.suggestedStatus === "NEEDS_REVIEW") {
        patch.image_status = "NEEDS_REVIEW";
        updatedPort = await patchPortSearchState(supabase, port.id, patch);
        summary.needs_review += 1;
        results.push({
          port_id: port.id,
          name: port.canonical_name,
          outcome: "needs_review",
          confidence: search.bestConfidence
        });
      } else {
        patch.image_status = "NO_IMAGE";
        updatedPort = await patchPortSearchState(supabase, port.id, patch);
        summary.no_image += 1;
        results.push({
          port_id: port.id,
          name: port.canonical_name,
          outcome: "no_image",
          confidence: search.bestConfidence
        });
      }

      summary.processed += 1;
      void updatedPort;
    } catch (error) {
      summary.errors += 1;
      results.push({
        port_id: port.id,
        name: port.canonical_name,
        outcome: "error",
        error: error.message || "Unknown error"
      });
    }
  }

  return {
    success: true,
    offset,
    next_offset: offset + batch.length,
    batch_size: batch.length,
    has_more: batch.length >= limit,
    summary,
    results,
    recheck_days: RECHECK_DAYS
  };
}

exports.handler = async function handler(event) {
  if (event.httpMethod === "OPTIONS") return jsonResponse(204, {});
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { success: false, error: "Method not allowed" });
  }

  try {
    await requireAdmin(event);
    const body = JSON.parse(event.body || "{}");
    const action = String(body.action || "").trim();

    if (action === "find_candidates") {
      return jsonResponse(200, await actionFindCandidates(body));
    }
    if (action === "apply_candidate") {
      return jsonResponse(200, await actionApplyCandidate(body));
    }
    if (action === "bulk_missing") {
      return jsonResponse(200, await actionBulkMissing(body));
    }

    return jsonResponse(400, { success: false, error: "Unknown action" });
  } catch (error) {
    const status = Number(error.statusCode) || (error.calm ? 400 : 500);
    const message =
      status === 401 || status === 403 || error.calm
        ? error.message || "Not authorised"
        : error.message && !/supabase|http \d+/i.test(error.message)
          ? error.message
          : "Port image finder failed. Please try again.";
    return jsonResponse(status, { success: false, error: message });
  }
};

exports._internal = {
  actionFindCandidates,
  actionApplyCandidate,
  actionBulkMissing,
  makeSupabaseClient
};
