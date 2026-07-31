/**
 * Public-safe research content enrichment helpers (Netlify function-local).
 */

const { toPublicResearchTeaser, normaliseContentJson } = require("./research-schemas");
const { normaliseEntityKey } = require("./research-normalize");
const { loadStructuredItinerary, annotateItineraryStop } = require("./marine-route-itinerary");

const MONTH_NAME_TO_NUM = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12
};

const PORT_REGION_HINTS = {
  barcelona: "Mediterranean",
  istanbul: "Mediterranean",
  athens: "Mediterranean",
  piraeus: "Mediterranean",
  rome: "Mediterranean",
  venice: "Mediterranean",
  dubrovnik: "Mediterranean",
  santorini: "Mediterranean",
  mykonos: "Mediterranean",
  palermo: "Mediterranean",
  lisbon: "Mediterranean",
  singapore: "Southeast Asia",
  bali: "Southeast Asia",
  sydney: "Australia",
  auckland: "New Zealand"
};

function facilityValue(facilities, keys) {
  if (!facilities || typeof facilities !== "object") return null;
  for (const key of keys) {
    if (facilities[key] != null && String(facilities[key]).trim() !== "") {
      return facilities[key];
    }
  }
  return null;
}

function boolFacility(facilities, keys) {
  const value = facilityValue(facilities, keys);
  if (value == null) return null;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (!text) return null;
  if (["yes", "true", "1", "included", "available"].includes(text)) return true;
  if (["no", "false", "0", "none", "not available"].includes(text)) return false;
  return value;
}

const { exclusiveAreasAsLabels } = require("../../../js/ci-ship-facilities.js");

function shipFactsFromRow(ship) {
  if (!ship) return null;
  const facilities = ship.facilities && typeof ship.facilities === "object" ? ship.facilities : {};
  const facts = {
    built: ship.year_built ?? null,
    refurbished: ship.year_refurbished ?? null,
    guests: ship.passenger_capacity ?? null,
    crew: ship.crew_count ?? null,
    decks: ship.deck_count ?? null,
    staterooms: ship.stateroom_count ?? null,
    length_metres: ship.length_metres ?? null,
    gross_tonnage: ship.gross_tonnage ?? null,
    restaurants: facilityValue(facilities, ["restaurants", "restaurant_count"]),
    bars: facilityValue(facilities, ["bars", "bar_count"]),
    pools: facilityValue(facilities, ["pools", "pool_count"]),
    hot_tubs: facilityValue(facilities, ["hot_tubs", "jacuzzis", "whirlpools"]),
    spa: boolFacility(facilities, ["spa", "has_spa"]),
    gym: boolFacility(facilities, ["gym", "fitness", "fitness_centre", "has_gym"]),
    theatre: boolFacility(facilities, ["theatre", "show_lounge", "has_theatre"]),
    casino: boolFacility(facilities, ["casino", "has_casino"]),
    kids_club: boolFacility(facilities, ["kids_club", "kids", "childrens_club", "has_kids_club"]),
    speciality_features: Array.isArray(facilities.speciality_features)
      ? facilities.speciality_features.filter(Boolean)
      : Array.isArray(facilities.specialty_features)
        ? facilities.specialty_features.filter(Boolean)
        : null,
    exclusive_areas: Array.isArray(facilities.exclusive_areas)
      ? exclusiveAreasAsLabels(facilities.exclusive_areas)
      : null
  };
  const hasAny = Object.entries(facts).some(([key, value]) => {
    if (key === "speciality_features" || key === "exclusive_areas") {
      return Array.isArray(value) && value.length > 0;
    }
    return value != null && value !== "";
  });
  return hasAny ? facts : null;
}

function pickText(value, maxLen) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    const items = value.map((row) => String(row || "").trim()).filter(Boolean);
    return items.length ? items : null;
  }
  const text = String(value).trim();
  if (!text) return null;
  return maxLen ? text.slice(0, maxLen) : text;
}

