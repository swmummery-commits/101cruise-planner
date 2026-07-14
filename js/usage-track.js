/**
 * 101cruise engagement tracking helper.
 *
 * Usage:
 *   CruiseUsage.trackPageOpen("packing");
 *   CruiseUsage.trackEvent("public_drinks_calculator", "tool_completed", { line_slug: "princess-cruises" });
 *
 * Never pass packing lists, budget values, notes, document contents, or other tool inputs.
 */
(function (root) {
  "use strict";

  const SESSION_KEY = "101cruise_usage_session_id";
  const PAGE_OPEN_KEY = "101cruise_usage_page_opens";
  const ENDPOINT = "/.netlify/functions/track-usage";

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
    try {
      if (root.navigator && typeof root.navigator.sendBeacon === "function") {
        const blob = new Blob([body], { type: "application/json" });
        root.navigator.sendBeacon(ENDPOINT, blob);
        return Promise.resolve({ success: true, beacon: true });
      }
    } catch (_error) {
      /* fall through */
    }

    return fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body,
      keepalive: true
    })
      .then(response => response.json().catch(() => ({ success: false })))
      .catch(() => ({ success: false }));
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
