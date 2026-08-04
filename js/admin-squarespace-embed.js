/**
 * Squarespace parent-page bridge for Admin iframe.
 * Load on the Squarespace /admin page (same document as #101cruise-admin).
 *
 * Handles:
 * - 101cruise-admin-height → resize iframe for natural parent scrolling
 * - clear absolute/fixed site header so Admin is not tucked under the nav
 */
(function () {
  "use strict";

  var CHILD_ORIGIN = "https://admirable-tiramisu-d4da8a.netlify.app";
  var IFRAME_ID = "101cruise-admin";
  var MIN_HEIGHT = 480;
  var MAX_HEIGHT = 20000;
  var MSG_HEIGHT = "101cruise-admin-height";
  var HEADER_GAP_PX = 20;

  function findFrame() {
    return document.getElementById(IFRAME_ID);
  }

  function isChildOrigin(origin) {
    return String(origin || "") === CHILD_ORIGIN;
  }

  function applyIframeHeight(px) {
    var iframe = findFrame();
    if (!iframe) return;
    var next = Math.max(MIN_HEIGHT, Math.ceil(Number(px) || 0));
    if (next > MAX_HEIGHT) next = MAX_HEIGHT;
    iframe.style.height = next + "px";
    iframe.setAttribute("height", String(next));
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
    }
  });

  function bindFrame() {
    var iframe = findFrame();
    if (!iframe) return;
    clearAbsoluteHeader();
    window.addEventListener("resize", clearAbsoluteHeader);
    iframe.addEventListener("load", function () {
      clearAbsoluteHeader();
      // Ask child to re-report after load (in case first posts were missed).
      try {
        iframe.contentWindow.postMessage(
          { type: "101cruise-request-admin-height" },
          CHILD_ORIGIN
        );
      } catch (err) {
        /* ignore */
      }
    });
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
    clearAbsoluteHeader: clearAbsoluteHeader,
    HEADER_GAP_PX: HEADER_GAP_PX
  };
})();
