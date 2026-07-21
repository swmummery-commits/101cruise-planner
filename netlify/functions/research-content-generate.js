/**
 * Admin Research Content generation (long-running).
 *
 * POST /.netlify/functions/research-content-generate
 * Actions: start_research | refresh_research | retry_generation
 *
 * Creates/updates draft research_content + sources. Never auto-publishes.
 */

const { requireAdmin } = require("./admin-auth");
const { ENTITY_TYPES, emptyContent, refreshAfterDate } = require("./lib/research-schemas");
const { normaliseEntityKey, normaliseAlias } = require("./lib/research-normalize");
const { retryGenerationFromSources, estimateActivity, gatherResearchMaterials, generateFromMaterials } = require("./lib/research-engine");

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

async function loadShipContext(shipId) {
  const rows = await supabase(
    `ci_cruise_ships?id=eq.${encodeURIComponent(shipId)}&select=id,name,slug,ship_class,year_built,year_refurbished,passenger_capacity,crew_count,deck_count,gross_tonnage,facilities,cruise_line_id,ci_cruise_lines(name,website_url)&limit=1`
  );
  const ship = rows?.[0];
  if (!ship) throw Object.assign(new Error("Ship not found"), { statusCode: 404 });
  const line = ship.ci_cruise_lines || {};
  const facilities = ship.facilities && typeof ship.facilities === "object" ? ship.facilities : {};
  const facts = [
    `Ship: ${ship.name}`,
    line.name ? `Cruise line: ${line.name}` : "",
    ship.year_built != null ? `Built: ${ship.year_built}` : "",
    ship.year_refurbished != null ? `Refurbished: ${ship.year_refurbished}` : "",
    ship.passenger_capacity != null ? `Guests: ${ship.passenger_capacity}` : "",
    ship.crew_count != null ? `Crew: ${ship.crew_count}` : "",
    ship.deck_count != null ? `Decks: ${ship.deck_count}` : "",
    ship.gross_tonnage != null ? `Gross tonnage: ${ship.gross_tonnage}` : "",
    facilities.restaurants != null ? `Restaurants: ${facilities.restaurants}` : "",
    facilities.pools != null ? `Pools: ${facilities.pools}` : "",
    facilities.spa != null ? `Spa: ${facilities.spa}` : ""
  ]
    .filter(Boolean)
    .join("\n");
  let officialDomain = "";
  try {
    if (line.website_url) officialDomain = new URL(line.website_url).hostname.replace(/^www\./, "");
  } catch {
    officialDomain = "";
  }
  return {
    entity_id: ship.id,
    entity_name: ship.name,
    entity_key: null,
    contextFacts: facts,
    officialDomain,
    cruise_line_id: ship.cruise_line_id,
    shipRow: ship
  };
}

async function loadLineContext(lineId) {
  const rows = await supabase(
    `ci_cruise_lines?id=eq.${encodeURIComponent(lineId)}&select=id,name,slug,website_url,line_type,market_segment,country,description&limit=1`
  );
  const line = rows?.[0];
  if (!line) throw Object.assign(new Error("Cruise line not found"), { statusCode: 404 });
  const facts = [
    `Cruise line: ${line.name}`,
    line.line_type ? `Line type: ${line.line_type}` : "",
    line.market_segment ? `Market segment: ${line.market_segment}` : "",
    line.country ? `Country: ${line.country}` : "",
    line.description ? `Existing description: ${String(line.description).slice(0, 400)}` : ""
  ]
    .filter(Boolean)
    .join("\n");
  let officialDomain = "";
  try {
    if (line.website_url) officialDomain = new URL(line.website_url).hostname.replace(/^www\./, "");
  } catch {
    officialDomain = "";
  }
  return {
    entity_id: line.id,
    entity_name: line.name,
    entity_key: null,
    contextFacts: facts,
    officialDomain
  };
}

