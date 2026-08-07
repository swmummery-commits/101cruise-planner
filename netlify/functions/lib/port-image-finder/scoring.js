/**
 * Deterministic confidence scoring for port image candidates.
 */

const { hasConflictingLocation, countryMentionScore } = require("./country-match");
const { primaryName } = require("./queries");

const REJECT_RE =
  /\b(cruise\s*ship|ocean\s*liner|passenger\s*ship|logo|map\b|flag\b|clipart|watermark|screenshot|brochure|infographic|diagram|powerpoint|indoor\s*event|stock\s*photo\s*site)\b/i;

const PORT_WORD_RE = /\b(cruise\s*port|harbour|harbor|waterfront|port\s+of|marina|terminal|wharf|pier)\b/i;

const SOURCE_TRUST = {
  manual: 40,
  wikimedia: 35,
  pexels: 28,
  brave: 8
};

const AUTO_APPROVE_THRESHOLD = 82;
const REVIEW_THRESHOLD = 52;

function candidateHaystack(candidate) {
  return [
    candidate?.title,
    candidate?.description,
    candidate?.sourceUrl,
    candidate?.pageUrl,
    candidate?.credit,
    candidate?.license
  ]
    .filter(Boolean)
    .join(" ");
}

function nameMatchScore(text, port) {
  const name = primaryName(port).toLowerCase();
  if (!name || !text) return 0;
  const hay = text.toLowerCase();
  let score = 0;

  if (hay.includes(name)) score += 38;

  const city = String(port?.city || "").trim().toLowerCase();
  if (city && city !== name && hay.includes(city)) score += 22;

  const aliases = Array.isArray(port?.aliases) ? port.aliases : [];
  for (const alias of aliases) {
    const a = String(alias || "").trim().toLowerCase();
    if (a.length >= 4 && hay.includes(a)) {
      score += 14;
      break;
    }
  }

  return score;
}

function imageQualityScore(candidate) {
  const w = Number(candidate?.width) || 0;
  const h = Number(candidate?.height) || 0;
  let score = 0;

  if (w > 0 && h > 0) {
    const ratio = w / h;
    if (w < 400 || h < 280) score -= 45;
    else if (w >= 1200 && h >= 750) score += 18;
    else if (w >= 800 && h >= 500) score += 10;
    if (ratio >= 1.15 && ratio <= 2.6) score += 14;
    else if (ratio < 0.85 || ratio > 3.2) score -= 20;
  }

  const url = String(candidate?.url || candidate?.thumbUrl || "").toLowerCase();
  if (/\.(svg|gif)\b/.test(url)) score -= 50;
  if (/logo|icon|sprite|badge|avatar|thumb\/\d{1,2}px/.test(url)) score -= 35;

  return score;
}

function licenseScore(candidate) {
  const provider = String(candidate?.provider || "").toLowerCase();
  if (provider === "wikimedia") {
    const license = String(candidate?.license || "").toLowerCase();
    if (/public domain|cc0|cc-by|creative commons/.test(license)) return 25;
    if (license) return 10;
    return 5;
  }
  if (provider === "pexels") return 22;
  if (provider === "brave") return -5;
  return 0;
}

/**
 * @param {object} candidate
 * @param {object} port
 * @returns {{ score: number, confidence: number, rejected: boolean, reasons: string[] }}
 */
function scorePortImageCandidate(candidate, port) {
  const reasons = [];
  const text = candidateHaystack(candidate);

  if (REJECT_RE.test(text)) {
    return { score: -100, confidence: 0, rejected: true, reasons: ["rejected_content"] };
  }

  let score = SOURCE_TRUST[String(candidate?.provider || "").toLowerCase()] || 0;
  score += nameMatchScore(text, port);
  score += countryMentionScore(text, port);
  score += imageQualityScore(candidate);
  score += licenseScore(candidate);

  if (PORT_WORD_RE.test(text)) {
    score += 12;
    reasons.push("port_context");
  }

  if (hasConflictingLocation(text, port)) {
    score -= 90;
    reasons.push("location_conflict");
  }

  const confidence = Math.max(0, Math.min(100, Math.round(score)));
  const rejected = confidence < 20 || reasons.includes("location_conflict");

  return { score, confidence, rejected, reasons };
}

function pickBestCandidate(candidates, port) {
  const scored = (candidates || [])
    .map((candidate) => {
      const result = scorePortImageCandidate(candidate, port);
      return { candidate, ...result };
    })
    .filter((row) => !row.rejected)
    .sort((a, b) => b.confidence - a.confidence);

  return scored;
}

function statusForConfidence(confidence, provider) {
  const p = String(provider || "").toLowerCase();
  if (confidence >= AUTO_APPROVE_THRESHOLD && (p === "wikimedia" || p === "pexels" || p === "manual")) {
    return "AUTO_APPROVED";
  }
  if (confidence >= REVIEW_THRESHOLD) return "NEEDS_REVIEW";
  return "NO_IMAGE";
}

module.exports = {
  AUTO_APPROVE_THRESHOLD,
  REVIEW_THRESHOLD,
  scorePortImageCandidate,
  pickBestCandidate,
  statusForConfidence
};
