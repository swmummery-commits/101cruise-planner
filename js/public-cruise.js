/**
 * Public dynamic cruise page: /cruise/{public_slug}
 * Loads only published, Airline-price-free payloads from the Netlify function.
 *
 * Branded header lives in cruise/index.html (page shell only).
 * This file renders cruise content into #public-cruise-app and must not
 * inject the logo/contact header into NewsletterPreview.
 */
(function () {
  "use strict";

  const HOME_URL = "https://www.101cruise.com.au";

  function esc(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function slugifyPublicSlug(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
  }

  function slugFromPath() {
    const parts = window.location.pathname.split("/").filter(Boolean);
    const cruiseIndex = parts.indexOf("cruise");
    if (cruiseIndex >= 0 && parts[cruiseIndex + 1]) {
      const raw = decodeURIComponent(parts[cruiseIndex + 1]);
      // Ignore static file leftovers if rewrite ever surfaces them.
      if (/^index\.html?$/i.test(raw)) return "";
      return slugifyPublicSlug(raw);
    }
    const params = new URLSearchParams(window.location.search);
    return slugifyPublicSlug(params.get("slug") || "");
  }

  function setMetadata(cruise) {
    const title = cruise.headline ? `${cruise.headline} | 101cruise` : "101cruise";
    const description = String(cruise.short_editorial || cruise.full_description || "").trim().slice(0, 160);
    const canonical = `${window.location.origin}/cruise/${cruise.public_slug}`;

    document.title = title;

    function setMeta(selector, attr, value) {
      if (!value) return;
      let el = document.querySelector(selector);
      if (!el) {
        el = document.createElement("meta");
        if (selector.startsWith('meta[name="')) {
          el.setAttribute("name", selector.match(/name="([^"]+)"/)[1]);
        } else if (selector.startsWith('meta[property="')) {
          el.setAttribute("property", selector.match(/property="([^"]+)"/)[1]);
        }
        document.head.appendChild(el);
      }
      el.setAttribute(attr, value);
    }

    setMeta('meta[name="description"]', "content", description || "Explore this cruise with 101cruise.");
    setMeta('meta[property="og:title"]', "content", title);
    setMeta('meta[property="og:description"]', "content", description || title);
    setMeta('meta[property="og:url"]', "content", canonical);
    const heroUrl = cruise.hero?.url || cruise.hero_image_url;
    if (heroUrl) {
      setMeta('meta[property="og:image"]', "content", heroUrl);
    }

    let link = document.querySelector('link[rel="canonical"]');
    if (!link) {
      link = document.createElement("link");
      link.setAttribute("rel", "canonical");
      document.head.appendChild(link);
    }
    link.setAttribute("href", canonical);
  }

  function renderNotFound(root) {
    root.innerHTML = `
      <div class="public-cruise-not-found">
        <p>This cruise is not currently available.</p>
        <p><a href="${esc(HOME_URL)}">Return to 101cruise</a></p>
      </div>
    `;
  }

  async function loadCruise(slug) {
    const response = await fetch(
      `/.netlify/functions/public-featured-cruise?slug=${encodeURIComponent(slug)}`,
      { headers: { Accept: "application/json" } }
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("unavailable");
    const payload = await response.json();
    return payload?.cruise || null;
  }

  async function init() {
    const root = document.getElementById("public-cruise-app");
    if (!root) return;

    const slug = slugFromPath();
    if (!slug) {
      renderNotFound(root);
      return;
    }

    try {
      const cruise = await loadCruise(slug);
      if (!cruise || !window.NewsletterPreview) {
        renderNotFound(root);
        return;
      }

      // Defence in depth: never render airline fields even if accidentally present.
      if (Array.isArray(cruise.pricing)) {
        cruise.pricing = cruise.pricing.map((row) => ({
          room_label: row.room_label,
          brochure_price: row.brochure_price,
          cruise_101_price: row.cruise_101_price,
          display_order: row.display_order
        }));
      }

      setMetadata(cruise);
      const model = window.NewsletterPreview.buildModel({
        ...cruise,
        outputMode: "general",
        description: cruise.short_editorial || "",
        full_description: cruise.full_description || cruise.short_editorial || "",
        pricingRows: cruise.pricing || []
      });
      root.innerHTML = window.NewsletterPreview.renderPublicCruisePage(model, { escapeHtml: esc });
    } catch (_error) {
      renderNotFound(root);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
