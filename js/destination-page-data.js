/**
 * Destination Experience — shared helpers + cruise placeholders.
 *
 * Sprint 11C: editorial content and imagery come from the Living Destination
 * API (destinations → research_content → media_library → destination_ports).
 * This module no longer owns destination editorial content.
 *
 * Cruises remain placeholder/manual until Cruise Discovery Engine.
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

  const PLACEHOLDER_CRUISE_SEEDS = [
    {
      cruiseLine: "Holland America Line",
      shipName: "Koningsdam",
      duration: "7 nights",
      itinerary: "Vancouver → Juneau → Skagway → Glacier Bay → Ketchikan → Vancouver",
      brochureFare: "From USD $1,899 pp"
    },
    {
      cruiseLine: "Princess Cruises",
      shipName: "Discovery Princess",
      duration: "7 nights",
      itinerary: "Seattle → Ketchikan → Juneau → Skagway → Glacier Bay → Victoria → Seattle",
      brochureFare: "From USD $1,749 pp"
    },
    {
      cruiseLine: "Celebrity Cruises",
      shipName: "Celebrity Edge",
      duration: "10 nights",
      itinerary: "Vancouver → Sitka → Juneau → Skagway → Icy Strait → Hubbard Glacier → Ketchikan → Vancouver",
      brochureFare: "From USD $2,499 pp"
    },
    {
      cruiseLine: "Norwegian Cruise Line",
      shipName: "Norwegian Bliss",
      duration: "7 nights",
      itinerary: "Seattle → Juneau → Skagway → Glacier Bay → Ketchikan → Victoria → Seattle",
      brochureFare: "From USD $1,629 pp"
    },
    {
      cruiseLine: "Royal Caribbean",
      shipName: "Quantum of the Seas",
      duration: "7 nights",
      itinerary: "Seattle → Juneau → Skagway → Sitka → Victoria → Seattle",
      brochureFare: "From USD $1,799 pp"
    },
    {
      cruiseLine: "Carnival Cruise Line",
      shipName: "Carnival Luminosa",
      duration: "7 nights",
      itinerary: "Seattle → Juneau → Skagway → Glacier Bay → Victoria → Seattle",
      brochureFare: "From USD $1,549 pp"
    },
    {
      cruiseLine: "Holland America Line",
      shipName: "Nieuw Amsterdam",
      duration: "14 nights",
      itinerary: "Seattle → Hubbard Glacier → Sitka → Juneau → Skagway → Glacier Bay → Ketchikan → Victoria → Seattle",
      brochureFare: "From USD $2,899 pp"
    },
    {
      cruiseLine: "Princess Cruises",
      shipName: "Majestic Princess",
      duration: "7 nights",
      itinerary: "Vancouver → Juneau → Skagway → Glacier Bay → Ketchikan → Vancouver",
      brochureFare: "From USD $1,829 pp"
    },
    {
      cruiseLine: "Celebrity Cruises",
      shipName: "Celebrity Solstice",
      duration: "7 nights",
      itinerary: "Vancouver → Icy Strait → Juneau → Skagway → Ketchikan → Vancouver",
      brochureFare: "From USD $1,999 pp"
    },
    {
      cruiseLine: "Norwegian Cruise Line",
      shipName: "Norwegian Encore",
      duration: "7 nights",
      itinerary: "Seattle → Juneau → Skagway → Glacier Bay → Ketchikan → Victoria → Seattle",
      brochureFare: "From USD $1,699 pp"
    }
  ];

  const DEPARTURE_DATES = [
    "12 May 2027",
    "19 May 2027",
    "26 May 2027",
    "02 Jun 2027",
    "09 Jun 2027",
    "16 Jun 2027",
    "23 Jun 2027",
    "30 Jun 2027",
    "07 Jul 2027",
    "14 Jul 2027",
    "21 Jul 2027",
    "28 Jul 2027",
    "04 Aug 2027",
    "11 Aug 2027",
    "18 Aug 2027",
    "25 Aug 2027",
    "01 Sep 2027",
    "08 Sep 2027",
    "15 May 2027",
    "22 May 2027",
    "05 Jun 2027",
    "12 Jun 2027",
    "19 Jun 2027",
    "26 Jun 2027",
    "03 Jul 2027",
    "10 Jul 2027",
    "17 Jul 2027",
    "24 Jul 2027",
    "31 Jul 2027",
    "07 Aug 2027",
    "14 Aug 2027",
    "21 Aug 2027",
    "28 Aug 2027",
    "04 Sep 2027",
    "11 Sep 2027",
    "18 May 2027",
    "25 Jun 2027"
  ];

  /** Placeholder catalog — Discovery Engine will replace this later. */
  function buildPlaceholderCruiseCatalog(slug, totalCount = 37) {
    const key = String(slug || "destination")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-");
    const sailings = [];
    for (let i = 0; i < totalCount; i += 1) {
      const seed = PLACEHOLDER_CRUISE_SEEDS[i % PLACEHOLDER_CRUISE_SEEDS.length];
      sailings.push({
        id: `${key}-placeholder-${i + 1}`,
        cruiseLine: seed.cruiseLine,
        shipName: seed.shipName,
        duration: seed.duration,
        departureDate: DEPARTURE_DATES[i % DEPARTURE_DATES.length],
        itinerary: seed.itinerary,
        brochureFare: seed.brochureFare
      });
    }
    return {
      totalCount: sailings.length,
      pageSize: CRUISE_PAGE_SIZE,
      source: "placeholder",
      sailings
    };
  }

  function getCruiseCatalog(dest) {
    if (dest?.cruiseCatalog?.sailings?.length) return dest.cruiseCatalog;
    return buildPlaceholderCruiseCatalog(dest?.slug || "destination", 37);
  }

  root.DestinationPageData = {
    CONTACT_EMAIL,
    QUOTE_URL,
    CRUISE_PAGE_SIZE,
    SUITABILITY,
    contactMailto,
    resolvePortImage,
    buildPlaceholderCruiseCatalog,
    getCruiseCatalog
  };
})(typeof window !== "undefined" ? window : globalThis);
