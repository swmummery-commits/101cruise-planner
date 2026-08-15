/**
 * Scroll the active page/viewport to the top after SPA navigation.
 * Respects in-page hash targets when the linked element exists.
 * Also scrolls a specific element into place (local + Squarespace parent).
 * Browser global: ViewportScroll
 */
(function (root) {
  "use strict";

  var PARENT_ORIGINS = ["https://www.101cruise.com.au", "https://101cruise.com.au"];
  var MSG_SCROLL_TOP = "101cruise-scroll-top";
  var MSG_SCROLL_TO = "101cruise-scroll-to";
  var MSG_REQUEST_PARENT_VIEWPORT = "101cruise-request-parent-viewport";
  var MSG_PARENT_VIEWPORT = "101cruise-parent-viewport";
  var DEFAULT_GAP_PX = 24;
  var latestParentGeometry = null;

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

  function onParentViewportMessage(event) {
    if (PARENT_ORIGINS.indexOf(String(event.origin || "")) === -1) return;
    var data = event.data;
    if (!data || data.type !== MSG_PARENT_VIEWPORT) return;
    var visibleTop = Number(data.visibleTop);
    var visibleHeight = Number(data.visibleHeight);
    if (!Number.isFinite(visibleTop) || !Number.isFinite(visibleHeight)) return;
    latestParentGeometry = {
      visibleTop: visibleTop,
      visibleHeight: visibleHeight,
      iframeHeight: Number(data.iframeHeight) || 0,
      parentViewportHeight: Number(data.parentViewportHeight) || 0
    };
  }

  if (typeof root.addEventListener === "function") {
    root.addEventListener("message", onParentViewportMessage);
  }

  function requestParentViewport() {
    postToParents({ type: MSG_REQUEST_PARENT_VIEWPORT });
  }

  function getVisibleBounds() {
    var g = latestParentGeometry;
    if (g && Number(g.visibleHeight) > 0) {
      return {
        top: g.visibleTop,
        bottom: g.visibleTop + g.visibleHeight,
        height: g.visibleHeight,
        mode: "parent"
      };
    }
    var h = Math.max(1, Number(root.innerHeight) || 800);
    return { top: 0, bottom: h, height: h, mode: "local" };
  }

  function scrollByDelta(deltaY) {
    var dy = Number(deltaY) || 0;
    if (!dy) return;
    var bounds = getVisibleBounds();
    if (bounds.mode === "parent") {
      postToParents({
        type: MSG_SCROLL_TO,
        offsetTop: Math.max(0, bounds.top + dy),
        gap: 0
      });
    }
    try {
      if (typeof root.scrollBy === "function") root.scrollBy(0, dy);
      else if (typeof root.scrollTo === "function") root.scrollTo(0, (root.scrollY || 0) + dy);
    } catch (_error) {
      /* ignore */
    }
    var seen = new Set();
    var nodes = collectScrollRoots();
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (seen.has(node)) continue;
      seen.add(node);
      try {
        if ("scrollTop" in node) node.scrollTop = (Number(node.scrollTop) || 0) + dy;
      } catch (_inner) {
        /* ignore */
      }
    }
  }

  function autoScrollFromClientY(clientY, options) {
    var opts = options && typeof options === "object" ? options : {};
    var edge = Number.isFinite(Number(opts.edgePx)) ? Number(opts.edgePx) : 80;
    var maxStep = Number.isFinite(Number(opts.maxStep)) ? Number(opts.maxStep) : 28;
    var y = Number(clientY);
    if (!Number.isFinite(y) || edge <= 0) return 0;
    var b = getVisibleBounds();
    var dy = 0;
    if (y < b.top + edge) {
      var t = (b.top + edge - y) / edge;
      dy = -Math.ceil(maxStep * Math.min(1, Math.max(0.2, t)));
    } else if (y > b.bottom - edge) {
      var t2 = (y - (b.bottom - edge)) / edge;
      dy = Math.ceil(maxStep * Math.min(1, Math.max(0.2, t2)));
    }
    if (dy) scrollByDelta(dy);
    return dy;
  }

  function postToParents(payload) {
    if (!root.parent || root.parent === root) return;
    for (var j = 0; j < PARENT_ORIGINS.length; j += 1) {
      try {
        root.parent.postMessage(payload, PARENT_ORIGINS[j]);
      } catch (_error) {
        /* ignore */
      }
    }
  }

  function elementDocumentOffsetTop(el) {
    if (!el || typeof el.getBoundingClientRect !== "function") return 0;
    var pageY = root.scrollY || root.pageYOffset || 0;
    if (!pageY && document.documentElement) pageY = document.documentElement.scrollTop || 0;
    if (!pageY && document.body) pageY = document.body.scrollTop || 0;
    return Math.round(el.getBoundingClientRect().top + pageY);
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

    postToParents({ type: MSG_SCROLL_TOP });
  }

  function scrollToElement(el, options) {
    if (!el) return;
    var opts = options && typeof options === "object" ? options : {};
    var gap = Number.isFinite(Number(opts.gap)) ? Number(opts.gap) : DEFAULT_GAP_PX;
    var behavior = opts.behavior === "smooth" ? "smooth" : "auto";
    var offsetTop = elementDocumentOffsetTop(el);
    var localTop = Math.max(0, offsetTop - gap);

    var seen = new Set();
    var nodes = collectScrollRoots(opts.root);
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (seen.has(node)) continue;
      seen.add(node);
      try {
        if (typeof node.scrollTo === "function") node.scrollTo({ top: localTop, behavior: behavior });
        else if ("scrollTop" in node) node.scrollTop = localTop;
      } catch (_error) {
        try {
          if ("scrollTop" in node) node.scrollTop = localTop;
        } catch (_inner) {
          /* ignore */
        }
      }
    }

    try {
      root.scrollTo({ top: localTop, behavior: behavior });
    } catch (_error) {
      try {
        root.scrollTo(0, localTop);
      } catch (_inner) {
        /* ignore */
      }
    }

    // Embedded Admin scrolls on the Squarespace parent page, not inside the iframe.
    postToParents({
      type: MSG_SCROLL_TO,
      offsetTop: offsetTop,
      gap: gap
    });
  }

  function scheduleScrollToTop(options) {
    root.requestAnimationFrame(function () {
      scrollViewportToTop(options);
      root.requestAnimationFrame(function () {
        scrollViewportToTop(options);
      });
    });
  }

  function scheduleScrollToElement(elOrFinder, options) {
    var opts = options && typeof options === "object" ? options : {};
    var delays = Array.isArray(opts.delays) ? opts.delays : [0, 80, 200, 450];

    function resolveEl() {
      if (typeof elOrFinder === "function") {
        try {
          return elOrFinder();
        } catch (_error) {
          return null;
        }
      }
      return elOrFinder || null;
    }

    function run() {
      var el = resolveEl();
      if (!el) return;
      scrollToElement(el, opts);
    }

    root.requestAnimationFrame(function () {
      run();
      root.requestAnimationFrame(run);
    });

    for (var i = 0; i < delays.length; i += 1) {
      root.setTimeout(run, Number(delays[i]) || 0);
    }
  }

  if (typeof document !== "undefined" && "scrollRestoration" in root.history) {
    root.history.scrollRestoration = "manual";
  }

  root.ViewportScroll = {
    scrollToTop: scrollViewportToTop,
    scheduleScrollToTop: scheduleScrollToTop,
    scrollToElement: scrollToElement,
    scheduleScrollToElement: scheduleScrollToElement,
    hasExplicitHashTarget: hasExplicitHashTarget,
    requestParentViewport: requestParentViewport,
    getVisibleBounds: getVisibleBounds,
    scrollByDelta: scrollByDelta,
    autoScrollFromClientY: autoScrollFromClientY,
    MSG_SCROLL_TOP: MSG_SCROLL_TOP,
    MSG_SCROLL_TO: MSG_SCROLL_TO,
    PARENT_ORIGINS: PARENT_ORIGINS
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
