/**
 * Entity key normalisation and trusted-source heuristics for research content.
 */

function normaliseEntityKey(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^(the|port of|port)\s+/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normaliseAlias(value) {
  return normaliseEntityKey(value);
}

function domainFromUrl(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

const LOW_QUALITY_HOST_PARTS = [
  "pinterest.",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "reddit.com",
  "quora.com",
  "medium.com",
  "blogspot.",
  "wordpress.com",
  "tumblr.com",
  "youtube.com",
  "youtu.be"
];

const TRUSTED_HOST_HINTS = [
  ".gov",
  ".gov.au",
  ".gov.uk",
  "tourism",
  "visit",
  "port",
  "harbour",
  "harbor",
  "cruise",
  "official"
];

const REPUTABLE_TRAVEL = [
  "lonelyplanet.com",
  "roughguides.com",
  "nationalgeographic.com",
  "bbc.com",
  "telegraph.co.uk",
  "smh.com.au",
  "theguardian.com",
  "cruisecritic.com",
  "cruisehive.com",
  "seatrade-cruise.com"
];

function isLowQualityDomain(domain) {
  const d = String(domain || "").toLowerCase();
  return LOW_QUALITY_HOST_PARTS.some((part) => d.includes(part));
}

function scoreSource(result, { officialDomains = [], entityType } = {}) {
  const domain = result.domain || domainFromUrl(result.url);
  if (!domain || isLowQualityDomain(domain)) return -100;

  let score = 10;
  const official = (officialDomains || []).map((d) => String(d).toLowerCase().replace(/^www\./, ""));
  if (official.some((d) => domain === d || domain.endsWith(`.${d}`))) score += 80;

  if (REPUTABLE_TRAVEL.some((d) => domain === d || domain.endsWith(`.${d}`))) score += 35;

  if (TRUSTED_HOST_HINTS.some((h) => domain.includes(h))) score += 15;

  if (entityType === "destination" || entityType === "port") {
    if (domain.includes("tourism") || domain.includes("visit") || domain.endsWith(".gov") || domain.includes(".gov.")) {
      score += 25;
    }
  }

  const title = String(result.title || "").toLowerCase();
  if (title.includes("official")) score += 8;
  return score;
}

function classifySourceType(domain, score) {
  const d = String(domain || "").toLowerCase();
  if (d.includes(".gov") || d.endsWith(".gov.au")) return "government";
  if (d.includes("port") || d.includes("harbour") || d.includes("harbor")) return "port_authority";
  if (d.includes("tourism") || d.includes("visit")) return "tourism_board";
  if (score >= 80) return "official_operator";
  if (REPUTABLE_TRAVEL.some((x) => d === x || d.endsWith(`.${x}`))) return "reputable_publication";
  return "other";
}

function buildSearchQueries({ entityType, entityName, officialDomain }) {
  const name = String(entityName || "").trim();
  const site = officialDomain ? `site:${officialDomain.replace(/^www\./, "")}` : "";
  const queries = [];

  if (entityType === "ship") {
    queries.push(`"${name}" official ship information`);
    queries.push(`"${name}" dining entertainment accessibility`);
    if (site) queries.push(`${site} "${name}"`);
    queries.push(`"${name}" cruise ship overview`);
  } else if (entityType === "cruise_line") {
    queries.push(`"${name}" official what is included`);
    queries.push(`"${name}" dress code wifi gratuities drinks`);
    if (site) queries.push(`${site} inclusions`);
    queries.push(`"${name}" cruise line brand overview`);
  } else if (entityType === "destination") {
    queries.push(`"${name}" official tourism`);
    queries.push(`"${name}" best time weather currency transport`);
    queries.push(`"${name}" tourism board`);
    queries.push(`visit "${name}" travel guide`);
  } else if (entityType === "port") {
    queries.push(`"${name}" cruise port authority`);
    queries.push(`"${name}" cruise terminal transport accessibility`);
    queries.push(`"${name}" official tourism`);
    queries.push(`"${name}" cruise port tender`);
  }

  return [...new Set(queries.map((q) => q.trim()).filter(Boolean))].slice(0, 4);
}

module.exports = {
  normaliseEntityKey,
  normaliseAlias,
  domainFromUrl,
  isLowQualityDomain,
  scoreSource,
  classifySourceType,
  buildSearchQueries
};
