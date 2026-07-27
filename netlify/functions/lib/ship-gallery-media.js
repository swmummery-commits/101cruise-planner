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

function isDefaultHeroDuplicate(row, heroUrl) {
  const url = String(row?.public_url || "").trim();
  const hero = String(heroUrl || "").trim();
  if (!url || !hero) return false;
  if (url !== hero) return false;
  return Boolean(row.is_default);
}

function filterShipGalleryMedia(rows, options = {}) {
  const heroUrl = options.heroUrl || options.hero_url || null;
  const limit = Number.isFinite(Number(options.limit)) ? Number(options.limit) : 8;

  return (rows || [])
    .filter((row) => row && row.is_active !== false && row.public_url)
    .filter((row) => row.media_type === "ship")
    .filter((row) => row.ship_id)
    .filter((row) => !isLogoMedia(row))
    .filter((row) => !isDefaultHeroDuplicate(row, heroUrl))
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
  isDefaultHeroDuplicate,
  filterShipGalleryMedia
};
