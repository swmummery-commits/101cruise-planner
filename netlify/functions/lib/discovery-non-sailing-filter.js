/**
 * Reject marketing / hub / land-tour pages that are not bookable sailings.
 * Used pre-fetch (URL score), post-fetch (candidate build), remediation, and source memory.
 *
 * Hierarchy:
 *  A. HARD REJECT — obvious non-sailing paths/types (no override)
 *  B. REGIONAL HUB — reject unless strong sailing evidence on the page
 *  C. Sailing-evidence override requires multiple signals; nights alone is insufficient
 */

const { normaliseName } = require("./cruise-finder-v2/enrichment/match-entities");

/** Filter version stored on hidden records for audit/replay */
const NON_SAILING_FILTER_VERSION = "2026-08-02.1";

/** Always non-sailing — no sailing-evidence override */
const HARD_REJECT_PATH_FRAGMENTS = [
  "/tours/",
  "/tour/",
  "/hotels/",
  "/hotel/",
  "/news/",
  "/blog/",
  "/blogs/",
  "/press/",
  "/media/",
  "/careers/",
  "/investors/",
  "/about/",
  "/why-cruise/",
  "/why-sail/",
  "/experiences/",
  "/experience/",
  "/vacation-packages/",
  "/packages/",
  "/land-tours/",
  "/cruisetours/",
  "/cruise-tours/",
  "/immersion/",
  "/overland/",
  "/travel-advisors/",
  "/faq/",
  "/contact/",
  "/privacy/",
  "/terms/",
  "/deck-plans/",
  "/deckplans/",
  "/cabins/",
  "/stateroom",
  "/suites/",
  "/dining/",
  "/restaurants/",
  "/entertainment/",
  "/onboard/",
  "/on-board/",
  "/life-on-board/",
  "/onboard-experience/",
  "/ships/",
  "/ship/",
  "/fleet/",
  "/destinations/",
  "/destination/",
  "/offers/",
  "/deals/",
  "/brochures/",
  "/magazine/",
  "/magazines/",
  "/articles/",
  "/article/",
  "/stories/",
  "/story/",
  "/awards/",
  "/sustainability/",
  "/accessibility/",
  "/promotions/",
  "/search/",
  "/results/",
  "/find-cruises/",
  "/cruise-search/",
  "/cruise-finder/",
  "/offer/",
  "/ports-of-call/",
  "/rewards/",
  "/rewards-program/",
  "/scenic-and-emerald-rewards/",
  "/afar/",
  "/homepage",
  "/acq/",
  "/online-guides/",
  "/guest-review/",
  "/review-of-"
];

/** Regional / marketing hubs — reject unless strong sailing evidence */
const REGIONAL_HUB_PATH_FRAGMENTS = ["/north-america/", "/south-america/"];

/** Path slugs that must never become ship-name guesses (unless canonical ship match) */
const INVALID_SHIP_GUESS_TOKENS = new Set(
  [
    "tours",
    "tour",
    "hotels",
    "hotel",
    "news",
    "blogs",
    "blog",
    "press",
    "media",
    "careers",
    "about",
    "experiences",
    "experience",
    "packages",
    "package",
    "overview",
    "announcements",
    "headlines",
    "articles",
    "article",
    "stories",
    "story",
    "destinations",
    "destination",
    "north america",
    "south america",
    "europe",
    "asia",
    "africa",
    "caribbean",
    "mediterranean",
    "alaska",
    "antarctica",
    "australia",
    "immersion",
    "overland",
    "advisors",
    "contact",
    "privacy",
    "terms",
    "faq",
    "search",
    "results",
    "landing",
    "homepage",
    "index",
    "ships",
    "ship",
    "fleet",
    "vessels",
    "yachts",
    "yacht",
    "offers",
    "deals",
    "promotions",
    "brochures",
    "magazine",
    "awards",
    "sustainability",
    "onboard",
    "dining",
    "entertainment",
    "suites",
    "cabins",
    "staterooms",
    "deckplans",
    "deck plans",
    "why cruise",
    "why sail",
    "our ships",
    "meet the fleet",
    "travel guide",
    "destination guide",
    "river cruise",
    "luxury onboard service",
    "cruises",
    "cruise",
    "luxury",
    "service",
    "holidays",
    "holiday",
    "voyages",
    "voyage"
  ].map(normaliseName)
);