async function resolveEntity(body) {
  const entityType = body.entity_type;
  if (!ENTITY_TYPES.includes(entityType)) {
    throw Object.assign(new Error("Unsupported entity type"), {
      statusCode: 400,
      code: "unsupported_entity_type"
    });
  }

  if (entityType === "ship") {
    if (!body.entity_id) {
      throw Object.assign(new Error("entity_id (ship UUID) is required"), { statusCode: 400 });
    }
    return { entityType, ...(await loadShipContext(body.entity_id)) };
  }
  if (entityType === "cruise_line") {
    if (!body.entity_id) {
      throw Object.assign(new Error("entity_id (cruise line UUID) is required"), { statusCode: 400 });
    }
    return { entityType, ...(await loadLineContext(body.entity_id)) };
  }

  const name = String(body.entity_name || "").trim();
  if (!name) {
    throw Object.assign(new Error("entity_name is required"), { statusCode: 400 });
  }
  const entityKey = normaliseEntityKey(body.entity_key || name);
  return {
    entityType,
    entity_id: null,
    entity_name: name,
    entity_key: entityKey,
    contextFacts: `${entityType}: ${name}`,
    officialDomain: ""
  };
}

async function nextVersion(entityType, entityId, entityKey) {
  let path = `research_content?entity_type=eq.${encodeURIComponent(entityType)}&select=content_version&order=content_version.desc&limit=1`;
  if (entityId) path += `&entity_id=eq.${encodeURIComponent(entityId)}`;
  else if (entityKey) path += `&entity_key=eq.${encodeURIComponent(entityKey)}`;
  const rows = await supabase(path);
  const current = Number(rows?.[0]?.content_version) || 0;
  return current + 1;
}

async function insertSources(researchContentId, sources) {
  if (!sources?.length) return [];
  const rows = sources.map((s) => ({
    research_content_id: researchContentId,
    source_url: s.source_url,
    source_domain: s.source_domain || null,
    source_title: s.source_title || null,
    source_type: s.source_type || null,
    publisher_name: s.publisher_name || null,
    published_date: s.published_date || null,
    is_primary_source: Boolean(s.is_primary_source),
    is_trusted: s.is_trusted !== false,
    source_order: Number(s.source_order) || 0,
    notes: s.notes || null,
    excerpt_chars: s.excerpt_chars || null
  }));
  return supabase("research_content_sources", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(rows)
  });
}

async function ensureAlias(entityType, entityName, entityKey, researchContentId) {
  if (!entityKey) return;
  const normalised = normaliseAlias(entityName);
  const existing = await supabase(
    `research_entity_aliases?entity_type=eq.${encodeURIComponent(entityType)}&normalised_alias=eq.${encodeURIComponent(normalised)}&select=id&limit=1`
  );
  if (existing?.length) {
    await supabase(`research_entity_aliases?id=eq.${encodeURIComponent(existing[0].id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        research_content_id: researchContentId,
        entity_key: entityKey,
        alias: entityName
      })
    });
    return;
  }
  await supabase("research_entity_aliases", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      entity_type: entityType,
      research_content_id: researchContentId,
      entity_key: entityKey,
      alias: entityName,
      normalised_alias: normalised
    })
  });
}

async function createDraftShell(entity, user, { replacesId = null, paulsTip = null, mediaId = null } = {}) {
  const version = await nextVersion(entity.entityType, entity.entity_id, entity.entity_key);
  const row = {
    entity_type: entity.entityType,
    entity_id: entity.entity_id,
    entity_key: entity.entity_key,
    entity_name: entity.entity_name,
    content_status: "draft",
    content_version: version,
    content_json: emptyContent(entity.entityType),
    summary_text: null,
    pauls_tip: paulsTip,
    media_id: mediaId,
    source_count: 0,
    replaces_id: replacesId,
    created_by: user.id,
    updated_by: user.id,
    canonical_slug: entity.entity_key || normaliseEntityKey(entity.entity_name)
  };
  const created = await supabase("research_content", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(row)
  });
  return created?.[0];
}

async function markFailed(id, detail, diagnostics, user, sources) {
  if (sources?.length) {
    try {
      await supabase(`research_content_sources?research_content_id=eq.${encodeURIComponent(id)}`, {
        method: "DELETE"
      });
      await insertSources(id, sources);
    } catch {
      // keep going
    }
  }
  const updated = await supabase(`research_content?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      content_status: "failed",
      failure_detail: String(detail || "").slice(0, 2000),
      diagnostics_json: diagnostics || {},
      source_count: sources?.length || 0,
      updated_by: user.id
    })
  });
  return updated?.[0];
}

async function applySuccess(id, result, user) {
  await supabase(`research_content_sources?research_content_id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
  await insertSources(id, result.sources || []);
  const updated = await supabase(`research_content?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      content_status: "draft",
      content_json: result.content_json,
      summary_text: result.summary_text,
      source_count: (result.sources || []).length,
      research_provider: result.research_provider || "brave",
      generation_provider: result.generation_provider,
      generation_model: result.generation_model,
      generated_at: result.generated_at,
      refresh_after: result.refresh_after || refreshAfterDate("ship"),
      diagnostics_json: result.diagnostics || {},
      failure_detail: null,
      updated_by: user.id
    })
  });
  return updated?.[0];
}

