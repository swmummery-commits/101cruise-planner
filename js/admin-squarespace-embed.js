/**
 * Squarespace parent-page bridge for Admin iframe.
 * Load on the Squarespace /admin page (same document as #101cruise-admin).
 *
 * Handles:
 * - 101cruise-admin-height → resize iframe for natural parent scrolling
 * - parent-visible viewport geometry → 101cruise-parent-viewport
 * - 101cruise-admin-loading-state → parent scroll lock while saving
 * - clear absolute/fixed site header so Admin is not tucked under the nav
 */
(function () {
  "use strict";

  var CHILD_ORIGIN = "https://admirable-tiramisu-d4da8a.netlify.app";
  var IFRAME_ID = "101cruise-admin";
  var MIN_HEIGHT = 480;
  var MAX_HEIGHT = 20000;
  var MSG_HEIGHT = "101cruise-admin-height";
  var MSG_VIEWPORT = "101cruise-parent-viewport";
  var MSG_REQUEST_VIEWPORT = "101cruise-request-parent-viewport";
  var MSG_LOADING = "101cruise-admin-loading-state";
  var HEADER_GAP_PX = 20;

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
    if (next > MAX_HEIGHT) next = MAX_HEIGHT;
    iframe.style.height = next + "px";
    iframe.setAttribute("height", String(next));
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

  /**
   * Squarespace /admin uses a full-bleed section with an absolute header.
   * Without top clearance the Admin iframe starts at y=0 under the nav.
   */
  function clearAbsoluteHeader() {
    var iframe = findFrame();
    if (!iframe) return;

    var header = document.getElementById("header");
    var headerHeight = 0;
    if (header) {
      var position = window.getComputedStyle(header).position;
      if (position === "absolute" || position === "fixed") {
        headerHeight = Math.ceil(header.getBoundingClientRect().height || 0);
      }
    }

    var sectionPad = 0;
    var node = iframe.parentElement;
    while (node && node !== document.body) {
      if (node.classList && node.classList.contains("page-section")) {
        sectionPad = parseFloat(window.getComputedStyle(node).paddingTop) || 0;
        break;
      }
      node = node.parentElement;
    }

    var needed = Math.max(0, Math.ceil(headerHeight + HEADER_GAP_PX - sectionPad));
    iframe.style.marginTop = needed ? needed + "px" : "";
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
      var top = (window.scrollY || window.pageYOffset || 0) + rect.top - HEADER_GAP_PX;
      window.scrollTo(0, Math.max(0, Math.ceil(top)));
      return;
    }

    if (data.type === "101cruise-scroll-to") {
      var targetFrame = findFrame();
      if (!targetFrame) return;
      var gap = Number.isFinite(Number(data.gap)) ? Number(data.gap) : HEADER_GAP_PX;
      var offsetTop = Math.max(0, Number(data.offsetTop) || 0);
      var frameRect = targetFrame.getBoundingClientRect();
      var absoluteTop =
        (window.scrollY || window.pageYOffset || 0) + frameRect.top + offsetTop - gap;
      window.scrollTo(0, Math.max(0, Math.ceil(absoluteTop)));
    }
  });

  function bindFrame() {
    var iframe = findFrame();
    if (!iframe) return;
    clearAbsoluteHeader();
    window.addEventListener("resize", clearAbsoluteHeader);
    window.addEventListener("scroll", scheduleViewport, { passive: true });
    window.addEventListener("resize", scheduleViewport);
    window.addEventListener("orientationchange", scheduleViewport);
    window.addEventListener("unload", unlockParentScroll);
    iframe.addEventListener("load", function () {
      clearAbsoluteHeader();
      scheduleViewport();
      try {
        iframe.contentWindow.postMessage({ type: "101cruise-request-admin-height" }, CHILD_ORIGIN);
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

  window.AdminSquarespaceEmbed = {
    CHILD_ORIGIN: CHILD_ORIGIN,
    IFRAME_ID: IFRAME_ID,
    MSG_HEIGHT: MSG_HEIGHT,
    computeParentVisibleGeometry: computeParentVisibleGeometry,
    clearAbsoluteHeader: clearAbsoluteHeader,
    HEADER_GAP_PX: HEADER_GAP_PX
  };
})();
