/**
 * Port image scoring — geographic confidence and image suitability are separate.
 */

const { hasConflictingLocation, countryMentionScore } = require("./country-match");
const { primaryName, searchIdentityName } = require("./queries");

const HARD_REJECT_RE =
  /\b(logo|map\b|flag\b|clipart|watermark|screenshot|brochure|infographic|diagram|powerpoint|indoor\s*event|stock\s*photo\s*site|advertisement)\b/i;

const PORT_DESTINATION_RE =
  /\b(harbour|harbor|waterfront|wharf|pier|marina|port of|coastline|cityscape|panorama|skyline|old town|promenade|lighthouse|harbor view|port view|bay|beach|coast|town|city|landscape|terminal)\b/i;

const GEO_AUTO_MIN = 78;
const SUIT_AUTO_MIN = 75;
const GEO_REVIEW_MIN = 55;
const SUIT_REVIEW_MIN = 50;
const OVERALL_REVIEW_MIN = 58;

const VESSEL_TYPE_WORDS =
  /\b(ship|ships|cruise ship|cruise ships|vessel|vessels|liner|liners|ferry|ferries|destroyer|frigate|carrier|battleship|submarine|corvette|patrol boat|naval|navy|yacht|yachts|tanker|cargo ship|container ship|bulk carrier|ocean liner|passenger ship|warship|aircraft carrier)\b/i;

const CRUISE_LINE_OR_VESSEL_NAME =
  /\b((m\/s|m-s|ms|mv|ss|rms|uss|hms|rv)\s+[a-z0-9.-]+|celebrity\s+[a-z]+|msc\s+[a-z]+|costa\s+[a-z]+|norwegian\s+[a-z]+|carnival\s+[a-z]+|azamara\s+[a-z]+|aidab[a-z]*|mein schiff|royal caribbean|queen mary|oasis of|symphony of|seabourn|princess\s+[a-z]+|cunard|seaside|solstice|artania|cavour|transport canada)\b/i;

const DESTINATION_SCENE_RE =
  /\b(harbour panorama|harbor panorama|harbour and|harbor and|waterfront|cityscape|skyline|panorama|panoramic|view of|aerial view|coastline|old town|promenade|architecture|inner harbour|inner harbor|port of|harbour view|harbor view|waterfront view|city view|landscape|wharf|pier|marina|coast|bay view|town view)\b/i;

const SHIP_DOMINANT_RE =
  /\b((m\/s|m-s|ms|mv|ss|rms)\s+[a-z0-9-]+|celebrity\s+[a-z]+|azamara\s+[a-z]+|queen mary|oasis of the|symphony of the|costa [a-z]+|aidab[a-z]*|mein schiff|norwegian [a-z]+|carnival [a-z]+|royal caribbean|ocean liner|passenger ship|cruise ship|cruise ships|two ships|three ships|ships and)\b/i;

const HISTORICAL_SIGNAL_RE =
  /\b(photochrom|historic photograph|historical photograph|archives?|circa|c\.\s*\d{4}|dated\s+\d{4}|18\d{2}s|1890s|1900s|1910s|1920s|1930s|1940s|1950s|19th century|early 20th century|waterfront 1890|harbour 1898|harbor 1898|harbour 1913|harbor 1913)\b/i;

const MILITARY_WAR_DESTINATION_RE =
  /\b(lancaster|bomber|bombardment|bombing raid|aerial attack|silhouetted over|naval combat|world war|wwii|ww2|wartime raid|military aircraft|war damage|anti-?aircraft|strafing|invasion fleet|torpedo attack|battleship|destroyer firing|naval bombardment|military harbour|military harbor|naval base|exercise guns|guns in the harbour|guns in the harbor|naval ships)\b/i;

const ELIGIBLE_SHORTLIST = 8;

function normaliseTitle(value) {
  return String(value || "")
    .replace(/^File:/i, "")
    .replace(/\.(jpg|jpeg|png|webp)$/i, "")
    .trim();
}

