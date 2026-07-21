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
const { cleanSlug } = require("./lib/destination-page");

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
  } else {
    // Default list: hide archived so only the current version shows
    path += `&content_status=neq.archived`;
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

/** Delete every other research_content row for the same entity (sources cascade). */
async function deleteOtherVersions(row, keepId) {
  let filter =
    `entity_type=eq.${encodeURIComponent(row.entity_type)}` +
    `&id=neq.${encodeURIComponent(keepId)}`;
  if (row.entity_id) {
    filter += `&entity_id=eq.${encodeURIComponent(row.entity_id)}`;
  } else if (row.entity_key) {
    filter += `&entity_key=eq.${encodeURIComponent(row.entity_key)}`;
  } else {
    return;
  }
  await supabase(`research_content?${filter}`, { method: "DELETE" });
}

/** Remove archived leftovers (from older publish behaviour). */
async function purgeArchived() {
  await supabase("research_content?content_status=eq.archived", { method: "DELETE" });
  return { success: true };
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

  // Delete previous versions for this entity — only the published row should remain.
  await deleteOtherVersions(row, id);

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
      failure_detail: null,
      replaces_id: null
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

  const published = updated?.[0] || { ...row, content_status: "published" };
  if (row.entity_type === "destination") {
    try {
      await ensureDestinationShellFromResearch(published);
    } catch (error) {
      console.warn("destination shell sync skipped", error.message || error);
    }
  }

  return { success: true, item: withFreshness(published) };
}

/**
 * Sprint 11C — keep Living Destination page shell in sync with published research.
 * Does not create ports (those are curated separately) and never overwrites hero media.
 */
async function ensureDestinationShellFromResearch(research) {
  const slug = cleanSlug(research.canonical_slug || research.entity_key || research.entity_name);
  if (!slug) return null;

  const existing = await supabase(
    `destinations?slug=ilike.${encodeURIComponent(slug)}&select=id,slug,status,hero_media_id,research_content_id&limit=1`
  );
  const row = existing?.[0] || null;
  const payload = {
    name: research.entity_name,
    slug,
    status: "published",
    research_content_id: research.id,
    seo_title: research.seo_title || `${research.entity_name} Cruises | 101cruise`,
    meta_description:
      research.meta_description ||
      String(research.summary_text || "").trim().slice(0, 160) ||
      null
  };

  // Prefer research media when shell has no hero yet
  if (!row?.hero_media_id && research.media_id) {
    payload.hero_media_id = research.media_id;
  }

  if (row?.id) {
    await supabase(`destinations?id=eq.${encodeURIComponent(row.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(payload)
    });
    return row.id;
  }

  const created = await supabase("destinations", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      ...payload,
      primary_region: null,
      display_order: 100,
      hero_media_id: research.media_id || null
    })
  });
  return created?.[0]?.id || null;
}

async function archiveContent(body, user) {
  const id = String(body.id || "").trim();
  if (!id) throw Object.assign(new Error("id is required"), { statusCode: 400 });
  // Hard-delete — previous versions are not kept in the Admin list.
  await supabase(`research_content?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
  return { success: true, deleted: true, id, updated_by: user.id };
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

async function loadResearchSummaries(entityType) {
  const rows = await supabase(
    `research_content?entity_type=eq.${encodeURIComponent(entityType)}` +
      `&select=id,entity_id,entity_key,entity_name,content_status,generated_at,updated_at,published_at,last_reviewed_at,content_version` +
      `&order=updated_at.desc&limit=1000`
  );
  const byId = new Map();
  const byKey = new Map();
  for (const row of rows || []) {
    const summary = {
      research_id: row.id,
      content_status: row.content_status,
      generated_at: row.generated_at,
      updated_at: row.updated_at,
      published_at: row.published_at,
      last_reviewed_at: row.last_reviewed_at,
      content_version: row.content_version
    };
    // Keep the most recently updated row per entity (rows are ordered desc)
    if (row.entity_id && !byId.has(row.entity_id)) byId.set(row.entity_id, summary);
    if (row.entity_key && !byKey.has(row.entity_key)) byKey.set(row.entity_key, summary);
  }
  return { byId, byKey };
}

function attachResearchSummary(entity, summary) {
  if (!summary) {
    return {
      ...entity,
      research_status: null,
      research_updated_at: null,
      research_generated_at: null,
      research_id: null
    };
  }
  return {
    ...entity,
    research_id: summary.research_id,
    research_status: summary.content_status,
    research_updated_at: summary.updated_at || summary.generated_at || summary.published_at || null,
    research_generated_at: summary.generated_at || null,
    research_published_at: summary.published_at || null,
    research_version: summary.content_version || null
  };
}

async function listEntities(body) {
  const entityType = body.entity_type;
  const summaries = await loadResearchSummaries(entityType);

  if (entityType === "ship") {
    const rows = await supabase(
      "ci_cruise_ships?select=id,name,slug,cruise_line_id,active,ci_cruise_lines(name,website_url)&order=name.asc&limit=500"
    );
    return {
      success: true,
      entities: (rows || []).map((row) => attachResearchSummary(row, summaries.byId.get(row.id)))
    };
  }
  if (entityType === "cruise_line") {
    const rows = await supabase(
      "ci_cruise_lines?select=id,name,slug,website_url,active,sold_by_101cruise&order=name.asc&limit=500"
    );
    return {
      success: true,
      entities: (rows || []).map((row) => attachResearchSummary(row, summaries.byId.get(row.id)))
    };
  }
  // Destinations/ports: distinct from existing research + media tags
  if (entityType === "destination" || entityType === "port") {
    const existing = await supabase(
      `research_content?entity_type=eq.${encodeURIComponent(entityType)}&select=entity_key,entity_name,content_status,generated_at,updated_at,published_at,content_version,id&order=updated_at.desc&limit=500`
    );
    const map = new Map();
    for (const row of existing || []) {
      if (!row.entity_key || map.has(row.entity_key)) continue;
      map.set(
        row.entity_key,
        attachResearchSummary(
          { entity_key: row.entity_key, entity_name: row.entity_name },
          {
            research_id: row.id,
            content_status: row.content_status,
            generated_at: row.generated_at,
            updated_at: row.updated_at,
            published_at: row.published_at,
            content_version: row.content_version
          }
        )
      );
    }
    return {
      success: true,
      entities: [...map.values()]
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
      case "purge_archived":
        return jsonResponse(200, await purgeArchived());
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
