/**
 * Public Ship Spotlight page.
 */
(function (global) {
  "use strict";

  const app = document.getElementById("public-ship-app");
  const HEIGHT_TYPE = "101cruise-public-ship-height";

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function slugify(value) {
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

  function readSlug() {
    const params = new URLSearchParams(global.location.search || "");
    const query = slugify(params.get("slug") || "");
    if (query) return query;
    const parts = String(global.location.pathname || "")
      .split("/")
      .filter(Boolean);
    const idx = parts.indexOf("ship");
    return idx >= 0 && parts[idx + 1] ? slugify(decodeURIComponent(parts[idx + 1])) : "";
  }

  function isEmbed() {
    return new URLSearchParams(global.location.search || "").get("embed") === "1";
  }

  function postHeight() {
    if (!isEmbed() || global.parent === global) return;
    const height = Math.max(
      document.documentElement.scrollHeight || 0,
      document.body?.scrollHeight || 0
    );
    global.parent.postMessage(
      { source: "101cruise-public-ship", type: HEIGHT_TYPE, height },
      "*"
    );
  }

  function normaliseGallery(value) {
    const list = Array.isArray(value) ? value : [];
    return list
      .map((item) => {
        if (typeof item === "string") return { url: item, alt: "" };
        if (!item || typeof item !== "object") return null;
        return {
          url: String(item.url || item.public_url || item.image_url || "").trim(),
          alt: String(item.alt || item.alt_text || item.title || "").trim()
        };
      })
      .filter((item) => item?.url && /^https:\/\//i.test(item.url));
  }

  function uniqueImages(items) {
    const seen = new Set();
    return items.filter((item) => {
      const key = String(item?.url || "").split("?")[0].trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function editorialHtml(spotlight) {
    const intro = String(spotlight?.editorial_intro || "").trim();
    const highlights = Array.isArray(spotlight?.highlights)
      ? spotlight.highlights.map((x) => String(typeof x === "string" ? x : x?.text || "").trim()).filter(Boolean)
      : [];
    if (!intro && !highlights.length) return "";
    return `
      <section class="ship-spotlight-editorial ship-reveal-block">
        <div class="ship-spotlight-editorial-inner">
          <p class="ship-spotlight-eyebrow">${esc(spotlight?.eyebrow || "SHIP OF THE WEEK")}</p>
          ${intro ? `<p class="ship-spotlight-intro">${esc(intro)}</p>` : ""}
          ${
            highlights.length
              ? `<div class="ship-spotlight-highlights">${highlights
                  .slice(0, 4)
                  .map((item) => `<div class="ship-spotlight-highlight"><span aria-hidden="true">•</span><p>${esc(item)}</p></div>`)
                  .join("")}</div>`
              : ""
          }
        </div>
      </section>`;
  }

  function galleryHtml(spotlight, ship) {
    const supporting = (Array.isArray(spotlight?.supporting_image_urls)
      ? spotlight.supporting_image_urls
      : []
    )
      .map((url) => ({ url: String(url || "").trim(), alt: ship?.name || "Cruise ship" }))
      .filter((item) => /^https:\/\//i.test(item.url));
    const gallery = normaliseGallery(ship?.image_gallery);
    const hero = String(spotlight?.hero_image_url || ship?.hero_image_url || "").trim();
    const images = uniqueImages([...supporting, ...gallery]).filter((item) => item.url !== hero).slice(0, 8);
    if (!images.length) return "";
    return `
      <section class="ship-spotlight-gallery ship-reveal-block" aria-label="${esc(ship?.name || "Ship")} gallery">
        <div class="ship-spotlight-section-head">
          <p class="ship-spotlight-eyebrow">ON BOARD</p>
          <h2>Explore ${esc(ship?.name || "the ship")}</h2>
        </div>
        <div class="ship-spotlight-gallery-grid">
          ${images
            .map(
              (item) =>
                `<figure><img src="${esc(item.url)}" alt="${esc(item.alt || ship?.name || "Cruise ship")}" loading="lazy"></figure>`
            )
            .join("")}
        </div>
      </section>`;
  }

  function renderError(message) {
    if (!app) return;
    app.innerHTML = `<div class="public-ship-message"><h1>Ship Spotlight</h1><p>${esc(message)}</p></div>`;
    postHeight();
  }

  async function load() {
    if (!app) return;
    const slug = readSlug();
    if (!slug) {
      renderError("This ship is not currently available.");
      return;
    }

    try {
      const response = await fetch(
        `/.netlify/functions/get-ship-spotlight?slug=${encodeURIComponent(slug)}`,
        { headers: { Accept: "application/json" } }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success || !data.ship || !data.spotlight) {
        renderError("This Ship Spotlight is not currently available.");
        return;
      }

      const ship = data.ship;
      const spotlight = data.spotlight;
      document.title = `${ship.name} | 101cruise`;
      const description = String(spotlight.editorial_intro || "").trim();
      const meta = document.querySelector('meta[name="description"]');
      if (meta && description) meta.setAttribute("content", description.slice(0, 155));

      if (!global.CiShipPresentation) {
        renderError("Detailed ship information is not available right now.");
        return;
      }

      const profile = global.CiShipPresentation.buildProfile(ship, {
        shipName: ship.name,
        cruiseLine: ship.cruise_line_name || ""
      });

      const page = global.CiShipPresentation.mountPresentation(app, profile, {
        mode: "public",
        cruiseLineLogo: ship.cruise_line_logo_url || "",
        shipImage: spotlight.hero_image_url || ship.hero_image_url || ""
      });

      if (page) {
        const hero = page.querySelector(".ship-hero") || page.firstElementChild;
        if (hero) hero.insertAdjacentHTML("afterend", editorialHtml(spotlight));
        page.insertAdjacentHTML("beforeend", galleryHtml(spotlight, ship));
      }

      postHeight();
      if (typeof ResizeObserver !== "undefined") {
        const observer = new ResizeObserver(() => postHeight());
        observer.observe(app);
      }
      global.addEventListener("load", postHeight, { once: true });
      global.addEventListener("resize", postHeight);
    } catch (_error) {
      renderError("This Ship Spotlight could not be loaded.");
    }
  }

  global.addEventListener("message", (event) => {
    if (event.data?.type === "101cruise-request-height") postHeight();
  });

  load();
})(window);
