/**
 * Destination Experience — shared helpers.
 *
 * Sprint 11C: editorial content and imagery come from the Living Destination API.
 * Sprint 11D: cruises come from Cruise Discovery Engine via the same API (cruiseCatalog).
 * Placeholders are no longer used on live destination pages.
 */
(function (root) {
  "use strict";

  const CONTACT_EMAIL = "paul@101cruise.com.au";
  const QUOTE_URL = "https://www.101cruise.com.au/quote";
  const CRUISE_PAGE_SIZE = 6;

  function contactMailto(destinationName, context) {
    const subject = encodeURIComponent(`${destinationName} cruise — best price`);
    const body = encodeURIComponent(
      [
        `Hi Paul,`,
        ``,
        `I'm interested in cruising ${destinationName}${context ? ` (${context})` : ""}.`,
        ``,
        `Could you please check current availability and your best price?`,
        ``,
        `Thank you`
      ].join("\n")
    );
    return `mailto:${CONTACT_EMAIL}?subject=${subject}&body=${body}`;
  }

  /** Suitability levels → bar fill % and label */
  const SUITABILITY = {
    excellent: { label: "Excellent", fill: 94 },
    very_good: { label: "Very Good", fill: 78 },
    good: { label: "Good", fill: 60 },
    fair: { label: "Fair", fill: 42 },
    limited: { label: "Limited", fill: 24 }
  };

  /**
   * Resolve a Featured Port image.
   * Contract: Media Library approved assets only — never open-web / AI search.
   */
  function resolvePortImage(port) {
    if (port?.media?.url) {
      return {
        url: port.media.url,
        alt: port.media.alt || port.name,
        objectPosition: port.media.objectPosition || "center center",
        source: "media_library"
      };
    }
    return {
      url: "",
      alt: port?.name || "Port",
      objectPosition: "center center",
      source: "placeholder"
    };
  }

  function emptyCruiseCatalog() {
    return {
      totalCount: 0,
      pageSize: CRUISE_PAGE_SIZE,
      source: "discovery",
      sailings: []
    };
  }

  /** Prefer API discovery catalog; never invent placeholder sailings. */
  function getCruiseCatalog(dest) {
    if (dest?.cruiseCatalog && Array.isArray(dest.cruiseCatalog.sailings)) {
      return {
        totalCount:
          dest.cruiseCatalog.totalCount != null
            ? dest.cruiseCatalog.totalCount
            : dest.cruiseCatalog.sailings.length,
        pageSize: dest.cruiseCatalog.pageSize || CRUISE_PAGE_SIZE,
        source: dest.cruiseCatalog.source || "discovery",
        sailings: dest.cruiseCatalog.sailings
      };
    }
    return emptyCruiseCatalog();
  }

  root.DestinationPageData = {
    CONTACT_EMAIL,
    QUOTE_URL,
    CRUISE_PAGE_SIZE,
    SUITABILITY,
    contactMailto,
    resolvePortImage,
    emptyCruiseCatalog,
    getCruiseCatalog
  };
})(typeof window !== "undefined" ? window : globalThis);
