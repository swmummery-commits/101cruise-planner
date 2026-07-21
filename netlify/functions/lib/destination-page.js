/**
 * Sprint 11C — map destinations + published research + media into the
 * public Destination Experience page DTO (presentation-ready).
 */

const { normaliseContentJson, asGoodToKnowArray, asSuitabilityLevel } = require("./research-schemas");

const SUITABILITY_PAGE_KEYS = [
  ["couples", "suitability_couples"],
  ["families", "suitability_families"],
  ["luxury", "suitability_luxury"],
  ["adventure", "suitability_adventure"],
  ["food_wine", "suitability_food_wine"],
  ["first_cruise", "suitability_first_cruise"]
];

function cleanSlug(raw) {
  return String(raw || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function mediaDto(row, fallbackAlt = "") {
  if (!row?.public_url) return null;
  return {
    id: row.id || null,
    url: row.public_url,
    alt: row.alt_text || row.title || fallbackAlt || "",
    title: row.title || fallbackAlt || "",
    width: row.width == null ? null : row.width,
    height: row.height == null ? null : row.height,
    objectPosition: "center center",
    source: "media_library"
  };
}

function buildSnapshot(content) {
  const rows = [
    { label: "Best Time", value: content.best_time_to_visit },
    { label: "Cruise Length", value: content.cruise_length },
    { label: "Climate", value: content.climate_summary },
    { label: "Currency", value: content.currency },
    { label: "Language", value: content.languages },
    { label: "Best Departure Ports", value: content.departure_ports }
  ];
  return rows
    .map((row) => ({
      label: row.label,
      value: String(row.value || "").trim()
    }))
    .filter((row) => row.value);
}

function buildGoodToKnow(content) {
  const fromResearch = asGoodToKnowArray(content.good_to_know);
  if (fromResearch.length) return fromResearch;

  const derived = [
    { label: "Currency", value: content.currency },
    { label: "Voltage", value: content.voltage },
    { label: "Language", value: content.languages },
    { label: "Tipping", value: content.tipping_ashore },
    { label: "Climate", value: content.climate_summary },
    { label: "Walking Level", value: content.walking_level }
  ];
  return derived
    .map((row) => ({
      label: row.label,
      value: String(row.value || "").trim()
    }))
    .filter((row) => row.value);
}

function buildSuitability(content, rawContent = null) {
  const raw = rawContent && typeof rawContent === "object" ? rawContent : {};
  const out = {};
  let hasExplicit = false;
  for (const [pageKey, researchKey] of SUITABILITY_PAGE_KEYS) {
    const rawValue = raw[researchKey];
    if (rawValue != null && String(rawValue).trim() !== "") {
      out[pageKey] = asSuitabilityLevel(rawValue, "good");
      hasExplicit = true;
    } else if (content[researchKey]) {
      out[pageKey] = asSuitabilityLevel(content[researchKey], "good");
    }
  }
  const summary = String(content.suitability_summary || raw.suitability_summary || "").trim();
  if (summary) out.summary = summary;
  // Only show section when research explicitly provided suitability data
  if (!hasExplicit && !summary) return null;
  // Fill missing bars with good when at least one dimension/summary exists
  for (const [pageKey] of SUITABILITY_PAGE_KEYS) {
    if (!out[pageKey]) out[pageKey] = "good";
  }
  return out;
}

function buildFaqs(content) {
  const faqs = Array.isArray(content.frequently_asked_questions)
    ? content.frequently_asked_questions
    : [];
  return faqs
    .map((faq) => ({
      q: String(faq.question || "").trim(),
      a: String(faq.answer || "").trim()
    }))
    .filter((faq) => faq.q && faq.a)
    .slice(0, 8);
}

function buildCruiseLines(content) {
  const lines = Array.isArray(content.cruise_lines_visiting) ? content.cruise_lines_visiting : [];
  return lines
    .map((line) => {
      if (typeof line === "string") return { name: line.trim() };
      return {
        name: String(line?.name || "").trim(),
        slug: line?.slug ? cleanSlug(line.slug) : null,
        id: line?.id || null
      };
    })
    .filter((line) => line.name);
}

function buildPorts(portRows, mediaById) {
  return (portRows || [])
    .filter((port) => port && port.active !== false)
    .sort((a, b) => (Number(a.display_order) || 0) - (Number(b.display_order) || 0))
    .map((port) => {
      const media = mediaDto(mediaById.get(port.hero_media_id), port.name);
      return {
        id: port.id,
        name: port.name,
        slug: cleanSlug(port.slug || port.name),
        description: String(port.short_description || "").trim(),
        mediaId: port.hero_media_id || null,
        mediaKey: port.slug ? `port:${cleanSlug(port.slug)}` : null,
        guideHref: null,
        media: media
          ? {
              url: media.url,
              alt: media.alt,
              objectPosition: media.objectPosition
            }
          : null
      };
    });
}

/**
 * Assemble the public page DTO consumed by js/public-destination.js
 */
function buildDestinationPageDto({
  destination,
  research,
  heroMedia,
  ports,
  portMediaById
}) {
  const rawContent = research?.content_json && typeof research.content_json === "object"
    ? research.content_json
    : {};
  const content = normaliseContentJson("destination", rawContent);
  const name = destination.name || research?.entity_name || "Destination";
  const slug = cleanSlug(destination.slug || research?.canonical_slug || name);
  const summary =
    String(research?.summary_text || "").trim() ||
    String(content.overview || "").trim().slice(0, 320);
  const whyCruiseHere = String(content.why_visit || content.overview || "").trim();
  const hero = mediaDto(heroMedia, `${name} cruise destination`);
  const suitability = buildSuitability(content, rawContent);
  const snapshot = buildSnapshot(content);
  const goodToKnow = buildGoodToKnow(content);
  const faqs = buildFaqs(content);
  const cruiseLines = buildCruiseLines(content);
  const featuredPorts = buildPorts(ports, portMediaById || new Map());

  return {
    id: destination.id,
    slug,
    name,
    status: destination.status,
    primaryRegion: destination.primary_region || null,
    displayOrder: destination.display_order ?? null,
    researchId: research?.id || destination.research_content_id || null,
    seoTitle: destination.seo_title || research?.seo_title || `${name} Cruises | 101cruise`,
    metaDescription:
      destination.meta_description ||
      research?.meta_description ||
      summary.slice(0, 160) ||
      `Explore ${name} cruises with 101cruise.`,
    summary,
    hero: hero || {
      url: "",
      alt: `${name} cruise destination`,
      objectPosition: "center center",
      source: "placeholder"
    },
    whyCruiseHere,
    snapshot,
    suitability,
    ports: featuredPorts,
    cruiseLines,
    goodToKnow,
    faqs,
    // Cruises remain placeholder client-side until Discovery Engine
    cruiseCatalog: null,
    source: "living_destination",
    publishedAt: research?.published_at || null,
    sections: {
      why: Boolean(whyCruiseHere),
      snapshot: snapshot.length > 0,
      suitability: Boolean(suitability),
      ports: featuredPorts.length > 0,
      cruiseLines: cruiseLines.length > 0,
      goodToKnow: goodToKnow.length > 0,
      faqs: faqs.length > 0
    }
  };
}

module.exports = {
  cleanSlug,
  mediaDto,
  buildDestinationPageDto,
  buildSnapshot,
  buildGoodToKnow,
  buildSuitability,
  buildFaqs,
  buildCruiseLines,
  buildPorts
};
