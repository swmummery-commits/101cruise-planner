/**
 * Shared Admin waiting overlay — nine-square BrandLoading + calm messages.
 * Browser global: AdminLoading
 */
(function (root) {
  "use strict";

  var OVERLAY_ID = "admin-loading-overlay";
  var BODY_LOCK_CLASS = "admin-loading-active";
  var INITIAL_MESSAGE = "Please wait…";
  var FAIL_MESSAGE = "Something didn't load properly. Please try again in a moment.";

  var refs = new Map();
  var overlayEl = null;
  var messageEl = null;
  var supportEl = null;
  var failTimer = null;
  var activeCount = 0;

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
    overlayEl.className = "admin-loading-overlay";
    overlayEl.setAttribute("role", "status");
    overlayEl.setAttribute("aria-live", "polite");
    overlayEl.setAttribute("aria-busy", "true");
    overlayEl.innerHTML =
      '<div class="admin-loading-panel">' +
      (typeof BrandLoading !== "undefined" && BrandLoading.html
        ? BrandLoading.html({ large: true, className: "admin-loading-spinner" })
        : '<span class="brand-loading-boxes brand-loading-boxes--large" aria-hidden="true">' +
          "<span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span>" +
          "</span>") +
      '<p class="admin-loading-message">' +
      INITIAL_MESSAGE +
      "</p>" +
      '<p class="admin-loading-support" hidden></p>' +
      "</div>";
    messageEl = overlayEl.querySelector(".admin-loading-message");
    supportEl = overlayEl.querySelector(".admin-loading-support");
    if (prefersReducedMotion()) {
      overlayEl.classList.add("admin-loading-reduced-motion");
    }
    document.body.appendChild(overlayEl);
    if (typeof BrandLoading !== "undefined" && BrandLoading.scan) {
      BrandLoading.scan(overlayEl);
    }
    return overlayEl;
  }

  function setMessage(message) {
    ensureOverlay();
    if (messageEl) messageEl.textContent = String(message || INITIAL_MESSAGE);
  }

  function setSupportMessage(message) {
    ensureOverlay();
    if (!supportEl) return;
    var text = String(message || "").trim();
    if (text) {
      supportEl.textContent = text;
      supportEl.hidden = false;
    } else {
      supportEl.textContent = "";
      supportEl.hidden = true;
    }
  }

  function clearTimers() {
    if (failTimer) {
      clearTimeout(failTimer);
      failTimer = null;
    }
  }

  function syncVisibility() {
    ensureOverlay();
    if (!overlayEl) return;
    var visible = activeCount > 0;
    overlayEl.classList.toggle("is-visible", visible);
    overlayEl.setAttribute("aria-busy", visible ? "true" : "false");
    if (typeof document !== "undefined" && document.body) {
      document.body.classList.toggle(BODY_LOCK_CLASS, visible);
    }
    if (!visible) {
      setSupportMessage("");
    }
  }

  function show(tokenOrKey, message, supportMessage) {
    var key = String(tokenOrKey || "default");
    var previous = refs.get(key) || 0;
    refs.set(key, previous + 1);
    if (previous === 0) activeCount += 1;

    clearTimers();
    if (activeCount === 1) {
      setMessage(message || INITIAL_MESSAGE);
      setSupportMessage(supportMessage || "");
    } else if (message) {
      setMessage(message);
      if (supportMessage != null) setSupportMessage(supportMessage);
    }
    syncVisibility();
    return key;
  }

  function hide(tokenOrKey) {
    var key = String(tokenOrKey || "default");
    var previous = refs.get(key) || 0;
    if (previous <= 0) return;
    var next = previous - 1;
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
    var opts = options && typeof options === "object" ? options : {};
    var delayMs = Number.isFinite(Number(opts.delayMs)) ? Number(opts.delayMs) : 0;
    var button = opts.button || null;
    var message = opts.message ? String(opts.message) : null;
    var supportMessage = opts.supportMessage != null ? String(opts.supportMessage) : null;
    var token = String(
      opts.key || "op-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8)
    );

    var uiStarted = false;
    var overlayShown = false;
    var buttonWasDisabled = false;
    var delayTimer = null;
    var settled = false;

    function startUi() {
      if (uiStarted || settled) return;
      uiStarted = true;
      overlayShown = true;
      show(token, message, supportMessage);
      if (button) {
        buttonWasDisabled = Boolean(button.disabled);
        button.disabled = true;
        button.classList.add("admin-loading-button-busy");
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
        button.classList.remove("admin-loading-button-busy");
      }
      if (overlayShown) hide(token);
    }
  }

  root.AdminLoading = {
    show: show,
    hide: hide,
    withLoading: withLoading,
    fail: fail,
    setMessage: setMessage,
    setSupportMessage: setSupportMessage
  };
})(typeof window !== "undefined" ? window : globalThis);
