/**
 * Newsletter typography constants.
 * Reused by newsletter preview, future newsletter generation, and landing pages.
 * Do not hardcode these values in renderers or Admin UI code.
 */
(function (global) {
  "use strict";

  const NewsletterTypography = {
    fonts: {
      sans: "Helvetica, Arial, sans-serif",
      serif: "Georgia, 'Times New Roman', serif"
    },
    colors: {
      black: "#000000",
      body: "#111111",
      muted: "#545454",
      white: "#ffffff",
      warning: "#c56a1a"
    },
    destinationStrip: {
      fontFamily: "Helvetica, Arial, sans-serif",
      fontSizePx: 14,
      fontWeight: 400,
      letterSpacingPx: 3,
      textTransform: "uppercase",
      color: "#545454",
      textAlign: "center",
      maxPreferredChars: 55,
      maxPreferredWords: 9
    },
    headline: {
      fontFamily: "Georgia, 'Times New Roman', serif",
      fontSizePx: 22,
      fontWeight: 700,
      letterSpacingPx: 0,
      textTransform: "none",
      color: "#000000",
      textAlign: "center",
      minWords: 4,
      preferredMinWords: 8,
      preferredMaxWords: 12,
      maxWords: 14
    },
    heroImage: {
      maxWidthPx: 600,
      aspectRatio: "16 / 9",
      objectFit: "cover",
      textAlign: "center"
    },
    dates: {
      fontFamily: "Helvetica, Arial, sans-serif",
      fontSizePx: 14,
      fontWeight: 700,
      letterSpacingPx: 1,
      textTransform: "uppercase",
      color: "#000000",
      textAlign: "center"
    },
    nightsShip: {
      fontFamily: "Helvetica, Arial, sans-serif",
      fontSizePx: 14,
      fontWeight: 700,
      letterSpacingPx: 1,
      textTransform: "uppercase",
      color: "#000000",
      textAlign: "center"
    },
    portsHeading: {
      fontFamily: "Helvetica, Arial, sans-serif",
      fontSizePx: 14,
      fontWeight: 700,
      letterSpacingPx: 0,
      textTransform: "uppercase",
      color: "#000000",
      textAlign: "center"
    },
    portsBody: {
      fontFamily: "Helvetica, Arial, sans-serif",
      fontSizePx: 14,
      fontWeight: 400,
      letterSpacingPx: 0,
      textTransform: "none",
      color: "#111111",
      textAlign: "center",
      longLineChars: 90
    },
    description: {
      fontFamily: "Helvetica, Arial, sans-serif",
      fontSizePx: 14,
      fontWeight: 400,
      letterSpacingPx: 0,
      textTransform: "none",
      color: "#111111",
      textAlign: "center",
      paragraphSpacingPx: 24,
      preferredMinWords: 60,
      preferredMaxWords: 90,
      maxRecommendedWords: 100
    },
    spacing: {
      sectionGapPx: 28,
      blockPaddingYPx: 40,
      blockPaddingXPx: 36
    }
  };

  global.NewsletterTypography = NewsletterTypography;
})(typeof window !== "undefined" ? window : globalThis);
