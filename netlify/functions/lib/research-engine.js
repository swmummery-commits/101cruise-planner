/**
 * Research orchestration: search → rank → fetch excerpts → generate → validate.
 */

const { braveSearch, dedupeSearchResults, getBraveApiKey } = require("./brave-search");
const { generateStructuredJson, getLlmConfig } = require("./llm-provider");
const {
  validateContentJson,
  normaliseContentJson,
  buildSystemPrompt,
  buildUserPrompt,
  refreshAfterDate
} = require("./research-schemas");
const {
  buildSearchQueries,
  scoreSource,
  classifySourceType,
  domainFromUrl
} = require("./research-normalize");
const { fetchSourceExcerpt } = require("./source-fetch");

function estimateActivity({ queryCount = 4, sourceFetchCount = 6 } = {}) {
  const llm = getLlmConfig();
  return {
    brave_search_configured: Boolean(getBraveApiKey()),
    ai_provider_configured: llm.configured,
    ai_provider: llm.provider,
    ai_model: llm.model,
    estimated_brave_queries: queryCount,
    estimated_source_fetches: sourceFetchCount,
    estimated_model_requests: llm.configured ? 1 : 0,
    notes: [
      "One research run searches Brave, fetches a few source pages, then calls the language model once (plus one repair if JSON is invalid).",
      "Content is stored for reuse — not generated on public page views."
    ]
  };
}

async function runResearchPipeline({
  entityType,
  entityName,
  officialDomain = "",
  contextFacts = "",
  maxSources = 6
}) {
  const started = Date.now();
  const diagnostics = {
    search_query_count: 0,
    source_fetch_count: 0,
    model_request_count: 0,
    token_usage: null,
    duration_ms: 0,
    queries: [],
    fetch_errors: []
  };

  const queries = buildSearchQueries({
    entityType,
    entityName,
    officialDomain
  });
  diagnostics.queries = queries;

  const apiKey = getBraveApiKey();
  if (!apiKey) {
    const err = new Error("BRAVE_SEARCH_API_KEY is not configured");
    err.code = "search_provider_unavailable";
    err.statusCode = 503;
    throw err;
  }

  const rawResults = [];
  for (const query of queries) {
    diagnostics.search_query_count += 1;
    const batch = await braveSearch(apiKey, query, { count: 8 });
    for (const row of batch) {
      rawResults.push({
        title: row.title || "",
        url: row.url || "",
        description: row.description || "",
        age: row.age || ""
      });
    }
  }

  const deduped = dedupeSearchResults(rawResults).map((row) => {
    const domain = row.domain || domainFromUrl(row.url);
    const score = scoreSource({ ...row, domain }, {
      officialDomains: officialDomain ? [officialDomain] : [],
      entityType
    });
    return {
      ...row,
      domain,
      score,
      source_type: classifySourceType(domain, score),
      is_trusted: score >= 20
    };
  });

  const ranked = deduped
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    const err = new Error("No credible sources found for this entity");
    err.code = "no_credible_sources";
    err.statusCode = 422;
    err.diagnostics = diagnostics;
    throw err;
  }

  const selected = ranked.slice(0, maxSources);
  const withExcerpts = [];
  for (const source of selected) {
    diagnostics.source_fetch_count += 1;
    const fetched = await fetchSourceExcerpt(source.url);
    if (!fetched.ok) {
      diagnostics.fetch_errors.push({ url: source.url, error: fetched.error });
    }
    withExcerpts.push({
      ...source,
      excerpt: fetched.ok
        ? fetched.excerpt
        : String(source.description || "").slice(0, 600),
      excerpt_chars: fetched.ok ? fetched.chars : String(source.description || "").length,
      fetch_ok: fetched.ok
    });
  }

  const usable = withExcerpts.filter((s) => String(s.excerpt || "").trim().length > 80);
  if (usable.length < 2) {
    const err = new Error("Could not retrieve enough readable source content");
    err.code = "source_fetch_blocked";
    err.statusCode = 422;
    err.sources = withExcerpts;
    err.diagnostics = diagnostics;
    throw err;
  }

  const systemPrompt = buildSystemPrompt(entityType);
  const userPrompt = buildUserPrompt({
    entityType,
    entityName,
    contextFacts,
    sources: usable
  });

  let generation;
  try {
    diagnostics.model_request_count += 1;
    generation = await generateStructuredJson({ systemPrompt, userPrompt });
  } catch (error) {
    error.sources = withExcerpts;
    error.diagnostics = { ...diagnostics, duration_ms: Date.now() - started };
    throw error;
  }

  diagnostics.token_usage = generation.usage || null;

  let parsed = null;
  try {
    parsed = JSON.parse(generation.text);
  } catch {
    parsed = null;
  }

  let validation = validateContentJson(entityType, parsed);
  if (!validation.ok) {
    diagnostics.model_request_count += 1;
    try {
      const repair = await generateStructuredJson({
        systemPrompt,
        userPrompt: [
          "Your previous JSON was invalid or incomplete.",
          `Error: ${validation.error}`,
          "Return corrected JSON only with all required keys.",
          `Previous output:\n${generation.text.slice(0, 6000)}`
        ].join("\n\n")
      });
      generation = repair;
      diagnostics.token_usage = repair.usage || diagnostics.token_usage;
      parsed = JSON.parse(repair.text);
      validation = validateContentJson(entityType, parsed);
    } catch (repairError) {
      const err = new Error("Invalid model response after repair attempt");
      err.code = "invalid_model_response";
      err.statusCode = 422;
      err.sources = withExcerpts;
      err.diagnostics = { ...diagnostics, duration_ms: Date.now() - started };
      err.detail = repairError.message || validation.error;
      throw err;
    }
  }

  if (!validation.ok) {
    const err = new Error(validation.error || "Invalid model response");
    err.code = "invalid_model_response";
    err.statusCode = 422;
    err.sources = withExcerpts;
    err.diagnostics = { ...diagnostics, duration_ms: Date.now() - started };
    throw err;
  }

  diagnostics.duration_ms = Date.now() - started;

  const content = normaliseContentJson(entityType, validation.content);
  const summary = String(content.overview || "").slice(0, 280);

  return {
    content_json: content,
    summary_text: summary,
    sources: withExcerpts.map((s, index) => ({
      source_url: s.url,
      source_domain: s.domain,
      source_title: s.title,
      source_type: s.source_type,
      publisher_name: s.domain,
      published_date: s.age || null,
      is_primary_source: index < 2,
      is_trusted: Boolean(s.is_trusted),
      source_order: index,
      excerpt_chars: s.excerpt_chars || 0,
      notes: s.fetch_ok ? null : "Snippet used; full page fetch failed"
    })),
    research_provider: "brave",
    generation_provider: generation.provider,
    generation_model: generation.model,
    generated_at: new Date().toISOString(),
    refresh_after: refreshAfterDate(entityType),
    diagnostics
  };
}

