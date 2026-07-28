/**
 * Transactional-ish ship hero replacement for Media Library.
 * Clears other ship defaults, sets the selected row default, updates
 * ci_cruise_ships.hero_image_url. Compensates on failure.
 * Does not delete or deactivate any media rows.
 */

function assignError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function isHttpUrl(value) {
  const url = String(value || "").trim();
  return /^https?:\/\//i.test(url);
}

/**
 * @param {object} opts
 * @param {string} opts.mediaId
 * @param {(path: string, options?: object) => Promise<any>} opts.supabase
 */
async function setShipHero({ mediaId, supabase }) {
  const id = String(mediaId || "").trim();
  if (!id) throw assignError("id is required", 400);

  const mediaRows = await supabase(
    `/rest/v1/media_library?id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
    { method: "GET" }
  );
  const media = Array.isArray(mediaRows) ? mediaRows[0] : null;
  if (!media) throw assignError("Media not found.", 404);
  if (media.media_type !== "ship") {
    throw assignError("Only ship images can be set as the ship hero.", 400);
  }
  if (!media.ship_id) {
    throw assignError("This image is not associated with a ship.", 400);
  }
  if (!isHttpUrl(media.public_url)) {
    throw assignError("This image does not have a valid public URL.", 400);
  }

  const shipRows = await supabase(
    `/rest/v1/ci_cruise_ships?id=eq.${encodeURIComponent(media.ship_id)}&select=id,name,hero_image_url&limit=1`,
    { method: "GET" }
  );
  const ship = Array.isArray(shipRows) ? shipRows[0] : null;
  if (!ship) {
    throw assignError("Associated ship was not found in Cruise Intelligence.", 400);
  }

  const defaultRows = await supabase(
    `/rest/v1/media_library?ship_id=eq.${encodeURIComponent(ship.id)}&media_type=eq.ship&is_default=eq.true&select=id,public_url,title`,
    { method: "GET" }
  );
  const previousDefaults = Array.isArray(defaultRows) ? defaultRows : [];
  const previousHeroUrl = ship.hero_image_url || null;

  // Idempotent: already sole default and hero matches.
  if (
    media.is_default === true &&
    previousDefaults.length === 1 &&
    previousDefaults[0].id === media.id &&
    previousHeroUrl === media.public_url
  ) {
    return {
      success: true,
      unchanged: true,
      media,
      ship: { ...ship, hero_image_url: media.public_url },
      previous_default_ids: previousDefaults.map((r) => r.id),
      message: "Ship hero updated."
    };
  }

  const snapshot = {
    previousHeroUrl,
    previousDefaultIds: previousDefaults.map((r) => r.id)
  };

  async function compensate(cause) {
    try {
      await supabase(
        `/rest/v1/media_library?ship_id=eq.${encodeURIComponent(ship.id)}&media_type=eq.ship&is_default=eq.true`,
        {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ is_default: false })
        }
      );
      for (const prevId of snapshot.previousDefaultIds) {
        await supabase(`/rest/v1/media_library?id=eq.${encodeURIComponent(prevId)}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ is_default: true })
        });
      }
      await supabase(`/rest/v1/ci_cruise_ships?id=eq.${encodeURIComponent(ship.id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ hero_image_url: snapshot.previousHeroUrl })
      });
    } catch (rollbackError) {
      console.error("set-ship-hero compensation failed", rollbackError);
    }
    throw assignError(
      cause?.message || "Could not update ship hero. Previous hero was restored.",
      cause?.statusCode && cause.statusCode >= 400 && cause.statusCode < 500
        ? cause.statusCode
        : 500
    );
  }

  try {
    // 1. Clear all current defaults for this ship.
    await supabase(
      `/rest/v1/media_library?ship_id=eq.${encodeURIComponent(ship.id)}&media_type=eq.ship&is_default=eq.true`,
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ is_default: false })
      }
    );

    // 2. Promote selected row.
    const updatedMediaRows = await supabase(
      `/rest/v1/media_library?id=eq.${encodeURIComponent(media.id)}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ is_default: true })
      }
    );
    const updatedMedia = Array.isArray(updatedMediaRows) ? updatedMediaRows[0] : updatedMediaRows;
    if (!updatedMedia || updatedMedia.is_default !== true) {
      throw assignError("Failed to mark the selected image as default.", 500);
    }

    // 3. Point ship hero at the selected public URL.
    const updatedShipRows = await supabase(
      `/rest/v1/ci_cruise_ships?id=eq.${encodeURIComponent(ship.id)}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          hero_image_url: media.public_url,
          last_verified_at: new Date().toISOString()
        })
      }
    );
    const updatedShip = Array.isArray(updatedShipRows) ? updatedShipRows[0] : updatedShipRows;
    if (!updatedShip || updatedShip.hero_image_url !== media.public_url) {
      throw assignError("Failed to update the ship hero image URL.", 500);
    }

    // 4. Verify invariants.
    const verifyDefaults = await supabase(
      `/rest/v1/media_library?ship_id=eq.${encodeURIComponent(ship.id)}&media_type=eq.ship&is_default=eq.true&select=id,public_url`,
      { method: "GET" }
    );
    const defaultsNow = Array.isArray(verifyDefaults) ? verifyDefaults : [];
    if (defaultsNow.length !== 1 || defaultsNow[0].id !== media.id) {
      throw assignError("Ship hero update left an invalid default state.", 500);
    }

    // Confirm former heroes remain as non-default rows (when they differ).
    for (const prevId of snapshot.previousDefaultIds) {
      if (prevId === media.id) continue;
      const prevRows = await supabase(
        `/rest/v1/media_library?id=eq.${encodeURIComponent(prevId)}&select=id,is_default&limit=1`,
        { method: "GET" }
      );
      const prev = Array.isArray(prevRows) ? prevRows[0] : null;
      if (!prev) {
        throw assignError("Previous hero image disappeared during update.", 500);
      }
      if (prev.is_default === true) {
        throw assignError("Previous hero remained marked as default.", 500);
      }
    }

    return {
      success: true,
      unchanged: false,
      media: updatedMedia,
      ship: {
        id: updatedShip.id,
        name: updatedShip.name || ship.name,
        hero_image_url: updatedShip.hero_image_url
      },
      previous_default_ids: snapshot.previousDefaultIds,
      previous_hero_image_url: snapshot.previousHeroUrl,
      message: "Ship hero updated."
    };
  } catch (error) {
    await compensate(error);
  }
}

module.exports = {
  setShipHero,
  isHttpUrl
};
