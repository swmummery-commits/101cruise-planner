/**
 * Verified static image fallbacks for Living Destination pages when
 * Media Library IDs are not yet linked on destinations / destination_ports.
 *
 * Prefer media_library in production; these are approved Netlify-hosted
 * (and Wikimedia) assets only — never invented or AI-generated.
 */

const CF_IMAGES =
  "https://admirable-tiramisu-d4da8a.netlify.app/public-tools/cruise-finder/images";

const DESTINATION_HEROES = {
  alaska: {
    url: `${CF_IMAGES}/alaska-hero.png`,
    objectPosition: "center 40%",
    alt: "Alaska cruise landscape"
  },
  japan: {
    url: `${CF_IMAGES}/japan-hero.png`,
    objectPosition: "center center",
    alt: "Japan cruise landscape"
  },
  mediterranean: {
    url: `${CF_IMAGES}/mediterranean-hero.png`,
    objectPosition: "center 40%",
    alt: "Mediterranean cruise landscape"
  },
  "greek-islands": {
    url: `${CF_IMAGES}/greek-islands-hero.png`,
    objectPosition: "center 35%",
    alt: "Greek Islands cruise landscape"
  },
  caribbean: {
    url: `${CF_IMAGES}/caribbean-hero.png`,
    objectPosition: "center 40%",
    alt: "Caribbean cruise landscape"
  },
  "british-isles": {
    url: `${CF_IMAGES}/british-isles-hero.png`,
    objectPosition: "center 40%",
    alt: "British Isles cruise landscape"
  },
  hawaii: {
    url: `${CF_IMAGES}/hawaii-hero.png`,
    objectPosition: "center 40%",
    alt: "Hawaii cruise landscape"
  },
  "australia-new-zealand": {
    url: `${CF_IMAGES}/australia-new-zealand-hero.png`,
    objectPosition: "center 40%",
    alt: "Australia and New Zealand cruise landscape"
  }
};

/** @deprecated Port static fallbacks removed — only Media Library port assets are shown. */
const PORT_IMAGES = {};

function cleanSlug(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function destinationHeroFallback(slug, name) {
  const key = cleanSlug(slug);
  const hit = DESTINATION_HEROES[key];
  if (!hit) return null;
  return {
    url: hit.url,
    alt: hit.alt || `${name || key} cruise destination`,
    objectPosition: hit.objectPosition || "center center",
    source: "static_fallback"
  };
}

function portImageFallback(_destinationSlug, _portSlug, _portName) {
  return null;
}

/**
 * Fill missing hero media on a living destination DTO.
 * Port images are never synthesised from destination heroes or shared crops.
 */
function applyDestinationImageFallbacks(page) {
  if (!page || typeof page !== "object") return page;
  const slug = cleanSlug(page.slug);

  if (!page.hero?.url) {
    const hero = destinationHeroFallback(slug, page.name);
    if (hero) page.hero = hero;
  }

  return page;
}

module.exports = {
  destinationHeroFallback,
  portImageFallback,
  applyDestinationImageFallbacks,
  DESTINATION_HEROES,
  PORT_IMAGES
};
