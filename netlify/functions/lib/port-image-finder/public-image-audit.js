/**
 * Audit existing public port images against current scoring rules (no downloads).
 */

const {
  scorePortImageCandidate,
  statusForCandidate,
  licenseIsUsable,
  classifyImageAge,
  isMilitaryWarDestinationImagery,
  isVesselPrimarySubject,
  genericImageryPenalty,
  destinationSpecificityScores,
  isDatedForModernPreference,
  computeGeographicScore
} = require("./scoring");

const HISTORICAL_AUDIT_PORTS = new Set([
  "nassau",
  "marseille",
  "quebec city",
  "st johns antigua",
  "cozumel",
  "skagway",
  "sitka",
  "naples"
]);

function normalizePortKey(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function candidateFromStored(port, media) {
  const title =
    media?.title ||
    (port?.image_source_url ? String(port.image_source_url).split("/").pop()?.replace(/_/g, " ") : "") ||
    port?.canonical_name ||
    "";
  return {
    title,
    description: media?.alt_text || media?.title || "",
    provider: port?.image_source || "wikimedia",
    license: port?.image_license || null,
    credit: port?.image_credit || null,
    sourceUrl: port?.image_source_url || media?.source_url || null,
    pageUrl: port?.image_source_url || media?.source_url || null,
    url: media?.public_url || "",
    width: media?.width || null,
    height: media?.height || null
  };
}

function imageTitle(port, media) {
  const candidate = candidateFromStored(port, media);
  return candidate.title || port?.image_source_url || "—";
}

function hasWrongGeographyForPort(port, candidate) {
  const title = String(candidate?.title || "").toLowerCase();
  const hay = [candidate?.title, candidate?.description, candidate?.sourceUrl].filter(Boolean).join(" ").toLowerCase();
  const canonical = normalizePortKey(port?.canonical_name);

  if (canonical === "los angeles" || /san pedro/i.test([port?.city, ...(port?.aliases || [])].join(" "))) {
    if (/santa monica beach|venice beach|malibu|hollywood only|beverly hills/i.test(title)) return true;
  }
  if (canonical === "ensenada" && /bah[ií]a de los [aá]ngeles|bahia de los angeles|punta arenas/i.test(hay)) {
    return true;
  }
  if (canonical === "cozumel" && /playa del carmen|terminal maritima playa/i.test(title)) return true;
  if (canonical === "costa maya" && /ensenada|cozumel only|playa del carmen only/i.test(hay)) return true;
  return computeGeographicScore(candidate, port) <= 0;
}

function editorialRating(scores, port, candidate) {
  if (!scores || scores.rejected) return "NO_IMAGE";
  const title = String(candidate?.title || "").toLowerCase();
  if (hasWrongGeographyForPort(port, candidate) || scores.geographic < 40) return "WRONG";
  if (scores.vesselPrimary) return "POOR";
  if (/\b(lancaster|bomber|warship|submarine|destroyer|frigate|wwii|world war)\b/i.test(title)) return "POOR";
  if (/san pedro|port of los angeles|harbour|harbor|waterfront|port of|terminal|wharf|pier/i.test(title) && scores.geographic >= 55) {
    return scores.suitability >= 60 ? "GOOD" : "ACCEPTABLE";
  }
  const specificity = destinationSpecificityScores(candidate, port);
  if (specificity.titleHit && scores.geographic >= 70 && scores.suitability >= 65) return "GOOD";
  if (scores.geographic >= 55 && scores.suitability >= 50) return "ACCEPTABLE";
  return "POOR";
}

function auditStoredPortImage(port, media) {
  const candidate = candidateFromStored(port, media);
  const scores = scorePortImageCandidate(candidate, port);
  const editorial = editorialRating(scores, port, candidate);
  const age = classifyImageAge(candidate);
  const licensed = licenseIsUsable(candidate);
  const wouldAutoApproveToday =
    statusForCandidate({ ...scores, candidate }) === "AUTO_APPROVED" && editorial !== "WRONG" && editorial !== "POOR";
  const genericPenalty = genericImageryPenalty(candidate, port);
  const dated = isDatedForModernPreference(candidate);
  const canonicalKey = normalizePortKey(port?.canonical_name);
  const reasons = [];

  let action = "KEEP";

  if (!licensed) {
    action = "REPLACE";
    reasons.push("licensing_failure");
  } else if (isMilitaryWarDestinationImagery(candidate)) {
    action = "REPLACE";
    reasons.push("military_war_imagery");
  } else if (scores.vesselPrimary) {
    action = "REPLACE";
    reasons.push("vessel_primary");
  } else if (editorial === "WRONG" || hasWrongGeographyForPort(port, candidate)) {
    action = "REPLACE";
    reasons.push("wrong_geography_or_destination");
  } else if (editorial === "POOR") {
    action = "REPLACE";
    reasons.push("editorial_poor");
  } else if (genericPenalty >= 30 && scores.geographic < 60) {
    action = "REPLACE";
    reasons.push("generic_country_or_region_imagery");
  } else if (editorial === "GOOD") {
    if (dated && HISTORICAL_AUDIT_PORTS.has(canonicalKey)) {
      action = "KEEP";
      reasons.push("dated_historical_good");
    } else {
      action = "KEEP";
    }
  } else if (editorial === "ACCEPTABLE") {
    if (dated && HISTORICAL_AUDIT_PORTS.has(canonicalKey)) {
      action = "REVIEW";
      reasons.push("dated_historical_acceptable");
    } else if (dated) {
      action = "REVIEW";
      reasons.push("dated_image");
    } else if (genericPenalty > 0) {
      action = "REVIEW";
      reasons.push("weak_destination_specificity");
    } else {
      action = "KEEP";
    }
  } else if (!wouldAutoApproveToday) {
    action = "REPLACE";
    reasons.push("would_not_auto_approve_today");
  }

  if (action === "KEEP" && /industrial|factory|refinery|power station/i.test(String(candidate?.title || ""))) {
    action = "REVIEW";
    reasons.push("industrial_imagery");
  }

  return {
    port_id: port?.id,
    canonical_name: port?.canonical_name,
    display_name: port?.display_name,
    image_status: port?.image_status,
    hero_media_id: port?.hero_media_id,
    current_image: imageTitle(port, media),
    image_source: port?.image_source || null,
    image_source_url: port?.image_source_url || null,
    image_license: port?.image_license || null,
    image_credit: port?.image_credit || null,
    editorial,
    action,
    reasons,
    scores: {
      geographic: scores.geographic,
      suitability: scores.suitability,
      confidence: scores.confidence,
      vesselPrimary: scores.vesselPrimary
    },
    ageClass: age.ageClass,
    dated,
    licensed,
    wouldAutoApproveToday,
    genericPenalty
  };
}

function buildPublicAuditMetrics(audits, { needsReviewPorts = [], noImagePorts = [] } = {}) {
  const autoApproved = audits.filter((a) => String(a.image_status || "").toUpperCase() === "AUTO_APPROVED");
  const manual = audits.filter((a) => String(a.image_status || "").toUpperCase() === "MANUAL");

  const keep = autoApproved.filter((a) => a.action === "KEEP");
  const review = autoApproved.filter((a) => a.action === "REVIEW");
  const replace = autoApproved.filter((a) => a.action === "REPLACE");

  const wrongGeography = autoApproved.filter((a) => a.reasons.includes("wrong_geography_or_destination"));
  const editorialPoor = autoApproved.filter((a) => a.editorial === "POOR" || a.reasons.includes("would_not_auto_approve_today"));
  const licensingFailures = autoApproved.filter((a) => a.reasons.includes("licensing_failure"));
  const vesselPrimary = autoApproved.filter((a) => a.reasons.includes("vessel_primary"));
  const militaryWar = autoApproved.filter((a) => a.reasons.includes("military_war_imagery"));
  const genericFailures = autoApproved.filter((a) => a.reasons.includes("generic_country_or_region_imagery"));
  const historical = autoApproved.filter((a) => a.dated || a.ageClass === "HISTORICAL");

  const formulas = {
    autoApprovedAudited: "audit rows where image_status === AUTO_APPROVED",
    manualAudited: "audit rows where image_status === MANUAL",
    keepReviewReplace: "KEEP + REVIEW + REPLACE === autoApprovedAudited",
    publicAutoApprovalQuality: "KEEP / autoApprovedAudited",
    publicGeographicAccuracy: "(autoApprovedAudited - wrongGeography) / autoApprovedAudited",
    publicLicensingAccuracy: "(autoApprovedAudited - licensingFailures) / autoApprovedAudited"
  };

  const reconciled =
    keep.length + review.length + replace.length === autoApproved.length &&
    autoApproved.length + manual.length === audits.length;

  return {
    autoApprovedAudited: autoApproved.length,
    manualAudited: manual.length,
    keep: keep.length,
    review: review.length,
    replace: replace.length,
    wrongGeography: wrongGeography.length,
    editorialPoor: editorialPoor.length,
    licensingFailures: licensingFailures.length,
    vesselPrimary: vesselPrimary.length,
    militaryWar: militaryWar.length,
    genericFailures: genericFailures.length,
    historical: historical.length,
    needsReviewCount: needsReviewPorts.length,
    noImageCount: noImagePorts.length,
    currentPublicAutoApprovalQuality: autoApproved.length ? percent(keep.length, autoApproved.length) : null,
    currentPublicGeographicAccuracy: autoApproved.length
      ? percent(autoApproved.length - wrongGeography.length, autoApproved.length)
      : null,
    currentPublicLicensingAccuracy: autoApproved.length
      ? percent(autoApproved.length - licensingFailures.length, autoApproved.length)
      : null,
    formulas,
    reconciled,
    exceptions: {
      review: review.map(summariseAuditRow),
      replace: replace.map(summariseAuditRow)
    },
    manual: manual.map(summariseAuditRow)
  };
}

function percent(part, total) {
  if (!total) return null;
  return Math.round((part / total) * 1000) / 10;
}

function summariseAuditRow(row) {
  return {
    port: row.canonical_name,
    current_image: row.current_image,
    status: row.image_status,
    editorial: row.editorial,
    action: row.action,
    reasons: row.reasons
  };
}

module.exports = {
  HISTORICAL_AUDIT_PORTS,
  candidateFromStored,
  imageTitle,
  editorialRating,
  hasWrongGeographyForPort,
  auditStoredPortImage,
  buildPublicAuditMetrics,
  summariseAuditRow
};
