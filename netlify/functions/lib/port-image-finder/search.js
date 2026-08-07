/**
 * Orchestrate port image search across Wikimedia → Pexels → Brave.
 */

const { buildPortImageQueries } = require("./queries");
const { pickBestCandidate, statusForCandidate } = require("./scoring");
const { searchWikimediaCommons } = require("./sources/wikimedia");
const { searchPexels } = require("./sources/pexels");
const { braveImageSearch, getBraveApiKey } = require("../brave-search");

const RECHECK_DAYS = 30;
const SHORTLIST_SIZE = 8;
const STRONG_CANDIDATE_GEO = 78;
const STRONG_CANDIDATE_SUIT = 72;

function dedupeCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const row of candidates || []) {
    const url = String(row?.url || row?.thumbUrl || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(row);
  }
  return out;
}

function countryCodeForSearch(port) {
  const code = String(port?.country_code || "").trim().toUpperCase();
  if (code === "AU") return "AU";
  if (code === "NZ") return "NZ";
  if (code === "US") return "US";
  if (code === "GB" || code === "UK") return "GB";
  if (code === "CA") return "CA";
  return "ALL";
}

function shouldSkipRecentSearch(port, { force = false } = {}) {
  if (force) return false;
  if (port?.image_status === "MANUAL") return true;
  if (port?.hero_media_id && (port?.image_status === "MANUAL" || port?.image_status === "AUTO_APPROVED")) {
    return true;
  }
  const checkedAt = port?.image_last_checked_at ? Date.parse(port.image_last_checked_at) : NaN;
  if (!Number.isFinite(checkedAt)) return false;
  const ageMs = Date.now() - checkedAt;
  return ageMs < RECHECK_DAYS * 24 * 60 * 60 * 1000;
}

function serialiseCandidate(row) {
  return {
    id: row.candidate?.id || `${row.candidate?.provider || "unknown"}|${String(row.candidate?.url || "").slice(0, 120)}`,
    provider: row.candidate?.provider || "",
    title: row.candidate?.title || "",
    description: row.candidate?.description || "",
    url: row.candidate?.url || "",
    thumbUrl: row.candidate?.thumbUrl || row.candidate?.url || "",
    width: row.candidate?.width || null,
    height: row.candidate?.height || null,
    sourceUrl: row.candidate?.sourceUrl || row.candidate?.pageUrl || "",
    pageUrl: row.candidate?.pageUrl || "",
    license: row.candidate?.license || null,
    credit: row.candidate?.credit || null,
    geographic: row.geographic,
    suitability: row.suitability,
    confidence: row.confidence,
    reasons: row.reasons || []
  };
}

function hasStrongCandidate(scored) {
  return scored.some(
    (row) => row.geographic >= STRONG_CANDIDATE_GEO && row.suitability >= STRONG_CANDIDATE_SUIT && row.confidence >= 78
  );
}

async function searchWikimediaQueries(queries, port, collected) {
  for (const query of queries) {
    try {
      const wiki = await searchWikimediaCommons(query, { limit: 10 });
      collected.push(...wiki);
    } catch (error) {
      console.warn("wikimedia port search skipped", query, error.message);
      if (String(error.code || "") === "rate_limited") break;
    }
    const interim = pickBestCandidate(dedupeCandidates(collected), port);
    if (hasStrongCandidate(interim)) break;
  }
}

/**
 * @param {object} port
 * @param {{ force?: boolean, autoApply?: boolean }} [options]
 */
async function findPortImageCandidates(port, options = {}) {
  if (port?.image_status === "MANUAL" && port?.hero_media_id && !options.force) {
    return {
      skipped: true,
      reason: "manual_image",
      candidates: Array.isArray(port.image_candidates) ? port.image_candidates : [],
      queries: [],
      autoApply: null
    };
  }

  if (shouldSkipRecentSearch(port, options) && !options.force) {
    return {
      skipped: true,
      reason: "recently_checked",
      candidates: Array.isArray(port.image_candidates) ? port.image_candidates : [],
      queries: [],
      autoApply: null
    };
  }

  const queries = buildPortImageQueries(port);
  const primaryQuery = queries[0] || "";
  const country = countryCodeForSearch(port);
  const collected = [];

  await searchWikimediaQueries(queries, port, collected);

  let scored = pickBestCandidate(dedupeCandidates(collected), port);

  if (!hasStrongCandidate(scored)) {
    for (const query of queries.slice(0, 2)) {
      try {
        const pexels = await searchPexels(query, { limit: 8 });
        collected.push(...pexels);
      } catch (error) {
        console.warn("pexels port search skipped", query, error.message);
      }
    }
    scored = pickBestCandidate(dedupeCandidates(collected), port);
  }

  if (!hasStrongCandidate(scored) && getBraveApiKey()) {
    for (const query of queries.slice(0, 2)) {
      try {
        const brave = await braveImageSearch(null, query, { count: 12, country });
        collected.push(...brave);
      } catch (error) {
        console.warn("brave port image search skipped", query, error.message);
      }
    }
    scored = pickBestCandidate(dedupeCandidates(collected), port);
  }

  const shortlist = scored.slice(0, SHORTLIST_SIZE).map(serialiseCandidate);
  const top = scored[0] || null;

  let autoApply = null;
  if (options.autoApply && top) {
    const status = statusForCandidate(top);
    if (status === "AUTO_APPROVED") {
      autoApply = {
        candidate: serialiseCandidate(top),
        status,
        confidence: top.confidence,
        geographic: top.geographic,
        suitability: top.suitability
      };
    }
  }

  return {
    skipped: false,
    reason: null,
    queries,
    primaryQuery,
    candidates: shortlist,
    autoApply,
    bestConfidence: top?.confidence || 0,
    bestGeographic: top?.geographic || 0,
    bestSuitability: top?.suitability || 0,
    suggestedStatus: top ? statusForCandidate(top) : "NO_IMAGE"
  };
}

module.exports = {
  RECHECK_DAYS,
  SHORTLIST_SIZE,
  buildPortImageQueries,
  findPortImageCandidates,
  shouldSkipRecentSearch,
  hasStrongCandidate
};
