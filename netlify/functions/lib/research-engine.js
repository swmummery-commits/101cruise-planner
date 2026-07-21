/**
 * Research orchestration: search → rank → fetch excerpts → generate → validate.
 *
 * Hardened for Netlify function time limits:
 * - Parallel Brave queries + source fetches
 * - Short per-request timeouts
 * - Soft time budget so generation can finish
 * - gatherResearchMaterials can be checkpointed to DB before LLM
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

/** Soft budget — leave headroom under Netlify’s real cap (often 26s, toml 60s). */
const RESEARCH_BUDGET_MS = Math.max(
  12_000,
  Number(process.env.RESEARCH_BUDGET_MS || 22_000)
);
const DEFAULT_MAX_SOURCES = 4;
const MIN_USABLE_SOURCES = 2;
const LLM_RESERVE_MS = 10_000;

function estimateActivity({ queryCount = 3, sourceFetchCount = 4 } = {}) {
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
      "Research searches Brave, fetches a few source pages in parallel, then calls the language model once.",
      "Content is stored for reuse — not generated on public page views.",
      "If a run times out, open the Failed draft and use Retry Generation when sources were saved."
    ]
  };
}

function mapSourcesForStorage(withExcerpts) {
  return (withExcerpts || []).map((s, index) => ({
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
    notes: s.fetch_ok ? null : "Snippet used; full page fetch failed or skipped for time"
  }));
}

/**
 * Phase 1: Brave search + ranked source excerpts (no LLM).
 * Safe to checkpoint to DB so Retry Generation works after a timeout.
 */
