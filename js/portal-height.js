/**
 * Child-side My Cruise content-height reporter for Squarespace iframe embeds.
 * Browser global: PortalHeight
 *
 * Posts 101cruise-my-cruise-height to allowed parent origins only (never "*").
 */
(function (root) {
  "use strict";

  var PARENT_ORIGINS = ["https://www.101cruise.com.au", "https://101cruise.com.au"];
  var MSG_HEIGHT = "101cruise-my-cruise-height";
  var MSG_REQUEST_VIEWPORT = "101cruise-request-parent-viewport";
  var started = false;
  var debounceTimer = null;
  var raf = 0;

  function isEmbedded() {
    return typeof window !== "undefined" && window.parent && window.parent !== window;
  }

  function measureHeight() {
    var root = document.getElementById("cruise-planner-app");
    if (!root) return 400;
    // Measure app content only — body/document scrollHeight tracks the iframe
    // viewport and creates a resize feedback loop with the parent.
    var height = Math.max(root.scrollHeight || 0, root.offsetHeight || 0);
    return Math.max(Math.ceil(height + 12), 360);
  }

  function postToParents(payload) {
    if (!isEmbedded()) return;
    for (var i = 0; i < PARENT_ORIGINS.length; i += 1) {
      try {
        window.parent.postMessage(payload, PARENT_ORIGINS[i]);
      } catch (err) {
        /* ignore */
      }
    }
  }

  function postHeightNow() {
    postToParents({ type: MSG_HEIGHT, height: measureHeight() });
    postToParents({ type: MSG_REQUEST_VIEWPORT });
  }

  function schedulePost() {
    if (!isEmbedded()) return;
    if (raf) window.cancelAnimationFrame(raf);
    raf = window.requestAnimationFrame(function () {
      raf = 0;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        debounceTimer = null;
        postHeightNow();
      }, 80);
    });
  }

  function start() {
    if (started || typeof document === "undefined") return;
    if (!isEmbedded()) return;
    started = true;

    document.documentElement.classList.add("is-embedded");
    if (document.body) document.body.classList.add("is-embedded");

    var root = document.getElementById("cruise-planner-app");
    if (root && typeof MutationObserver !== "undefined") {
      new MutationObserver(schedulePost).observe(root, {
        childList: true,
        subtree: true,
        attributes: true
      });
    }
    if (root && typeof ResizeObserver !== "undefined") {
      new ResizeObserver(schedulePost).observe(root);
    }
    window.addEventListener("load", schedulePost);
    window.addEventListener("resize", schedulePost);
    schedulePost();
    window.setTimeout(postHeightNow, 120);
    window.setTimeout(postHeightNow, 450);
  }

  root.PortalHeight = {
    start: start,
    schedule: schedulePost,
    postNow: postHeightNow,
    measureHeight: measureHeight,
    PARENT_ORIGINS: PARENT_ORIGINS
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