function toPublicShipResearchFull(row) {
  if (!row || row.content_status !== "published") return null;
  const content = normaliseContentJson("ship", row.content_json || {});
  const bestFor = pickText(content.best_for);
  const notIdeal = pickText(content.not_ideal_for);
  const highlights = pickText(content.key_highlights);

  return {
    entity_name: row.entity_name,
    summary_text: row.summary_text || "",
    overview: pickText(content.overview, 1200),
    personality: pickText(content.personality, 400),
    best_for: Array.isArray(bestFor) ? bestFor : null,
    not_ideal_for: Array.isArray(notIdeal) ? notIdeal : null,
    dining_summary: pickText(content.dining_summary, 800),
    entertainment_summary: pickText(content.entertainment_summary, 800),
    wellness_summary: pickText(content.wellness_summary, 800),
    family_summary: pickText(content.family_summary, 800),
    accommodation_summary: pickText(content.accommodation_summary, 800),
    key_highlights: Array.isArray(highlights) ? highlights.slice(0, 8) : null,
    pauls_tip: row.pauls_tip ? String(row.pauls_tip).trim().slice(0, 500) : "",
    media_id: row.media_id || null,
    image: null
  };
}

function toPublicDestinationResearchFull(row) {
  if (!row || row.content_status !== "published") return null;
  const content = normaliseContentJson("destination", row.content_json || {});
  const idealFor = pickText(content.ideal_for) || pickText(content.best_for);
  const highlights = pickText(content.key_highlights);
  const whyVisit = pickText(content.why_visit);
  const goodToKnow = Array.isArray(content.good_to_know)
    ? content.good_to_know
        .map((row) => ({
          label: String(row?.label || "").trim(),
          value: String(row?.value || "").trim()
        }))
        .filter((row) => row.label && row.value)
        .slice(0, 8)
    : null;

  return {
    entity_name: row.entity_name,
    entity_key: row.entity_key || null,
    summary_text: row.summary_text || "",
    overview: pickText(content.overview, 800),
    tagline: pickText(content.overview, 180),
    why_visit: Array.isArray(whyVisit) ? whyVisit.slice(0, 6) : null,
    ideal_for: Array.isArray(idealFor) ? idealFor.slice(0, 6) : null,
    best_time_to_visit: pickText(content.best_time_to_visit, 400),
    climate_summary: pickText(content.climate_summary, 400),
    key_highlights: Array.isArray(highlights) ? highlights.slice(0, 6) : null,
    signature_experiences: pickText(content.signature_experiences),
    good_to_know: goodToKnow && goodToKnow.length ? goodToKnow : null,
    pauls_tip: row.pauls_tip ? String(row.pauls_tip).trim().slice(0, 500) : "",
    media_id: row.media_id || null,
    image: null
  };
}

function extractMonthsFromText(text) {
  const raw = String(text || "").toLowerCase();
  if (!raw) return [];
  const found = new Set();
  for (const [name, num] of Object.entries(MONTH_NAME_TO_NUM)) {
    if (raw.includes(name)) found.add(num);
  }
  return Array.from(found).sort((a, b) => a - b);
}

function inferDestinationKeys(cruiseRow, itineraryStops) {
  const keys = [];
  const push = (value) => {
    const key = normaliseEntityKey(String(value || "").trim());
    if (key && !keys.includes(key)) keys.push(key);
  };

  push(cruiseRow.destination_strip);
  push(cruiseRow.headline);
  push(cruiseRow.departure_port);
  push(cruiseRow.arrival_port);

  for (const stop of itineraryStops || []) {
    if (stop.is_sea_day) continue;
    push(stop.name);
    const hint = PORT_REGION_HINTS[normaliseEntityKey(stop.name)];
    if (hint) push(hint);
  }

  const depHint = PORT_REGION_HINTS[normaliseEntityKey(cruiseRow.departure_port)];
  const arrHint = PORT_REGION_HINTS[normaliseEntityKey(cruiseRow.arrival_port)];
  if (depHint) push(depHint);
  if (arrHint) push(arrHint);

  return keys;
}

async function loadPublishedByEntityId(supabaseGet, entityType, entityId) {
  if (!entityId) return null;
  try {
    const rows = await supabaseGet(
      `research_content?entity_type=eq.${encodeURIComponent(entityType)}` +
        `&entity_id=eq.${encodeURIComponent(entityId)}` +
        `&content_status=eq.published` +
        `&select=id,entity_type,entity_id,entity_key,entity_name,content_json,summary_text,seo_title,meta_description,canonical_slug,pauls_tip,media_id,published_at,refresh_after,content_status` +
        `&limit=1`
    );
    return Array.isArray(rows) ? rows[0] || null : null;
  } catch (error) {
    console.warn("research published by id skipped", error.message || error);
    return null;
  }
}