const NON_SAILING_TITLE_PATTERNS = [
  /\bluxury\s+(?:grace\s+bay\s+)?beach\s+hotel\b/i,
  /\bhotel\s+(?:in|at|on)\b/i,
  /\bopens?\s+.+\s+season\s+for\s+sale\b/i,
  /\bexpedition\s+season\s+for\s+sale\b/i,
  /\bluxury\s+on\s?board\s+service\b/i,
  /\briver\s+cruise\s+service\b/i,
  /\bwhy\s+sail\s+with\s+us\b/i,
  /\bmeet\s+the\s+fleet\b/i,
  /\bour\s+ships\b/i,
  /\bdestination\s+guide\b/i,
  /\btravel\s+guide\b/i,
  /\bdeck\s+plan\b/i,
  /\bcabin\s+categor/i,
  /\bpress\s+release\b/i,
  /\bnewsroom\b/i,
  /\bcareers?\s+at\b/i,
  /\binvestor\s+relations\b/i,
  /\bland\s+tour\b/i,
  /\bcruise\s+tour\b/i,
  /\bvacation\s+package\b/i,
  /\bsearch\s+results\b/i,
  /\bfind\s+a\s+cruise\b/i,
  /\bcommon\s+faq/i,
  /\brewards?\s+program\b/i,
  /\bscenic\s+&?\s+emerald\s+rewards\b/i
];

const TRANSIENT_FETCH_REASONS = new Set([
  "fetch_failed",
  "fetch_timeout",
  "fetch_blocked",
  "fetch_incomplete",
  "transient_provider_error",
  "network_error",
  "rate_limited"
]);

function safePath(url) {
  try {
    return new URL(String(url || "").trim()).pathname.toLowerCase();
  } catch {
    return "";
  }
}

function pathIncludesFragment(path, fragments) {
  return fragments.some((frag) => {
    const core = String(frag || "")
      .replace(/^\/+|\/+$/g, "");
    if (!core) return false;
    const re = new RegExp(`(?:^|/)${core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/|$)`);
    return re.test(path);
  });
}

function pathMatchesHardReject(url) {
  const path = safePath(url);
  if (!path) return false;
  if (isStructuredOfficialSailingDetailUrl(url)) return false;
  return pathIncludesFragment(path, HARD_REJECT_PATH_FRAGMENTS);
}

/** Individual sailing detail URLs from official line SPAs — not marketing hub pages. */
function isStructuredOfficialSailingDetailUrl(url) {
  try {
    const u = new URL(String(url || "").trim());
    const path = u.pathname.toLowerCase();
    if (!path.includes("/cruise-search/details")) return false;
    const params = u.searchParams;
    return Boolean(
      params.get("voyagecode") ||
        params.get("voyageCode") ||
        params.get("saildate") ||
        params.get("sailDate") ||
        params.get("shipcode") ||
        params.get("shipCode")
    );
  } catch {
    return false;
  }
}

function pathMatchesRegionalHub(url) {
  const path = safePath(url);
  if (!path) return false;
  return pathIncludesFragment(path, REGIONAL_HUB_PATH_FRAGMENTS);
}

/** @deprecated use pathMatchesHardReject — kept for callers */
function pathMatchesNonSailing(url) {
  return pathMatchesHardReject(url) || pathMatchesRegionalHub(url);
}

function normaliseKnownShipNames(names) {
  return new Set((names || []).map((n) => normaliseName(n)).filter(Boolean));
}

