/**
 * Shared Client Portal loading overlay with reference counting.
 * Browser global: PortalLoading
 */
(function (root) {
  "use strict";

  const OVERLAY_ID = "portal-loading-overlay";
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

  function prefersReducedMotion() {
    return (
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function ensureOverlay() {
    if (overlayEl || typeof document === "undefined") return overlayEl;

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

  function syncVisibility() {
    ensureOverlay();
    if (!overlayEl) return;

    const visible = activeCount > 0;
    overlayEl.classList.toggle("is-visible", visible);
    overlayEl.setAttribute("aria-hidden", visible ? "false" : "true");

    if (!visible) {
      clearTimers();
      setMessage(INITIAL_MESSAGE);
    }
  }

  function show(tokenOrKey) {
    const key = String(tokenOrKey || "default");
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
      show(token);
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
    fail: fail
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
