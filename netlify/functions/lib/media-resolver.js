/**
 * Server-side Featured Cruise image resolution (CommonJS).
 * Keep in sync with js/media-resolver.js for browser/Admin.
 */

/** Supabase often serves SVG as attachment — never use SVG URLs in previews/emails. */
function isSvgAssetUrl(url) {
  const path = String(url || "")
    .trim()
    .toLowerCase()
    .split("?")[0]
    .split("#")[0];
  return path.endsWith(".svg");
}

function coerceRouteMapDisplayUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (!isSvgAssetUrl(raw)) return raw;
  const coerced = raw.replace(/route-map\.svg(?=(\?|#|$))/i, "route-map.png");
  if (coerced !== raw && !isSvgAssetUrl(coerced)) return coerced;
  return "";
}

function asMediaObject(partial = {}, source = "unknown") {
  let url = String(partial.url || partial.public_url || "").trim();
  if (!url) return null;
  if (source.toLowerCase().includes("route") || partial.media_type === "route_map") {
    url = coerceRouteMapDisplayUrl(url);
    if (!url) return null;
  } else if (isSvgAssetUrl(url) && /route-map/i.test(url)) {
    url = coerceRouteMapDisplayUrl(url);
    if (!url) return null;
  }
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
    // Prefer explicit Featured Cruise selection even if marked inactive.
    if (selected) {
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
      cruise.hero_media_id
        ? "Featured Cruise Media Library selection"
        : "Legacy Featured Cruise image URL"
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

function isLegacyLocalRouteMapPath(value) {
  const p = String(value || "");
  return p.startsWith("generated-assets/") || p.startsWith("/generated-assets/");
}

function generatedRouteMapPublicUrl(cruise = {}, context = {}) {
  if (context.generatedRouteMapUrl) return String(context.generatedRouteMapUrl).trim();

  const pngPath = String(cruise.route_map_png_path || "").trim();
  const svgPath = String(cruise.route_map_svg_path || "").trim();
  if (!pngPath || !svgPath) return "";
  if (isLegacyLocalRouteMapPath(pngPath) || isLegacyLocalRouteMapPath(svgPath)) return "";
  if (/^https?:\/\//i.test(pngPath)) return pngPath;

  const supabaseUrl = String(context.supabaseUrl || process.env.SUPABASE_URL || "")
    .trim()
    .replace(/\/$/, "");
  if (!supabaseUrl) return "";

  const encoded = pngPath
    .replace(/^\//, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  let url = `${supabaseUrl}/storage/v1/object/public/featured-cruise-route-maps/${encoded}`;
  const bust = Date.parse(cruise.route_map_generated_at || "") || null;
  if (bust) url += `?t=${encodeURIComponent(String(bust))}`;
  return url;
}

function resolveRouteMapImage(cruise = {}, context = {}) {
  const mediaLibrary = context.mediaLibrary || [];
  const routeMapMedia = context.routeMapMedia || cruise.route_map_media || null;
  if (cruise.route_map_media_id && routeMapMedia) {
    const fromMedia = asMediaObject(
      { ...routeMapMedia, media_type: "route_map" },
      "Featured Cruise Media Library selection"
    );
    if (fromMedia) return fromMedia;
  }
  if (cruise.route_map_media_id) {
    const fromList = mediaLibrary.find((m) => m.id === cruise.route_map_media_id);
    if (fromList) {
      const fromMedia = asMediaObject(
        { ...fromList, media_type: "route_map" },
        "Featured Cruise Media Library selection"
      );
      if (fromMedia) return fromMedia;
    }
  }
  const legacyUrl = coerceRouteMapDisplayUrl(cruise.route_map_image_url);
  if (legacyUrl) {
    return asMediaObject(
      { url: legacyUrl, alt_text: "Route map", title: "Route map", media_type: "route_map" },
      "Legacy route map URL"
    );
  }
  const generatedUrl = coerceRouteMapDisplayUrl(generatedRouteMapPublicUrl(cruise, context));
  if (generatedUrl) {
    return asMediaObject(
      {
        url: generatedUrl,
        alt_text: "Route map",
        title: "Route map",
        width: cruise.route_map_width,
        height: cruise.route_map_height,
        media_type: "route_map"
      },
      "Generated route map"
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
  isSvgAssetUrl,
  coerceRouteMapDisplayUrl,
  findShipDefault,
  findDestinationDefault,
  resolveAltText,
  resolveHeroImage,
  resolveRouteMapImage,
  resolveCruiseImages,
  destinationCandidatesFromCruise
};
