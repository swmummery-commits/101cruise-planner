/**
 * Admin Research Content API (list / read / save / publish / archive / sources / aliases).
 *
 * POST /.netlify/functions/research-content
 * Body: { action, ... }
 */

const { requireAdmin } = require("./admin-auth");
const {
  ENTITY_TYPES,
  validateContentJson,
  freshnessLabel,
  refreshAfterDate
} = require("./lib/research-schemas");
const { normaliseEntityKey, normaliseAlias } = require("./lib/research-normalize");
const { estimateActivity } = require("./lib/research-engine");
const { getLlmConfig } = require("./lib/llm-provider");
const { getBraveApiKey } = require("./lib/brave-search");

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
  if (!url || !key) throw new Error("Supabase server access is not configured");
  return { url: url.replace(/\/$/, ""), key };
}

async function supabase(path, options = {}) {
  const { url, key } = config();
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    ...(options.headers || {})
  };
  if (options.body !== undefined && options.body !== null) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }
  const response = await fetch(`${url}/rest/v1/${path}`, { ...options, headers });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const msg = data?.message || data?.error || data?.msg || `HTTP ${response.status}`;
    const err = new Error(msg);
    err.statusCode = response.status;
    err.body = data;
    throw err;
  }
  return data;
}

function withFreshness(row) {
  return {
    ...row,
    freshness: freshnessLabel(row.refresh_after)
  };
}

async function listContent(body) {
  const limit = Math.min(Number(body.limit) || 200, 400);
  let path = `research_content?select=*&order=updated_at.desc&limit=${limit}`;
  if (body.entity_type && ENTITY_TYPES.includes(body.entity_type)) {
    path += `&entity_type=eq.${encodeURIComponent(body.entity_type)}`;
  }
  if (body.content_status) {
    path += `&content_status=eq.${encodeURIComponent(body.content_status)}`;
  }
  if (body.q) {
    const q = String(body.q).trim();
    if (q) path += `&entity_name=ilike.*${encodeURIComponent(q)}*`;
  }
  const rows = await supabase(path);
  let list = (rows || []).map(withFreshness);
  if (body.freshness && body.freshness !== "all") {
    list = list.filter((row) => row.freshness === body.freshness);
  }
  return { success: true, items: list };
}

async function getContent(body) {
  const id = String(body.id || "").trim();
  if (!id) throw Object.assign(new Error("id is required"), { statusCode: 400 });
  const rows = await supabase(
    `research_content?id=eq.${encodeURIComponent(id)}&select=*&limit=1`
  );
  const row = rows?.[0];
  if (!row) throw Object.assign(new Error("Research content not found"), { statusCode: 404 });
  const sources = await supabase(
    `research_content_sources?research_content_id=eq.${encodeURIComponent(id)}&select=*&order=source_order.asc`
  );
  const aliases = await supabase(
    `research_entity_aliases?or=(research_content_id.eq.${encodeURIComponent(id)},and(entity_type.eq.${encodeURIComponent(row.entity_type)},entity_key.eq.${encodeURIComponent(row.entity_key || "")}))&select=*&limit=50`
  );
  let publishedSibling = null;
  if (row.content_status !== "published") {
    let pubPath = `research_content?entity_type=eq.${encodeURIComponent(row.entity_type)}&content_status=eq.published&select=id,entity_name,content_json,summary_text,published_at,content_version&limit=1`;
    if (row.entity_id) pubPath += `&entity_id=eq.${encodeURIComponent(row.entity_id)}`;
    else if (row.entity_key) pubPath += `&entity_key=eq.${encodeURIComponent(row.entity_key)}`;
    const pub = await supabase(pubPath);
    publishedSibling = pub?.[0] || null;
  }
  return {
    success: true,
    item: withFreshness(row),
    sources: sources || [],
    aliases: aliases || [],
    published_sibling: publishedSibling
  };
}

async function findExisting(body) {
  const entityType = body.entity_type;
  if (!ENTITY_TYPES.includes(entityType)) {
    throw Object.assign(new Error("Unsupported entity type"), { statusCode: 400, code: "unsupported_entity_type" });
  }
  const entityId = body.entity_id ? String(body.entity_id).trim() : "";
  const entityKey = body.entity_key
    ? normaliseEntityKey(body.entity_key)
    : normaliseEntityKey(body.entity_name || "");
  const name = String(body.entity_name || "").trim();

  let rows = [];
  if (entityId && (entityType === "ship" || entityType === "cruise_line")) {
    rows = await supabase(
      `research_content?entity_type=eq.${encodeURIComponent(entityType)}&entity_id=eq.${encodeURIComponent(entityId)}&select=*&order=updated_at.desc&limit=20`
    );
  } else if (entityKey) {
    rows = await supabase(
      `research_content?entity_type=eq.${encodeURIComponent(entityType)}&entity_key=eq.${encodeURIComponent(entityKey)}&select=*&order=updated_at.desc&limit=20`
    );
    if (!rows?.length && name) {
      const aliasRows = await supabase(
        `research_entity_aliases?entity_type=eq.${encodeURIComponent(entityType)}&normalised_alias=eq.${encodeURIComponent(normaliseAlias(name))}&select=*&limit=5`
      );
      const contentIds = [...new Set((aliasRows || []).map((a) => a.research_content_id).filter(Boolean))];
      if (contentIds.length) {
        rows = await supabase(
          `research_content?id=in.(${contentIds.map(encodeURIComponent).join(",")})&select=*&order=updated_at.desc&limit=20`
        );
      }
    }
  }

  return {
    success: true,
    entity_key: entityKey || null,
    items: (rows || []).map(withFreshness),
    duplicate_warning: (rows || []).length > 0
  };
}

