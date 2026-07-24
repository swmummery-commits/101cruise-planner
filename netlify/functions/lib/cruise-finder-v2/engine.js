/**
 * Cruise Finder Engine V2 orchestrator (Phase 1 — not production-activated).
 */

const { normaliseSearchRequest } = require("./normalise-search-request");
const { normaliseCruiseResult } = require("./normalise-cruise-result");
const { deduplicateCandidates, buildCandidateKey } = require("./deduplicate");
const { getProvider, createDefaultRegistry } = require("./providers/provider-registry");
const {
  loadLocalCatalogues,
  enrichCandidate
} = require("./enrichment/match-entities");

const DEFAULT_TIMEOUT_MS = 12_000;

function withTimeout(promise, ms, code = "provider_timeout") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Provider timed out after ${ms}ms`);
      err.code = code;
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {object} questionnaireBody Finder POST body
 * @param {{ providerId?: string, limit?: number, timeoutMs?: number, enrich?: boolean }} [options]
 */
async function runEngineV2Search(questionnaireBody, options = {}) {
  const normalised = normaliseSearchRequest(questionnaireBody);
  if (!normalised.ok) {
    return {
      ok: false,
      error: normalised.error,
      request: null,
      candidates: [],
      enrichment: [],
      meta: {}
    };
  }

  const providerId = options.providerId || "fixture";
  const provider = getProvider(providerId);
  if (!provider) {
    return {
      ok: false,
      error: { code: "unknown_provider", message: `Unknown provider: ${providerId}` },
      request: normalised.request,
      candidates: [],
      enrichment: [],
      meta: {}
    };
  }

  const timeoutMs = options.timeoutMs != null ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  let searchResult;
  try {
    searchResult = await withTimeout(
      provider.search(normalised.request, { limit: options.limit || 10 }),
      timeoutMs
    );
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error.code || "provider_failure",
        message: String(error.message || error)
      },
      request: normalised.request,
      candidates: [],
      enrichment: [],
      meta: { providerId, feasibility: provider.getFeasibility?.() }
    };
  }

  if (!searchResult || searchResult.ok === false) {
    return {
      ok: false,
      error: searchResult?.error || { code: "provider_empty", message: "Provider returned failure." },
      request: normalised.request,
      candidates: [],
      enrichment: [],
      meta: { providerId, ...(searchResult?.meta || {}), feasibility: provider.getFeasibility?.() }
    };
  }

  const accepted = [];
  const rejected = [];
  for (const raw of searchResult.candidates || []) {
    const result = normaliseCruiseResult(raw);
    if (result.ok) accepted.push(result.cruise);
    else rejected.push({ raw, errors: result.errors });
  }

  const { unique, duplicates } = deduplicateCandidates(accepted);
  const withKeys = unique.map((c) => ({ ...c, candidateKey: buildCandidateKey(c) }));

  let enrichment = [];
  if (options.enrich !== false) {
    const catalogues = loadLocalCatalogues(options.cataloguePaths || {});
    enrichment = withKeys.map((cruise) => ({
      providerCruiseId: cruise.providerCruiseId,
      candidateKey: cruise.candidateKey,
      ...enrichCandidate(cruise, catalogues)
    }));
  }

  return {
    ok: true,
    request: normalised.request,
    candidates: withKeys,
    enrichment,
    meta: {
      providerId,
      returned: withKeys.length,
      rejected: rejected.length,
      duplicates: duplicates.length,
      duplicateKeys: duplicates.map((d) => d.key),
      feasibility: provider.getFeasibility?.(),
      ...(searchResult.meta || {})
    }
  };
}

function readEngineFlag(env = process.env) {
  const raw = String(env.CRUISE_FINDER_ENGINE || "v1").trim().toLowerCase();
  return raw === "v2" ? "v2" : "v1";
}

module.exports = {
  runEngineV2Search,
  readEngineFlag,
  createDefaultRegistry,
  DEFAULT_TIMEOUT_MS
};
