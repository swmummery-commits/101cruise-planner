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
      warning: "#c56a1a",
      brandGreen: "#8DD9BF"
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
      maxPreferredWords: 9,
      marginBottomPx: 52
    },
    headline: {
      fontFamily: "Georgia, 'Times New Roman', serif",
      fontSizePx: 22,
      fontWeight: 700,
      letterSpacingPx: 0,
      textTransform: "none",
      color: "#000000",
      textAlign: "center",
      maxWidthPx: 500,
      minWords: 4,
      preferredMinWords: 8,
      preferredMaxWords: 10,
      maxWords: 12,
      maxLines: 3,
      approxCharsPerLine: 42
    },
    heroImage: {
      maxWidthPx: 600,
      aspectRatio: "16 / 9",
      objectFit: "cover",
      textAlign: "center",
      marginBottomPx: 36
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
      maxRecommendedWords: 100,
      marginTopPx: 38
    },
    editorialDivider: {
      color: "#E8E8E8",
      heightPx: 1,
      marginTopPx: 34,
      marginBottomPx: 34
    },
    exploreMore: {
      fontFamily: "Helvetica, Arial, sans-serif",
      fontSizePx: 13,
      fontWeight: 700,
      letterSpacingPx: 1.5,
      textTransform: "uppercase",
      color: "#111111",
      background: "#8DD9BF",
      marginTopPx: 48,
      paddingYPx: 14,
      paddingXPx: 28
    },
    spacing: {
      sectionGapPx: 32,
      blockPaddingYPx: 48,
      blockPaddingXPx: 40,
      destinationToHeadlinePx: 52,
      heroToDatesPx: 36,
      nightsToPortsExtraPx: 22,
      portsToDividerPx: 34,
      dividerToDescriptionPx: 34,
      descriptionToCtaPx: 48
    }
  };

  global.NewsletterTypography = NewsletterTypography;
})(typeof window !== "undefined" ? window : globalThis);
