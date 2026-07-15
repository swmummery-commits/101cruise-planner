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
        return url.href.replace(/[^/]+$/, "");
      } catch (_error) {
        /* continue */
      }
    }
    return "/public-tools/cruise-finder/";
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

  function hydrate(rootEl) {
    if (!rootEl) return;
    rootEl.querySelectorAll(".cf-mag-hero[data-image-url]").forEach((hero) => {
      if (hero.dataset.cfHeroBound === "1") return;
      hero.dataset.cfHeroBound = "1";

      const url = resolveImageUrl(hero.getAttribute("data-image-url") || "");
      const position = hero.getAttribute("data-object-position") || "center center";
      const img = hero.querySelector(".cf-mag-image");

      if (!img || !url) {
        markFallback(hero);
        return;
      }

      img.style.objectPosition = position;

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
