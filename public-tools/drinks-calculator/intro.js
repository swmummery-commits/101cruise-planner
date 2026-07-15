/**
 * 101cruise public Drinks Calculator — intro / landing embed.
 *
 * Mounts into: <div id="101cruise-drinks-intro"></div>
 *
 * Opens the live calculator page:
 *   CALCULATOR_PAGE_URL?line=<cruise_line_slug>
 */

(function () {
  "use strict";

  const MOUNT_ID = "101cruise-drinks-intro";
  const NETLIFY_ORIGIN = "https://admirable-tiramisu-d4da8a.netlify.app";
  const CALCULATOR_PAGE_URL = "https://101cruise.com.au/drinks-calculator";
  const SCRIPT_EL = document.currentScript;

  function slugify(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  const ICON_SHIP = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 17h18"></path>
      <path d="M5 17l2-8h10l2 8"></path>
      <path d="M8 9V7h8v2"></path>
      <path d="M10 13h4"></path>
    </svg>
  `;

  const ICON_CALC = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="3" width="14" height="18" rx="2"></rect>
      <path d="M8 7h8"></path>
      <path d="M8 12h2"></path>
      <path d="M11.5 12h2"></path>
      <path d="M15 12h1"></path>
      <path d="M8 16h2"></path>
      <path d="M11.5 16h2"></path>
      <path d="M15 16h1"></path>
    </svg>
  `;

  const ICON_CHART = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 19h16"></path>
      <path d="M7 16V10"></path>
      <path d="M12 16V6"></path>
      <path d="M17 16v-4"></path>
    </svg>
  `;

  function getScriptOrigin() {
    if (SCRIPT_EL && SCRIPT_EL.src) {
      try {
        return new URL(SCRIPT_EL.src).origin;
      } catch (_error) {
        /* ignore */
      }
    }

    const scripts = document.querySelectorAll('script[src*="drinks-calculator/intro.js"]');
    const last = scripts[scripts.length - 1];
    if (last && last.src) {
      try {
        return new URL(last.src).origin;
      } catch (_error) {
        /* ignore */
      }
    }

    return NETLIFY_ORIGIN;
  }

  function replaceAllLiteral(value, search, replacement) {
    return String(value).split(search).join(replacement);
  }

  const TOOLS_ORIGIN = getScriptOrigin();
  const LINES_API_URL = `${TOOLS_ORIGIN}/.netlify/functions/public-calculator-lines`;
  const HERO_IMAGE_URL = `${TOOLS_ORIGIN}/assets/default-cruise-hero.jpg`;

  function escapeHtml(value) {
    let text = value == null ? "" : String(value);
    text = replaceAllLiteral(text, "&", "&amp;");
    text = replaceAllLiteral(text, "<", "&lt;");
    text = replaceAllLiteral(text, ">", "&gt;");
    text = replaceAllLiteral(text, '"', "&quot;");
    text = replaceAllLiteral(text, "'", "&#039;");
    return text;
  }

  function getMount() {
    return (
      document.getElementById(MOUNT_ID) ||
      document.querySelector("[data-dc-intro]") ||
      document.getElementById("cruise-drinks-intro")
    );
  }

  function renderShell(mount) {
    mount.innerHTML = `
      <section class="dc-intro" aria-labelledby="dc-intro-heading">
        <header class="dc-intro-hero" style="--dc-hero-image: url('${escapeHtml(HERO_IMAGE_URL)}')">
          <div>
            <p class="dc-intro-hero-kicker" id="dc-intro-heading">Cruise Drinks Package Calculator</p>
            <p class="dc-intro-hero-sub">Is the Drinks Package Worth It?</p>
          </div>
        </header>

        <section class="dc-intro-section" aria-labelledby="dc-how-title">
          <h2 class="dc-intro-section-title" id="dc-how-title">How to use this calculator</h2>
          <div class="dc-intro-steps">
            <article class="dc-intro-step">
              <div class="dc-intro-step-icon">${ICON_SHIP}</div>
              <h3>Select your cruise line</h3>
              <p>Choose the cruise line you’ll be sailing with to load typical onboard prices and package details.</p>
            </article>
            <article class="dc-intro-step">
              <div class="dc-intro-step-icon">${ICON_CALC}</div>
              <h3>Enter your typical day</h3>
              <p>Enter the number of each drink you usually enjoy in a day while on your cruise.</p>
            </article>
            <article class="dc-intro-step">
              <div class="dc-intro-step-icon">${ICON_CHART}</div>
              <h3>Compare &amp; decide</h3>
              <p>We’ll compare the drinks package with buying drinks individually so you can decide.</p>
            </article>
          </div>
        </section>

        <section class="dc-intro-section dc-intro-chooser" aria-labelledby="dc-choose-title">
          <h2 class="dc-intro-section-title" id="dc-choose-title">Choose your cruise line</h2>
          <p id="dc-intro-status" class="dc-intro-status" role="status" aria-live="polite">Loading cruise lines…</p>
          <div class="dc-intro-field">
            <label class="dc-intro-label" for="dc-intro-line-select">Choose your cruise line</label>
            <div class="dc-intro-select-wrap">
              <select id="dc-intro-line-select" class="dc-intro-select" disabled>
                <option value="">Loading cruise lines…</option>
              </select>
            </div>
          </div>
          <button id="dc-intro-open" class="dc-intro-button" type="button" disabled>
            Open Calculator →
          </button>
          <p class="dc-intro-note">
            Prices are based on typical onboard rates and may vary by ship, sailing and promotion.
            Personal inputs are not stored.
          </p>
        </section>

        <section class="dc-intro-supported" aria-labelledby="dc-supported-title">
          <h2 class="dc-intro-section-title" id="dc-supported-title">Supported cruise lines</h2>
          <div id="dc-intro-logo-grid" class="dc-intro-logo-grid"></div>
          <p class="dc-intro-supported-foot">More lines will be added over time.</p>
        </section>
      </section>
    `;
  }

  function setStatus(message, isError) {
    const status = document.getElementById("dc-intro-status");
    if (!status) return;
    status.textContent = message || "";
    status.classList.toggle("is-error", Boolean(isError));
    status.hidden = !message;
  }

  function renderLogoGrid(lines) {
    const grid = document.getElementById("dc-intro-logo-grid");
    if (!grid) return;

    if (!lines.length) {
      grid.innerHTML = `<div class="dc-intro-logo-fallback">Cruise line logos will appear here when available.</div>`;
      return;
    }

    grid.innerHTML = lines.map(line => {
      const name = escapeHtml(line.cruise_line_name);
      if (line.logo_url) {
        return `
          <div class="dc-intro-logo-card">
            <img src="${escapeHtml(line.logo_url)}" alt="${name}" loading="lazy" onerror="this.insertAdjacentHTML('afterend','<span class=&quot;dc-intro-logo-fallback&quot;>'+this.alt+'</span>'); this.remove();">
          </div>
        `;
      }
      return `
        <div class="dc-intro-logo-card">
          <span class="dc-intro-logo-fallback">${name}</span>
        </div>
      `;
    }).join("");
  }

  function populateSelect(lines) {
    const select = document.getElementById("dc-intro-line-select");
    const button = document.getElementById("dc-intro-open");
    if (!select || !button) return;

    if (!lines.length) {
      select.innerHTML = `<option value="">No cruise lines available</option>`;
      select.disabled = true;
      button.disabled = true;
      setStatus("Calculator options are not available right now.", true);
      return;
    }

    select.innerHTML = [
      `<option value="">Select a cruise line</option>`,
      ...lines.map(line => {
        const slug = slugify(line.cruise_line_name);
        return `<option value="${escapeHtml(slug)}">${escapeHtml(line.cruise_line_name)}</option>`;
      })
    ].join("");

    select.disabled = false;
    button.disabled = true;
    setStatus("");

    select.addEventListener("change", () => {
      button.disabled = !select.value;
    });

    button.addEventListener("click", () => {
      const lineSlug = String(select.value || "").trim();
      if (!lineSlug || button.disabled) return;
      const url = new URL(CALCULATOR_PAGE_URL);
      url.searchParams.set("line", lineSlug);
      window.location.assign(url.toString());
    });
  }

  async function loadLines() {
    const select = document.getElementById("dc-intro-line-select");
    const button = document.getElementById("dc-intro-open");
    if (select) select.disabled = true;
    if (button) button.disabled = true;
    setStatus("Loading cruise lines…", false);

    try {
      const response = await fetch(LINES_API_URL, {
        method: "GET",
        headers: { Accept: "application/json" }
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload?.success || !Array.isArray(payload.lines)) {
        throw new Error("LINES_UNAVAILABLE");
      }

      populateSelect(payload.lines);
      renderLogoGrid(payload.lines);
    } catch (_error) {
      if (select) {
        select.innerHTML = `<option value="">Unavailable</option>`;
        select.disabled = true;
      }
      if (button) button.disabled = true;
      setStatus("We couldn’t load the cruise lines. Please try again shortly.", true);
      renderLogoGrid([]);
    }
  }

  function init() {
    const mount = getMount();
    if (!mount) {
      console.error("[drinks-intro] Mount element #" + MOUNT_ID + " was not found.");
      return;
    }

    if (mount.getAttribute("data-dc-intro-ready") === "1") {
      return;
    }
    mount.setAttribute("data-dc-intro-ready", "1");

    try {
      renderShell(mount);
      loadLines();
    } catch (error) {
      console.error("[drinks-intro] Failed to render intro", error);
      mount.removeAttribute("data-dc-intro-ready");
      mount.innerHTML = '<p class="dc-intro-status is-error">We couldn’t load the Drinks Calculator intro. Please refresh and try again.</p>';
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
