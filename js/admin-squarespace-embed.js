/**
 * Squarespace parent-page bridge for Admin iframe.
 * Load on the Squarespace /admin page (same document as #101cruise-admin).
 *
 * Handles:
 * - 101cruise-admin-height → resize iframe for natural parent scrolling
 */
(function () {
  "use strict";

  var CHILD_ORIGIN = "https://admirable-tiramisu-d4da8a.netlify.app";
  var IFRAME_ID = "101cruise-admin";
  var MIN_HEIGHT = 480;
  var MAX_HEIGHT = 20000;
  var MSG_HEIGHT = "101cruise-admin-height";

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

  window.addEventListener("message", function (event) {
    if (!isChildOrigin(event.origin)) return;
    var data = event.data || {};
    if (!data || typeof data !== "object") return;
    if (data.type === MSG_HEIGHT) {
      applyIframeHeight(data.height);
    }
  });

  function bindFrame() {
    var iframe = findFrame();
    if (!iframe) return;
    iframe.addEventListener("load", function () {
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
    MSG_HEIGHT: MSG_HEIGHT
  };
})();
