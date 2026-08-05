/**
 * Ship gallery media filtering helpers for Client Portal ship-gallery endpoint.
 */

"use strict";

function normaliseText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function isLogoMedia(row) {
  if (!row) return true;

  const title = normaliseText(row.title);
  const tags = Array.isArray(row.tags) ? row.tags.map(normaliseText) : [];

  if (title.includes("logo") || tags.some((tag) => tag.includes("logo"))) {
    return true;
  }

  if (row.media_type === "cruise_line" && !row.ship_id) {
    return true;
  }

  if (row.cruise_line_id && !row.ship_id) {
    return true;
  }

  return false;
}

function isHeroUrlMatch(row, heroUrl) {
  const url = String(row?.public_url || "").trim();
  const hero = String(heroUrl || "").trim();
  return Boolean(url && hero && url === hero);
}

function isDefaultHeroDuplicate(row, heroUrl) {
  return isHeroUrlMatch(row, heroUrl) && Boolean(row?.is_default);
}

function filterShipGalleryMedia(rows, options = {}) {
  const heroUrl = options.heroUrl || options.hero_url || null;
  const limit = Number.isFinite(Number(options.limit)) ? Number(options.limit) : 8;
  const seen = new Set();

  return (rows || [])
    .filter((row) => row && row.is_active !== false && row.public_url)
    .filter((row) => row.media_type === "ship")
    .filter((row) => row.ship_id)
    .filter((row) => !isLogoMedia(row))
    .filter((row) => !isHeroUrlMatch(row, heroUrl))
    .filter((row) => {
      const url = String(row.public_url || "").trim();
      if (!url || seen.has(url)) return false;
      seen.add(url);
      return true;
    })
    .slice(0, limit)
    .map((row) => ({
      id: row.id,
      url: row.public_url,
      alt: row.alt_text || row.title || "",
      title: row.title || ""
    }));
}

module.exports = {
  normaliseText,
  isLogoMedia,
  isHeroUrlMatch,
  isDefaultHeroDuplicate,
  filterShipGalleryMedia
};
