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
   * Drop blank URLs and an accidental hero duplicate before render.
   */
  function normaliseShipGalleryImages(images, options = {}) {
    const heroUrl = String(options.heroUrl || options.hero_url || "").trim();
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
        alt: String(img.alt || img.alt_text || img.title || "Ship photo"),
        title: String(img.title || "")
      });
    }
    return out;
  }

  function lightboxMarkup() {
    return `<div class="dashboard-ship-gallery-lightbox" id="shipGalleryLightbox" hidden>
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
      <img src="${escapeHtml(img.url)}" alt="${label}" loading="lazy" width="960" height="540">
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

  return {
    escapeHtml,
    normaliseShipGalleryImages,
    renderShipGallerySection,
    render: renderShipGallerySection
  };
});
