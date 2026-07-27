/**
 * Shared Client Portal loading overlay with reference counting.
 * Browser global: PortalLoading
 *
 * Positioning uses the iframe/layout viewport (fixed + 100dvh), never
 * document/scrollHeight centering. In tall auto-resized embeds, the overlay
 * band is anchored near the triggering control / last pointer so it stays in
 * the currently viewed slice of the iframe — without parent-window access.
 */
(function (root) {
  "use strict";

  const OVERLAY_ID = "portal-loading-overlay";
  const BODY_LOCK_CLASS = "portal-loading-active";
  const INITIAL_MESSAGE = "Give me a few seconds — I'm loading the information.";
  const SLOW_MESSAGE = "Still loading — this is taking a little longer than usual.";
  const FAIL_MESSAGE =
    "Something didn't load properly. Please try again in a moment.";

  const refs = new Map();
  let overlayEl = null;
  let messageEl = null;
  let slowTimer = null;
  let failTimer = null;
  let activeCount = 0;
  let scrollLocked = false;
  let savedScrollX = 0;
  let savedScrollY = 0;
  let savedHtmlOverflow = "";
  let savedBodyOverflow = "";
  let savedHtmlOverscroll = "";
  let savedBodyOverscroll = "";
  let lastPointerY = null;
  let pointerBound = false;

  function prefersReducedMotion() {
    return (
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function bindPointerTracking() {
    if (pointerBound || typeof document === "undefined") return;
    pointerBound = true;
    document.addEventListener(
      "pointerdown",
      function (event) {
        if (typeof event.clientY === "number") lastPointerY = event.clientY;
      },
      true
    );
  }

  /**
   * Pure helper: choose a viewport-sized band height (never document height).
   */
  function resolveViewportHeight(metrics) {
    const m = metrics || {};
    const visual = Number(m.visualViewportHeight) || 0;
    const inner = Number(m.innerHeight) || 0;
    const screenH = Number(m.screenAvailHeight) || 0;
    // Tall auto-resized iframe: innerHeight ≈ document height. Cap to a
    // device-like viewport so the panel is not centred mid-document.
    if (screenH > 0 && inner > screenH * 1.25) {
      return Math.max(240, Math.min(Math.round(screenH * 0.92), 960));
    }
    if (visual > 0 && (inner <= 0 || visual <= inner * 1.05)) {
      return Math.max(240, Math.round(visual));
    }
    if (inner > 0) return Math.max(240, Math.round(inner));
    if (screenH > 0) return Math.max(240, Math.min(Math.round(screenH * 0.92), 960));
    return 800;
  }

  /**
   * Pure helper: place a viewport-tall band around an anchor centre Y.
   */
  function computeOverlayBand(input) {
    const viewportHeight = resolveViewportHeight(input);
    const documentHeight = Math.max(Number(input && input.documentHeight) || 0, viewportHeight);
    const height = viewportHeight;
    const maxTop = Math.max(0, documentHeight - height);
    const hasAnchor = Number.isFinite(Number(input && input.anchorCenterY));
    const center = hasAnchor ? Number(input.anchorCenterY) : height / 2;
    const top = Math.max(0, Math.min(Math.round(center - height / 2), maxTop));
    return { top: top, height: height };
  }

  function readLiveMetrics(anchorEl) {
    const vv = typeof window !== "undefined" && window.visualViewport ? window.visualViewport : null;
    let anchorCenterY = null;
    if (anchorEl && typeof anchorEl.getBoundingClientRect === "function") {
      const rect = anchorEl.getBoundingClientRect();
      if (rect && Number.isFinite(rect.top)) {
        anchorCenterY = rect.top + (Number(rect.height) || 0) / 2 + (window.scrollY || 0);
      }
    } else if (typeof lastPointerY === "number") {
      anchorCenterY = lastPointerY + (window.scrollY || 0);
    }
    return {
      visualViewportHeight: vv && vv.height ? vv.height : 0,
      innerHeight: typeof window !== "undefined" ? window.innerHeight || 0 : 0,
      screenAvailHeight:
        typeof window !== "undefined" && window.screen ? window.screen.availHeight || 0 : 0,
      documentHeight: Math.max(
        (typeof document !== "undefined" && document.documentElement
          ? document.documentElement.scrollHeight
          : 0) || 0,
        (typeof document !== "undefined" && document.body ? document.body.scrollHeight : 0) || 0,
        (typeof window !== "undefined" ? window.innerHeight : 0) || 0
      ),
      anchorCenterY: anchorCenterY
    };
  }

  function applyOverlayGeometry(anchorEl) {
    ensureOverlay();
    if (!overlayEl) return;
    const band = computeOverlayBand(readLiveMetrics(anchorEl));
    overlayEl.style.position = "fixed";
    overlayEl.style.left = "0";
    overlayEl.style.right = "0";
    overlayEl.style.width = "100%";
    overlayEl.style.top = band.top + "px";
    overlayEl.style.bottom = "auto";
    overlayEl.style.height = band.height + "px";
    overlayEl.style.maxHeight = band.height + "px";
    overlayEl.style.margin = "0";
    overlayEl.style.transform = "none";
  }

  function clearOverlayGeometry() {
    if (!overlayEl) return;
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
    // Keep the same page position — do not jump to top.
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

    bindPointerTracking();

    overlayEl = document.createElement("div");
    overlayEl.id = OVERLAY_ID;
    overlayEl.className = "portal-loading-overlay";
    overlayEl.setAttribute("role", "status");
    overlayEl.setAttribute("aria-hidden", "true");
    overlayEl.innerHTML =
      '<div class="portal-loading-panel">' +
      '<div class="portal-loading-spinner" aria-hidden="true"></div>' +
      `<p class="portal-loading-message" aria-live="polite">${INITIAL_MESSAGE}</p>` +
      "</div>";

    document.body.appendChild(overlayEl);
    messageEl = overlayEl.querySelector(".portal-loading-message");

    if (prefersReducedMotion()) {
      overlayEl.classList.add("portal-loading-reduced-motion");
    }

    return overlayEl;
  }

  function clearTimers() {
    if (slowTimer) {
      clearTimeout(slowTimer);
      slowTimer = null;
    }
    if (failTimer) {
      clearTimeout(failTimer);
      failTimer = null;
    }
  }

  function setMessage(text) {
    ensureOverlay();
    if (messageEl) messageEl.textContent = text;
  }

  function syncVisibility(anchorEl) {
    ensureOverlay();
    if (!overlayEl) return;

    const visible = activeCount > 0;
    overlayEl.classList.toggle("is-visible", visible);
    overlayEl.setAttribute("aria-hidden", visible ? "false" : "true");

    if (visible) {
      applyOverlayGeometry(anchorEl || null);
      lockScroll();
    } else {
      clearTimers();
      setMessage(INITIAL_MESSAGE);
      clearOverlayGeometry();
      unlockScroll();
    }
  }

  function show(tokenOrKey, options) {
    const key = String(tokenOrKey || "default");
    const opts = options && typeof options === "object" ? options : {};
    const previous = refs.get(key) || 0;
    refs.set(key, previous + 1);

    if (previous === 0) {
      activeCount += 1;
    }

    ensureOverlay();

    if (activeCount === 1) {
      setMessage(INITIAL_MESSAGE);
      clearTimers();
      slowTimer = setTimeout(function () {
        setMessage(SLOW_MESSAGE);
      }, 4000);
    }

    syncVisibility(opts.anchor || opts.button || null);
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

    syncVisibility(null);
  }

  function fail(message) {
    setMessage(message || FAIL_MESSAGE);
    clearTimers();

    failTimer = setTimeout(function () {
      refs.clear();
      activeCount = 0;
      syncVisibility(null);
    }, 2500);
  }

  async function withLoading(asyncFn, options) {
    const opts = options && typeof options === "object" ? options : {};
    const delayMs = Number.isFinite(Number(opts.delayMs)) ? Number(opts.delayMs) : 250;
    const button = opts.button || null;
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
      show(token, { button: button, anchor: button });
      if (button) {
        buttonWasDisabled = Boolean(button.disabled);
        button.disabled = true;
        button.classList.add("portal-loading-button-busy");
      }
    }

    delayTimer = setTimeout(startUi, delayMs);

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

  root.PortalLoading = {
    show: show,
    hide: hide,
    withLoading: withLoading,
    fail: fail,
    __test__: {
      resolveViewportHeight: resolveViewportHeight,
      computeOverlayBand: computeOverlayBand,
      BODY_LOCK_CLASS: BODY_LOCK_CLASS
    }
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