async function saveDraft(body, user) {
  const id = body.id ? String(body.id).trim() : "";
  if (!id) throw Object.assign(new Error("id is required"), { statusCode: 400 });

  const existingRows = await supabase(
    `research_content?id=eq.${encodeURIComponent(id)}&select=*&limit=1`
  );
  const existing = existingRows?.[0];
  if (!existing) throw Object.assign(new Error("Research content not found"), { statusCode: 404 });

  const patch = {
    updated_by: user.id
  };

  if (body.content_json != null) {
    const validation = validateContentJson(existing.entity_type, body.content_json);
    if (!validation.ok) {
      throw Object.assign(new Error(validation.error || "Invalid content"), { statusCode: 400 });
    }
    patch.content_json = validation.content;
    patch.summary_text = String(validation.content.overview || "").slice(0, 280);
  }
  if (body.summary_text != null) patch.summary_text = String(body.summary_text).trim().slice(0, 500);
  if (body.seo_title != null) patch.seo_title = String(body.seo_title).trim().slice(0, 120) || null;
  if (body.meta_description != null) {
    patch.meta_description = String(body.meta_description).trim().slice(0, 300) || null;
  }
  if (body.canonical_slug != null) {
    patch.canonical_slug = normaliseEntityKey(body.canonical_slug) || null;
  }
  if (body.pauls_tip != null) patch.pauls_tip = String(body.pauls_tip).trim().slice(0, 1000) || null;
  if (body.media_id !== undefined) patch.media_id = body.media_id || null;
  if (body.content_status === "draft" || body.content_status === "reviewed") {
    patch.content_status = body.content_status;
    if (body.content_status === "reviewed") {
      patch.last_reviewed_at = new Date().toISOString();
    }
  }

  const updated = await supabase(`research_content?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch)
  });
  return { success: true, item: withFreshness(updated?.[0] || { ...existing, ...patch }) };
}

async function publishContent(body, user) {
  const id = String(body.id || "").trim();
  if (!id) throw Object.assign(new Error("id is required"), { statusCode: 400 });
  const rows = await supabase(`research_content?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  const row = rows?.[0];
  if (!row) throw Object.assign(new Error("Research content not found"), { statusCode: 404 });
  if (row.content_status === "failed") {
    throw Object.assign(new Error("Cannot publish failed research — retry generation first"), {
      statusCode: 400
    });
  }
  const validation = validateContentJson(row.entity_type, row.content_json);
  if (!validation.ok) {
    throw Object.assign(new Error(validation.error || "Content is incomplete"), { statusCode: 400 });
  }

  // Archive current published sibling(s) first to satisfy unique index.
  let pubFilter = `entity_type=eq.${encodeURIComponent(row.entity_type)}&content_status=eq.published&id=neq.${encodeURIComponent(id)}`;
  if (row.entity_id) pubFilter += `&entity_id=eq.${encodeURIComponent(row.entity_id)}`;
  else if (row.entity_key) pubFilter += `&entity_key=eq.${encodeURIComponent(row.entity_key)}`;

  await supabase(`research_content?${pubFilter}`, {
    method: "PATCH",
    body: JSON.stringify({
      content_status: "archived",
      updated_by: user.id
    })
  });

  const now = new Date().toISOString();
  const updated = await supabase(`research_content?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      content_status: "published",
      content_json: validation.content,
      summary_text: row.summary_text || String(validation.content.overview || "").slice(0, 280),
      published_at: now,
      last_reviewed_at: now,
      refresh_after: row.refresh_after || refreshAfterDate(row.entity_type),
      updated_by: user.id,
      failure_detail: null
    })
  });

  // Ensure primary alias exists for key-based entities
  if (row.entity_key) {
    const alias = normaliseAlias(row.entity_name);
    const existingAlias = await supabase(
      `research_entity_aliases?entity_type=eq.${encodeURIComponent(row.entity_type)}&normalised_alias=eq.${encodeURIComponent(alias)}&select=id&limit=1`
    );
    if (!existingAlias?.length) {
      await supabase("research_entity_aliases", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          entity_type: row.entity_type,
          research_content_id: id,
          entity_id: row.entity_id,
          entity_key: row.entity_key,
          alias: row.entity_name,
          normalised_alias: alias
        })
      });
    } else {
      await supabase(`research_entity_aliases?id=eq.${encodeURIComponent(existingAlias[0].id)}`, {
        method: "PATCH",
        body: JSON.stringify({ research_content_id: id, entity_key: row.entity_key })
      });
    }
  }

  return { success: true, item: withFreshness(updated?.[0]) };
}

async function archiveContent(body, user) {
  const id = String(body.id || "").trim();
  if (!id) throw Object.assign(new Error("id is required"), { statusCode: 400 });
  const updated = await supabase(`research_content?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ content_status: "archived", updated_by: user.id })
  });
  if (!updated?.length) throw Object.assign(new Error("Research content not found"), { statusCode: 404 });
  return { success: true, item: withFreshness(updated[0]) };
}

