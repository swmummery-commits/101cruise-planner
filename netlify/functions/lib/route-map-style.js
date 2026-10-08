/**
 * Route map style selection.
 * Classic is the existing 16:9 map. Social is an additional promotional design.
 */

const { ROUTE_MAP_THEME } = require("./route-map-theme");

const ROUTE_MAP_STYLES = Object.freeze({
  classic: "classic",
  social: "social"
});

function normaliseRouteMapStyle(value) {
  const key = String(value || "classic")
    .trim()
    .toLowerCase();
  return key === ROUTE_MAP_STYLES.social ? ROUTE_MAP_STYLES.social : ROUTE_MAP_STYLES.classic;
}

function buildSocialTheme(scale) {
  const s = Math.max(0.55, Math.min(1.4, Number(scale) || 1));
  const px = (n) => Math.round(n * s * 10) / 10;
  return {
    sea: {
      fill: "#B7D7EA",
      stops: [
        { offset: "0%", color: "#A9D0E6" },
        { offset: "55%", color: "#C5E2F1" },
        { offset: "100%", color: "#D7EEF7" }
      ],
      vignetteColor: "#7EB4D0",
      vignetteOpacity: 0.12,
      depthOpacity: 0.035,
      depthColor: "#6AA4C4",
      coastalBands: [
        { width: px(16), color: "#E7F6FB", opacity: 0.55 },
        { width: px(7), color: "#D2EBF5", opacity: 0.7 }
      ]
    },
    land: {
      fill: "#F4F7F2",
      stroke: "#C9D5D4",
      strokeWidth: px(1.15),
      strokeOpacity: 0.95
    },
    route: {
      stroke: "#1A3344",
      strokeWidth: px(4.6),
      underlayStroke: "#FFFFFF",
      underlayWidth: px(8.2),
      underlayOpacity: 0.92,
      glowStroke: "#1A3344",
      glowWidth: px(4.6),
      glowOpacity: 0,
      highlightStroke: "#1A3344",
      highlightWidth: px(0),
      highlightOpacity: 0
    },
    arrows: {
      enabled: true,
      spacingPx: px(168),
      minCount: 2,
      maxCount: 6,
      size: px(8.5),
      fill: "#FFFFFF",
      stroke: "#1A3344",
      strokeWidth: px(0.6),
      strokeOpacity: 0.45,
      clearancePx: px(28),
      endPadding: 0.08
    },
    marker: {
      variant: "social",
      radius: px(5.6),
      fill: "#FFFFFF",
      stroke: "#163042",
      strokeWidth: px(1.7),
      fontSize: px(12)
    },
    label: {
      fill: "#14283A",
      haloFill: "#F7FBFD",
      haloWidth: px(4.6),
      fontSize: Math.max(12, px(20)),
      fontWeight: 700,
      maxChars: s < 0.8 ? 16 : 22,
      offset: px(24),
      leaderStroke: "#3C4C59",
      leaderWidth: px(1.15),
      leaderOpacity: 0.7,
      includeSequencePrefix: false,
      leaderOnlyWhenClose: true,
      closePx: px(108)
    },
    countryLabel: {
      fill: "#8AA0AE",
      haloFill: "#F7FBFD",
      fontSize: Math.max(9, px(12)),
      maxLabels: s < 0.8 ? 3 : 5,
      haloWidth: px(2.4)
    },
    layout: {
      paddingRatio: 0.16,
      paddingDegreesMin: 1.4,
      shipProgress: 0.55
    }
  };
}

/**
 * Canvas + theme for a Social Route Map.
 * Explicit width/height win so the same design can sit in square or portrait frames.
 */
function resolveSocialRender(options = {}) {
  const format = ["square", "portrait", "landscape"].includes(options.format)
    ? options.format
    : "portrait";
  const presets = {
    square: [1080, 1080],
    portrait: [1080, 1350],
    landscape: [1200, 675]
  };
  const [presetW, presetH] = presets[format];
  const width = Number(options.width) > 0 ? Number(options.width) : presetW;
  const height = Number(options.height) > 0 ? Number(options.height) : presetH;
  const inset = options.presentation === "inset";
  const scale = width / 1080;
  const footer = inset ? 0 : Math.round(Math.min(132, Math.max(76, height * 0.078)));
  return {
    width,
    height,
    footer,
    hideShip: true,
    inset,
    branding: options.branding && typeof options.branding === "object" ? options.branding : null,
    theme: buildSocialTheme(inset ? Math.max(scale, 0.62) : scale)
  };
}

module.exports = {
  ROUTE_MAP_STYLES,
  ROUTE_MAP_THEME,
  normaliseRouteMapStyle,
  resolveSocialRender,
  buildSocialTheme
};
