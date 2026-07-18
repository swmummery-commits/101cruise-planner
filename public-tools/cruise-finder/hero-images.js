/**
 * Cruise Finder — destination hero images (verified URLs only).
 *
 * Selection order:
 *   1. Approved seasonal image for the traveller’s month (when configured)
 *   2. Approved general destination image
 *   3. Branded gradient fallback if the image fails to load
 *
 * No live/random image search during normal page use.
 * Relative paths (e.g. images/hawaii-hero.png) resolve against this script folder.
 */
(function (root) {
  "use strict";

  const NETLIFY_ORIGIN = "https://admirable-tiramisu-d4da8a.netlify.app";
  const IMAGE_LOAD_TIMEOUT_MS = 3000;
  const SCRIPT_EL = document.currentScript;

  function imagesBaseUrl() {
    const candidates = [];
    if (SCRIPT_EL && SCRIPT_EL.src) candidates.push(SCRIPT_EL.src);
    document.querySelectorAll('script[src*="cruise-finder/"]').forEach((el) => {
      if (el.src) candidates.push(el.src);
    });

    for (let i = 0; i < candidates.length; i += 1) {
      try {
        const url = new URL(candidates[i]);
        // Prefer absolute Netlify/tool origin — never resolve against Squarespace.
        if (url.hostname.indexOf("101cruise.com.au") !== -1) continue;
        return url.href.replace(/[^/]+$/, "");
      } catch (_error) {
        /* continue */
      }
    }
    return `${NETLIFY_ORIGIN}/public-tools/cruise-finder/`;
  }

  function resolveImageUrl(url) {
    if (!url) return "";
    if (/^https?:\/\//i.test(url) || url.startsWith("data:")) return url;
    const base = imagesBaseUrl();
    return base + String(url).replace(/^\.\//, "").replace(/^\//, "");
  }

  function pick(dest, travelMonth) {
    const id = dest && dest.id ? dest.id : "";
    let image = null;
    if (typeof root.CruiseFinderPickDestinationImage === "function") {
      image = root.CruiseFinderPickDestinationImage(id, travelMonth);
    } else if (dest && dest.image_url) {
      image = { url: dest.image_url, objectPosition: "center center" };
    }
    if (!image || !image.url) return null;
    return {
      url: resolveImageUrl(image.url),
      objectPosition: image.objectPosition || "center center",
      credit: image.credit || null
    };
  }

  function heroImageEl(hero) {
    return hero.querySelector(".cf-mag-image, img");
  }

  function markFallback(hero) {
    if (!hero) return;
    hero.classList.add("is-fallback");
    hero.classList.remove("is-loaded");
    const img = heroImageEl(hero);
    if (img) {
      img.removeAttribute("src");
      img.removeAttribute("srcset");
      img.alt = "";
      img.style.display = "none";
    }
  }

  function bindHero(hero) {
    if (!hero || hero.dataset.cfHeroBound === "1") return;
    hero.dataset.cfHeroBound = "1";

    const url = resolveImageUrl(hero.getAttribute("data-image-url") || "");
    const position = hero.getAttribute("data-object-position") || "center center";
    const img = heroImageEl(hero);

    if (!img || !url) {
      markFallback(hero);
      return;
    }

    let settled = false;
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (ok) {
        hero.classList.add("is-loaded");
        hero.classList.remove("is-fallback");
        img.style.display = "";
      } else {
        markFallback(hero);
      }
    };

    img.style.objectPosition = position;
    img.style.display = "";
    img.addEventListener("load", () => settle(true), { once: true });
    img.addEventListener("error", () => settle(false), { once: true });
    img.decoding = "async";
    img.loading = "eager";
    img.sizes = "(max-width: 760px) 100vw, 760px";
    img.src = url;

    const timer = window.setTimeout(() => settle(false), IMAGE_LOAD_TIMEOUT_MS);

    if (img.complete && img.naturalWidth > 0) settle(true);
  }

  function hydrate(rootEl) {
    if (!rootEl) return;
    rootEl.querySelectorAll(".cf-mag-hero[data-image-url], .cf-dest-media[data-image-url]").forEach((hero) => {
      bindHero(hero);
    });
  }

  root.CruiseFinderHeroImages = {
    pick,
    hydrate,
    resolveImageUrl,
    buildSearchPhrase: function () {
      return "";
    },
    buildSearchPhrases: function () {
      return [];
    },
    requireParam: function () {
      return "";
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