/**
 * Retry generation using already-saved source rows (url/title/domain + optional notes).
 * Re-fetches excerpts for trusted non-excluded sources.
 */
async function retryGenerationFromSources({
  entityType,
  entityName,
  contextFacts = "",
  sources = []
}) {
  const started = Date.now();
  const diagnostics = {
    search_query_count: 0,
    source_fetch_count: 0,
    model_request_count: 0,
    token_usage: null,
    duration_ms: 0,
    queries: [],
    fetch_errors: [],
    mode: "retry_generation"
  };

  const selected = (sources || [])
    .filter((s) => !s.exclude_from_refresh && s.is_trusted !== false)
    .slice(0, 8);

  if (selected.length < 2) {
    const err = new Error("Not enough trusted sources to retry generation");
    err.code = "no_credible_sources";
    err.statusCode = 422;
    throw err;
  }

  const withExcerpts = [];
  for (const source of selected) {
    diagnostics.source_fetch_count += 1;
    const url = source.source_url || source.url;
    const fetched = await fetchSourceExcerpt(url);
    if (!fetched.ok) diagnostics.fetch_errors.push({ url, error: fetched.error });
    withExcerpts.push({
      title: source.source_title || source.title || "",
      url,
      domain: source.source_domain || domainFromUrl(url),
      excerpt: fetched.ok ? fetched.excerpt : "",
      excerpt_chars: fetched.chars || 0
    });
  }

  const usable = withExcerpts.filter((s) => s.excerpt.length > 80);
  if (usable.length < 2) {
    const err = new Error("Could not re-fetch enough source content for generation");
    err.code = "source_fetch_blocked";
    err.statusCode = 422;
    err.diagnostics = diagnostics;
    throw err;
  }

  diagnostics.model_request_count += 1;
  let generation = await generateStructuredJson({
    systemPrompt: buildSystemPrompt(entityType),
    userPrompt: buildUserPrompt({ entityType, entityName, contextFacts, sources: usable })
  });
  diagnostics.token_usage = generation.usage || null;

  let parsed;
  try {
    parsed = JSON.parse(generation.text);
  } catch {
    parsed = null;
  }
  let validation = validateContentJson(entityType, parsed);
  if (!validation.ok) {
    diagnostics.model_request_count += 1;
    generation = await generateStructuredJson({
      systemPrompt: buildSystemPrompt(entityType),
      userPrompt: `Repair this JSON for ${entityType} "${entityName}". Error: ${validation.error}\n\n${generation.text.slice(0, 6000)}`
    });
    parsed = JSON.parse(generation.text);
    validation = validateContentJson(entityType, parsed);
  }
  if (!validation.ok) {
    const err = new Error(validation.error || "Invalid model response");
    err.code = "invalid_model_response";
    err.statusCode = 422;
    err.diagnostics = { ...diagnostics, duration_ms: Date.now() - started };
    throw err;
  }

  diagnostics.duration_ms = Date.now() - started;
  const content = normaliseContentJson(entityType, validation.content);
  return {
    content_json: content,
    summary_text: String(content.overview || "").slice(0, 280),
    generation_provider: generation.provider,
    generation_model: generation.model,
    generated_at: new Date().toISOString(),
    refresh_after: refreshAfterDate(entityType),
    diagnostics
  };
}

module.exports = {
  estimateActivity,
  runResearchPipeline,
  retryGenerationFromSources
};
