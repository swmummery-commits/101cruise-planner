/**
 * Sprint 11D.2 — Score Brave/official search hits before fetch.
 * Prefer sailing/itinerary URLs; demote fleet/ship/marketing pages.
 */

const POSITIVE_TERMS = [
  "itinerary",
  "itineraries",
  "sailing",
  "sailings",
  "departure",
  "departures",
  "cruise-details",
  "cruise_details",
  "voyage",
  "voyages",
  "booking",
  "find-a-cruise",
  "findacruise",
  "search-cruises",
  "cruise-search",
  "cruisesearch",
  "availability",
  "depart",
  "departs"
];

const POSITIVE_PATH_FRAGMENTS = [
  "/itinerary",
  "/itineraries",
  "/sailing",
  "/sailings",
  "/voyage",
  "/voyages",
  "/booking",
  "/book/",
  "/find-a-cruise",
  "/cruise-search",
  "/search-cruises",
  "/cruise-details",
  "/cruises/",
  "/departures"
];

const NEGATIVE_PATH_FRAGMENTS = [
  "/ships/",
  "/ship/",
  "/fleet/",
  "/destinations/",
  "/destination/",
  "/about/",
  "/blog/",
  "/news/",
  "/offers/",
  "/deals/",
  "/why-cruise/",
  "/experience/",
  "/cabins/",
  "/deck-plans/",
  "/deckplans/",
  "/restaurants/",
  "/dining/",
  "/entertainment/",
  "/suites/",
  "/stateroom",
  "/media/",
  "/press/",
  "/careers/",
  "/investors/"
];

const NEGATIVE_TERMS = [
  "deck plan",
  "deck plans",
  "cabin categories",
  "why cruise",
  "meet the fleet",
  "our ships",
  "ship overview",
  "destination guide",
  "travel guide",
  "blog"
];

function safeUrlParts(url) {
  try {
    const u = new URL(String(url || "").trim());
    return {
      href: u.href,
      path: (u.pathname || "/").toLowerCase(),
      host: u.hostname.replace(/^www\./i, "").toLowerCase()
    };
  } catch {
    return { href: String(url || ""), path: "", host: "" };
  }
}

function collectMatches(hay, patterns) {
  const found = [];
  const lower = String(hay || "").toLowerCase();
  for (const p of patterns) {
    if (lower.includes(String(p).toLowerCase())) found.push(p);
  }
  return found;
}

function hasExplicitDate(text) {
  const raw = String(text || "");
  return (
    /\b(20\d{2})-(\d{2})-(\d{2})\b/.test(raw) ||
    /\b\d{1,2}[\/.\-]\d{1,2}[\/.\-]20\d{2}\b/.test(raw) ||
    /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+20\d{2}\b/i.test(
      raw
    ) ||
    /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+20\d{2}\b/i.test(
      raw
    )
  );
}

function hasNightsPhrase(text) {
  return /\b\d{1,2}\s*[-–]?\s*nights?\b/i.test(String(text || "")) || /\b\d{1,2}\s*nt\b/i.test(String(text || ""));
}

function hasSailingId(text) {
  return /\b(?:voyage|sailing|cruise)\s*(?:id|#|no\.?|number)?\s*[:=]?\s*[A-Z0-9-]{4,}\b/i.test(
    String(text || "")
  );
}

function isGenericHomepage(path) {
  return !path || path === "/" || path === "/en" || path === "/en-au" || path === "/en-us" || /^\/[a-z]{2}(-[a-z]{2})?\/?$/i.test(path);
}

/**
 * Score a search hit for sailing likelihood.
 * @returns {{ score: number, positive: string[], negative: string[], hasSailingSignal: boolean, decision: 'fetch'|'skip', reason: string }}
 */