async function loadPublishedByEntityKey(supabaseGet, entityType, entityKey) {
  if (!entityKey) return null;
  try {
    const rows = await supabaseGet(
      `research_content?entity_type=eq.${encodeURIComponent(entityType)}` +
        `&entity_key=eq.${encodeURIComponent(entityKey)}` +
        `&content_status=eq.published` +
        `&select=id,entity_type,entity_id,entity_key,entity_name,content_json,summary_text,seo_title,meta_description,canonical_slug,pauls_tip,media_id,published_at,refresh_after,content_status` +
        `&limit=1`
    );
    return Array.isArray(rows) ? rows[0] || null : null;
  } catch (error) {
    console.warn("research published by key skipped", error.message || error);
    return null;
  }
}

async function resolveDestinationKey(supabaseGet, destinationStrip) {
  const raw = String(destinationStrip || "").trim();
  if (!raw) return null;
  const key = normaliseEntityKey(raw);
  if (!key) return null;

  const direct = await loadPublishedByEntityKey(supabaseGet, "destination", key);
  if (direct) return { key, row: direct };

  try {
    const aliases = await supabaseGet(
      `research_entity_aliases?entity_type=eq.destination&normalised_alias=eq.${encodeURIComponent(key)}` +
        `&select=entity_key,research_content_id&limit=1`
    );
    const alias = Array.isArray(aliases) ? aliases[0] : null;
    if (alias?.entity_key) {
      const row = await loadPublishedByEntityKey(supabaseGet, "destination", alias.entity_key);
      if (row) return { key: alias.entity_key, row };
    }
    if (alias?.research_content_id) {
      const rows = await supabaseGet(
        `research_content?id=eq.${encodeURIComponent(alias.research_content_id)}&content_status=eq.published&select=id,entity_type,entity_id,entity_key,entity_name,content_json,summary_text,seo_title,meta_description,canonical_slug,pauls_tip,media_id,published_at,refresh_after,content_status&limit=1`
      );
      const row = Array.isArray(rows) ? rows[0] : null;
      if (row) return { key: row.entity_key, row };
    }
  } catch (error) {
    console.warn("research destination alias skipped", error.message || error);
  }
  return { key, row: null };
}

async function resolveDestinationForCruise(supabaseGet, cruiseRow, itineraryStops) {
  const candidates = inferDestinationKeys(cruiseRow, itineraryStops);
  for (const key of candidates) {
    const resolved = await resolveDestinationKey(supabaseGet, key);
    if (resolved?.row) return resolved;
  }
  return { key: candidates[0] || null, row: null };
}

async function attachPublicMedia(supabaseGet, teaser) {
  if (!teaser?.media_id) return teaser;
  try {
    const rows = await supabaseGet(
      `media_library?id=eq.${encodeURIComponent(teaser.media_id)}&is_active=eq.true` +
        `&select=id,title,alt_text,public_url,width,height&limit=1`
    );
    const media = Array.isArray(rows) ? rows[0] : null;
    if (media?.public_url) {
      teaser.image = {
        url: media.public_url,
        alt_text: media.alt_text || teaser.entity_name || "",
        title: media.title || teaser.entity_name || "",
        width: media.width,
        height: media.height
      };
    }
  } catch (error) {
    console.warn("research media attach skipped", error.message || error);
  }
  return teaser;
}

function stopDisplayName(row) {
  const stopType = String(row.stop_type || "").trim();
  if (stopType === "at_sea") return "At sea";
  return (
    String(row.display_name || row.canonical_name || row.entered_port_text || "").trim() ||
    "Port"
  );
}

function toPublicItineraryStop(row, index, portImages) {
  const stopType = String(row.stop_type || "").trim() || "port_call";
  const isSeaDay = stopType === "at_sea";
  const name = stopDisplayName(row);
  const imageKey = normaliseEntityKey(name);
  const image = !isSeaDay && portImages && portImages[imageKey] ? portImages[imageKey] : null;

  return {
    order: row.display_order != null ? Number(row.display_order) : index + 1,
    day_number: row.day_number == null ? null : Number(row.day_number),
    stop_type: stopType,
    name,
    is_sea_day: isSeaDay,
    image
  };
}

