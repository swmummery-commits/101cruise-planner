/**
 * Server-side Featured Cruise image resolution (CommonJS).
 * Keep in sync with js/media-resolver.js for browser/Admin.
 */

function asMediaObject(partial = {}, source = "unknown") {
  const url = String(partial.url || partial.public_url || "").trim();
  if (!url) return null;
  return {
    id: partial.id || null,
    url,
    title: String(partial.title || "").trim(),
    altText: String(partial.altText || partial.alt_text || partial.title || "").trim(),
    source,
    width: partial.width == null ? null : Number(partial.width),
    height: partial.height == null ? null : Number(partial.height)
  };
}

function findShipDefault(mediaList, shipId) {
  if (!shipId || !Array.isArray(mediaList)) return null;
  return (
    mediaList.find(
      (m) =>
        m.is_active !== false &&
        m.media_type === "ship" &&
        m.ship_id === shipId &&
        m.is_default
    ) ||
    mediaList.find(
      (m) => m.is_active !== false && m.media_type === "ship" && m.ship_id === shipId
    ) ||
    null
  );
}

function findDestinationDefault(mediaList, destinationNames = []) {
  if (!Array.isArray(mediaList) || !destinationNames.length) return null;
  const names = destinationNames
    .map((n) => String(n || "").trim().toLowerCase())
    .filter(Boolean);
  if (!names.length) return null;
  const defaults = mediaList.filter(
    (m) => m.is_active !== false && m.media_type === "destination" && m.is_default
  );
  for (const name of names) {
    const hit = defaults.find(
      (m) => String(m.destination_name || "").trim().toLowerCase() === name
    );
    if (hit) return hit;
  }
  for (const name of names) {
    const hit = mediaList.find(
      (m) =>
        m.is_active !== false &&
        m.media_type === "destination" &&
        String(m.destination_name || "").trim().toLowerCase() === name
    );
    if (hit) return hit;
  }
  return null;
}

function destinationCandidatesFromCruise(cruise = {}) {
  const ports = String(cruise.itinerary_summary || "")
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean);
  return [cruise.destination_name, cruise.departure_port, cruise.arrival_port, ...ports].filter(
    Boolean
  );
}

function resolveAltText(cruise = {}, media = null, fallbackTitle = "") {
  const override = String(cruise.hero_image_alt || "").trim();
  if (override) return override;
  const mediaAlt = String(media?.alt_text || media?.altText || "").trim();
  if (mediaAlt) return mediaAlt;
  const mediaTitle = String(media?.title || "").trim();
  if (mediaTitle) return mediaTitle;
  return String(fallbackTitle || cruise.headline || "Cruise image").trim();
}

function resolveHeroImage(cruise = {}, context = {}) {
  const mediaLibrary = context.mediaLibrary || [];
  const heroMedia = context.heroMedia || cruise.hero_media || null;

  if (cruise.hero_media_id) {
    const selected =
      heroMedia || mediaLibrary.find((m) => m.id === cruise.hero_media_id) || null;
    if (selected && selected.is_active !== false) {
      const resolved = asMediaObject(selected, "Featured Cruise Media Library selection");
      if (resolved) {
        resolved.altText = resolveAltText(cruise, selected, resolved.title);
        return resolved;
      }
    }
  }

  const legacyUrl = String(cruise.hero_image_url || "").trim();
  if (legacyUrl) {
    return asMediaObject(
      {
        url: legacyUrl,
        alt_text: resolveAltText(cruise, null, cruise.headline),
        title: cruise.headline || "Cruise image"
      },
      "Legacy Featured Cruise image URL"
    );
  }

  const shipId = cruise.cruise_ship_id || cruise.ship_id || context.ship?.id;
  const shipDefault = findShipDefault(mediaLibrary, shipId);
  if (shipDefault) {
    const shipName = context.ship?.name || shipDefault.ci_cruise_ships?.name || "ship";
    const resolved = asMediaObject(shipDefault, `Default image for ${shipName}`);
    if (resolved) {
      resolved.altText = resolveAltText(cruise, shipDefault, shipName);
      return resolved;
    }
  }

  const destDefault = findDestinationDefault(
    mediaLibrary,
    destinationCandidatesFromCruise(cruise)
  );
  if (destDefault) {
    const resolved = asMediaObject(
      destDefault,
      `Destination default — ${destDefault.destination_name}`
    );
    if (resolved) {
      resolved.altText = resolveAltText(cruise, destDefault, destDefault.destination_name);
      return resolved;
    }
  }

  const ciHero = String(context.ship?.hero_image_url || cruise.ci_ship_hero_url || "").trim();
  if (ciHero) {
    return asMediaObject(
      {
        url: ciHero,
        alt_text: resolveAltText(cruise, null, context.ship?.name || cruise.headline),
        title: context.ship?.name || "Ship image"
      },
      "Legacy Cruise Intelligence image"
    );
  }

  return null;
}

function resolveRouteMapImage(cruise = {}, context = {}) {
  const mediaLibrary = context.mediaLibrary || [];
  const routeMapMedia = context.routeMapMedia || cruise.route_map_media || null;
  if (cruise.route_map_media_id && routeMapMedia) {
    return asMediaObject(routeMapMedia, "Featured Cruise Media Library selection");
  }
  if (cruise.route_map_media_id) {
    const fromList = mediaLibrary.find((m) => m.id === cruise.route_map_media_id);
    if (fromList) return asMediaObject(fromList, "Featured Cruise Media Library selection");
  }
  const legacyUrl = String(cruise.route_map_image_url || "").trim();
  if (legacyUrl) {
    return asMediaObject(
      { url: legacyUrl, alt_text: "Route map", title: "Route map" },
      "Legacy route map URL"
    );
  }
  return null;
}

function resolveCruiseImages(cruise = {}, context = {}) {
  return {
    hero: resolveHeroImage(cruise, context),
    routeMap: resolveRouteMapImage(cruise, context)
  };
}

module.exports = {
  asMediaObject,
  findShipDefault,
  findDestinationDefault,
  resolveAltText,
  resolveHeroImage,
  resolveRouteMapImage,
  resolveCruiseImages,
  destinationCandidatesFromCruise
};
