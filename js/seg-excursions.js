/**
 * My Cruise Shore Excursions Group deep-link enhancement.
 * Rewrites SEG checklist links to the customer's sailing-specific results page
 * whenever the ship has an SEG Ship ID mapping. Falls back to the agency homepage.
 */
(function () {
  "use strict";

  const SEG_HOSTS = new Set(["shoreexcursionsgroup.com", "www.shoreexcursionsgroup.com"]);
  const SEG_FALLBACK_URL = "https://www.shoreexcursionsgroup.com/?id=1721337&data=steve@101cruise.com.au&source=portal";

  let cachedCruiseKey = "";
  let cachedUrl = "";
  let lookupPromise = null;
  let rewriteQueued = false;

  function isSegUrl(value) {
    try {
      return SEG_HOSTS.has(new URL(value, window.location.origin).hostname.toLowerCase());
    } catch (_error) {
      return false;
    }
  }

  function cruiseKey(cruise) {
    return [
      cruise?.ship_name || "",
      cruise?.cruise_line || "",
      String(cruise?.departure_date || "").slice(0, 10),
      cruise?.nights || ""
    ].join("|");
  }

  async function resolveSegUrl() {
    if (typeof loadCurrentCruise !== "function") return SEG_FALLBACK_URL;

    const cruise = await loadCurrentCruise();
    if (!cruise) return SEG_FALLBACK_URL;

    const key = cruiseKey(cruise);
    if (cachedUrl && key === cachedCruiseKey) return cachedUrl;
    if (lookupPromise && key === cachedCruiseKey) return lookupPromise;

    cachedCruiseKey = key;
    const params = new URLSearchParams();
    params.set("ship_name", cruise.ship_name || "");
    params.set("cruise_line", cruise.cruise_line || "");
    params.set("departure_date", String(cruise.departure_date || "").slice(0, 10));
    params.set("nights", String(cruise.nights || ""));

    lookupPromise = fetch(`/.netlify/functions/seg-sailing-link?${params.toString()}`, {
      method: "GET",
      headers: { Accept: "application/json" }
    })
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        return data?.url || SEG_FALLBACK_URL;
      })
      .catch(() => SEG_FALLBACK_URL)
      .then((url) => {
        cachedUrl = url;
        return url;
      })
      .finally(() => {
        lookupPromise = null;
      });

    return lookupPromise;
  }

  async function rewriteSegLinks() {
    const links = Array.from(document.querySelectorAll('a[href*="shoreexcursionsgroup.com"]'))
      .filter((link) => isSegUrl(link.href));
    if (!links.length) return;

    const targetUrl = await resolveSegUrl();
    const isSailingSpecific = targetUrl.includes("/results/");

    links.forEach((link) => {
      link.href = targetUrl;
      link.dataset.segLink = isSailingSpecific ? "sailing" : "fallback";
      if (isSailingSpecific && !link.title) {
        link.title = "View shore excursions available for your cruise";
      }
    });
  }

  function queueRewrite() {
    if (rewriteQueued) return;
    rewriteQueued = true;
    queueMicrotask(() => {
      rewriteQueued = false;
      rewriteSegLinks().catch(() => {});
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", queueRewrite, { once: true });
  } else {
    queueRewrite();
  }

  const observer = new MutationObserver(queueRewrite);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
