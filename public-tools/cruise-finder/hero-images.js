/**
 * Cruise Finder — destination hero image lookup (separate from recommendations).
 *
 * Phrase → Netlify destination-hero function → royalty-free image URL.
 * Provider can be swapped in the function without touching scoring/UI copy.
 */
(function (root) {
  "use strict";

  const cache = Object.create(null);

  /** Default scenery phrases — no ships, no cruise-line branding. */
  const DEFAULT_PHRASES = {
    alaska: "Alaska glaciers and mountains",
    japan: "Japan landscape",
    mediterranean: "Mediterranean coast",
    "norwegian-fjords": "Norwegian Fjords",
    caribbean: "Caribbean tropical beach",
    "south-pacific": "South Pacific tropical lagoon",
    "australia-new-zealand": "Australia and New Zealand scenery",
    antarctica: "Antarctica landscape",
    hawaii: "Hawaii tropical coast",
    "greek-islands": "Greek Islands Santorini"
  };

  /**
   * Seasonal overrides — only used in the relevant months.
   * Outside these months the default (non-seasonal) phrase is used.
   */
  const SEASONAL_PHRASES = {
    japan: {
      3: "Japan cherry blossoms",
      4: "Japan cherry blossoms",
      6: "Japan summer scenery",
      7: "Japan summer scenery",
      8: "Japan summer scenery",
      10: "Japan autumn landscape",
      11: "Japan autumn colours"
    },
    alaska: {
      5: "Alaska glaciers mountains wildlife",
      6: "Alaska glaciers mountains wildlife",
      7: "Alaska glaciers mountains wildlife",
      8: "Alaska glaciers mountains wildlife"
    },
    mediterranean: {
      6: "Mediterranean coast island scenery",
      7: "Mediterranean coast island scenery",
      8: "Mediterranean coast island scenery",
      9: "Mediterranean coast island scenery"
    },
    "canada-new-england": {
      9: "Canada New England autumn",
      10: "Canada New England autumn colours"
    }
  };

  function buildSearchPhrase(dest, context) {
    const ctx = context || {};
    if (ctx.aiImageSearchPhrase) {
      return String(ctx.aiImageSearchPhrase).trim();
    }

    const id = dest && dest.id ? dest.id : "";
    const base =
      (dest && dest.image_search_phrase) ||
      DEFAULT_PHRASES[id] ||
      (dest && dest.name ? `${dest.name} landscape` : "travel destination landscape");

    const month = Number(ctx.travelMonth) || 0;
    if (!month || !id) return base;

    const seasonal = SEASONAL_PHRASES[id];
    if (seasonal && seasonal[month]) return seasonal[month];
    return base;
  }

  function lookupUrl(toolsOrigin, phrase) {
    return `${toolsOrigin}/.netlify/functions/destination-hero?q=${encodeURIComponent(phrase)}`;
  }

  function resolve(phrase, toolsOrigin) {
    const key = String(phrase || "")
      .trim()
      .toLowerCase();
    if (!key) return Promise.resolve(null);
    if (Object.prototype.hasOwnProperty.call(cache, key)) {
      return Promise.resolve(cache[key]);
    }

    try {
      const stored = sessionStorage.getItem(`cf-hero:${key}`);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && typeof parsed.url === "string") {
          cache[key] = parsed.url || null;
          return Promise.resolve(cache[key]);
        }
      }
    } catch (_error) {
      /* ignore */
    }

    return fetch(lookupUrl(toolsOrigin, phrase), { method: "GET", credentials: "omit" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        const url = data && typeof data.url === "string" && data.url ? data.url : null;
        cache[key] = url;
        try {
          sessionStorage.setItem(`cf-hero:${key}`, JSON.stringify({ url: url || "" }));
        } catch (_error) {
          /* ignore */
        }
        return url;
      })
      .catch(() => {
        cache[key] = null;
        return null;
      });
  }

  function markFallback(hero) {
    if (!hero) return;
    hero.classList.add("is-fallback");
    hero.classList.remove("is-loaded");
    const img = hero.querySelector(".cf-mag-image");
    if (img) {
      img.removeAttribute("src");
      img.removeAttribute("srcset");
      img.alt = "";
    }
  }

  function hydrate(rootEl, toolsOrigin) {
    if (!rootEl) return;
    rootEl.querySelectorAll(".cf-mag-hero[data-image-search]").forEach((hero) => {
      if (hero.dataset.cfHeroBound === "1") return;
      hero.dataset.cfHeroBound = "1";

      const phrase = hero.getAttribute("data-image-search") || "";
      const img = hero.querySelector(".cf-mag-image");
      if (!img || !phrase) {
        markFallback(hero);
        return;
      }

      resolve(phrase, toolsOrigin).then((url) => {
        if (!url) {
          markFallback(hero);
          return;
        }
        const onLoad = () => {
          hero.classList.add("is-loaded");
          hero.classList.remove("is-fallback");
        };
        const onError = () => markFallback(hero);
        img.addEventListener("load", onLoad, { once: true });
        img.addEventListener("error", onError, { once: true });
        img.decoding = "async";
        img.loading = "lazy";
        img.sizes = "(max-width: 760px) 100vw, 760px";
        img.src = url;
        if (img.complete && img.naturalWidth > 0) onLoad();
      });
    });
  }

  root.CruiseFinderHeroImages = {
    buildSearchPhrase,
    resolve,
    hydrate
  };
})(typeof window !== "undefined" ? window : globalThis);