async function loadPortImages(supabaseGet, stopNames, destinationName) {
  const out = Object.create(null);
  const names = Array.from(
    new Set(
      (stopNames || [])
        .map((name) => String(name || "").trim())
        .filter(Boolean)
        .filter((name) => name.toLowerCase() !== "at sea")
    )
  );
  if (!names.length) return out;

  for (const name of names) {
    const key = normaliseEntityKey(name);
    if (out[key]) continue;
    try {
      const encodedPort = encodeURIComponent(name);
      const rows = await supabaseGet(
        `media_library?media_type=eq.port&is_active=eq.true&port_name=eq.${encodedPort}` +
          `&select=id,title,alt_text,public_url,width,height,port_name&order=is_default.desc,created_at.asc&limit=1`
      );
      let media = Array.isArray(rows) ? rows[0] : null;
      if (!media?.public_url && destinationName) {
        const destRows = await supabaseGet(
          `media_library?media_type=eq.port&is_active=eq.true&destination_name=eq.${encodeURIComponent(
            destinationName
          )}&port_name=eq.${encodedPort}` +
            `&select=id,title,alt_text,public_url,width,height,port_name&order=is_default.desc,created_at.asc&limit=1`
        );
        media = Array.isArray(destRows) ? destRows[0] : null;
      }
      if (media?.public_url) {
        out[key] = {
          url: media.public_url,
          alt_text: media.alt_text || name,
          title: media.title || name,
          width: media.width,
          height: media.height
        };
      }
    } catch (error) {
      console.warn("port media skipped", name, error.message || error);
    }
  }
  return out;
}

async function loadShipGallery(supabaseGet, shipId) {
  if (!shipId) return [];
  try {
    const rows = await supabaseGet(
      `media_library?ship_id=eq.${encodeURIComponent(shipId)}&media_type=eq.ship&is_active=eq.true` +
        `&select=id,title,alt_text,public_url,width,height,is_default&order=is_default.desc,created_at.asc&limit=8`
    );
    return (Array.isArray(rows) ? rows : [])
      .filter((row) => row?.public_url)
      .map((row) => ({
        url: row.public_url,
        alt_text: row.alt_text || row.title || "",
        title: row.title || "",
        width: row.width,
        height: row.height
      }));
  } catch (error) {
    console.warn("ship gallery skipped", error.message || error);
    return [];
  }
}

async function loadPublicItinerary(supabaseGet, cruiseId, destinationName) {
  const loaded = await loadStructuredItinerary(supabaseGet, cruiseId);
  if (!loaded.ok || !Array.isArray(loaded.itinerary) || !loaded.itinerary.length) {
    return {
      stops: [],
      port_count: 0,
      sea_day_count: 0,
      ok: false
    };
  }

  const annotated = (loaded.annotated || loaded.itinerary.map((row, index) => annotateItineraryStop(row, index)));
  const portNames = annotated.filter((row) => String(row.stop_type) !== "at_sea").map(stopDisplayName);
  const portImages = await loadPortImages(supabaseGet, portNames, destinationName);
  const stops = annotated.map((row, index) => toPublicItineraryStop(row, index, portImages));
  const portCount = stops.filter((stop) => !stop.is_sea_day).length;
  const seaDayCount = stops.filter((stop) => stop.is_sea_day).length;

  return {
    stops,
    port_count: portCount,
    sea_day_count: seaDayCount,
    ok: true
  };
}

function buildDestinationSeason(destinationFull) {
  if (!destinationFull) return null;
  const bestMonths = extractMonthsFromText(destinationFull.best_time_to_visit);
  if (!bestMonths.length) return null;
  return {
    best_months: bestMonths,
    best_time_to_visit: destinationFull.best_time_to_visit || "",
    climate_summary: destinationFull.climate_summary || ""
  };
}

/**
 * Enrich a public cruise payload with published research, itinerary and media.
 * Never throws — returns null fields on failure.
 */
