/**
 * Sprint 12A — Assisted deck-plan source finder.
 * Official ship page first; official-domain Brave search as fallback only.
 * Returns only the strongest candidates (never dozens).
 */

const { braveSearch, getBraveApiKey, dedupeSearchResults } = require("./brave-search");
const { fetchSourceExcerpt } = require("./source-fetch");

const MAX_CANDIDATES = 3;
const MIN_CANDIDATE_SCORE = 50;
const MAX_BRAVE_QUERIES_PER_FIND = 2;
const BRAVE_RESULTS_PER_QUERY = 3;
const RECENT_SEARCH_CACHE_HOURS = 168; // 7 days

const DECK_LINK_LABELS = [
  "deck plans",
  "deck plan",
  "explore the ship",
  "ship layout",
  "decks",
  "deck plans & layouts",
  "interactive deck plan",
  "virtual tour"
];

const DECK_PATH_HINTS = [
  /deck[-_]?plans?/i,
  /ship[-_]?layout/i,
  /explore[-_]?the[-_]?ship/i,
  /\/decks?\b/i,
  /interactive[-_]?deck/i
];

const UNOFFICIAL_BLOCKLIST = [
  "cruisecritic",
  "cruisecompete",
  "cruisemapper",
  "shipmate",
  "tripadvisor",
  "reddit.com",
  "facebook.com",
  "pinterest",
  "youtube.com",
  "wikipedia",
  "cruiseline.com",
  "iglucruise",
  "cruise.co.uk",
  "vacations.com",
  "expedia",
  "kayak"
];

