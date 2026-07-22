/**
 * Public-safe research content enrichment helpers (Netlify function-local).
 */

const { toPublicResearchTeaser } = require("./research-schemas");
const { normaliseEntityKey } = require("./research-normalize");

function facilityValue(facilities, keys) {
  if (!facilities || typeof facilities !== "object") return null;
  for (const key of keys) {
    if (facilities[key] != null && String(facilities[key]).trim() !== "") {
      return facilities[key];
    }
  }
  return null;
}

function shipFactsFromRow(ship) {
  if (!ship) return null;
  const facilities = ship.facilities && typeof ship.facilities === "object" ? ship.facilities : {};
  const facts = {
    built: ship.year_built ?? null,
    refurbished: ship.year_refurbished ?? null,
    guests: ship.passenger_capacity ?? null,
    crew: ship.crew_count ?? null,
    decks: ship.deck_count ?? null,
    restaurants: facilityValue(facilities, ["restaurants", "restaurant_count"]),
    pools: facilityValue(facilities, ["pools", "pool_count"]),
    spa: facilityValue(facilities, ["spa", "has_spa"]),
    casino: facilityValue(facilities, ["casino", "has_casino"]),
    kids_club: facilityValue(facilities, ["kids_club", "kids", "childrens_club", "has_kids_club"])
  };
  const hasAny = Object.values(facts).some((v) => v != null && v !== "");
  return hasAny ? facts : null;
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

  // Direct key match first
  const direct = await loadPublishedByEntityKey(supabaseGet, "destination", key);
  if (direct) return { key, row: direct };

  // Alias match
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

/**
 * Enrich a public cruise payload with published research teasers.
 * Never throws — returns null fields on failure.
 */
async function enrichPublicCruise(supabaseGet, cruiseRow, basePayload) {
  const out = {
    ...basePayload,
    research: {
      ship: null,
      destination: null,
      ship_facts: null
    }
  };

  try {
    const shipId = cruiseRow.cruise_ship_id;
    if (shipId) {
      let shipRow = cruiseRow.ci_cruise_ships;
      try {
        const full = await supabaseGet(
          `ci_cruise_ships?id=eq.${encodeURIComponent(shipId)}` +
            `&select=id,name,year_built,year_refurbished,passenger_capacity,crew_count,deck_count,facilities,hero_image_url&limit=1`
        );
        if (Array.isArray(full) && full[0]) shipRow = full[0];
      } catch {
        // keep embed
      }
      out.research.ship_facts = shipFactsFromRow(shipRow);

      const publishedShip = await loadPublishedByEntityId(supabaseGet, "ship", shipId);
      if (publishedShip) {
        out.research.ship = await attachPublicMedia(
          supabaseGet,
          toPublicResearchTeaser(publishedShip, { maxHighlights: 4 })
        );
      }
    }

    const dest = await resolveDestinationKey(supabaseGet, cruiseRow.destination_strip);
    if (dest?.row) {
      out.research.destination = await attachPublicMedia(
        supabaseGet,
        toPublicResearchTeaser(dest.row, { maxHighlights: 3 })
      );
    }
  } catch (error) {
    console.warn("research enrichment skipped", error.message || error);
  }

  return out;
}

module.exports = {
  shipFactsFromRow,
  enrichPublicCruise,
  normaliseEntityKey
};
