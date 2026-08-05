/**
 * Client Portal ship gallery section rendering.
 * Dual export: CommonJS (Node tests) + browser global ShipGallerySection.
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ShipGallerySection = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function escapeHtml(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function imageUrl(img) {
    return String(img?.url || img?.public_url || "").trim();
  }

  /**
   * Drop blank URLs, hero duplicate, and repeated URLs before render.
   */
  function normaliseShipGalleryImages(images, options = {}) {
    const heroUrl = String(options.heroUrl || options.hero_url || "").trim();
    const limit = Number.isFinite(Number(options.limit)) ? Number(options.limit) : null;
    const defaultAlt = String(options.defaultAlt || "").trim();
    const list = Array.isArray(images) ? images : [];
    const out = [];
    const seen = new Set();

    for (const img of list) {
      const url = imageUrl(img);
      if (!url) continue;
      if (heroUrl && url === heroUrl) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({
        url,
        alt: String(img.alt || img.alt_text || img.title || defaultAlt || "Ship photo"),
        title: String(img.title || "")
      });
      if (limit != null && out.length >= limit) break;
    }
    return out;
  }

  function lightboxMarkup() {
    return `<div class="dashboard-ship-gallery-lightbox" id="shipGalleryLightbox" hidden aria-hidden="true">
      <button type="button" id="shipGalleryLightboxClose" aria-label="Close image">Close</button>
      <img id="shipGalleryLightboxImage" alt="">
    </div>`;
  }

  function itemButton(img, index, extraClass) {
    const cls = extraClass
      ? `dashboard-ship-gallery-item ${extraClass}`
      : "dashboard-ship-gallery-item";
    const label = escapeHtml(img.alt || img.title || "Ship photo");
    return `<button type="button" class="${cls}" data-gallery-index="${index}" aria-label="${label}">
      <img src="${escapeHtml(img.url)}" alt="${label}" loading="lazy" width="960" height="540" onerror="this.closest('.dashboard-ship-gallery-item')?.setAttribute('hidden','')">
    </button>`;
  }

  /**
   * Render Explore your ship markup.
   * 0 → ""; 1 → single full-width image; 2+ → horizontal track.
   */
  function renderShipGallerySection(images, options = {}) {
    const list = normaliseShipGalleryImages(images, options);
    if (list.length === 0) return "";

    if (list.length === 1) {
      return `
    <section class="dashboard-ship-gallery dashboard-ship-gallery--single" aria-label="Explore your ship">
      <div class="dashboard-ship-gallery-head"><h3>Explore your ship</h3></div>
      ${itemButton(list[0], 0, "dashboard-ship-gallery-item--single")}
    </section>
    ${lightboxMarkup()}`;
    }

    const items = list.map((img, index) => itemButton(img, index)).join("");
    return `
    <section class="dashboard-ship-gallery" aria-label="Explore your ship">
      <div class="dashboard-ship-gallery-head"><h3>Explore your ship</h3></div>
      <div class="dashboard-ship-gallery-track">${items}</div>
    </section>
    ${lightboxMarkup()}`;
  }

  /**
   * Compact grid gallery for My Ship page — "More photos of [Ship Name]".
   */
  function renderShipPageGallerySection(images, options = {}) {
    const shipName = String(options.shipName || options.ship_name || "").trim();
    if (!shipName) return "";

    const defaultAlt = `${shipName} additional ship photo`;
    const list = normaliseShipGalleryImages(images, {
      heroUrl: options.heroUrl || options.hero_url,
      limit: options.limit ?? 8,
      defaultAlt
    });
    if (list.length === 0) return "";

    const heading = `More photos of ${shipName}`;
    const items = list
      .map((img, index) => {
        const label = escapeHtml(img.alt || defaultAlt);
        return `<button type="button" class="ship-page-gallery-item" data-gallery-index="${index}" aria-label="${label}">
      <img src="${escapeHtml(img.url)}" alt="${label}" loading="lazy" decoding="async" width="480" height="320" onerror="this.closest('.ship-page-gallery-item')?.setAttribute('hidden','')">
    </button>`;
      })
      .join("");

    return `
    <section class="ship-page-gallery" aria-label="${escapeHtml(heading)}">
      <div class="ship-page-gallery-head"><h3>${escapeHtml(heading)}</h3></div>
      <div class="ship-page-gallery-grid">${items}</div>
    </section>
    ${lightboxMarkup()}`;
  }

  return {
    escapeHtml,
    normaliseShipGalleryImages,
    renderShipGallerySection,
    renderShipPageGallerySection,
    render: renderShipGallerySection
  };
});
