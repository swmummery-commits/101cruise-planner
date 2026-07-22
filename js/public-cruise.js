/**
 * Public dynamic cruise page: /cruise/{public_slug} or /cruise?slug=
 * Loads only published, Airline-price-free payloads from the Netlify function.
 *
 * Production Squarespace host URL (newsletter Explore More):
 *   https://www.101cruise.com.au/cruise?slug={public-slug}
 * Netlify continues to support path and query slugs for the embedded renderer.
 *
 * Branded header lives in cruise/index.html (page shell only).
 * This file renders cruise content into #public-cruise-app and must not
 * inject the logo/contact header into NewsletterPreview.
 *
 * Sprint 13E: when embedded (Squarespace iframe), reports content height via postMessage.
 */
(function () {
  "use strict";

  const HOME_URL = "https://www.101cruise.com.au";
  const HEIGHT_MESSAGE_TYPE = "101cruise-public-cruise-height";

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

  function isEmbedded() {
    try {
      return window.self !== window.top;
    } catch (_err) {
      return true;
    }
  }

  function wantsEmbedChrome() {
    const params = new URLSearchParams(window.location.search);
    return params.get("embed") === "1" || isEmbedded();
  }

  function applyEmbedChrome() {
    if (!wantsEmbedChrome()) return;
    document.documentElement.classList.add("cr101-embed");
    document.body.classList.add("cr101-embed");
  }

  /**
   * Primary for Netlify: /cruise/{slug}
   * Also: ?slug= (and Squarespace parent uses ?slug= then iframes Netlify path)
   */
  function slugFromPath() {
    const parts = window.location.pathname.split("/").filter(Boolean);
    const cruiseIndex = parts.indexOf("cruise");
    if (cruiseIndex >= 0 && parts[cruiseIndex + 1]) {
      const raw = decodeURIComponent(parts[cruiseIndex + 1]);
      if (/^index\.html?$/i.test(raw)) {
        /* fall through to query */
      } else {
        const fromPath = slugifyPublicSlug(raw);
        if (fromPath) return fromPath;
      }
    }
    const params = new URLSearchParams(window.location.search);
    return slugifyPublicSlug(params.get("slug") || "");
  }

  function measureContentHeight() {
    const root = document.getElementById("public-cruise-app");
    const shell = document.querySelector(".public-cruise-shell");
    const targets = [document.documentElement, document.body, shell, root].filter(Boolean);
    let max = 0;
    for (const el of targets) {
      const h = Math.max(el.scrollHeight || 0, el.offsetHeight || 0);
      if (h > max) max = h;
    }
    return Math.ceil(max);
  }

  let heightTimer = null;
  function reportHeightToParent() {
    if (!isEmbedded()) return;
    const height = measureContentHeight();
    if (!height || height < 40) return;
    try {
      window.parent.postMessage(
        {
          source: "101cruise-public-cruise",
          type: HEIGHT_MESSAGE_TYPE,
          height
        },
        "*"
      );
    } catch (_err) {
      /* ignore */
    }
  }

  function scheduleHeightReport() {
    if (!isEmbedded()) return;
    if (heightTimer) window.clearTimeout(heightTimer);
    heightTimer = window.setTimeout(() => {
      reportHeightToParent();
      // Second pass after images/fonts settle
      window.setTimeout(reportHeightToParent, 250);
      window.setTimeout(reportHeightToParent, 900);
    }, 40);
  }

  function startHeightObserver() {
    if (!isEmbedded()) return;
    window.addEventListener("message", (event) => {
      const data = event.data || {};
      if (data.type === "101cruise-request-height") scheduleHeightReport();
    });
    scheduleHeightReport();
    window.addEventListener("load", scheduleHeightReport);
    window.addEventListener("resize", scheduleHeightReport);
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => scheduleHeightReport());
      const shell = document.querySelector(".public-cruise-shell");
      const root = document.getElementById("public-cruise-app");
      if (shell) ro.observe(shell);
      if (root) ro.observe(root);
    }
    document.addEventListener(
      "load",
      (event) => {
        if (event.target && event.target.tagName === "IMG") scheduleHeightReport();
      },
      true
    );
  }

  function setMetadata(cruise) {
    const title = cruise.headline ? `${cruise.headline} | 101cruise` : "101cruise";
    const description = String(cruise.short_editorial || cruise.full_description || "")
      .trim()
      .slice(0, 160);
    const canonical = cruise.public_slug
      ? `${HOME_URL}/cruise?slug=${encodeURIComponent(cruise.public_slug)}`
      : HOME_URL;

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

  async function loadCruise(slug) {
    const response = await fetch(
      `/.netlify/functions/public-featured-cruise?slug=${encodeURIComponent(slug)}`,
      { headers: { Accept: "application/json" } }
    );
    const payload = await response.json().catch(() => ({}));
    if (response.status === 404) {
      return { cruise: null, reason: "not_found", detail: payload?.detail || "" };
    }
    if (!response.ok) {
      console.error("public-featured-cruise failed", response.status, payload);
      return {
        cruise: null,
        reason: "unavailable",
        detail: payload?.detail || payload?.error || `HTTP ${response.status}`
      };
    }
    return { cruise: payload?.cruise || null, reason: payload?.cruise ? "ok" : "not_found", detail: "" };
  }

  function renderUnavailable(root, { slug, reason, detail }) {
    const hint =
      reason === "not_found"
        ? "No published Featured Cruise matches this page slug. In Admin → Newsletter, set Publication Status to Published, confirm the Public Slug, then Save."
        : "The public cruise API could not load this page.";
    root.innerHTML = `
      <div class="public-cruise-not-found">
        <p>This cruise is not currently available.</p>
        <p class="public-cruise-not-found-hint">${esc(hint)}</p>
        <p class="public-cruise-not-found-meta">Slug: <code>${esc(slug || "—")}</code>${detail ? ` · ${esc(detail)}` : ""}</p>
        <p><a href="${esc(HOME_URL)}" target="_top">Return to 101cruise</a></p>
      </div>
    `;
    scheduleHeightReport();
  }

  async function init() {
    applyEmbedChrome();
    startHeightObserver();

    const root = document.getElementById("public-cruise-app");
    if (!root) return;

    const slug = slugFromPath();
    if (!slug) {
      renderUnavailable(root, { slug: "", reason: "not_found", detail: "No slug in URL path" });
      return;
    }

    try {
      const result = await loadCruise(slug);
      const cruise = result.cruise;
      if (!cruise || !window.NewsletterPreview) {
        renderUnavailable(root, {
          slug,
          reason: result.reason || "not_found",
          detail: !window.NewsletterPreview ? "Newsletter renderer failed to load" : result.detail || ""
        });
        return;
      }

      // Public page must never show room pricing (newsletter keeps pricing).
      delete cruise.pricing;

      setMetadata(cruise);
      const model = window.NewsletterPreview.buildModel({
        ...cruise,
        outputMode: "general",
        description: cruise.short_editorial || "",
        full_description: cruise.full_description || cruise.short_editorial || "",
        pricingRows: [],
        research: cruise.research || null,
        researchShip: cruise.research?.ship || null,
        researchDestination: cruise.research?.destination || null,
        shipFacts: cruise.research?.ship_facts || null
      });
      root.innerHTML = window.NewsletterPreview.renderPublicCruisePage(model, { escapeHtml: esc });
      scheduleHeightReport();
    } catch (error) {
      console.error("public cruise page error", error);
      renderUnavailable(root, {
        slug,
        reason: "unavailable",
        detail: String(error?.message || error || "Unexpected error")
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
