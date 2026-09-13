/* Allow the public Ship Spotlight page to render an unsaved/admin preview by
 * forwarding preview=1 and ship_id to the public endpoint request. */
(function (global) {
  "use strict";

  if (global.__shipSpotlightPreviewBridgeInstalled || typeof global.fetch !== "function") return;
  const params = new URLSearchParams(global.location.search || "");
  const preview = params.get("preview") === "1";
  const shipId = String(params.get("ship_id") || params.get("shipId") || "").trim();
  if (!preview || !shipId) return;

  const originalFetch = global.fetch.bind(global);
  global.fetch = function (input, init) {
    try {
      const raw = typeof input === "string" ? input : String(input?.url || "");
      if (raw.includes("/.netlify/functions/public-ship-spotlight?") && !raw.includes("preview=1")) {
        const separator = raw.includes("?") ? "&" : "?";
        const next = `${raw}${separator}preview=1&ship_id=${encodeURIComponent(shipId)}`;
        return originalFetch(next, init);
      }
    } catch (_error) {
      // Fall through to the original request.
    }
    return originalFetch(input, init);
  };
  global.__shipSpotlightPreviewBridgeInstalled = true;
})(window);
