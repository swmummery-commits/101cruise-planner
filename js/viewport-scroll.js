/**
 * Scroll the active page/viewport to the top after SPA navigation.
 * Respects in-page hash targets when the linked element exists.
 * Browser global: ViewportScroll
 */
(function (root) {
  "use strict";

  var PARENT_ORIGINS = ["https://www.101cruise.com.au", "https://101cruise.com.au"];
  var MSG_SCROLL_TOP = "101cruise-scroll-top";

  function hasExplicitHashTarget() {
    var hash = String(root.location && root.location.hash ? root.location.hash : "").trim();
    if (!hash || hash === "#") return false;
    try {
      return Boolean(document.querySelector(hash));
    } catch (_error) {
      return false;
    }
  }

  function collectScrollRoots(extra) {
    var nodes = [
      document.scrollingElement,
      document.documentElement,
      document.body,
      document.getElementById("cruise-admin-app"),
      document.getElementById("cruise-planner-app"),
      extra
    ];
    return nodes.filter(Boolean);
  }

  function scrollViewportToTop(options) {
    var opts = options && typeof options === "object" ? options : {};
    if (opts.respectHash !== false && hasExplicitHashTarget()) return;

    var seen = new Set();
    var nodes = collectScrollRoots(opts.root);
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (seen.has(el)) continue;
      seen.add(el);
      try {
        if (typeof el.scrollTo === "function") el.scrollTo(0, 0);
        if ("scrollTop" in el) el.scrollTop = 0;
      } catch (_error) {
        /* ignore */
      }
    }

    try {
      root.scrollTo(0, 0);
    } catch (_error) {
      /* ignore */
    }

    if (root.parent && root.parent !== root) {
      for (var j = 0; j < PARENT_ORIGINS.length; j += 1) {
        try {
          root.parent.postMessage({ type: MSG_SCROLL_TOP }, PARENT_ORIGINS[j]);
        } catch (_error) {
          /* ignore */
        }
      }
    }
  }

  function scheduleScrollToTop(options) {
    root.requestAnimationFrame(function () {
      scrollViewportToTop(options);
      root.requestAnimationFrame(function () {
        scrollViewportToTop(options);
      });
    });
  }

  if (typeof document !== "undefined" && "scrollRestoration" in root.history) {
    root.history.scrollRestoration = "manual";
  }

  root.ViewportScroll = {
    scrollToTop: scrollViewportToTop,
    scheduleScrollToTop: scheduleScrollToTop,
    hasExplicitHashTarget: hasExplicitHashTarget,
    MSG_SCROLL_TOP: MSG_SCROLL_TOP,
    PARENT_ORIGINS: PARENT_ORIGINS
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