async function gatherResearchMaterials({
  entityType,
  entityName,
  officialDomain = "",
  maxSources = DEFAULT_MAX_SOURCES,
  budgetMs = RESEARCH_BUDGET_MS
}) {
  const started = Date.now();
  const deadline = started + budgetMs;
  const remaining = () => deadline - Date.now();

  const diagnostics = {
    search_query_count: 0,
    source_fetch_count: 0,
    model_request_count: 0,
    token_usage: null,
    duration_ms: 0,
    queries: [],
    fetch_errors: [],
    phase: "gather",
    budget_ms: budgetMs
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

  const searchTimeout = Math.min(7_000, Math.max(3_000, Math.floor(remaining() / Math.max(queries.length, 1))));
  const searchBatches = await Promise.all(
    queries.map(async (query) => {
      diagnostics.search_query_count += 1;
      try {
        return await braveSearch(apiKey, query, { count: 6, timeoutMs: searchTimeout });
      } catch (error) {
        diagnostics.fetch_errors.push({ query, error: error.message || "Brave search failed" });
        return [];
      }
    })
  );

  const rawResults = [];
  for (const batch of searchBatches) {
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
    err.diagnostics = { ...diagnostics, duration_ms: Date.now() - started };
    throw err;
  }

  const selected = ranked.slice(0, maxSources);
  const fetchBudget = remaining() - LLM_RESERVE_MS;
  const perFetchTimeout = Math.min(
    5_000,
    Math.max(1_800, Math.floor(fetchBudget / Math.max(selected.length, 1)))
  );

  const withExcerpts = await Promise.all(
    selected.map(async (source) => {
      diagnostics.source_fetch_count += 1;
      const snippet = String(source.description || "").trim();

      // Not enough time left — use Brave snippet only
      if (remaining() < LLM_RESERVE_MS + 1_500) {
        return {
          ...source,
          excerpt: snippet.slice(0, 600),
          excerpt_chars: Math.min(snippet.length, 600),
          fetch_ok: false
        };
      }

      const fetched = await fetchSourceExcerpt(source.url, { timeoutMs: perFetchTimeout });
      if (!fetched.ok) {
        diagnostics.fetch_errors.push({ url: source.url, error: fetched.error });
      }
      const excerpt = fetched.ok
        ? fetched.excerpt
        : snippet.slice(0, 600);
      return {
        ...source,
        excerpt,
        excerpt_chars: fetched.ok ? fetched.chars : excerpt.length,
        fetch_ok: fetched.ok
      };
    })
  );

  const usable = withExcerpts.filter((s) => String(s.excerpt || "").trim().length > 80);
  if (usable.length < MIN_USABLE_SOURCES) {
    const err = new Error("Could not retrieve enough readable source content");
    err.code = "source_fetch_blocked";
    err.statusCode = 422;
    err.sources = withExcerpts;
    err.diagnostics = { ...diagnostics, duration_ms: Date.now() - started };
    throw err;
  }

  diagnostics.duration_ms = Date.now() - started;
  diagnostics.phase = "gathered";
  diagnostics.remaining_ms_after_gather = remaining();

  return {
    entityType,
    entityName,
    contextFacts: "",
    withExcerpts,
    usable,
    diagnostics,
    sourcesForStorage: mapSourcesForStorage(withExcerpts)
  };
}

/**
 * Phase 2: LLM generation from gathered materials.
 */
async function generateFromMaterials({
  entityType,
  entityName,
  contextFacts = "",
  withExcerpts,
  usable,
  diagnostics: priorDiagnostics = {},
  allowRepair = true
}) {
  const started = Date.now();
  const diagnostics = {
    ...priorDiagnostics,
    phase: "generate",
    model_request_count: priorDiagnostics.model_request_count || 0
  };

  const sources = usable || withExcerpts.filter((s) => String(s.excerpt || "").trim().length > 80);
  const systemPrompt = buildSystemPrompt(entityType);
  const userPrompt = buildUserPrompt({
    entityType,
    entityName,
    contextFacts,
    sources
  });

  let generation;
  try {
    diagnostics.model_request_count += 1;
    generation = await generateStructuredJson({ systemPrompt, userPrompt });
  } catch (error) {
    error.sources = withExcerpts;
    error.diagnostics = { ...diagnostics, duration_ms: (priorDiagnostics.duration_ms || 0) + (Date.now() - started) };
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
  if (!validation.ok && allowRepair) {
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
      err.diagnostics = {
        ...diagnostics,
        duration_ms: (priorDiagnostics.duration_ms || 0) + (Date.now() - started)
      };
      err.detail = repairError.message || validation.error;
      throw err;
    }
  }

  if (!validation.ok) {
    const err = new Error(validation.error || "Invalid model response");
    err.code = "invalid_model_response";
    err.statusCode = 422;
    err.sources = withExcerpts;
    err.diagnostics = {
      ...diagnostics,
      duration_ms: (priorDiagnostics.duration_ms || 0) + (Date.now() - started)
    };
    throw err;
  }

  diagnostics.duration_ms = (priorDiagnostics.duration_ms || 0) + (Date.now() - started);
  diagnostics.phase = "complete";

  const content = normaliseContentJson(entityType, validation.content);
  const summary = String(content.overview || "").slice(0, 280);

  return {
    content_json: content,
    summary_text: summary,
    sources: mapSourcesForStorage(withExcerpts),
    research_provider: "brave",
    generation_provider: generation.provider,
    generation_model: generation.model,
    generated_at: new Date().toISOString(),
    refresh_after: refreshAfterDate(entityType),
    diagnostics
  };
}

async function runResearchPipeline({
  entityType,
  entityName,
  officialDomain = "",
  contextFacts = "",
  maxSources = DEFAULT_MAX_SOURCES
}) {
  const gathered = await gatherResearchMaterials({
    entityType,
    entityName,
    officialDomain,
    maxSources
  });
  return generateFromMaterials({
    entityType,
    entityName,
    contextFacts,
    withExcerpts: gathered.withExcerpts,
    usable: gathered.usable,
    diagnostics: gathered.diagnostics,
    allowRepair: (gathered.diagnostics.remaining_ms_after_gather || 0) > 12_000
  });
}

/**
 * Retry generation using already-saved source rows (url/title/domain + optional notes).
 * Re-fetches excerpts in parallel for trusted non-excluded sources.
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
    .slice(0, DEFAULT_MAX_SOURCES + 1);

  if (selected.length < MIN_USABLE_SOURCES) {
    const err = new Error("Not enough trusted sources to retry generation");
    err.code = "no_credible_sources";
    err.statusCode = 422;
    throw err;
  }

  const withExcerpts = await Promise.all(
    selected.map(async (source) => {
      diagnostics.source_fetch_count += 1;
      const url = source.source_url || source.url;
      const fetched = await fetchSourceExcerpt(url, { timeoutMs: 5_000 });
      if (!fetched.ok) diagnostics.fetch_errors.push({ url, error: fetched.error });
      return {
        title: source.source_title || source.title || "",
        url,
        domain: source.source_domain || domainFromUrl(url),
        excerpt: fetched.ok ? fetched.excerpt : "",
        excerpt_chars: fetched.chars || 0,
        fetch_ok: fetched.ok,
        is_trusted: true,
        source_type: source.source_type || null
      };
    })
  );

  const usable = withExcerpts.filter((s) => s.excerpt.length > 80);
  if (usable.length < MIN_USABLE_SOURCES) {
    const err = new Error("Could not re-fetch enough source content for generation");
    err.code = "source_fetch_blocked";
    err.statusCode = 422;
    err.diagnostics = { ...diagnostics, duration_ms: Date.now() - started };
    throw err;
  }

  diagnostics.duration_ms = Date.now() - started;
  return generateFromMaterials({
    entityType,
    entityName,
    contextFacts,
    withExcerpts,
    usable,
    diagnostics,
    allowRepair: true
  });
}

module.exports = {
  estimateActivity,
  gatherResearchMaterials,
  generateFromMaterials,
  runResearchPipeline,
  retryGenerationFromSources,
  RESEARCH_BUDGET_MS,
  DEFAULT_MAX_SOURCES
};
