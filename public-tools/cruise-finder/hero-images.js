/**
 * Cruise Finder — destination hero images (verified URLs only).
 *
 * Selection order:
 *   1. Approved seasonal image for the traveller’s month (when configured)
 *   2. Approved general destination image
 *   3. Branded gradient fallback if the image fails to load
 *
 * No live/random image search during normal page use.
 */
(function (root) {
  "use strict";

  function pick(dest, travelMonth) {
    const id = dest && dest.id ? dest.id : "";
    if (typeof root.CruiseFinderPickDestinationImage === "function") {
      return root.CruiseFinderPickDestinationImage(id, travelMonth);
    }
    if (dest && dest.image_url) {
      return { url: dest.image_url, objectPosition: "center center" };
    }
    return null;
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

      const url = hero.getAttribute("data-image-url") || "";
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
    /* Compatibility stubs — live search removed */
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
