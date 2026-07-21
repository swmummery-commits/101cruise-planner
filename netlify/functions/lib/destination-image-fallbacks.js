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

/** Port images keyed as `${destinationSlug}:${portSlug}` */
const PORT_IMAGES = {
  // Until Media Library assets are linked, use the approved Alaska hero with
  // distinct crops so each card shows a photograph (not an empty placeholder).
  "alaska:juneau": {
    url: `${CF_IMAGES}/alaska-hero.png`,
    objectPosition: "18% 42%",
    alt: "Juneau, Alaska"
  },
  "alaska:skagway": {
    url: `${CF_IMAGES}/alaska-hero.png`,
    objectPosition: "48% 28%",
    alt: "Skagway, Alaska"
  },
  "alaska:ketchikan": {
    url: `${CF_IMAGES}/alaska-hero.png`,
    objectPosition: "72% 48%",
    alt: "Ketchikan, Alaska"
  },
  "alaska:sitka": {
    url: `${CF_IMAGES}/alaska-hero.png`,
    objectPosition: "35% 55%",
    alt: "Sitka, Alaska"
  },
  "alaska:icy-strait-point": {
    url: `${CF_IMAGES}/alaska-hero.png`,
    objectPosition: "60% 35%",
    alt: "Icy Strait Point, Alaska"
  }
};

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

function portImageFallback(destinationSlug, portSlug, portName) {
  const key = `${cleanSlug(destinationSlug)}:${cleanSlug(portSlug)}`;
  const hit = PORT_IMAGES[key];
  if (hit) {
    return {
      url: hit.url,
      alt: hit.alt || portName || portSlug,
      objectPosition: hit.objectPosition || "center center",
      source: "static_fallback"
    };
  }
  // Last resort: destination hero crop for known destinations
  const hero = DESTINATION_HEROES[cleanSlug(destinationSlug)];
  if (!hero) return null;
  return {
    url: hero.url,
    alt: portName || portSlug || "Port",
    objectPosition: "center 35%",
    source: "static_fallback"
  };
}

/**
 * Fill missing hero / port media on a living destination DTO.
 */
function applyDestinationImageFallbacks(page) {
  if (!page || typeof page !== "object") return page;
  const slug = cleanSlug(page.slug);

  if (!page.hero?.url) {
    const hero = destinationHeroFallback(slug, page.name);
    if (hero) page.hero = hero;
  }

  if (Array.isArray(page.ports)) {
    page.ports = page.ports.map((port) => {
      if (port?.media?.url) return port;
      const media = portImageFallback(slug, port.slug || port.name, port.name);
      if (!media) return port;
      return { ...port, media };
    });
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
