/**
 * Squarespace parent-page bridge for My Cruise iframe.
 * Load on the Squarespace /my-cruise page (same document as #101cruise-my-cruise).
 *
 * Handles:
 * - 101cruise-my-cruise-height → resize iframe for natural parent scrolling
 * - parent-visible viewport geometry → 101cruise-parent-viewport
 * - 101cruise-portal-loading-state → parent scroll lock
 */
(function () {
  "use strict";

  var CHILD_ORIGIN = "https://admirable-tiramisu-d4da8a.netlify.app";
  var IFRAME_ID = "101cruise-my-cruise";
  var MIN_HEIGHT = 360;
  var MAX_HEIGHT = 12000;

  var MSG_HEIGHT = "101cruise-my-cruise-height";
  var MSG_VIEWPORT = "101cruise-parent-viewport";
  var MSG_REQUEST_VIEWPORT = "101cruise-request-parent-viewport";
  var MSG_LOADING = "101cruise-portal-loading-state";

  var raf = 0;
  var loadingActive = false;
  var savedScrollX = 0;
  var savedScrollY = 0;
  var savedHtmlOverflow = "";
  var savedBodyOverflow = "";
  var savedHtmlOverscroll = "";
  var savedBodyOverscroll = "";

  function findFrame() {
    return document.getElementById(IFRAME_ID);
  }

  function isChildOrigin(origin) {
    return String(origin || "") === CHILD_ORIGIN;
  }

  function computeParentVisibleGeometry(iframeRect, parentInnerHeight, parentInnerWidth) {
    var iframeHeight = Math.max(0, Number(iframeRect && iframeRect.height) || 0);
    var iframeWidth = Math.max(0, Number(iframeRect && iframeRect.width) || 0);
    var parentH = Math.max(0, Number(parentInnerHeight) || 0);
    var parentW = Math.max(0, Number(parentInnerWidth) || 0);
    var top = Number(iframeRect && iframeRect.top);
    var safeTop = isFinite(top) ? top : 0;
    var visibleTop = Math.max(0, -safeTop);
    var visibleBottom = Math.min(iframeHeight, parentH - safeTop);
    var visibleHeight = Math.max(0, visibleBottom - visibleTop);
    return {
      type: MSG_VIEWPORT,
      visibleTop: Math.round(visibleTop),
      visibleHeight: Math.round(visibleHeight),
      visibleWidth: Math.round(iframeWidth || parentW || 0),
      iframeHeight: Math.round(iframeHeight),
      parentViewportHeight: Math.round(parentH)
    };
  }

  function postViewport() {
    var iframe = findFrame();
    if (!iframe || !iframe.contentWindow) return;
    var rect = iframe.getBoundingClientRect();
    var payload = computeParentVisibleGeometry(rect, window.innerHeight, window.innerWidth);
    try {
      iframe.contentWindow.postMessage(payload, CHILD_ORIGIN);
    } catch (err) {
      /* ignore */
    }
  }

  function scheduleViewport() {
    if (raf) return;
    raf = window.requestAnimationFrame(function () {
      raf = 0;
      postViewport();
    });
  }

  function applyIframeHeight(px) {
    var iframe = findFrame();
    if (!iframe) return;
    var next = Math.max(MIN_HEIGHT, Math.ceil(Number(px) || 0));
    if (next > MAX_HEIGHT) return;
    iframe.style.height = next + "px";
    iframe.setAttribute("height", String(next));
    iframe.style.overflow = "hidden";
    iframe.style.overscrollBehavior = "none";
    iframe.setAttribute("scrolling", "no");
    scheduleViewport();
  }

  function lockParentScroll() {
    if (loadingActive) return;
    loadingActive = true;
    savedScrollX = window.scrollX || window.pageXOffset || 0;
    savedScrollY = window.scrollY || window.pageYOffset || 0;
    savedHtmlOverflow = document.documentElement.style.overflow;
    savedBodyOverflow = document.body.style.overflow;
    savedHtmlOverscroll = document.documentElement.style.overscrollBehavior;
    savedBodyOverscroll = document.body.style.overscrollBehavior;
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    document.documentElement.style.overscrollBehavior = "none";
    document.body.style.overscrollBehavior = "none";
    if (typeof window.scrollTo === "function") {
      window.scrollTo(savedScrollX, savedScrollY);
    }
  }

  function unlockParentScroll() {
    if (!loadingActive) return;
    document.documentElement.style.overflow = savedHtmlOverflow;
    document.body.style.overflow = savedBodyOverflow;
    document.documentElement.style.overscrollBehavior = savedHtmlOverscroll;
    document.body.style.overscrollBehavior = savedBodyOverscroll;
    loadingActive = false;
    if (typeof window.scrollTo === "function") {
      window.scrollTo(savedScrollX, savedScrollY);
    }
  }

  window.addEventListener("message", function (event) {
    if (!isChildOrigin(event.origin)) return;
    var data = event.data || {};
    if (!data || typeof data !== "object") return;

    if (data.type === MSG_HEIGHT) {
      applyIframeHeight(data.height);
      return;
    }

    if (data.type === MSG_REQUEST_VIEWPORT) {
      scheduleViewport();
      return;
    }

    if (data.type === MSG_LOADING) {
      if (data.active === true) lockParentScroll();
      else if (data.active === false) unlockParentScroll();
      return;
    }

    if (data.type === "101cruise-scroll-top") {
      var iframe = findFrame();
      if (!iframe) return;
      try {
        iframe.scrollIntoView({ block: "start", behavior: "auto" });
      } catch (err) {
        /* ignore */
      }
      var rect = iframe.getBoundingClientRect();
      var top = (window.scrollY || window.pageYOffset || 0) + rect.top - 12;
      window.scrollTo(0, Math.max(0, Math.ceil(top)));
    }
  });

  window.addEventListener("scroll", scheduleViewport, { passive: true });
  window.addEventListener("resize", scheduleViewport);
  window.addEventListener("orientationchange", scheduleViewport);
  window.addEventListener("unload", unlockParentScroll);

  function bindFrame() {
    var iframe = findFrame();
    if (!iframe) return;
    iframe.style.overflow = "hidden";
    iframe.style.overscrollBehavior = "none";
    iframe.setAttribute("scrolling", "no");
    iframe.addEventListener("load", function () {
      scheduleViewport();
      try {
        iframe.contentWindow.postMessage({ type: MSG_REQUEST_VIEWPORT }, CHILD_ORIGIN);
      } catch (err) {
        /* ignore */
      }
    });
    scheduleViewport();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindFrame);
  } else {
    bindFrame();
  }

  // Expose pure helper for diagnostics / tests when loaded in Node via vm.
  window.PortalSquarespaceEmbed = {
    computeParentVisibleGeometry: computeParentVisibleGeometry,
    CHILD_ORIGIN: CHILD_ORIGIN,
    IFRAME_ID: IFRAME_ID
  };
})();
