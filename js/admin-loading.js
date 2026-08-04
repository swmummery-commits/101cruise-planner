/**
 * Shared Admin waiting overlay — nine-square BrandLoading + calm messages.
 * Positions in the visible viewport when embedded (parent geometry postMessage).
 * Browser global: AdminLoading
 */
(function (root) {
  "use strict";

  var OVERLAY_ID = "admin-loading-overlay";
  var BODY_LOCK_CLASS = "admin-loading-active";
  var PARENT_GEOMETRY_CLASS = "admin-loading-overlay--parent-viewport";
  var VISUAL_GEOMETRY_CLASS = "admin-loading-overlay--visual-viewport";
  var INITIAL_MESSAGE =
    typeof BrandLoading !== "undefined" && BrandLoading.CANONICAL_MESSAGE
      ? BrandLoading.CANONICAL_MESSAGE
      : "Hang tight! Just getting your info.";
  var SAVING_MESSAGE =
    typeof BrandLoading !== "undefined" && BrandLoading.SAVING_MESSAGE
      ? BrandLoading.SAVING_MESSAGE
      : "Hang tight! Saving your info.";
  var FAIL_MESSAGE = "Something didn't load properly. Please try again in a moment.";

  var bridge =
    typeof root.PortalParentViewport !== "undefined" ? root.PortalParentViewport : null;
  var PARENT_ORIGINS = bridge
    ? bridge.PARENT_ORIGINS
    : ["https://www.101cruise.com.au", "https://101cruise.com.au"];
  var MSG = bridge
    ? bridge.MSG
    : {
        PARENT_VIEWPORT: "101cruise-parent-viewport",
        REQUEST_PARENT_VIEWPORT: "101cruise-request-parent-viewport",
        LOADING_STATE: "101cruise-admin-loading-state"
      };

  var refs = new Map();
  var overlayEl = null;
  var messageEl = null;
  var supportEl = null;
  var failTimer = null;
  var activeCount = 0;
  var latestParentGeometry = null;
  var parentListenerBound = false;
  var geometryListenersBound = false;
  var parentLoadingNotified = false;

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
    for (var i = 0; i < PARENT_ORIGINS.length; i += 1) {
      try {
        window.parent.postMessage(payload, PARENT_ORIGINS[i]);
      } catch (_error) {
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
    var h = Math.max(1, Math.round(Number(fallbackInnerHeight) || 0) || 800);
    return { mode: "direct", top: 0, height: h };
  }

  function resolveLocalViewportBox() {
    var vv = typeof window !== "undefined" && window.visualViewport;
    if (vv && Number.isFinite(vv.offsetTop) && Number.isFinite(vv.height) && vv.height > 0) {
      return {
        mode: "visual",
        top: Math.max(0, Math.round(vv.offsetTop)),
        height: Math.max(1, Math.round(vv.height))
      };
    }
    return null;
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
      var data = event.data || {};
      if (!data || data.type !== MSG.PARENT_VIEWPORT) return;
      var visibleTop = Number(data.visibleTop);
      var visibleHeight = Number(data.visibleHeight);
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

      if (activeCount > 0) applyOverlayGeometry();
    });
  }

  function bindGeometryListeners() {
    if (geometryListenersBound || typeof window === "undefined") return;
    geometryListenersBound = true;
    var schedule = function () {
      if (activeCount > 0) {
        requestParentViewport();
        applyOverlayGeometry();
      }
    };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("scroll", schedule);
      window.visualViewport.addEventListener("resize", schedule);
    }
  }

  function applyOverlayGeometry() {
    ensureOverlay();
    if (!overlayEl) return;

    var fallback =
      (typeof window !== "undefined" &&
        window.visualViewport &&
        window.visualViewport.height) ||
      (typeof window !== "undefined" && window.innerHeight) ||
      800;

    var box = resolveOverlayBox(latestParentGeometry, fallback);
    if (box.mode !== "parent") {
      var local = resolveLocalViewportBox();
      if (local) box = local;
    }

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
    overlayEl.classList.toggle(VISUAL_GEOMETRY_CLASS, box.mode === "visual");
  }

  function clearOverlayGeometry() {
    if (!overlayEl) return;
    overlayEl.classList.remove(PARENT_GEOMETRY_CLASS);
    overlayEl.classList.remove(VISUAL_GEOMETRY_CLASS);
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

  function ensureOverlay() {
    if (overlayEl || typeof document === "undefined") return overlayEl;

    bindParentViewportListener();
    bindGeometryListeners();

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

    if (visible) {
      requestParentViewport();
      applyOverlayGeometry();
      notifyParentLoading(true);
    } else {
      clearOverlayGeometry();
      notifyParentLoading(false);
    }

    if (typeof document !== "undefined" && document.body) {
      document.body.classList.remove(BODY_LOCK_CLASS);
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

  async function withSaving(asyncFn, options) {
    var opts = options && typeof options === "object" ? options : {};
    return withLoading(asyncFn, {
      delayMs: Number.isFinite(Number(opts.delayMs)) ? Number(opts.delayMs) : 0,
      key: opts.key || "admin-saving",
      message: opts.message ? String(opts.message) : SAVING_MESSAGE,
      supportMessage: opts.supportMessage != null ? String(opts.supportMessage) : null,
      button: opts.button || null
    });
  }

  root.AdminLoading = {
    show: show,
    hide: hide,
    withLoading: withLoading,
    withSaving: withSaving,
    fail: fail,
    setMessage: setMessage,
    setSupportMessage: setSupportMessage,
    SAVING_MESSAGE: SAVING_MESSAGE
  };
})(typeof window !== "undefined" ? window : globalThis);
