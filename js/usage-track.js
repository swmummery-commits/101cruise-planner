/**
 * 101cruise engagement tracking helper.
 *
 * Usage:
 *   CruiseUsage.trackPageOpen("packing");
 *   CruiseUsage.trackEvent("public_drinks_calculator", "tool_completed", { line_slug: "princess-cruises" });
 *
 * Never pass packing lists, budget values, notes, document contents, or other tool inputs.
 *
 * When this script is loaded from Netlify while embedded on another host (e.g. Squarespace),
 * events are posted to the Netlify function origin — not the page origin.
 */
(function (root) {
  "use strict";

  const SESSION_KEY = "101cruise_usage_session_id";
  const PAGE_OPEN_KEY = "101cruise_usage_page_opens";
  const NETLIFY_ORIGIN = "https://admirable-tiramisu-d4da8a.netlify.app";
  const SCRIPT_EL = typeof document !== "undefined" ? document.currentScript : null;

  function getToolsOrigin() {
    if (SCRIPT_EL && SCRIPT_EL.src) {
      try {
        return new URL(SCRIPT_EL.src).origin;
      } catch (_error) {
        /* ignore */
      }
    }
    if (typeof document !== "undefined") {
      const scripts = document.querySelectorAll('script[src*="usage-track.js"]');
      const last = scripts[scripts.length - 1];
      if (last && last.src) {
        try {
          return new URL(last.src).origin;
        } catch (_error) {
          /* ignore */
        }
      }
    }
    if (root.location && /netlify\.app$/i.test(root.location.hostname || "")) {
      return root.location.origin;
    }
    return NETLIFY_ORIGIN;
  }

  const ENDPOINT = `${getToolsOrigin()}/.netlify/functions/track-usage`;

  function uuid() {
    if (root.crypto && typeof root.crypto.randomUUID === "function") {
      return root.crypto.randomUUID();
    }
    return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function getSessionId() {
    try {
      let id = root.sessionStorage.getItem(SESSION_KEY);
      if (!id) {
        id = uuid();
        root.sessionStorage.setItem(SESSION_KEY, id);
      }
      return id;
    } catch (_error) {
      return uuid();
    }
  }

  function getDeviceType() {
    const width = root.innerWidth || 0;
    if (width > 0 && width < 768) return "mobile";
    if (width > 0 && width < 1024) return "tablet";
    if (width > 0) return "desktop";
    return "unknown";
  }

  function getContext() {
    const context = (typeof root.getCruiseUsageContext === "function" && root.getCruiseUsageContext()) || {};
    return {
      surface: context.surface || "my_cruise",
      booking_reference: context.booking_reference || null,
      user_id: context.user_id || null,
      metadata: context.metadata && typeof context.metadata === "object" ? context.metadata : {}
    };
  }

  function pageOpenSeen(moduleName) {
    try {
      const raw = root.sessionStorage.getItem(PAGE_OPEN_KEY);
      const map = raw ? JSON.parse(raw) : {};
      return Boolean(map[moduleName]);
    } catch (_error) {
      return false;
    }
  }

  function markPageOpen(moduleName) {
    try {
      const raw = root.sessionStorage.getItem(PAGE_OPEN_KEY);
      const map = raw ? JSON.parse(raw) : {};
      map[moduleName] = true;
      root.sessionStorage.setItem(PAGE_OPEN_KEY, JSON.stringify(map));
    } catch (_error) {
      /* ignore */
    }
  }

  function postEvent(payload) {
    const body = JSON.stringify(payload);
    const sameOrigin =
      root.location && typeof root.location.origin === "string" && ENDPOINT.startsWith(root.location.origin);

    // Cross-origin embeds (e.g. Squarespace → Netlify): sendBeacon with application/json
    // often fails silently. Prefer fetch+keepalive so Public Tools insights stay accurate.
    const postWithFetch = () =>
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body,
        keepalive: true,
        mode: "cors",
        credentials: "omit"
      })
        .then((response) => response.json().catch(() => ({ success: false })))
        .catch(() => ({ success: false }));

    if (!sameOrigin) return postWithFetch();

    try {
      if (root.navigator && typeof root.navigator.sendBeacon === "function") {
        const blob = new Blob([body], { type: "text/plain;charset=UTF-8" });
        const queued = root.navigator.sendBeacon(ENDPOINT, blob);
        if (queued) return Promise.resolve({ success: true, beacon: true });
      }
    } catch (_error) {
      /* fall through to fetch */
    }

    return postWithFetch();
  }

  function trackEvent(moduleName, eventType, metadata) {
    const context = getContext();
    const safeMeta = Object.assign({}, context.metadata || {}, metadata || {});
    return postEvent({
      session_id: getSessionId(),
      surface: context.surface,
      module: moduleName,
      event_type: eventType,
      booking_reference: context.booking_reference,
      user_id: context.user_id,
      device_type: getDeviceType(),
      metadata: safeMeta,
      dedupe_page_open: eventType === "page_open"
    });
  }

  function trackPageOpen(moduleName, metadata) {
    if (pageOpenSeen(moduleName)) {
      return Promise.resolve({ success: true, deduped: true });
    }
    markPageOpen(moduleName);
    return trackEvent(moduleName, "page_open", metadata);
  }

  root.CruiseUsage = {
    trackPageOpen,
    trackEvent,
    getSessionId
  };
})(typeof window !== "undefined" ? window : globalThis);