function scoreSailingUrl(hit, adapter = null) {
  const url = String(hit?.url || "").trim();
  const title = String(hit?.title || "");
  const snippet = String(hit?.description || hit?.snippet || "");
  const { path } = safeUrlParts(url);
  const blob = `${url}\n${title}\n${snippet}`;

  const positive = [];
  const negative = [];
  let score = 0;

  for (const frag of POSITIVE_PATH_FRAGMENTS) {
    if (path.includes(frag)) {
      positive.push(frag);
      score += 4;
    }
  }
  for (const term of POSITIVE_TERMS) {
    if (blob.toLowerCase().includes(term)) {
      positive.push(term);
      score += 2;
    }
  }
  if (hasNightsPhrase(blob)) {
    positive.push("N-night");
    score += 5;
  }
  if (hasExplicitDate(blob)) {
    positive.push("explicit_date");
    score += 5;
  }
  if (hasSailingId(blob)) {
    positive.push("sailing_id");
    score += 3;
  }
  if (/\bdepart(?:s|ure|ing)?\b/i.test(blob) && hasExplicitDate(blob)) {
    positive.push("departure+date");
    score += 3;
  }

  for (const frag of NEGATIVE_PATH_FRAGMENTS) {
    if (path.includes(frag)) {
      negative.push(frag);
      score -= 8;
    }
  }
  for (const term of NEGATIVE_TERMS) {
    if (blob.toLowerCase().includes(term)) {
      negative.push(term);
      score -= 3;
    }
  }
  if (isGenericHomepage(path)) {
    negative.push("generic_homepage");
    score -= 10;
  }

  // Adapter overrides
  if (adapter?.acceptedUrlPatterns?.length) {
    const accepted = adapter.acceptedUrlPatterns.some((re) => re.test(url) || re.test(path));
    if (accepted) {
      positive.push("adapter_accepted_pattern");
      score += 6;
    }
  }
  if (adapter?.excludedUrlPatterns?.length) {
    const excluded = adapter.excludedUrlPatterns.some((re) => re.test(url) || re.test(path));
    if (excluded) {
      negative.push("adapter_excluded_pattern");
      score -= 12;
    }
  }

  const hasSailingSignal =
    hasExplicitDate(blob) ||
    hasNightsPhrase(blob) ||
    hasSailingId(blob) ||
    POSITIVE_PATH_FRAGMENTS.some((f) => path.includes(f)) ||
    /\/(?:itinerary|sailing|voyage|booking|find-a-cruise|cruise-search|cruise-details)/i.test(path) ||
    (Boolean(adapter?.acceptedUrlPatterns?.some((re) => re.test(url) || re.test(path))) &&
      score >= 4);

  let decision = "fetch";
  let reason = "sailing_candidate";
  if (score <= -6 || (negative.length >= 2 && positive.length === 0)) {
    decision = "skip";
    reason = negative[0] ? `non_sailing:${negative[0]}` : "low_sailing_score";
  } else if (!hasSailingSignal) {
    decision = "skip";
    reason = "ignored_non_sailing_source";
  } else if (score < 2) {
    decision = "skip";
    reason = "insufficient_sailing_score";
  }

  return {
    score,
    positive: [...new Set(positive)],
    negative: [...new Set(negative)],
    hasSailingSignal,
    decision,
    reason
  };
}

function buildBraveSailingQueries({ host, destName, adapter }) {
  const dest = destName || "cruise";
  const year = new Date().getUTCFullYear();
  const nextYear = year + 1;
  const base = [
    `site:${host} inurl:itinerary ${dest} ${nextYear}`,
    `site:${host} inurl:sailing ${dest}`,
    `site:${host} "${dest}" ("7-night" OR "7 nights" OR "10-night" OR "14-night") cruise`,
    `site:${host} "Departs" ${dest} cruise`,
    `site:${host} inurl:voyage ${dest}`,
    `site:${host} (itinerary OR sailing) ${dest} -ships -fleet -blog -destination`
  ];
  if (adapter?.braveQueries) {
    return adapter.braveQueries({ host, destName: dest, year, nextYear }).filter(Boolean);
  }
  return base;
}

module.exports = {
  scoreSailingUrl,
  buildBraveSailingQueries,
  hasExplicitDate,
  hasNightsPhrase,
  POSITIVE_PATH_FRAGMENTS,
  NEGATIVE_PATH_FRAGMENTS
};