function domainFromUrl(value) {
  try {
    return new URL(String(value || "").trim()).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function isBlockedDomain(hostname) {
  const host = String(hostname || "").toLowerCase();
  return UNOFFICIAL_BLOCKLIST.some((bit) => host === bit || host.endsWith(`.${bit}`) || host.includes(bit));
}

function sameSiteOrSubdomain(candidateHost, officialHost) {
  const a = String(candidateHost || "").toLowerCase().replace(/^www\./, "");
  const b = String(officialHost || "").toLowerCase().replace(/^www\./, "");
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function absoluteUrl(href, baseUrl) {
  try {
    return new URL(String(href || "").trim(), baseUrl).toString();
  } catch {
    return "";
  }
}

function classifySourceType(url, title = "", reason = "") {
  const u = String(url || "").toLowerCase();
  const blob = `${u} ${title} ${reason}`.toLowerCase();
  if (/\.pdf(\?|#|$)/i.test(u) || blob.includes("filetype:pdf")) return "official_pdf";
  if (
    /interactive|viewer|explore|360|virtual|deck-?plan-?tool|ship.?explorer/i.test(blob) ||
    /\/viewer\b|\/explore\b|\/interactive\b/i.test(u)
  ) {
    return "official_interactive_viewer";
  }
  if (DECK_PATH_HINTS.some((re) => re.test(u)) || /deck/i.test(blob)) return "official_page";
  return "other_official_asset";
}

function sourceTypeLabel(type) {
  switch (type) {
    case "official_pdf":
      return "Official PDF";
    case "official_interactive_viewer":
      return "Official interactive viewer";
    case "official_page":
      return "Official page";
    default:
      return "Other official asset";
  }
}

function confidenceFromScore(score) {
  if (score >= 70) return "high";
  if (score >= 50) return "medium";
  return "low";
}

function extractAnchors(html, baseUrl) {
  const out = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(String(html || ""))) !== null) {
    const href = absoluteUrl(match[1], baseUrl);
    if (!href || !/^https?:/i.test(href)) continue;
    const text = String(match[2] || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
    out.push({ href, text });
  }
  return out;
}

function scoreDeckCandidate({ url, title, description, reasonBits, officialDomain, fromOfficialPage }) {
  let score = 0;
  const host = domainFromUrl(url);
  const blob = `${url} ${title} ${description} ${(reasonBits || []).join(" ")}`.toLowerCase();

  if (isBlockedDomain(host)) return { score: 0, reject: true };

  if (fromOfficialPage) score += 35;
  if (sameSiteOrSubdomain(host, officialDomain)) score += 40;
  else if (fromOfficialPage) score += 10;
  else return { score: 0, reject: true };

  if (DECK_PATH_HINTS.some((re) => re.test(url))) score += 25;
  if (DECK_LINK_LABELS.some((label) => blob.includes(label))) score += 20;
  if (/\.pdf(\?|#|$)/i.test(url)) score += 15;
  if (/interactive|viewer|explore the ship/i.test(blob)) score += 12;
  if (/\bdeck\b/i.test(blob)) score += 8;

  return { score, reject: false };
}

function toCandidate(row) {
  const sourceType = classifySourceType(row.url, row.title, row.reason);
  return {
    id: row.id || `${sourceType}:${row.url}`,
    title: row.title || sourceTypeLabel(sourceType),
    url: row.url,
    source_domain: domainFromUrl(row.url),
    source_type: sourceType,
    source_type_label: sourceTypeLabel(sourceType),
    reason: row.reason,
    confidence: confidenceFromScore(row.score),
    score: row.score
  };
}

/** Keep only the strongest handful; drop weak/medium-low noise. */
function selectStrongestCandidates(rows) {
  const sorted = [...rows].sort((a, b) => b.score - a.score);
  const strong = sorted.filter((r) => r.score >= MIN_CANDIDATE_SCORE);
  const pool = strong.length ? strong : sorted.slice(0, 1).filter((r) => r.score >= 40);
  return pool.slice(0, MAX_CANDIDATES).map(toCandidate);
}

function candidatesFromOfficialPage(html, shipPageUrl, shipName, officialDomain) {
  const anchors = extractAnchors(html, shipPageUrl);
  const results = [];
  const seen = new Set();

  for (const anchor of anchors) {
    const href = anchor.href;
    if (seen.has(href)) continue;
    const labelBlob = `${anchor.text} ${href}`.toLowerCase();
    const labelHit = DECK_LINK_LABELS.some((label) => labelBlob.includes(label));
    const pathHit = DECK_PATH_HINTS.some((re) => re.test(href));
    const pdfHit = /\.pdf(\?|#|$)/i.test(href);
    if (!labelHit && !pathHit && !pdfHit) continue;

    const host = domainFromUrl(href);
    if (isBlockedDomain(host)) continue;

    const reasonBits = [];
    if (labelHit) reasonBits.push(`Link text/path matches deck-plan wording (“${anchor.text || "link"}”)`);
    if (pathHit) reasonBits.push("URL path looks like a deck-plan resource");
    if (pdfHit) reasonBits.push("PDF asset linked from the official ship page");
    reasonBits.push("Found on the official ship page");

    const scored = scoreDeckCandidate({
      url: href,
      title: anchor.text || `Deck plan link — ${shipName}`,
      description: "",
      reasonBits,
      officialDomain,
      fromOfficialPage: true
    });
    if (scored.reject || scored.score < 40) continue;

    seen.add(href);
    results.push({
      url: href,
      title: anchor.text || `Deck Plans — ${shipName}`,
      reason: reasonBits.join(". "),
      score: scored.score,
      id: `page:${href}`
    });
  }

  return results;
}

async function candidatesFromBrave(shipName, officialDomain, apiKey) {
  if (!officialDomain || !apiKey) {
    return { rows: [], braveRequests: 0 };
  }

  const queries = [
    `site:${officialDomain} "${shipName}" "deck plans"`,
    `site:${officialDomain} "${shipName}" filetype:pdf deck`,
    `site:${officialDomain} "${shipName}" "deck plan"`,
    `site:${officialDomain} "${shipName}" "deck layout"`
  ].slice(0, MAX_BRAVE_QUERIES_PER_FIND);

  const collected = [];
  let braveRequests = 0;

  for (const query of queries) {
    try {
      braveRequests += 1;
      const rows = await braveSearch(apiKey, query, {
        count: BRAVE_RESULTS_PER_QUERY,
        timeoutMs: 7000
      });
      for (const row of rows || []) {
        collected.push({
          title: row.title,
          url: row.url,
          description: row.description || "",
          query
        });
      }
      // Early stop if we already have strong official hits
      const provisional = dedupeSearchResults(collected).filter((row) => {
        const host = domainFromUrl(row.url);
        return sameSiteOrSubdomain(host, officialDomain) && !isBlockedDomain(host);
      });
      if (provisional.length >= MAX_CANDIDATES) break;
    } catch {
      // Continue other queries
    }
  }

  const deduped = dedupeSearchResults(collected);
  const out = [];
  for (const row of deduped) {
    const host = domainFromUrl(row.url);
    if (!sameSiteOrSubdomain(host, officialDomain)) continue;
    if (isBlockedDomain(host)) continue;

    const reasonBits = [`Official-domain search: ${row.query}`];
    if (row.description) reasonBits.push(String(row.description).slice(0, 140));

    const scored = scoreDeckCandidate({
      url: row.url,
      title: row.title,
      description: row.description,
      reasonBits,
      officialDomain,
      fromOfficialPage: false
    });
    if (scored.reject || scored.score < MIN_CANDIDATE_SCORE) continue;

    out.push({
      url: row.url,
      title: row.title || `Deck plan — ${shipName}`,
      reason: `Matched official-domain search for “${shipName}” deck plans.`,
      score: scored.score,
      id: `search:${row.url}`
    });
  }
  return { rows: out, braveRequests };
}

function isRecentSearch(lastSearchedAt, hours = RECENT_SEARCH_CACHE_HOURS) {
  if (!lastSearchedAt) return false;
  const t = new Date(lastSearchedAt).getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < hours * 3600 * 1000;
}

/**
 * @param {{
 *   shipName: string,
 *   officialShipUrl?: string,
 *   officialDomain?: string,
 *   lineWebsiteUrl?: string,
 *   lastSearchedAt?: string,
 *   cachedCandidates?: array,
 *   force?: boolean
 * }} input
 */
async function findDeckPlanCandidates(input) {
  const shipName = String(input.shipName || "").trim();
  const officialShipUrl = String(input.officialShipUrl || "").trim();
  const officialDomain =
    String(input.officialDomain || "").trim().replace(/^www\./i, "").toLowerCase() ||
    domainFromUrl(input.lineWebsiteUrl) ||
    domainFromUrl(officialShipUrl);
  const force = input.force === true;

  const diagnostics = {
    official_domain: officialDomain || null,
    official_ship_url: officialShipUrl || null,
    scanned_ship_page: false,
    used_brave_fallback: false,
    ship_page_error: null,
    brave_requests: 0,
    cache_hit: false,
    max_candidates: MAX_CANDIDATES
  };

  // Cost control: reuse recent candidates unless forced
  if (!force && isRecentSearch(input.lastSearchedAt)) {
    const cached = Array.isArray(input.cachedCandidates) ? input.cachedCandidates : [];
    diagnostics.cache_hit = true;
    return {
      candidates: cached.slice(0, MAX_CANDIDATES),
      diagnostics,
      officialDomain,
      skippedSearch: true
    };
  }

  const byUrl = new Map();

  if (officialShipUrl) {
    diagnostics.scanned_ship_page = true;
    const fetched = await fetchSourceExcerpt(officialShipUrl, {
      timeoutMs: 6000,
      includeHtml: true,
      maxExcerptChars: 500
    });
    if (!fetched.ok) {
      diagnostics.ship_page_error = fetched.error || "Failed to fetch ship page";
    } else {
      for (const row of candidatesFromOfficialPage(
        fetched.html || "",
        officialShipUrl,
        shipName,
        officialDomain
      )) {
        const prev = byUrl.get(row.url);
        if (!prev || row.score > prev.score) byUrl.set(row.url, row);
      }
    }
  }

  // Brave only when page scan did not yield a strong candidate
  const pageStrong = [...byUrl.values()].some((r) => r.score >= MIN_CANDIDATE_SCORE);
  if (!pageStrong && officialDomain) {
    diagnostics.used_brave_fallback = true;
    const apiKey = getBraveApiKey();
    if (apiKey) {
      const brave = await candidatesFromBrave(shipName, officialDomain, apiKey);
      diagnostics.brave_requests = brave.braveRequests;
      for (const row of brave.rows) {
        const prev = byUrl.get(row.url);
        if (!prev || row.score > prev.score) byUrl.set(row.url, row);
      }
    }
  }

  const candidates = selectStrongestCandidates([...byUrl.values()]);

  return { candidates, diagnostics, officialDomain, skippedSearch: false };
}

module.exports = {
  findDeckPlanCandidates,
  domainFromUrl,
  sourceTypeLabel,
  classifySourceType,
  isBlockedDomain,
  sameSiteOrSubdomain,
  selectStrongestCandidates,
  isRecentSearch,
  MAX_CANDIDATES,
  MIN_CANDIDATE_SCORE,
  MAX_BRAVE_QUERIES_PER_FIND,
  RECENT_SEARCH_CACHE_HOURS
};