function titleSegments(title) {
  return normaliseTitle(title)
    .split(/\s[-–—]\s/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Detect when a vessel is the principal subject (not incidental in a wide harbour scene).
 */
function isVesselPrimarySubject(candidate) {
  const title = normaliseTitle(candidate?.title);
  const titleLower = title.toLowerCase();
  const desc = String(candidate?.description || "").toLowerCase();
  const combined = `${titleLower} ${desc}`.trim();
  if (!combined) return { vesselPrimary: false, reason: null };

  if (/\b(harbour|harbor|waterfront|port|city|panorama|skyline|coastline)\b.*\b(with|and)\s+(cruise\s+)?ships?\b/i.test(combined)) {
    return { vesselPrimary: false, reason: "destination_with_incidental_ships" };
  }
  if (/\bview of\b.*\b(harbour|harbor|port|waterfront|city)\b/i.test(combined)) {
    return { vesselPrimary: false, reason: "view_of_destination" };
  }

  const segments = titleSegments(title);
  const lead = (segments[0] || titleLower).toLowerCase();

  if (/^\w[\w\s.-]*\(\d+\)/i.test(segments[0] || title) && !/\b(harbour|harbor|waterfront|port|lighthouse|leuchtturm|hafen|skyline|cityscape)\b/i.test(lead)) {
    return { vesselPrimary: true, reason: "hull_number_lead" };
  }
  if (/^uss\s+/i.test(titleLower) && /\b(commissioning|in port|at port|naval|patrol|corvette|frigate|destroyer)\b/i.test(combined)) {
    return { vesselPrimary: true, reason: "us_navy_vessel_event" };
  }
  if (/^(tcg|hms|uss|rv|ms|mv|ss)\s+/i.test(titleLower) && /\([A-Z]?-?\d+\)/i.test(title)) {
    return { vesselPrimary: true, reason: "named_warship" };
  }
  if (/\([A-Z]{0,3}-?\d+\)/i.test(title) && /\b(in port|at port|harbour|harbor|naval|patrol|corvette|frigate|destroyer)\b/i.test(combined)) {
    return { vesselPrimary: true, reason: "pennant_in_port" };
  }

  if (CRUISE_LINE_OR_VESSEL_NAME.test(lead) && !DESTINATION_SCENE_RE.test(lead)) {
    return { vesselPrimary: true, reason: "named_vessel_lead" };
  }
  if (CRUISE_LINE_OR_VESSEL_NAME.test(titleLower.slice(0, 45)) && !DESTINATION_SCENE_RE.test(titleLower.slice(0, 45))) {
    return { vesselPrimary: true, reason: "named_vessel_early" };
  }

  if (
    /^(cruise ship|cruise ships|passenger ship|ocean liner|naval|navy|destroyer|frigate|carrier|ferry|yacht|tanker|cargo ship|container ship|patrol boat|transport canada)\b/i.test(
      titleLower
    )
  ) {
    return { vesselPrimary: true, reason: "vessel_type_lead" };
  }

  if (segments.length >= 2) {
    const tail = segments.slice(1).join(" ").toLowerCase();
    const leadIsPlace =
      DESTINATION_SCENE_RE.test(lead) ||
      /\b(harbour|harbor|port|waterfront|city|bc|canada|italy|australia|zealand)\b/i.test(lead);
    const tailVesselFocused =
      VESSEL_TYPE_WORDS.test(tail) &&
      (CRUISE_LINE_OR_VESSEL_NAME.test(tail) || /\b(patrol boat|destroyer|frigate|carrier)\b/i.test(tail)) &&
      !/\b(panorama|skyline|cityscape|architecture|view of|with ships|and ships)\b/i.test(tail);
    if (leadIsPlace && tailVesselFocused) {
      return { vesselPrimary: true, reason: "location_then_vessel_focus" };
    }
    if (!leadIsPlace && VESSEL_TYPE_WORDS.test(lead) && !DESTINATION_SCENE_RE.test(lead)) {
      return { vesselPrimary: true, reason: "vessel_lead_segment" };
    }
  }

  if (VESSEL_TYPE_WORDS.test(titleLower) && !DESTINATION_SCENE_RE.test(titleLower)) {
    const shipPos = titleLower.search(VESSEL_TYPE_WORDS);
    const destPos = titleLower.search(/\b(harbour|harbor|waterfront|port of|panorama|skyline|cityscape)\b/i);
    if (destPos < 0 || (shipPos >= 0 && shipPos < destPos)) {
      return { vesselPrimary: true, reason: "vessel_before_destination_language" };
    }
  }

  return { vesselPrimary: false, reason: null };
}

function normalizeMatchText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function destinationNamesForPort(port) {
  const names = new Set();
  for (const value of [searchIdentityName(port), primaryName(port), port?.city]) {
    const n = normalizeMatchText(value);
    if (n.length >= 3) names.add(n);
  }
  for (const alias of Array.isArray(port?.aliases) ? port.aliases : []) {
    const n = normalizeMatchText(alias);
    if (n.length >= 3) names.add(n);
  }
  return [...names];
}

function destinationSpecificityScores(candidate, port) {
  const title = normalizeMatchText(normaliseTitle(candidate?.title));
  const hay = normalizeMatchText(candidateHaystack(candidate));
  const names = destinationNamesForPort(port);
  let titleHit = false;
  let anyHit = false;
  for (const name of names) {
    if (name.length < 4) continue;
    if (title.includes(name)) titleHit = true;
    if (hay.includes(name)) anyHit = true;
  }
  return { titleHit, anyHit, names };
}

function physicalPortDestinationBoost(candidate, port) {
  const title = normalizeMatchText(normaliseTitle(candidate?.title));
  const names = destinationNamesForPort(port);
  const portContext = names.join(" ");

  if (/los angeles|san pedro|long beach/i.test(portContext)) {
    if (
      /san pedro|port of los angeles|world cruise center|los angeles harbour|los angeles harbor|la harbour|la harbor|cruise terminal|port of la\b/i.test(
        title
      )
    ) {
      return 14;
    }
    if (/santa monica|venice beach|malibu|hollywood|beverly hills|downtown los angeles/i.test(title)) {
      return -22;
    }
  }

  const hasPhysicalPortAlias = /san pedro|port of|harbour|harbor|waterfront|terminal/i.test(portContext);
  if (hasPhysicalPortAlias && /port of|harbour|harbor|waterfront|terminal|wharf|pier/i.test(title)) {
    return 6;
  }
  return 0;
}

function genericImageryPenalty(candidate, port) {
  const { titleHit, anyHit } = destinationSpecificityScores(candidate, port);
  if (anyHit) return 0;

  const title = normalizeMatchText(normaliseTitle(candidate?.title));
  const hay = normalizeMatchText(candidateHaystack(candidate));
  const countryScore = countryMentionScore(hay, port);
  const genericTitle =
    /\b(road\s+\d+|route\s+\d+|highway|landscape|coastline|coast|countryside|tropical|mountains?|scenery|generic)\b/i.test(
      title
    );
  const genericRegionOnly = /\b(greek islands?|south pacific|caribbean|scandinavia|alaska|iceland|australia|norway)\b/i.test(
    title
  );

  if (genericTitle && countryScore > 0) return 38;
  if (genericRegionOnly && !PORT_DESTINATION_RE.test(title)) return 30;
  if (countryScore >= 20 && !PORT_DESTINATION_RE.test(title)) return 24;
  return 0;
}

function extractYearSignals(text) {
  const hay = String(text || "");
  const years = [];
  for (const match of hay.matchAll(/\b(18\d{2}|19[0-9]{2}|20[0-1]\d)\b/g)) {
    years.push(Number(match[1]));
  }
  return years;
}

function classifyImageAge(candidate) {
  const hay = candidateHaystack(candidate);
  const militaryWar = isMilitaryWarDestinationImagery(candidate);
  if (militaryWar) {
    return { ageClass: "HISTORICAL", historical: true, militaryWar: true };
  }
  if (HISTORICAL_SIGNAL_RE.test(hay)) {
    return { ageClass: "HISTORICAL", historical: true, militaryWar: false };
  }
  const years = extractYearSignals(hay);
  if (years.length) {
    const maxYear = Math.max(...years);
    if (maxYear < 1970) {
      return { ageClass: "HISTORICAL", historical: true, militaryWar: false };
    }
    if (maxYear >= 2000) {
      return { ageClass: "MODERN", historical: false, militaryWar: false };
    }
    return { ageClass: "UNKNOWN", historical: false, militaryWar: false };
  }
  return { ageClass: "UNKNOWN", historical: false, militaryWar: false };
}

function isMilitaryWarDestinationImagery(candidate) {
  return MILITARY_WAR_DESTINATION_RE.test(candidateHaystack(candidate));
}

function historicalSuitabilityPenalty(candidate) {
  const age = classifyImageAge(candidate);
  if (age.militaryWar) return 45;
  if (age.historical) return 14;
  return 0;
}

function candidateHaystack(candidate) {
  return [candidate?.title, candidate?.description, candidate?.sourceUrl, candidate?.pageUrl, candidate?.credit]
    .filter(Boolean)
    .join(" ");
}

function destinationSignalHaystack(candidate) {
  return [candidate?.title, candidate?.description, candidate?.sourceUrl, candidate?.pageUrl].filter(Boolean).join(" ");
}

function nameMatchScore(text, port) {
  const names = new Set(
    [searchIdentityName(port), primaryName(port), port?.city]
      .map((v) => String(v || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const aliases = Array.isArray(port?.aliases) ? port.aliases : [];
  for (const alias of aliases) {
    const a = String(alias || "").trim().toLowerCase();
    if (a.length >= 4) names.add(a);
  }

  const hay = String(text || "").toLowerCase();
  let score = 0;
  for (const name of names) {
    if (hay.includes(name)) {
      score += name.startsWith("port ") ? 36 : 30;
      break;
    }
  }
  return Math.min(40, score);
}

function dimensionScore(candidate) {
  const w = Number(candidate?.width) || 0;
  const h = Number(candidate?.height) || 0;
  if (w <= 0 || h <= 0) return 0;
  let score = 0;
  const ratio = w / h;
  if (w < 400 || h < 280) score -= 30;
  else if (w >= 1200 && h >= 750) score += 12;
  else if (w >= 800 && h >= 500) score += 6;
  if (ratio >= 1.15 && ratio <= 2.6) score += 10;
  else if (ratio < 0.85 || ratio > 3.2) score -= 15;
  const url = String(candidate?.url || candidate?.thumbUrl || "").toLowerCase();
  if (/\.(svg|gif)\b/.test(url)) score -= 40;
  if (/logo|icon|sprite|badge|avatar/.test(url)) score -= 25;
  return score;
}

function licenseIsUsable(candidate) {
  const provider = String(candidate?.provider || "").toLowerCase();
  const license = String(candidate?.license || "").toLowerCase();
  if (provider === "pexels") return true;
  if (provider === "manual") return true;
  if (provider === "brave") {
    return /public domain|cc0|cc-by|creative commons/.test(license);
  }
  if (provider === "wikimedia") {
    return /public domain|cc0|cc-by|creative commons/.test(license) || Boolean(license);
  }
  return false;
}

function hasKnownWrongDestinationMatch(candidate, port) {
  const canonical = String(port?.canonical_name || "").trim().toLowerCase();
  const titleOnly = normaliseTitle(candidate?.title).toLowerCase();
  const hayLower = candidateHaystack(candidate).toLowerCase();

  if (canonical === "tokyo" && /ogasawara|chichijima|futami|bonin islands|hahajima|mukojima/i.test(hayLower) && !/\btokyo\b/i.test(titleOnly)) {
    return true;
  }
  if (
    canonical === "casablanca" &&
    /diamond harbour|diamond harbor|navire\s+(diamond|victoria)\s+harbour/i.test(hayLower) &&
    !/casablanca|morocco|maroc/i.test(hayLower)
  ) {
    return true;
  }
  if (
    canonical === "kahului" &&
    (/cocos nucifera|coconut palm\b/i.test(titleOnly) || /\bstarr\s+\d+.*cocos/i.test(titleOnly)) &&
    !/kahului|maui|hawaii/i.test(hayLower)
  ) {
    return true;
  }
  if (
    canonical === "punta arenas" &&
    (/patagonien\b|patagonia\b|puerto eden/i.test(hayLower) || /\b1983-12 patagonien\b/i.test(titleOnly)) &&
    !/punta arenas|magellan|magallanes|strait of magellan/i.test(hayLower)
  ) {
    return true;
  }
  return false;
}

function computeGeographicScore(candidate, port) {
  const titleOnly = normaliseTitle(candidate?.title).toLowerCase();
  if (String(port?.canonical_name || "").trim().toLowerCase() === "cozumel" && /playa del carmen|terminal maritima playa/i.test(titleOnly)) {
    return 0;
  }
  if (String(port?.canonical_name || "").trim().toLowerCase() === "ensenada") {
    const hayLower = candidateHaystack(candidate).toLowerCase();
    if (/bah[ií]a de los [aá]ngeles|bahia de los angeles|punta arenas.*bah[ií]a/i.test(hayLower)) {
      return 0;
    }
  }
  if (hasKnownWrongDestinationMatch(candidate, port)) return 0;

  const text = candidateHaystack(candidate);
  if (hasConflictingLocation(destinationSignalHaystack(candidate), port)) return 0;

  const specificity = destinationSpecificityScores(candidate, port);
  let score = 20;
  score += nameMatchScore(text, port);
  score += countryMentionScore(text, port);
  if (specificity.titleHit) score += 30;
  else if (specificity.anyHit) score += 14;
  if (PORT_DESTINATION_RE.test(text)) score += 8;
  score -= genericImageryPenalty(candidate, port);
  score += physicalPortDestinationBoost(candidate, port);

  const provider = String(candidate?.provider || "").toLowerCase();
  if (provider === "wikimedia") score += 8;
  if (provider === "pexels") score += 6;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function computeSuitabilityScore(candidate) {
  const text = candidateHaystack(candidate);
  const title = String(candidate?.title || "").toLowerCase();
  const combined = `${title} ${text}`.toLowerCase();
  const vessel = isVesselPrimarySubject(candidate);

  if (HARD_REJECT_RE.test(combined)) return 0;

  let score = 42;
  score += dimensionScore(candidate);

  if (PORT_DESTINATION_RE.test(combined)) score += 22;
  if (/\b(aerial view|panoramic|landscape|city view|harbour view|harbor view)\b/i.test(combined)) score += 10;

  if (SHIP_DOMINANT_RE.test(title) || SHIP_DOMINANT_RE.test(combined)) score -= 38;
  if (/\b(cruise ship|passenger ship|ocean liner|container ship|cargo ship|naval ship)\b/i.test(combined)) {
    score -= 35;
  }
  if (/\b(cruise ships|two ships|three ships|ships and)\b/i.test(title)) score -= 30;

  const shipHits = (combined.match(/\b(ship|ships|liner|vessel)\b/gi) || []).length;
  const portHits = (combined.match(PORT_DESTINATION_RE) || []).length;
  if (shipHits >= 2 && portHits === 0) score -= 25;

  if (vessel.vesselPrimary) score -= 48;
  score -= historicalSuitabilityPenalty(candidate);

  return Math.max(0, Math.min(100, Math.round(score)));
}

function computeOverallConfidence(geographic, suitability, { vesselPrimary = false } = {}) {
  if (geographic <= 0 || suitability <= 0) return 0;
  if (geographic < 35 || suitability < 35) {
    return Math.max(0, Math.min(45, Math.round(Math.min(geographic, suitability) * 0.8)));
  }

  let weighted = Math.round(geographic * 0.55 + suitability * 0.45);
  if (vesselPrimary) weighted = Math.min(weighted, 72);

  if (geographic >= 90 && suitability >= 85 && !vesselPrimary) return Math.min(95, weighted);
  if (geographic >= 85 && suitability < 70) return Math.min(72, weighted);
  if (geographic >= 80 && suitability < 60) return Math.min(65, weighted);
  return Math.min(90, weighted);
}

function scorePortImageCandidate(candidate, port) {
  const text = candidateHaystack(candidate);
  const vessel = isVesselPrimarySubject(candidate);

  if (hasConflictingLocation(destinationSignalHaystack(candidate), port)) {
    return {
      geographic: 0,
      suitability: 0,
      confidence: 0,
      rejected: true,
      vesselPrimary: false,
      vesselReason: null,
      reasons: ["location_conflict"]
    };
  }

  const geographic = computeGeographicScore(candidate, port);
  const suitability = computeSuitabilityScore(candidate);
  const confidence = computeOverallConfidence(geographic, suitability, { vesselPrimary: vessel.vesselPrimary });
  const specificity = destinationSpecificityScores(candidate, port);

  const reasons = [];
  if (geographic >= 70) reasons.push("geo_match");
  if (suitability >= 70) reasons.push("suitable_imagery");
  if (suitability < 50) reasons.push("ship_or_low_suitability");
  if (SHIP_DOMINANT_RE.test(String(candidate?.title || ""))) reasons.push("ship_dominated");
  if (vessel.vesselPrimary) reasons.push("vessel_primary_subject");

  if (specificity.titleHit) reasons.push("destination_in_title");
  if (genericImageryPenalty(candidate, port) > 0) reasons.push("generic_imagery");
  if (classifyImageAge(candidate).historical) reasons.push("historical_imagery");
  if (isMilitaryWarDestinationImagery(candidate)) reasons.push("military_war_imagery");
  if (String(candidate?.provider || "").toLowerCase() === "brave" && !licenseIsUsable(candidate)) {
    reasons.push("unlicensed_brave");
  }

  const rejected = geographic < 25 || suitability < 20 || confidence < 20;

  return {
    geographic,
    suitability,
    confidence,
    rejected,
    vesselPrimary: vessel.vesselPrimary,
    vesselReason: vessel.reason,
    reasons
  };
}

function pickBestCandidate(candidates, port) {
  return (candidates || [])
    .map((candidate) => ({ candidate, ...scorePortImageCandidate(candidate, port) }))
    .filter((row) => !row.rejected)
    .sort((a, b) => {
      const aSpec = destinationSpecificityScores(a.candidate, port);
      const bSpec = destinationSpecificityScores(b.candidate, port);
      if (aSpec.titleHit !== bSpec.titleHit) return bSpec.titleHit ? 1 : -1;
      if (a.vesselPrimary !== b.vesselPrimary) return a.vesselPrimary ? 1 : -1;
      const aBrave = String(a.candidate?.provider || "").toLowerCase() === "brave";
      const bBrave = String(b.candidate?.provider || "").toLowerCase() === "brave";
      const aWiki =
        String(a.candidate?.provider || "").toLowerCase() === "wikimedia" && licenseIsUsable(a.candidate);
      const bWiki =
        String(b.candidate?.provider || "").toLowerCase() === "wikimedia" && licenseIsUsable(b.candidate);
      if (aWiki !== bWiki) return bWiki ? 1 : -1;
      if (aBrave !== bBrave) return aBrave ? 1 : -1;
      const aAge = classifyImageAge(a.candidate);
      const bAge = classifyImageAge(b.candidate);
      if (aAge.militaryWar !== bAge.militaryWar) return aAge.militaryWar ? 1 : -1;
      if (aAge.historical !== bAge.historical) return aAge.historical ? 1 : -1;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      if (b.suitability !== a.suitability) return b.suitability - a.suitability;
      return b.geographic - a.geographic;
    });
}

function statusForScores(scores, provider) {
  const geo = Number(scores?.geographic) || 0;
  const suit = Number(scores?.suitability) || 0;
  const overall = Number(scores?.confidence) || 0;
  const p = String(provider || "").toLowerCase();
  const licensed = licenseIsUsable({ provider: p, license: scores?.license });

  if (scores?.vesselPrimary) {
    if (geo >= GEO_REVIEW_MIN && suit >= SUIT_REVIEW_MIN && overall >= OVERALL_REVIEW_MIN) {
      return "NEEDS_REVIEW";
    }
    return "NO_IMAGE";
  }

  if (p === "brave" && !licensed) {
    if (geo >= GEO_REVIEW_MIN && suit >= SUIT_REVIEW_MIN && overall >= OVERALL_REVIEW_MIN) {
      return "NEEDS_REVIEW";
    }
    return "NO_IMAGE";
  }

  if (
    geo >= GEO_AUTO_MIN &&
    suit >= SUIT_AUTO_MIN &&
    overall >= 80 &&
    licensed &&
    p !== "brave"
  ) {
    if (p === "wikimedia" || p === "pexels" || p === "manual") return "AUTO_APPROVED";
  }

  if (geo >= GEO_REVIEW_MIN && suit >= SUIT_REVIEW_MIN && overall >= OVERALL_REVIEW_MIN) {
    return "NEEDS_REVIEW";
  }

  return "NO_IMAGE";
}

function candidatePassesEligibility(row, port) {
  if (!row || row.rejected) return false;
  if (row.vesselPrimary) return false;
  if (isMilitaryWarDestinationImagery(row.candidate)) return false;
  if (String(row.candidate?.provider || "").toLowerCase() === "brave" && !licenseIsUsable(row.candidate)) {
    return false;
  }
  if (row.geographic < GEO_REVIEW_MIN) return false;
  if (row.suitability < SUIT_REVIEW_MIN) return false;
  if (row.confidence < OVERALL_REVIEW_MIN) return false;
  if (statusForCandidate(row) === "NO_IMAGE") return false;
  return true;
}

function isDatedForModernPreference(candidate) {
  const age = classifyImageAge(candidate);
  if (age.historical || age.ageClass === "HISTORICAL") return true;
  const years = extractYearSignals(candidateHaystack(candidate));
  return years.length > 0 && Math.max(...years) < 1990;
}

function comparableModernAlternative(modernRow, historicalRow) {
  if (!modernRow || !historicalRow) return false;
  if (modernRow.geographic < historicalRow.geographic - 10) return false;
  if (modernRow.suitability < historicalRow.suitability - 12) return false;
  if (modernRow.confidence < historicalRow.confidence - 15) return false;
  return true;
}

function pickFirstEligibleWithModernPreference(ranked, port, { limit = ELIGIBLE_SHORTLIST } = {}) {
  const eligible = [];
  for (let i = 0; i < Math.min(limit, ranked.length); i++) {
    if (candidatePassesEligibility(ranked[i], port)) {
      eligible.push({ row: ranked[i], rank: i + 1 });
    }
  }
  if (!eligible.length) return { row: null, rank: null, displacedHistorical: false };

  let chosen = eligible[0];
  let displacedHistorical = false;
  if (isDatedForModernPreference(chosen.row.candidate)) {
    for (let j = 1; j < eligible.length; j++) {
      const candidateAge = classifyImageAge(eligible[j].row.candidate);
      if (candidateAge.ageClass === "MODERN" && comparableModernAlternative(eligible[j].row, chosen.row)) {
        chosen = eligible[j];
        displacedHistorical = true;
        break;
      }
    }
  }
  return { row: chosen.row, rank: chosen.rank, displacedHistorical };
}

function pickEligibleCandidate(candidates, port, { limit = ELIGIBLE_SHORTLIST } = {}) {
  const ranked = pickBestCandidate(candidates, port);
  return pickFirstEligibleWithModernPreference(ranked, port, { limit }).row;
}

function pickEligibleCandidateWithContext(candidates, port, { limit = ELIGIBLE_SHORTLIST } = {}) {
  const ranked = pickBestCandidate(candidates, port);
  const rawTop = ranked[0] || null;
  const picked = pickFirstEligibleWithModernPreference(ranked, port, { limit });
  if (!picked.row) {
    return { row: null, rank: null, ranked, rawTop, displacedHistorical: false };
  }
  return {
    row: picked.row,
    rank: picked.rank,
    ranked,
    rawTop,
    displacedHistorical: picked.displacedHistorical
  };
}

function statusForCandidate(row) {
  return statusForScores(
    {
      geographic: row.geographic,
      suitability: row.suitability,
      confidence: row.confidence,
      license: row.candidate?.license,
      vesselPrimary: row.vesselPrimary
    },
    row.candidate?.provider
  );
}

module.exports = {
  GEO_AUTO_MIN,
  SUIT_AUTO_MIN,
  ELIGIBLE_SHORTLIST,
  scorePortImageCandidate,
  pickBestCandidate,
  pickEligibleCandidate,
  pickEligibleCandidateWithContext,
  candidatePassesEligibility,
  statusForScores,
  statusForCandidate,
  computeGeographicScore,
  computeSuitabilityScore,
  computeOverallConfidence,
  licenseIsUsable,
  isVesselPrimarySubject,
  destinationSpecificityScores,
  genericImageryPenalty,
  physicalPortDestinationBoost,
  destinationNamesForPort,
  comparableModernAlternative,
  isDatedForModernPreference,
  classifyImageAge,
  isMilitaryWarDestinationImagery,
  historicalSuitabilityPenalty,
  hasKnownWrongDestinationMatch
};
