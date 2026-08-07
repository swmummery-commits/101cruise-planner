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

  if (/^\w[\w\s.-]*\(\d+\)/i.test(segments[0] || title)) {
    return { vesselPrimary: true, reason: "hull_number_lead" };
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

function candidateHaystack(candidate) {
  return [candidate?.title, candidate?.description, candidate?.sourceUrl, candidate?.pageUrl, candidate?.credit]
    .filter(Boolean)
    .join(" ");
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
  if (provider === "pexels") return true;
  if (provider === "manual") return true;
  if (provider === "wikimedia") {
    const license = String(candidate?.license || "").toLowerCase();
    return /public domain|cc0|cc-by|creative commons/.test(license) || Boolean(license);
  }
  return false;
}

function computeGeographicScore(candidate, port) {
  const text = candidateHaystack(candidate);
  if (hasConflictingLocation(text, port)) return 0;

  let score = 20;
  score += nameMatchScore(text, port);
  score += countryMentionScore(text, port);
  if (PORT_DESTINATION_RE.test(text)) score += 8;

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

  if (hasConflictingLocation(text, port)) {
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

  const reasons = [];
  if (geographic >= 70) reasons.push("geo_match");
  if (suitability >= 70) reasons.push("suitable_imagery");
  if (suitability < 50) reasons.push("ship_or_low_suitability");
  if (SHIP_DOMINANT_RE.test(String(candidate?.title || ""))) reasons.push("ship_dominated");
  if (vessel.vesselPrimary) reasons.push("vessel_primary_subject");

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
      if (a.vesselPrimary !== b.vesselPrimary) return a.vesselPrimary ? 1 : -1;
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

  if (scores?.vesselPrimary) {
    if (geo >= GEO_REVIEW_MIN && suit >= SUIT_REVIEW_MIN && overall >= OVERALL_REVIEW_MIN) {
      return "NEEDS_REVIEW";
    }
    return "NO_IMAGE";
  }

  if (
    geo >= GEO_AUTO_MIN &&
    suit >= SUIT_AUTO_MIN &&
    overall >= 80 &&
    licenseIsUsable({ provider, license: scores?.license })
  ) {
    if (p === "wikimedia" || p === "pexels" || p === "manual") return "AUTO_APPROVED";
  }

  if (geo >= GEO_REVIEW_MIN && suit >= SUIT_REVIEW_MIN && overall >= OVERALL_REVIEW_MIN) {
    return "NEEDS_REVIEW";
  }

  return "NO_IMAGE";
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
  scorePortImageCandidate,
  pickBestCandidate,
  statusForScores,
  statusForCandidate,
  computeGeographicScore,
  computeSuitabilityScore,
  computeOverallConfidence,
  licenseIsUsable,
  isVesselPrimarySubject
};
