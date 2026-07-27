/**
 * Shared My Cruise embed bridge constants + parent-visible geometry helpers.
 * Dual export: CommonJS (Node tests) + browser global PortalParentViewport.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PortalParentViewport = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CHILD_ORIGIN = "https://admirable-tiramisu-d4da8a.netlify.app";
  const PARENT_ORIGINS = ["https://www.101cruise.com.au", "https://101cruise.com.au"];

  const MSG = {
    HEIGHT: "101cruise-my-cruise-height",
    PARENT_VIEWPORT: "101cruise-parent-viewport",
    REQUEST_PARENT_VIEWPORT: "101cruise-request-parent-viewport",
    LOADING_STATE: "101cruise-portal-loading-state"
  };

  function isAllowedParentOrigin(origin) {
    return PARENT_ORIGINS.indexOf(String(origin || "")) !== -1;
  }

  function isAllowedChildOrigin(origin) {
    return String(origin || "") === CHILD_ORIGIN;
  }

  /**
   * Compute the iframe slice currently visible in the parent browser viewport.
   *
   * @param {{top:number,left?:number,width?:number,height:number,bottom?:number,right?:number}} iframeRect
   * @param {number} parentInnerHeight
   * @param {number} [parentInnerWidth]
   */
  function computeParentVisibleGeometry(iframeRect, parentInnerHeight, parentInnerWidth) {
    const rect = iframeRect || {};
    const iframeHeight = Math.max(0, Number(rect.height) || 0);
    const iframeWidth = Math.max(0, Number(rect.width) || 0);
    const parentH = Math.max(0, Number(parentInnerHeight) || 0);
    const parentW = Math.max(0, Number(parentInnerWidth) || 0);
    const top = Number(rect.top);
    const safeTop = Number.isFinite(top) ? top : 0;

    const visibleTop = Math.max(0, -safeTop);
    const visibleBottom = Math.min(iframeHeight, parentH - safeTop);
    const visibleHeight = Math.max(0, visibleBottom - visibleTop);

    return {
      type: MSG.PARENT_VIEWPORT,
      visibleTop: Math.round(visibleTop),
      visibleHeight: Math.round(visibleHeight),
      visibleWidth: Math.round(iframeWidth || parentW || 0),
      iframeHeight: Math.round(iframeHeight),
      parentViewportHeight: Math.round(parentH)
    };
  }

  /**
   * Resolve overlay box from parent geometry, or direct Netlify fallback.
   */
  function resolveOverlayBox(parentGeometry, fallbackInnerHeight) {
    const g = parentGeometry || null;
    if (
      g &&
      Number.isFinite(Number(g.visibleTop)) &&
      Number.isFinite(Number(g.visibleHeight)) &&
      Number(g.visibleHeight) > 0
    ) {
      return {
        mode: "parent",
        top: Math.max(0, Math.round(Number(g.visibleTop))),
        height: Math.max(1, Math.round(Number(g.visibleHeight)))
      };
    }
    const h = Math.max(1, Math.round(Number(fallbackInnerHeight) || 0) || 800);
    return { mode: "direct", top: 0, height: h };
  }

  return {
    CHILD_ORIGIN: CHILD_ORIGIN,
    PARENT_ORIGINS: PARENT_ORIGINS,
    MSG: MSG,
    isAllowedParentOrigin: isAllowedParentOrigin,
    isAllowedChildOrigin: isAllowedChildOrigin,
    computeParentVisibleGeometry: computeParentVisibleGeometry,
    resolveOverlayBox: resolveOverlayBox
  };
});
