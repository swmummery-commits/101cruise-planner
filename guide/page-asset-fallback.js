(() => {
  "use strict";

  const RAW_BASE = "https://raw.githubusercontent.com/swmummery-commits/101cruise-planner/main/guide/pages";
  const CACHE_KEY = Date.now().toString(36);
  const PAGE_RE = /(?:^|\/)page-(\d{2})\.webp(?:\?.*)?$/i;

  document.addEventListener("error", (event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement)) return;

    const src = img.currentSrc || img.src || "";
    const match = src.match(PAGE_RE);
    if (!match) return;

    // If the GitHub fallback itself fails, allow the normal viewer error
    // handler to run rather than retrying forever.
    if (img.dataset.githubFallbackTried === "1") return;

    img.dataset.githubFallbackTried = "1";

    // Stop the original Netlify image error reaching viewer-v3's onerror
    // handler. The same <img> element is immediately retried from GitHub.
    event.preventDefault();
    event.stopImmediatePropagation();

    const page = match[1];
    img.src = `${RAW_BASE}/page-${page}.webp?v=${CACHE_KEY}`;
  }, true);
})();