async function enrichPublicCruise(supabaseGet, cruiseRow, basePayload) {
  const out = {
    ...basePayload,
    newsletter_number: cruiseRow.newsletter_number == null ? null : Number(cruiseRow.newsletter_number),
    destination_region: null,
    itinerary: {
      stops: [],
      port_count: 0,
      sea_day_count: 0
    },
    media: {
      destination_images: [],
      ship_gallery: [],
      ship_hero: null
    },
    research: {
      ship: null,
      ship_full: null,
      destination: null,
      destination_full: null,
      destination_season: null,
      ship_facts: null
    }
  };

  try {
    const shipId = cruiseRow.cruise_ship_id;
    let shipRow = cruiseRow.ci_cruise_ships;
    if (shipId) {
      try {
        const full = await supabaseGet(
          `ci_cruise_ships?id=eq.${encodeURIComponent(shipId)}` +
            `&select=id,name,year_built,year_refurbished,passenger_capacity,crew_count,deck_count,stateroom_count,gross_tonnage,length_metres,facilities,hero_image_url&limit=1`
        );
        if (Array.isArray(full) && full[0]) shipRow = full[0];
      } catch {
        // keep embed
      }

      out.research.ship_facts = shipFactsFromRow(shipRow);

      if (shipRow?.hero_image_url) {
        out.media.ship_hero = {
          url: shipRow.hero_image_url,
          alt_text: shipRow.name || "Ship",
          title: shipRow.name || "Ship",
          width: null,
          height: null
        };
      }

      out.media.ship_gallery = await loadShipGallery(supabaseGet, shipId);

      const publishedShip = await loadPublishedByEntityId(supabaseGet, "ship", shipId);
      if (publishedShip) {
        out.research.ship = await attachPublicMedia(
          supabaseGet,
          toPublicResearchTeaser(publishedShip, { maxHighlights: 4 })
        );
        out.research.ship_full = await attachPublicMedia(supabaseGet, toPublicShipResearchFull(publishedShip));
      }
    }

    const itinerary = await loadPublicItinerary(supabaseGet, cruiseRow.id, null);
    out.itinerary = {
      stops: itinerary.stops,
      port_count: itinerary.port_count,
      sea_day_count: itinerary.sea_day_count
    };

    const dest = await resolveDestinationForCruise(supabaseGet, cruiseRow, itinerary.stops);
    if (dest?.row) {
      out.destination_region = dest.row.entity_name || dest.key || null;
      out.research.destination = await attachPublicMedia(
        supabaseGet,
        toPublicResearchTeaser(dest.row, { maxHighlights: 3 })
      );
      out.research.destination_full = await attachPublicMedia(
        supabaseGet,
        toPublicDestinationResearchFull(dest.row)
      );
      out.research.destination_season = buildDestinationSeason(out.research.destination_full);

      try {
        const destMedia = await supabaseGet(
          `media_library?media_type=eq.destination&is_active=eq.true&destination_name=eq.${encodeURIComponent(
            dest.row.entity_name || dest.key
          )}` +
            `&select=id,title,alt_text,public_url,width,height&order=is_default.desc,created_at.asc&limit=6`
        );
        out.media.destination_images = (Array.isArray(destMedia) ? destMedia : [])
          .filter((row) => row?.public_url)
          .map((row) => ({
            url: row.public_url,
            alt_text: row.alt_text || row.title || "",
            title: row.title || "",
            width: row.width,
            height: row.height
          }));
      } catch (error) {
        console.warn("destination media skipped", error.message || error);
      }

      if (itinerary.stops.length) {
        const portNames = itinerary.stops.filter((stop) => !stop.is_sea_day).map((stop) => stop.name);
        const portImages = await loadPortImages(
          supabaseGet,
          portNames,
          dest.row.entity_name || dest.key
        );
        out.itinerary.stops = itinerary.stops.map((stop) => {
          if (stop.is_sea_day) return stop;
          const key = normaliseEntityKey(stop.name);
          return Object.assign({}, stop, { image: portImages[key] || stop.image || null });
        });
      }
    } else if (itinerary.stops.length) {
      const portNames = itinerary.stops.filter((stop) => !stop.is_sea_day).map((stop) => stop.name);
      const portImages = await loadPortImages(supabaseGet, portNames, null);
      out.itinerary.stops = itinerary.stops.map((stop) => {
        if (stop.is_sea_day) return stop;
        const key = normaliseEntityKey(stop.name);
        return Object.assign({}, stop, { image: portImages[key] || null });
      });
    }
  } catch (error) {
    console.warn("research enrichment skipped", error.message || error);
  }

  return out;
}

module.exports = {
  shipFactsFromRow,
  enrichPublicCruise,
  normaliseEntityKey,
  toPublicShipResearchFull,
  toPublicDestinationResearchFull,
  loadPublicItinerary
};