async function startResearch(body, user) {
  const entity = await resolveEntity(body);
  const forceNew = body.force_new === true;

  // Duplicate detection for destinations/ports
  if (!forceNew && (entity.entityType === "destination" || entity.entityType === "port")) {
    const existing = await supabase(
      `research_content?entity_type=eq.${encodeURIComponent(entity.entityType)}&entity_key=eq.${encodeURIComponent(entity.entity_key)}&select=id,entity_name,content_status,content_version,updated_at&order=updated_at.desc&limit=5`
    );
    if (existing?.length && body.confirm_duplicate !== true) {
      return {
        success: false,
        code: "duplicate_entity",
        error: "Existing research content found for this entity key",
        existing: existing,
        entity_key: entity.entity_key,
        estimate: estimateActivity()
      };
    }
  }

  let replacesId = null;
  let paulsTip = null;
  let mediaId = null;

  if (body.refresh_of) {
    const prevRows = await supabase(
      `research_content?id=eq.${encodeURIComponent(body.refresh_of)}&select=*&limit=1`
    );
    const prev = prevRows?.[0];
    if (prev) {
      replacesId = prev.content_status === "published" ? prev.id : prev.replaces_id || prev.id;
      paulsTip = prev.pauls_tip;
      mediaId = prev.media_id;
    }
  } else if (entity.entity_id || entity.entity_key) {
    let pubPath = `research_content?entity_type=eq.${encodeURIComponent(entity.entityType)}&content_status=eq.published&select=id,pauls_tip,media_id&limit=1`;
    if (entity.entity_id) pubPath += `&entity_id=eq.${encodeURIComponent(entity.entity_id)}`;
    else pubPath += `&entity_key=eq.${encodeURIComponent(entity.entity_key)}`;
    const pub = await supabase(pubPath);
    if (pub?.[0]) {
      replacesId = pub[0].id;
      paulsTip = pub[0].pauls_tip;
      mediaId = pub[0].media_id;
    }
  }

  const draft = await createDraftShell(entity, user, { replacesId, paulsTip, mediaId });
  await ensureAlias(entity.entityType, entity.entity_name, entity.entity_key, draft.id);

  let gathered = null;
  try {
    // Phase 1 — search + fetch (checkpoint sources so Retry Generation works if LLM times out)
    gathered = await gatherResearchMaterials({
      entityType: entity.entityType,
      entityName: entity.entity_name,
      officialDomain: entity.officialDomain
    });
    gathered.contextFacts = entity.contextFacts;

    try {
      await supabase(`research_content_sources?research_content_id=eq.${encodeURIComponent(draft.id)}`, {
        method: "DELETE"
      });
      await insertSources(draft.id, gathered.sourcesForStorage || []);
      await supabase(`research_content?id=eq.${encodeURIComponent(draft.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          content_status: "failed",
          failure_detail: "Sources gathered — generating draft…",
          source_count: (gathered.sourcesForStorage || []).length,
          diagnostics_json: { ...(gathered.diagnostics || {}), phase: "sources_checkpointed" },
          updated_by: user.id
        })
      });
    } catch {
      // continue — generation may still succeed
    }

    // Phase 2 — LLM generation
    const result = await generateFromMaterials({
      entityType: entity.entityType,
      entityName: entity.entity_name,
      contextFacts: entity.contextFacts,
      withExcerpts: gathered.withExcerpts,
      usable: gathered.usable,
      diagnostics: gathered.diagnostics,
      allowRepair: (gathered.diagnostics?.remaining_ms_after_gather || 0) > 12_000
    });
    // Preserve Paul's tip — never overwrite from AI
    const saved = await applySuccess(draft.id, result, user);
    if (paulsTip) {
      await supabase(`research_content?id=eq.${encodeURIComponent(draft.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ pauls_tip: paulsTip })
      });
      saved.pauls_tip = paulsTip;
    }
    return {
      success: true,
      item: saved,
      diagnostics: result.diagnostics,
      message: "Research draft created"
    };
  } catch (error) {
    const rawSources = error.sources || gathered?.withExcerpts || [];
    const mappedSources = (rawSources.length ? rawSources : gathered?.sourcesForStorage || []).map((s, index) => {
      if (s.source_url || s.url) {
        return {
          source_url: s.source_url || s.url,
          source_domain: s.source_domain || s.domain || null,
          source_title: s.source_title || s.title || null,
          source_type: s.source_type || null,
          publisher_name: s.publisher_name || s.domain || null,
          published_date: s.published_date || s.age || null,
          is_primary_source: index < 2,
          is_trusted: s.is_trusted !== false,
          source_order: index,
          excerpt_chars: s.excerpt_chars || 0,
          notes: s.notes || (s.fetch_ok === false ? "Snippet used; full page fetch failed or skipped for time" : null)
        };
      }
      return s;
    }).filter((s) => s.source_url);

    const detail =
      error.message ||
      (gathered?.sourcesForStorage?.length
        ? "Research interrupted after sources were saved — use Retry Generation"
        : "Research failed");

    const failed = await markFailed(
      draft.id,
      detail,
      error.diagnostics || gathered?.diagnostics || { error: error.message },
      user,
      mappedSources.length ? mappedSources : gathered?.sourcesForStorage || null
    );
    return jsonErrorFromResearch(error, failed);
  }
}

