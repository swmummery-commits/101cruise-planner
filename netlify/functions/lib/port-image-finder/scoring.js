/**
 * Port image scoring — geographic confidence and image suitability are separate.
 */

const { hasConflictingLocation, countryMentionScore } = require("./country-match");
const { primaryName, searchIdentityName } = require("./queries");

const HARD_REJECT_RE =
  /\b(logo|map\b|flag\b|clipart|watermark|screenshot|brochure|infographic|diagram|powerpoint|indoor\s*event|stock\s*photo\s*site|advertisement)\b/i;

const PORT_DESTINATION_RE =
  /\b(harbour|harbor|waterfront|wharf|pier|marina|port of|coastline|cityscape|panorama|skyline|old town|promenade|lighthouse|waterfront|harbor view|port view|bay|beach|coast|town|city|landscape|terminal)\b/i;

const SHIP_DOMINANT_RE =
  /\b((m\/s|m-s|ms|mv|ss|rms)\s+[a-z0-9-]+|celebrity\s+[a-z]+|azamara\s+[a-z]+|queen mary|oasis of the|symphony of the|costa [a-z]+|aidab[a-z]*|mein schiff|norwegian [a-z]+|carnival [a-z]+|royal caribbean|ocean liner|passenger ship|cruise ship|cruise ships|two ships|three ships|ships and)\b/i;

const GEO_AUTO_MIN = 78;
const SUIT_AUTO_MIN = 75;
const GEO_REVIEW_MIN = 55;
const SUIT_REVIEW_MIN = 50;
const OVERALL_REVIEW_MIN = 58;

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
  if (/\.jpg\)$/i.test(title) && /celebrity|solstice|azamara|artania|costa|aidab/i.test(title)) score -= 20;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function computeOverallConfidence(geographic, suitability) {
  if (geographic <= 0 || suitability <= 0) return 0;
  if (geographic < 35 || suitability < 35) {
    return Math.max(0, Math.min(45, Math.round(Math.min(geographic, suitability) * 0.8)));
  }

  const weighted = Math.round(geographic * 0.55 + suitability * 0.45);
  if (geographic >= 90 && suitability >= 85) return Math.min(95, weighted);
  if (geographic >= 85 && suitability < 70) return Math.min(72, weighted);
  if (geographic >= 80 && suitability < 60) return Math.min(65, weighted);
  return Math.min(90, weighted);
}

/**
 * @param {object} candidate
 * @param {object} port
 */
function scorePortImageCandidate(candidate, port) {
  const reasons = [];
  const text = candidateHaystack(candidate);

  if (hasConflictingLocation(text, port)) {
    return {
      geographic: 0,
      suitability: 0,
      confidence: 0,
      rejected: true,
      reasons: ["location_conflict"]
    };
  }

  const geographic = computeGeographicScore(candidate, port);
  const suitability = computeSuitabilityScore(candidate);
  const confidence = computeOverallConfidence(geographic, suitability);

  if (geographic >= 70) reasons.push("geo_match");
  if (suitability >= 70) reasons.push("suitable_imagery");
  if (suitability < 50) reasons.push("ship_or_low_suitability");
  if (SHIP_DOMINANT_RE.test(String(candidate?.title || ""))) reasons.push("ship_dominated");

  const rejected = geographic < 25 || suitability < 20 || confidence < 20;

  return {
    geographic,
    suitability,
    confidence,
    rejected,
    reasons
  };
}

function pickBestCandidate(candidates, port) {
  return (candidates || [])
    .map((candidate) => ({ candidate, ...scorePortImageCandidate(candidate, port) }))
    .filter((row) => !row.rejected)
    .sort((a, b) => {
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
      license: row.candidate?.license
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
  licenseIsUsable
};