function matchesKnownShip(guess, knownShipNames) {
  const norm = normaliseName(guess);
  if (!norm || !knownShipNames?.size) return false;
  if (knownShipNames.has(norm)) return true;
  for (const ship of knownShipNames) {
    if (ship.includes(norm) || norm.includes(ship)) return true;
  }
  return false;
}

function slugTokenRejected(value, knownShipNames = null) {
  const norm = normaliseName(value);
  if (!norm) return false;
  if (knownShipNames && matchesKnownShip(norm, knownShipNames)) return false;
  if (INVALID_SHIP_GUESS_TOKENS.has(norm)) return true;
  const tokens = norm.split(" ").filter(Boolean);
  if (tokens.length && tokens.every((t) => INVALID_SHIP_GUESS_TOKENS.has(t))) return true;
  return false;
}

function titleLooksNonSailing(title) {
  const text = String(title || "").trim();
  if (!text) return false;
  return NON_SAILING_TITLE_PATTERNS.some((re) => re.test(text));
}

function guessLooksNonSailing(guess, knownShipNames = null) {
  return slugTokenRejected(guess, knownShipNames);
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
  return (
    /\b\d{1,2}\s*[-–]?\s*nights?\b/i.test(String(text || "")) ||
    /\b\d{1,2}\s*nt\b/i.test(String(text || ""))
  );
}

function hasSailingId(text) {
  return /\b(?:voyage|sailing|cruise)\s*(?:id|#|no\.?|number)?\s*[:=]?\s*[A-Z0-9-]{4,}\b/i.test(
    String(text || "")
  );
}

function hasEmbarkation(text) {
  return /\b(?:depart(?:s|ing|ure)?|embark(?:s|ation)?|from)\b/i.test(String(text || ""));
}

function isFutureDate(value) {
  if (!value) return false;
  const d = new Date(String(value).slice(0, 10));
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d >= today;
}

/**
 * Strong sailing evidence requires multiple independent signals.
 * A single weak signal (e.g. "7 nights" alone) is never sufficient.
 * @returns {{ sufficient: boolean, score: number, signals: string[] }}
 */
function evaluateSailingEvidence(input = {}) {
  const knownShipNames = input.knownShipNames || normaliseKnownShipNames(input.knownShipNamesList);
  const title = String(input.title || input.itinerary || "").trim();
  const description = String(input.description || input.excerpt || "").trim();
  const blob = `${title}\n${description}`;
  const signals = [];
  let score = 0;

  if (input.ship_id) {
    signals.push("ship_id");
    score += 3;
  } else if (input.matched_ship?.id) {
    signals.push("matched_ship");
    score += 3;
  } else {
    const guesses = []
      .concat(input.ship_name_guess || [])
      .concat(input.ship_name_guesses || [])
      .filter(Boolean);
    const canonicalGuess = guesses.find((g) => matchesKnownShip(g, knownShipNames));
    if (canonicalGuess) {
      signals.push("canonical_ship");
      score += 3;
    } else if (guesses.some((g) => g && !guessLooksNonSailing(g, knownShipNames))) {
      signals.push("credible_ship_guess");
      score += 1;
    }
  }

  const departureDate =
    input.departure_date || input.raw_extract?.departure_date || null;
  if (departureDate && isFutureDate(departureDate)) {
    signals.push("future_departure_date");
    score += 3;
  } else if (hasExplicitDate(blob)) {
    signals.push("explicit_date_in_text");
    score += 2;
  }

  if (input.departure_port && String(input.departure_port).trim().length > 2) {
    signals.push("departure_port");
    score += 2;
  } else if (hasEmbarkation(blob) && hasExplicitDate(blob)) {
    signals.push("embarkation_with_date");
    score += 2;
  }

  if (input.nights && input.itinerary) {
    signals.push("nights_with_itinerary");
    score += 2;
  } else if (input.nights && signals.some((s) => s.startsWith("ship") || s.includes("departure"))) {
    signals.push("nights_with_ship_or_date");
    score += 1;
  } else if (hasNightsPhrase(blob) && signals.length >= 2) {
    signals.push("nights_in_text");
    score += 1;
  }

  if (input.return_date) {
    signals.push("return_date");
    score += 1;
  }

  if (hasSailingId(blob) || input.official_sailing_id) {
    signals.push("sailing_identifier");
    score += 2;
  }

  if (input.structured_sailing || input.raw_extract?.structured_sailing) {
    signals.push("structured_metadata");
    score += 3;
  }

  if (/\b(?:itinerary|ports of call|port sequence)\b/i.test(blob) && signals.length >= 1) {
    signals.push("itinerary_detail");
    score += 1;
  }

  const nightsOnly =
    signals.length === 1 &&
    (signals[0] === "nights_in_text" ||
      (signals[0] === "nights_with_itinerary" && !input.itinerary && !/\bport\b/i.test(blob)));

  const sufficient =
    !nightsOnly &&
    score >= 5 &&
    signals.length >= 3 &&
    (signals.some((s) => s.includes("ship")) ||
      signals.includes("ship_id") ||
      signals.includes("matched_ship") ||
      signals.includes("canonical_ship")) &&
    (signals.some((s) => s.includes("date") || s.includes("departure")) ||
      signals.includes("departure_port") ||
      signals.includes("embarkation_with_date"));

  return { sufficient, score, signals };
}

