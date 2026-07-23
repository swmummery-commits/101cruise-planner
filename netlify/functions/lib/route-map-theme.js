/**
 * Sprint 13E Phase 3C — visual theme for route-map SVG renderer.
 * Final polish on the approved 3B baseline. Constants only — no redesign.
 */

const ROUTE_MAP_THEME = Object.freeze({
  brandGreen: "#8DD9BF",

  sea: {
    /** Fallback flat fill if gradients unavailable */
    fill: "#3E7FA8",
    gradientId: "sea-gradient",
    /** Deep → mid → near-coast teal (vector gradient only) */
    stops: [
      { offset: "0%", color: "#2F6F9C" },
      { offset: "42%", color: "#3F86B0" },
      { offset: "72%", color: "#4E96B8" },
      { offset: "100%", color: "#6BB0C4" }
    ],
    vignetteId: "sea-vignette",
    vignetteColor: "#1E4E6E",
    vignetteOpacity: 0.18,
    /** Soft depth ellipses (deterministic, low opacity) */
    depthOpacity: 0.07,
    depthColor: "#1A4560",
    /**
     * Shallow coastal water — multi-band strokes under land.
     * Widest/faintest first → extends further to sea and fades into deep blue.
     * (SVG strokes are centred on the coastline; land fill masks the inland half.)
     */
    coastalBands: [
      { width: 52, color: "#8FCFE0", opacity: 0.1 },
      { width: 38, color: "#7EC8D8", opacity: 0.16 },
      { width: 26, color: "#6FBFCF", opacity: 0.22 },
      { width: 14, color: "#5EB4C6", opacity: 0.28 }
    ]
  },

  land: {
    /** Warm sand — approved; do not change fill */
    fill: "#F3EBDC",
    reliefFill: "#E2D6C2",
    reliefOffsetX: 1.1,
    reliefOffsetY: 1.4,
    /** Phase 3C: slightly clearer coastline edge only */
    stroke: "#C9B89E",
    strokeWidth: 0.85,
    strokeOpacity: 0.7
  },

  route: {
    /** Primary hero stroke — brand green (width unchanged) */
    stroke: "#8DD9BF",
    strokeWidth: 3.1,
    linecap: "round",
    linejoin: "round",
    /** Soft dark underlay for contrast on pale land / bright sea */
    underlayStroke: "#1F3A48",
    underlayWidth: 5.2,
    underlayOpacity: 0.28,
    /** Soft brand glow under the green (elegant, not neon) */
    glowStroke: "#8DD9BF",
    glowWidth: 9.5,
    glowOpacity: 0.32,
    /** Light highlight edge above the green */
    highlightStroke: "#FFFFFF",
    highlightWidth: 1.15,
    highlightOpacity: 0.35,
    highlightOffset: 0
  },

  arrows: {
    enabled: true,
    /** Wider spacing → fewer arrows; clearer direction */
    spacingPx: 130,
    minCount: 2,
    maxCount: 9,
    /** ~65% larger than Phase 3B (7.5) */
    size: 12.4,
    fill: "#8DD9BF",
    stroke: "#1F3A48",
    strokeWidth: 0.65,
    strokeOpacity: 0.28,
    /** Clearance from port markers / ship / labels */
    clearancePx: 30,
    /** Keep arrows off the first/last few % of the route */
    endPadding: 0.07
  },

  marker: {
    radius: 11.5,
    fill: "#FFFFFF",
    stroke: "#8DD9BF",
    strokeWidth: 2.4,
    innerStroke: "#2C3338",
    innerStrokeWidth: 0.7,
    numberFill: "#1A1F23",
    shadowOpacity: 0.18,
    fontFamily:
      "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
    fontSize: 11,
    fontWeight: 700
  },

  label: {
    fill: "#243038",
    fontFamily:
      "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
    fontSize: 11.5,
    fontWeight: 500,
    maxChars: 28,
    offset: 16,
    paddingX: 2,
    paddingY: 2,
    leaderStroke: "#5B6770",
    leaderWidth: 0.7,
    leaderOpacity: 0.4
  },

  ship: {
    hull: "#1A2630",
    deck: "#3D4F5C",
    window: "#E8EEF2",
    stripe: "#FFFFFF",
    accent: "#8DD9BF",
    stroke: "#0F171C",
    strokeWidth: 0.7,
    /** Signature scale */
    length: 44,
    beam: 18
  },

  layout: {
    width: 1200,
    height: 675,
    paddingRatio: 0.12,
    paddingDegreesMin: 0.85,
    minLonSpan: 4.5,
    minLatSpan: 3.0,
    coordPrecision: 2,
    shipProgress: 0.55,
    shipMarkerClearancePx: 40,
    coastlineResolution: "50m"
  }
});

module.exports = {
  ROUTE_MAP_THEME
};