function jsonErrorFromResearch(error, failedItem) {
  return {
    success: false,
    code: error.code || "research_failed",
    error: error.message || "Research failed",
    item: failedItem || null,
    diagnostics: error.diagnostics || null,
    statusCode: error.statusCode || 500
  };
}

async function retryGeneration(body, user) {
  const id = String(body.id || "").trim();
  if (!id) throw Object.assign(new Error("id is required"), { statusCode: 400 });
  const rows = await supabase(`research_content?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  const row = rows?.[0];
  if (!row) throw Object.assign(new Error("Research content not found"), { statusCode: 404 });

  const sources = await supabase(
    `research_content_sources?research_content_id=eq.${encodeURIComponent(id)}&select=*&order=source_order.asc`
  );

  let contextFacts = "";
  if (row.entity_type === "ship" && row.entity_id) {
    contextFacts = (await loadShipContext(row.entity_id)).contextFacts;
  } else if (row.entity_type === "cruise_line" && row.entity_id) {
    contextFacts = (await loadLineContext(row.entity_id)).contextFacts;
  }

  try {
    const result = await retryGenerationFromSources({
      entityType: row.entity_type,
      entityName: row.entity_name,
      contextFacts,
      sources: sources || []
    });
    const updated = await supabase(`research_content?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        content_status: "draft",
        content_json: result.content_json,
        summary_text: result.summary_text,
        generation_provider: result.generation_provider,
        generation_model: result.generation_model,
        generated_at: result.generated_at,
        refresh_after: result.refresh_after,
        diagnostics_json: result.diagnostics || {},
        failure_detail: null,
        updated_by: user.id,
        pauls_tip: row.pauls_tip
      })
    });
    return { success: true, item: updated?.[0], diagnostics: result.diagnostics };
  } catch (error) {
    await markFailed(id, error.message, error.diagnostics, user, null);
    const payload = jsonErrorFromResearch(error, null);
    const err = new Error(payload.error);
    err.statusCode = payload.statusCode;
    err.payload = payload;
    throw err;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(204, "");
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { success: false, error: "Method not allowed" });
  }

  try {
    const user = await requireAdmin(event);
    const body = JSON.parse(event.body || "{}");
    const action = String(body.action || "start_research").trim();

    if (action === "estimate") {
      return jsonResponse(200, { success: true, estimate: estimateActivity(body) });
    }

    if (action === "retry_generation") {
      try {
        return jsonResponse(200, await retryGeneration(body, user));
      } catch (error) {
        if (error.payload) {
          return jsonResponse(error.statusCode || 500, error.payload);
        }
        throw error;
      }
    }

    if (action === "start_research" || action === "refresh_research") {
      if (action === "refresh_research" && body.id && !body.refresh_of) {
        body.refresh_of = body.id;
      }
      const result = await startResearch(body, user);
      if (result.success === false) {
        return jsonResponse(result.statusCode || (result.code === "duplicate_entity" ? 409 : 500), result);
      }
      return jsonResponse(200, result);
    }

    return jsonResponse(400, { success: false, error: `Unknown action: ${action}` });
  } catch (error) {
    const status = error.statusCode || 500;
    return jsonResponse(status, {
      success: false,
      error: error.message || "Research generation failed",
      code: error.code || null
    });
  }
};
