/**
 * Cruise Finder — destination hero image lookup (separate from recommendations).
 *
 * Controlled scenery phrases per destination → Netlify destination-hero → URL.
 * Tries seasonal → primary → fallbacks; branded gradient if none load.
 */
(function (root) {
  "use strict";

  const cache = Object.create(null);

  /**
   * Controlled image-search config — destination scenery only.
   * Never use broad single-word searches. Never request ships.
   */
  const IMAGE_CONFIG = {
    alaska: {
      requireAny: ["alaska", "alaskan", "glacier", "denali", "juneau", "skagway"],
      primary: "Alaska glacier landscape",
      fallbacks: ["Alaska mountains wilderness", "Alaska wilderness mountains"],
      seasonal: {
        5: "Alaska glacier landscape summer",
        6: "Alaska glaciers mountains wilderness",
        7: "Alaska glaciers mountains wilderness",
        8: "Alaska glacier landscape summer"
      }
    },
    japan: {
      requireAny: ["japan", "japanese", "tokyo", "kyoto", "fuji", "sakura", "mt fuji"],
      primary: "Japan landscape",
      fallbacks: ["Japan temple landscape", "Japan mountain landscape"],
      seasonal: {
        3: "Japan cherry blossoms landscape",
        4: "Japan cherry blossoms landscape",
        10: "Japan autumn scenery",
        11: "Japan autumn colours landscape"
      }
    },
    mediterranean: {
      requireAny: ["mediterranean", "santorini", "amalfi", "croatia", "greek", "italy", "spain", "coast"],
      primary: "Mediterranean coast landscape",
      fallbacks: ["Mediterranean coastal village", "Mediterranean sea coastline"],
      seasonal: {
        5: "Mediterranean coast landscape",
        6: "Mediterranean coastal island scenery",
        7: "Mediterranean coastal island scenery",
        8: "Mediterranean coastal island scenery",
        9: "Mediterranean coast landscape"
      }
    },
    "norwegian-fjords": {
      requireAny: ["norway", "norwegian", "fjord", "fjords", "bergen", "geiranger"],
      primary: "Norwegian Fjords landscape",
      fallbacks: ["Norway fjord mountains", "Norwegian fjord scenery"],
      seasonal: {
        5: "Norwegian Fjords landscape",
        6: "Norwegian Fjords summer landscape",
        7: "Norwegian Fjords summer landscape",
        8: "Norwegian Fjords landscape"
      }
    },
    caribbean: {
      requireAny: ["caribbean", "bahamas", "barbados", "jamaica", "antigua", "st lucia", "turquoise"],
      primary: "Caribbean tropical beach",
      fallbacks: ["Caribbean turquoise water", "Caribbean island coast"],
      seasonal: {}
    },
    "south-pacific": {
      requireAny: ["bora bora", "tahiti", "fiji", "pacific", "polynesia", "lagoon", "moorea"],
      primary: "South Pacific tropical lagoon",
      fallbacks: ["Bora Bora lagoon landscape", "Pacific island tropical lagoon"],
      seasonal: {}
    },
    "australia-new-zealand": {
      requireAny: [
        "sydney",
        "harbour",
        "harbor",
        "australia",
        "australian",
        "zealand",
        "milford",
        "auckland",
        "queensland"
      ],
      primary: "Sydney Harbour landscape",
      fallbacks: ["New Zealand Milford Sound", "Australia New Zealand coastal scenery"],
      seasonal: {}
    },
    antarctica: {
      requireAny: ["antarctica", "antarctic", "penguin", "iceberg", "polar"],
      primary: "Antarctica ice landscape",
      fallbacks: ["Antarctica mountains and sea", "Antarctic ice wilderness"],
      seasonal: {}
    },
    hawaii: {
      requireAny: ["hawaii", "hawaiian", "oahu", "maui", "honolulu", "waikiki", "volcano", "kauai"],
      primary: "Hawaii tropical coastline",
      fallbacks: ["Hawaii volcanic landscape", "Hawaii beach landscape"],
      seasonal: {}
    },
    "greek-islands": {
      requireAny: ["greece", "greek", "santorini", "mykonos", "aegean", "cyclades"],
      primary: "Greek Islands Santorini landscape",
      fallbacks: ["Santorini white buildings sea", "Aegean Greek island coast"],
      seasonal: {
        5: "Greek Islands Santorini landscape",
        6: "Greek Islands coastal scenery",
        7: "Greek Islands coastal scenery",
        8: "Greek Islands coastal scenery",
        9: "Greek Islands Santorini landscape"
      }
    },
    "canada-new-england": {
      requireAny: ["canada", "new england", "vermont", "maine", "quebec", "autumn", "fall foliage"],
      primary: "Canada New England coastal scenery",
      fallbacks: ["New England autumn landscape", "Canada autumn foliage landscape"],
      seasonal: {
        9: "Canada New England autumn colours",
        10: "Canada New England autumn colours"
      }
    }
  };

  function getConfig(dest) {
    const id = dest && dest.id ? dest.id : "";
    return IMAGE_CONFIG[id] || null;
  }

  /** Ordered phrases: seasonal (if in season) → primary → fallbacks (deduped). */
  function buildSearchPhrases(dest, context) {
    const ctx = context || {};
    if (ctx.aiImageSearchPhrase) {
      return [String(ctx.aiImageSearchPhrase).trim()].filter(Boolean);
    }

    const config = getConfig(dest);
    const month = Number(ctx.travelMonth) || 0;
    const phrases = [];

    if (config) {
      if (month && config.seasonal && config.seasonal[month]) {
        phrases.push(config.seasonal[month]);
      }
      if (config.primary) phrases.push(config.primary);
      (config.fallbacks || []).forEach((p) => phrases.push(p));
    } else {
      const base =
        (dest && dest.image_search_phrase) ||
        (dest && dest.name ? `${dest.name} landscape` : "travel destination landscape");
      phrases.push(base);
    }

    const seen = Object.create(null);
    return phrases.filter((p) => {
      const key = String(p || "")
        .trim()
        .toLowerCase();
      if (!key || seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  /** @deprecated use buildSearchPhrases — kept for callers that expect a single string */
  function buildSearchPhrase(dest, context) {
    const list = buildSearchPhrases(dest, context);
    return list[0] || "";
  }

  function requireParam(dest) {
    const config = getConfig(dest);
    if (!config || !config.requireAny || !config.requireAny.length) return "";
    return config.requireAny.join(",");
  }

  function lookupUrl(toolsOrigin, phrase, requireCsv) {
    let url = `${toolsOrigin}/.netlify/functions/destination-hero?q=${encodeURIComponent(phrase)}`;
    if (requireCsv) {
      url += `&require=${encodeURIComponent(requireCsv)}`;
    }
    return url;
  }

  function resolve(phrase, toolsOrigin, requireCsv) {
    const key = `${String(phrase || "")
      .trim()
      .toLowerCase()}|${String(requireCsv || "").toLowerCase()}`;
    if (!key || key === "|") return Promise.resolve(null);
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

    return fetch(lookupUrl(toolsOrigin, phrase, requireCsv), { method: "GET", credentials: "omit" })
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

  function resolveWithFallbacks(phrases, toolsOrigin, requireCsv) {
    const list = Array.isArray(phrases) ? phrases.slice() : [];
    function next(i) {
      if (i >= list.length) return Promise.resolve(null);
      return resolve(list[i], toolsOrigin, requireCsv).then((url) => {
        if (url) return url;
        return next(i + 1);
      });
    }
    return next(0);
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

  function tryLoadImage(img, url) {
    return new Promise((resolveLoad) => {
      if (!img || !url) {
        resolveLoad(false);
        return;
      }
      const onLoad = () => resolveLoad(true);
      const onError = () => resolveLoad(false);
      img.addEventListener("load", onLoad, { once: true });
      img.addEventListener("error", onError, { once: true });
      img.decoding = "async";
      img.loading = "lazy";
      img.sizes = "(max-width: 760px) 100vw, 760px";
      img.src = url;
      if (img.complete && img.naturalWidth > 0) resolveLoad(true);
    });
  }

  function hydrate(rootEl, toolsOrigin) {
    if (!rootEl) return;
    rootEl.querySelectorAll(".cf-mag-hero[data-image-phrases], .cf-mag-hero[data-image-search]").forEach((hero) => {
      if (hero.dataset.cfHeroBound === "1") return;
      hero.dataset.cfHeroBound = "1";

      let phrases = [];
      try {
        phrases = JSON.parse(hero.getAttribute("data-image-phrases") || "[]");
      } catch (_error) {
        phrases = [];
      }
      if (!phrases.length) {
        const single = hero.getAttribute("data-image-search") || "";
        if (single) phrases = [single];
      }

      const requireCsv = hero.getAttribute("data-image-require") || "";
      const img = hero.querySelector(".cf-mag-image");
      if (!img || !phrases.length) {
        markFallback(hero);
        return;
      }

      function tryAt(index) {
        if (index >= phrases.length) {
          markFallback(hero);
          return;
        }
        resolve(phrases[index], toolsOrigin, requireCsv).then((url) => {
          if (!url) {
            tryAt(index + 1);
            return;
          }
          img.removeAttribute("src");
          tryLoadImage(img, url).then((ok) => {
            if (ok) {
              hero.classList.add("is-loaded");
              hero.classList.remove("is-fallback");
            } else {
              tryAt(index + 1);
            }
          });
        });
      }

      tryAt(0);
    });
  }

  root.CruiseFinderHeroImages = {
    IMAGE_CONFIG,
    buildSearchPhrase,
    buildSearchPhrases,
    requireParam,
    resolve,
    resolveWithFallbacks,
    hydrate
  };
})(typeof window !== "undefined" ? window : globalThis);
