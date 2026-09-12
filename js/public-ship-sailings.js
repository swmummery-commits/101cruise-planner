/**
 * Upcoming verified sailings for public Ship Spotlight pages.
 */
(function (global) {
  "use strict";

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
    const index = parts.indexOf("ship");
    return index >= 0 && parts[index + 1] ? slugify(decodeURIComponent(parts[index + 1])) : "";
  }

  function cardHtml(row) {
    const facts = [
      row.departureDateLabel,
      row.nights ? `${row.nights} nights` : "",
      row.departurePort ? `Departs ${row.departurePort}` : ""
    ].filter(Boolean);
    return `
      <article class="ship-sailing-card">
        <div class="ship-sailing-card-copy">
          <p class="ship-sailing-meta">${facts.map(esc).join(" · ")}</p>
          <h3>${esc(row.title || "Cruise sailing")}</h3>
          ${row.destination ? `<p class="ship-sailing-destination">${esc(row.destination)}</p>` : ""}
          ${row.brochureFare ? `<p class="ship-sailing-fare">Brochure fare ${esc(row.brochureFare)}</p>` : ""}
        </div>
        <div class="ship-sailing-actions">
          <a class="ship-sailing-button" href="https://www.101cruise.com.au/quote" target="_top">Request a quote</a>
          ${row.officialUrl ? `<a class="ship-sailing-source" href="${esc(row.officialUrl)}" target="_blank" rel="noopener noreferrer">View sailing details</a>` : ""}
        </div>
      </article>`;
  }

  function renderSection(data) {
    const rows = Array.isArray(data?.sailings) ? data.sailings : [];
    if (!rows.length) return "";
    return `
      <section class="ship-sailings ship-reveal-block" data-ship-sailings>
        <div class="ship-sailings-head">
          <p class="ship-spotlight-eyebrow">SAIL ON THIS SHIP</p>
          <h2>Upcoming sailings</h2>
          <p>Current verified sailings in the 101cruise cruise database. New enquiries are shown only outside our public booking cutoff.</p>
        </div>
        <div class="ship-sailings-grid">
          ${rows.map(cardHtml).join("")}
        </div>
      </section>`;
  }

  function appendWhenReady(html) {
    if (!html) return;
    const append = () => {
      const page = document.querySelector("#public-ship-app .ship-page");
      if (!page || page.querySelector("[data-ship-sailings]")) return false;
      page.insertAdjacentHTML("beforeend", html);
      global.dispatchEvent(new Event("resize"));
      return true;
    };
    if (append()) return;
    const observer = new MutationObserver(() => {
      if (append()) observer.disconnect();
    });
    observer.observe(document.getElementById("public-ship-app") || document.body, {
      childList: true,
      subtree: true
    });
    setTimeout(() => observer.disconnect(), 10000);
  }

  async function load() {
    const slug = readSlug();
    if (!slug) return;
    try {
      const response = await fetch(
        `/.netlify/functions/get-ship-sailings?slug=${encodeURIComponent(slug)}`,
        { headers: { Accept: "application/json" } }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success !== true) return;
      appendWhenReady(renderSection(data));
    } catch {
      // The ship profile remains useful if live sailing inventory is temporarily unavailable.
    }
  }

  load();
})(window);