async function updateSource(body, user) {
  const id = String(body.source_id || body.id || "").trim();
  if (!id) throw Object.assign(new Error("source_id is required"), { statusCode: 400 });
  const patch = {};
  if (body.is_trusted != null) patch.is_trusted = Boolean(body.is_trusted);
  if (body.exclude_from_refresh != null) patch.exclude_from_refresh = Boolean(body.exclude_from_refresh);
  if (body.notes != null) patch.notes = String(body.notes).trim().slice(0, 1000) || null;
  if (body.is_primary_source != null) patch.is_primary_source = Boolean(body.is_primary_source);
  if (!Object.keys(patch).length) {
    throw Object.assign(new Error("No source fields to update"), { statusCode: 400 });
  }
  const updated = await supabase(`research_content_sources?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch)
  });
  if (!updated?.length) throw Object.assign(new Error("Source not found"), { statusCode: 404 });
  return { success: true, source: updated[0], updated_by: user.id };
}

async function addAlias(body) {
  const entityType = body.entity_type;
  const alias = String(body.alias || "").trim();
  if (!ENTITY_TYPES.includes(entityType) || !alias) {
    throw Object.assign(new Error("entity_type and alias are required"), { statusCode: 400 });
  }
  const row = {
    entity_type: entityType,
    research_content_id: body.research_content_id || null,
    entity_id: body.entity_id || null,
    entity_key: body.entity_key ? normaliseEntityKey(body.entity_key) : null,
    alias,
    normalised_alias: normaliseAlias(alias)
  };
  const created = await supabase("research_entity_aliases", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(row)
  });
  return { success: true, alias: created?.[0] };
}

async function listEntities(body) {
  const entityType = body.entity_type;
  if (entityType === "ship") {
    const rows = await supabase(
      "ci_cruise_ships?select=id,name,slug,cruise_line_id,active,ci_cruise_lines(name,website_url)&order=name.asc&limit=500"
    );
    return { success: true, entities: rows || [] };
  }
  if (entityType === "cruise_line") {
    const rows = await supabase(
      "ci_cruise_lines?select=id,name,slug,website_url,active,sold_by_101cruise&order=name.asc&limit=500"
    );
    return { success: true, entities: rows || [] };
  }
  // Destinations/ports: distinct from existing research + media tags
  if (entityType === "destination" || entityType === "port") {
    const existing = await supabase(
      `research_content?entity_type=eq.${encodeURIComponent(entityType)}&select=entity_key,entity_name&order=entity_name.asc&limit=500`
    );
    const map = new Map();
    for (const row of existing || []) {
      if (row.entity_key) map.set(row.entity_key, row.entity_name);
    }
    return {
      success: true,
      entities: [...map.entries()].map(([entity_key, entity_name]) => ({ entity_key, entity_name }))
    };
  }
  throw Object.assign(new Error("Unsupported entity type"), {
    statusCode: 400,
    code: "unsupported_entity_type"
  });
}

async function providerStatus() {
  const llm = getLlmConfig();
  return {
    success: true,
    brave_configured: Boolean(getBraveApiKey()),
    ai_configured: llm.configured,
    ai_provider: llm.provider,
    ai_model: llm.model,
    estimate: estimateActivity()
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(204, "");
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { success: false, error: "Method not allowed" });
  }

  try {
    const user = await requireAdmin(event);
    const body = JSON.parse(event.body || "{}");
    const action = String(body.action || "").trim();

    switch (action) {
      case "list":
        return jsonResponse(200, await listContent(body));
      case "get":
        return jsonResponse(200, await getContent(body));
      case "find_existing":
        return jsonResponse(200, await findExisting(body));
      case "save_draft":
        return jsonResponse(200, await saveDraft(body, user));
      case "mark_reviewed":
        body.content_status = "reviewed";
        return jsonResponse(200, await saveDraft(body, user));
      case "publish":
        return jsonResponse(200, await publishContent(body, user));
      case "archive":
        return jsonResponse(200, await archiveContent(body, user));
      case "update_source":
        return jsonResponse(200, await updateSource(body, user));
      case "add_alias":
        return jsonResponse(200, await addAlias(body));
      case "list_entities":
        return jsonResponse(200, await listEntities(body));
      case "provider_status":
        return jsonResponse(200, await providerStatus());
      case "estimate":
        return jsonResponse(200, { success: true, estimate: estimateActivity(body) });
      default:
        return jsonResponse(400, { success: false, error: `Unknown action: ${action}` });
    }
  } catch (error) {
    const status = error.statusCode || 500;
    return jsonResponse(status, {
      success: false,
      error: error.message || "Research content request failed",
      code: error.code || null
    });
  }
};
