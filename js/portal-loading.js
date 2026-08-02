/**
 * Shared Client Portal loading overlay with reference counting.
 * Browser global: PortalLoading
 *
 * When embedded in Squarespace, positions the overlay using parent-visible
 * viewport geometry from 101cruise-parent-viewport postMessage (never
 * screen.availHeight / pointer heuristics / full iframe mid-point).
 */
(function (root) {
  "use strict";

  const OVERLAY_ID = "portal-loading-overlay";
  const BODY_LOCK_CLASS = "portal-loading-active";
  const PARENT_GEOMETRY_CLASS = "portal-loading-overlay--parent-viewport";
  const INITIAL_MESSAGE = "Hang tight! Just getting your info.";
  const FAIL_MESSAGE =
    "Something didn't load properly. Please try again in a moment.";
  let supportEl = null;

  const bridge =
    typeof root.PortalParentViewport !== "undefined" ? root.PortalParentViewport : null;
  const PARENT_ORIGINS = bridge
    ? bridge.PARENT_ORIGINS
    : ["https://www.101cruise.com.au", "https://101cruise.com.au"];
  const MSG = bridge
    ? bridge.MSG
    : {
        PARENT_VIEWPORT: "101cruise-parent-viewport",
        REQUEST_PARENT_VIEWPORT: "101cruise-request-parent-viewport",
        LOADING_STATE: "101cruise-portal-loading-state"
      };

  const refs = new Map();
  let overlayEl = null;
  let messageEl = null;
  let failTimer = null;
  let activeCount = 0;
  let scrollLocked = false;
  let savedScrollX = 0;
  let savedScrollY = 0;
  let savedHtmlOverflow = "";
  let savedBodyOverflow = "";
  let savedHtmlOverscroll = "";
  let savedBodyOverscroll = "";
  let latestParentGeometry = null;
  let parentListenerBound = false;
  let parentLoadingNotified = false;

  function prefersReducedMotion() {
    return (
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function isEmbedded() {
    return typeof window !== "undefined" && window.parent && window.parent !== window;
  }

  function isAllowedParentOrigin(origin) {
    if (bridge && bridge.isAllowedParentOrigin) return bridge.isAllowedParentOrigin(origin);
    return PARENT_ORIGINS.indexOf(String(origin || "")) !== -1;
  }

  function postToParents(payload) {
    if (!isEmbedded()) return;
    for (let i = 0; i < PARENT_ORIGINS.length; i += 1) {
      try {
        window.parent.postMessage(payload, PARENT_ORIGINS[i]);
      } catch (_err) {
        /* ignore */
      }
    }
  }

  function resolveOverlayBox(parentGeometry, fallbackInnerHeight) {
    if (bridge && bridge.resolveOverlayBox) {
      return bridge.resolveOverlayBox(parentGeometry, fallbackInnerHeight);
    }
    if (
      parentGeometry &&
      Number.isFinite(Number(parentGeometry.visibleTop)) &&
      Number.isFinite(Number(parentGeometry.visibleHeight)) &&
      Number(parentGeometry.visibleHeight) > 0
    ) {
      return {
        mode: "parent",
        top: Math.max(0, Math.round(Number(parentGeometry.visibleTop))),
        height: Math.max(1, Math.round(Number(parentGeometry.visibleHeight)))
      };
    }
    const h = Math.max(1, Math.round(Number(fallbackInnerHeight) || 0) || 800);
    return { mode: "direct", top: 0, height: h };
  }

  function requestParentViewport() {
    postToParents({ type: MSG.REQUEST_PARENT_VIEWPORT });
  }

  function notifyParentLoading(active) {
    if (!isEmbedded()) return;
    if (active && parentLoadingNotified) return;
    if (!active && !parentLoadingNotified) return;
    parentLoadingNotified = Boolean(active);
    postToParents({ type: MSG.LOADING_STATE, active: Boolean(active) });
  }

  function bindParentViewportListener() {
    if (parentListenerBound || typeof window === "undefined") return;
    parentListenerBound = true;
    window.addEventListener("message", function (event) {
      if (!isAllowedParentOrigin(event.origin)) return;
      const data = event.data || {};
      if (!data || data.type !== MSG.PARENT_VIEWPORT) return;
      const visibleTop = Number(data.visibleTop);
      const visibleHeight = Number(data.visibleHeight);
      if (!Number.isFinite(visibleTop) || !Number.isFinite(visibleHeight)) return;

      if (visibleHeight > 0) {
        latestParentGeometry = {
          visibleTop: visibleTop,
          visibleHeight: visibleHeight,
          visibleWidth: Number(data.visibleWidth) || 0,
          iframeHeight: Number(data.iframeHeight) || 0,
          parentViewportHeight: Number(data.parentViewportHeight) || 0
        };
      }
      // visibleHeight === 0 → keep most recent valid geometry

      if (activeCount > 0) applyOverlayGeometry();
    });
  }

  function applyOverlayGeometry() {
    ensureOverlay();
    if (!overlayEl) return;

    const fallback =
      (typeof window !== "undefined" &&
        window.visualViewport &&
        window.visualViewport.height) ||
      (typeof window !== "undefined" && window.innerHeight) ||
      800;

    const box = resolveOverlayBox(latestParentGeometry, fallback);
    overlayEl.style.position = "fixed";
    overlayEl.style.left = "0";
    overlayEl.style.right = "0";
    overlayEl.style.width = "100%";
    overlayEl.style.top = box.top + "px";
    overlayEl.style.bottom = "auto";
    overlayEl.style.height = box.height + "px";
    overlayEl.style.maxHeight = box.height + "px";
    overlayEl.style.margin = "0";
    overlayEl.style.transform = "none";
    overlayEl.classList.toggle(PARENT_GEOMETRY_CLASS, box.mode === "parent");
  }

  function clearOverlayGeometry() {
    if (!overlayEl) return;
    overlayEl.classList.remove(PARENT_GEOMETRY_CLASS);
    overlayEl.style.top = "";
    overlayEl.style.bottom = "";
    overlayEl.style.height = "";
    overlayEl.style.maxHeight = "";
    overlayEl.style.width = "";
    overlayEl.style.left = "";
    overlayEl.style.right = "";
    overlayEl.style.margin = "";
    overlayEl.style.transform = "";
    overlayEl.style.position = "";
  }

  function lockScroll() {
    if (scrollLocked || typeof document === "undefined") return;
    scrollLocked = true;
    savedScrollX = window.scrollX || window.pageXOffset || 0;
    savedScrollY = window.scrollY || window.pageYOffset || 0;
    savedHtmlOverflow = document.documentElement.style.overflow;
    savedBodyOverflow = document.body.style.overflow;
    savedHtmlOverscroll = document.documentElement.style.overscrollBehavior;
    savedBodyOverscroll = document.body.style.overscrollBehavior;
    document.documentElement.classList.add(BODY_LOCK_CLASS);
    document.body.classList.add(BODY_LOCK_CLASS);
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    document.documentElement.style.overscrollBehavior = "none";
    document.body.style.overscrollBehavior = "none";
    if (typeof window.scrollTo === "function") {
      window.scrollTo(savedScrollX, savedScrollY);
    }
  }

  function unlockScroll() {
    if (!scrollLocked || typeof document === "undefined") return;
    document.documentElement.classList.remove(BODY_LOCK_CLASS);
    document.body.classList.remove(BODY_LOCK_CLASS);
    document.documentElement.style.overflow = savedHtmlOverflow;
    document.body.style.overflow = savedBodyOverflow;
    document.documentElement.style.overscrollBehavior = savedHtmlOverscroll;
    document.body.style.overscrollBehavior = savedBodyOverscroll;
    scrollLocked = false;
    if (typeof window.scrollTo === "function") {
      window.scrollTo(savedScrollX, savedScrollY);
    }
  }

  function ensureOverlay() {
    if (overlayEl || typeof document === "undefined") return overlayEl;

    bindParentViewportListener();

    overlayEl = document.createElement("div");
    overlayEl.id = OVERLAY_ID;
    overlayEl.className = "portal-loading-overlay";
    overlayEl.setAttribute("role", "status");
    overlayEl.setAttribute("aria-hidden", "true");
    overlayEl.innerHTML =
      '<div class="portal-loading-panel">' +
      (typeof BrandLoading !== "undefined" && BrandLoading.html
        ? BrandLoading.html({ large: true, className: "portal-loading-spinner" })
        : '<div class="portal-loading-spinner brand-loading-boxes brand-loading-boxes--large" aria-hidden="true">' +
          new Array(10).join("<span></span>") +
          "</div>") +
      `<p class="portal-loading-message" aria-live="polite">${INITIAL_MESSAGE}</p>` +
      '<p class="portal-loading-support" hidden></p>' +
      "</div>";

    document.body.appendChild(overlayEl);
    messageEl = overlayEl.querySelector(".portal-loading-message");
    supportEl = overlayEl.querySelector(".portal-loading-support");

    if (prefersReducedMotion()) {
      overlayEl.classList.add("portal-loading-reduced-motion");
    }

    return overlayEl;
  }

  function clearTimers() {
    if (failTimer) {
      clearTimeout(failTimer);
      failTimer = null;
    }
  }

  function setMessage(text) {
    ensureOverlay();
    if (messageEl) messageEl.textContent = text;
  }

  function setSupportMessage(text) {
    ensureOverlay();
    if (!supportEl) return;
    const value = String(text || "").trim();
    if (value) {
      supportEl.textContent = value;
      supportEl.hidden = false;
    } else {
      supportEl.textContent = "";
      supportEl.hidden = true;
    }
  }

  function syncVisibility() {
    ensureOverlay();
    if (!overlayEl) return;

    const visible = activeCount > 0;
    overlayEl.classList.toggle("is-visible", visible);
    overlayEl.setAttribute("aria-hidden", visible ? "false" : "true");

    if (visible) {
      requestParentViewport();
      applyOverlayGeometry();
      lockScroll();
      notifyParentLoading(true);
    } else {
      clearTimers();
      setMessage(INITIAL_MESSAGE);
      setSupportMessage("");
      clearOverlayGeometry();
      unlockScroll();
      notifyParentLoading(false);
    }
  }

  function show(tokenOrKey, message, supportMessage) {
    const key = String(tokenOrKey || "default");
    const previous = refs.get(key) || 0;
    refs.set(key, previous + 1);

    if (previous === 0) {
      activeCount += 1;
    }

    ensureOverlay();

    if (activeCount === 1) {
      setMessage(INITIAL_MESSAGE);
      setSupportMessage("");
      clearTimers();
    }

    syncVisibility();
    return key;
  }

  function hide(tokenOrKey) {
    const key = String(tokenOrKey || "default");
    const previous = refs.get(key) || 0;
    if (previous <= 0) return;

    const next = previous - 1;
    if (next <= 0) {
      refs.delete(key);
      activeCount = Math.max(0, activeCount - 1);
    } else {
      refs.set(key, next);
    }

    syncVisibility();
  }

  function fail(message) {
    setMessage(message || FAIL_MESSAGE);
    clearTimers();

    failTimer = setTimeout(function () {
      refs.clear();
      activeCount = 0;
      syncVisibility();
    }, 2500);
  }

  async function withLoading(asyncFn, options) {
    const opts = options && typeof options === "object" ? options : {};
    const delayMs = Number.isFinite(Number(opts.delayMs)) ? Number(opts.delayMs) : 250;
    const button = opts.button || null;
    const message = opts.message ? String(opts.message) : null;
    const supportMessage = opts.supportMessage != null ? String(opts.supportMessage) : null;
    const token = String(opts.key || `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

    let uiStarted = false;
    let overlayShown = false;
    let buttonWasDisabled = false;
    let delayTimer = null;
    let settled = false;

    function startUi() {
      if (uiStarted || settled) return;
      uiStarted = true;
      overlayShown = true;
      show(token, message, supportMessage);
      if (button) {
        buttonWasDisabled = Boolean(button.disabled);
        button.disabled = true;
        button.classList.add("portal-loading-button-busy");
      }
    }

    delayTimer = setTimeout(startUi, Math.max(0, delayMs));

    try {
      return await asyncFn();
    } catch (error) {
      if (!overlayShown) startUi();
      fail();
      throw error;
    } finally {
      settled = true;
      clearTimeout(delayTimer);
      if (button && uiStarted) {
        button.disabled = buttonWasDisabled;
        button.classList.remove("portal-loading-button-busy");
      }
      if (overlayShown) hide(token);
    }
  }

  // Eagerly listen so geometry is warm before the first overlay show.
  if (typeof window !== "undefined") {
    bindParentViewportListener();
    if (isEmbedded()) requestParentViewport();
  }

  root.PortalLoading = {
    show: show,
    hide: hide,
    withLoading: withLoading,
    fail: fail,
    setMessage: setMessage,
    setSupportMessage: setSupportMessage,
    __test__: {
      resolveOverlayBox: resolveOverlayBox,
      isAllowedParentOrigin: isAllowedParentOrigin,
      BODY_LOCK_CLASS: BODY_LOCK_CLASS,
      PARENT_GEOMETRY_CLASS: PARENT_GEOMETRY_CLASS,
      INITIAL_MESSAGE: INITIAL_MESSAGE,
      getLatestParentGeometry: function () {
        return latestParentGeometry;
      },
      setLatestParentGeometryForTest: function (value) {
        latestParentGeometry = value;
      }
    }
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