/**
 * Individual sailing gate — required before any page may enter sailing review or publish.
 * Destination publication status is irrelevant; marketing expedition pages must fail here.
 * @returns {{ proven: boolean, missing: string[], reason: string|null }}
 */
function provesIndividualSailing(input = {}) {
  const knownShipNames =
    input.knownShipNames || normaliseKnownShipNames(input.knownShipNamesList || input.ships?.map((s) => s.name));

  const hasShip =
    Boolean(input.ship_id) ||
    Boolean(input.matched_ship?.id) ||
    (input.shipResolution?.resolved && input.shipResolution.confidence >= 85) ||
    Boolean(
      input.ship_name_guess &&
        matchesKnownShip(input.ship_name_guess, knownShipNames) &&
        !guessLooksNonSailing(input.ship_name_guess, knownShipNames)
    );

  const departureDate = input.departure_date || input.raw_extract?.departure_date || null;
  const hasFutureDate = departureDate && isFutureDate(departureDate);

  const portMeta = input.departure_port_meta || input.raw_extract?.departure_port_meta;
  const hasPort =
    Boolean(input.departure_port && String(input.departure_port).trim().length > 2) ||
    portMeta?.status === "resolved";

  const missing = [];
  if (!hasShip) missing.push("ship");
  if (!hasFutureDate) missing.push("future_departure_date");
  if (!hasPort) missing.push("embarkation_port");

  return {
    proven: missing.length === 0,
    missing,
    reason: missing.length ? "non_sailing_marketing_page" : null
  };
}

/**
 * Safety check before auto-reject writes — block if strong individual sailing evidence exists.
 */
function hasStrongIndividualSailingEvidence(input = {}) {
  const evidence = evaluateSailingEvidence(input);
  const individual = provesIndividualSailing(input);
  return evidence.sufficient && individual.proven;
}

function isTransientFetchFailure(reason) {
  return TRANSIENT_FETCH_REASONS.has(String(reason || "").trim());
}

function nonSailingReviewReason(classifierReason) {
  return `non_sailing:${classifierReason}:${NON_SAILING_FILTER_VERSION}`;
}

function parseNonSailingReviewReason(reviewReason) {
  const raw = String(reviewReason || "");
  if (!raw.startsWith("non_sailing:")) return null;
  const parts = raw.split(":");
  return {
    classifier: parts[1] || null,
    version: parts[2] || null,
    retryable: false
  };
}

/**
 * @returns {{ rejected: boolean, reason: string|null, override: boolean|null }}
 */
function classifyNonSailingSource(input = {}) {
  const knownShipNames =
    input.knownShipNames || normaliseKnownShipNames(input.knownShipNamesList || input.ships?.map((s) => s.name));

  const url = String(input.url || input.official_url || input.source_url || "").trim();
  const title = String(input.title || input.itinerary || input.raw_extract?.title || "").trim();
  const description = String(
    input.description || input.excerpt || input.raw_extract?.description || ""
  ).trim();
  const blob = `${title}\n${description}`.toLowerCase();

  const evidence = evaluateSailingEvidence({ ...input, title, description, knownShipNames });

  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.startsWith("blog.") && !evidence.sufficient) {
      return { rejected: true, reason: "non_sailing_blog_subdomain", override: false };
    }
  } catch {
    /* ignore */
  }

  if (pathMatchesHardReject(url)) {
    return { rejected: true, reason: "non_sailing_url_path", override: false };
  }

  if (pathMatchesRegionalHub(url) && !evidence.sufficient) {
    return { rejected: true, reason: "non_sailing_regional_hub", override: false };
  }

  if (titleLooksNonSailing(title) && !evidence.sufficient) {
    return { rejected: true, reason: "non_sailing_title", override: false };
  }

  const guesses = []
    .concat(input.ship_name_guess || [])
    .concat(input.ship_name_guesses || [])
    .concat(input.raw_extract?.ship_name_guesses || [])
    .concat(input.raw_ship_name ? [input.raw_ship_name] : [])
    .concat(input.payload?.raw_ship_name ? [input.payload.raw_ship_name] : [])
    .filter(Boolean);

  const badGuesses = guesses.filter((g) => guessLooksNonSailing(g, knownShipNames));
  if (badGuesses.length && !input.ship_id && !evidence.sufficient) {
    return { rejected: true, reason: "non_sailing_ship_guess", override: false };
  }

  if (
    !input.ship_id &&
    !input.departure_date &&
    !input.raw_extract?.departure_date &&
    !evidence.sufficient &&
    (blob.includes("hotel") ||
      (blob.includes("opens ") && blob.includes(" for sale")) ||
      blob.includes("newsroom") ||
      blob.includes("land tour") ||
      blob.includes("cruise tour") ||
      blob.includes("search results"))
  ) {
    return { rejected: true, reason: "non_sailing_content", override: false };
  }

  if (pathMatchesRegionalHub(url) && evidence.sufficient) {
    return { rejected: false, reason: null, override: true };
  }

  return { rejected: false, reason: null, override: null };
}

function isNonSailingUrl(url, input = {}) {
  return classifyNonSailingSource({ ...input, url }).rejected;
}

function isNonSailingSource(input) {
  return classifyNonSailingSource(input).rejected;
}

module.exports = {
  NON_SAILING_FILTER_VERSION,
  HARD_REJECT_PATH_FRAGMENTS,
  REGIONAL_HUB_PATH_FRAGMENTS,
  INVALID_SHIP_GUESS_TOKENS,
  NON_SAILING_PATH_FRAGMENTS: HARD_REJECT_PATH_FRAGMENTS,
  NON_SAILING_SLUG_TOKENS: INVALID_SHIP_GUESS_TOKENS,
  pathMatchesHardReject,
  pathMatchesRegionalHub,
  pathMatchesNonSailing,
  slugTokenRejected,
  guessLooksNonSailing,
  titleLooksNonSailing,
  evaluateSailingEvidence,
  provesIndividualSailing,
  hasStrongIndividualSailingEvidence,
  classifyNonSailingSource,
  isNonSailingUrl,
  isNonSailingSource,
  isTransientFetchFailure,
  nonSailingReviewReason,
  parseNonSailingReviewReason,
  matchesKnownShip,
  normaliseKnownShipNames,
  hasExplicitDate,
  hasNightsPhrase
};
