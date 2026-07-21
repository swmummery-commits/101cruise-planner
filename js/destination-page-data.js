/**
 * Destination Experience — template content.
 *
 * Sprint 11A polish: static placeholders only.
 *
 * FUTURE DATA ARCHITECTURE (not implemented yet)
 * ---------------------------------------------
 * Featured Ports:
 *   Research Engine → featured port list → Media Library lookup
 *   (media_id / media_key) → approved image only.
 *   Never search the web or run AI image search at page load.
 *   If no approved Media Library asset exists → placeholder.
 *
 * Cruises:
 *   Cruise Discovery Engine will supply totalCount + sailing cards.
 *   Until then, cruiseCatalog is local placeholder data.
 *
 * Port cards:
 *   href will become /port/{slug} Port Guide pages later.
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
    good: { label: "Good", fill: 60 }
  };

  /**
   * Resolve a Featured Port image.
   * Contract: Media Library approved assets only — never open-web / AI search.
   * Placeholder allowed when no approved media exists.
   */
  function resolvePortImage(port) {
    // FUTURE: lookup Media Library by port.mediaId or port.mediaKey
    if (port?.media?.url) {
      return {
        url: port.media.url,
        alt: port.media.alt || port.name,
        objectPosition: port.media.objectPosition || "center center",
        source: "media_library"
      };
    }
    if (port?.placeholderImage?.url) {
      return {
        url: port.placeholderImage.url,
        alt: port.placeholderImage.alt || port.name,
        objectPosition: port.placeholderImage.objectPosition || "center center",
        source: "placeholder"
      };
    }
    return {
      url: "",
      alt: port?.name || "Port",
      objectPosition: "center center",
      source: "placeholder"
    };
  }

  const ALASKA_CRUISE_SEEDS = [
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

  /** Build placeholder catalog — Discovery Engine will replace this later. */
  function buildPlaceholderCruiseCatalog(totalCount) {
    const sailings = [];
    for (let i = 0; i < totalCount; i += 1) {
      const seed = ALASKA_CRUISE_SEEDS[i % ALASKA_CRUISE_SEEDS.length];
      sailings.push({
        id: `alaska-placeholder-${i + 1}`,
        cruiseLine: seed.cruiseLine,
        shipName: seed.shipName,
        duration: seed.duration,
        departureDate: DEPARTURE_DATES[i % DEPARTURE_DATES.length],
        itinerary: seed.itinerary,
        brochureFare: seed.brochureFare
      });
    }
    return {
      // FUTURE: totalCount from Cruise Discovery Engine
      totalCount: sailings.length,
      pageSize: CRUISE_PAGE_SIZE,
      source: "placeholder",
      sailings
    };
  }

  const DESTINATIONS = {
    alaska: {
      slug: "alaska",
      name: "Alaska",
      summary:
        "Glaciers, wildlife and cool-climate scenic cruising through the Inside Passage — a classic bucket-list voyage for Australian travellers.",
      hero: {
        // FUTURE: Media Library approved destination hero
        url: "/public-tools/cruise-finder/images/alaska-hero.png",
        objectPosition: "center 40%",
        alt: "Alaska cruise destination — mountain and glacier coastline"
      },
      whyCruiseHere:
        "Alaska is for travellers who want scenery that stops conversation. Glaciers, wildlife and cool summer light turn every sea day into the main event — not filler between ports. Classic stops like Juneau, Skagway and Ketchikan add gold-rush colour and easy shore days, while long daylight from May through August makes the season feel generous and alive. From Australia it is a longer journey, but a completely different kind of cruise: crisp air, dramatic horizons, and a genuine sense of wilderness you feel from the deck the moment you arrive.",
      snapshot: [
        { label: "Best Time", value: "May – August" },
        { label: "Cruise Length", value: "7 – 14 nights" },
        { label: "Climate", value: "Cool & changeable" },
        { label: "Currency", value: "US Dollar (USD)" },
        { label: "Language", value: "English" },
        { label: "Best Departure Ports", value: "Vancouver · Seattle · Seward" }
      ],
      suitability: {
        couples: "excellent",
        families: "very_good",
        luxury: "very_good",
        adventure: "excellent",
        food_wine: "good",
        first_cruise: "very_good",
        summary:
          "Ideal if you want scenery and wildlife over beach days — especially couples and travellers happy to pack layers."
      },
      /**
       * Featured Ports — Research Engine list later.
       * mediaId / mediaKey → Media Library only (no web search).
       * guideHref reserved for future Port Guide pages.
       */
      ports: [
        {
          name: "Juneau",
          slug: "juneau",
          description: "Alaska’s capital — glaciers nearby, whale watching and a walkable waterfront.",
          mediaId: null,
          mediaKey: "port:juneau",
          guideHref: null,
          placeholderImage: {
            url: "/public-tools/cruise-finder/images/alaska-hero.png",
            objectPosition: "center 30%",
            alt: "Juneau, Alaska — mountain coastline"
          }
        },
        {
          name: "Skagway",
          slug: "skagway",
          description: "Gold-rush town with the White Pass railway and a charming main street.",
          mediaId: null,
          mediaKey: "port:skagway",
          guideHref: null,
          placeholderImage: {
            url: "/public-tools/cruise-finder/images/alaska-hero.png",
            objectPosition: "left center",
            alt: "Skagway, Alaska — scenic approach"
          }
        },
        {
          name: "Ketchikan",
          slug: "ketchikan",
          description: "Totem poles, creek walks and rainforest scenery at the start of many itineraries.",
          mediaId: null,
          mediaKey: "port:ketchikan",
          guideHref: null,
          placeholderImage: {
            url: "/public-tools/cruise-finder/images/alaska-hero.png",
            objectPosition: "right 40%",
            alt: "Ketchikan, Alaska — forested shoreline"
          }
        },
        {
          name: "Sitka",
          slug: "sitka",
          description: "Russian and Tlingit heritage with quieter harbour energy and coastal trails.",
          mediaId: null,
          mediaKey: "port:sitka",
          guideHref: null,
          placeholderImage: {
            url: "/public-tools/cruise-finder/images/alaska-hero.png",
            objectPosition: "center 55%",
            alt: "Sitka, Alaska — harbour and peaks"
          }
        },
        {
          name: "Icy Strait Point",
          slug: "icy-strait-point",
          description: "Wildlife, zip lines and a soft adventure stop near Hoonah.",
          mediaId: null,
          mediaKey: "port:icy-strait-point",
          guideHref: null,
          placeholderImage: {
            url: "/public-tools/cruise-finder/images/alaska-hero.png",
            objectPosition: "center 20%",
            alt: "Icy Strait Point, Alaska"
          }
        }
      ],
      // FUTURE: cruiseCatalog from Cruise Discovery Engine
      cruiseCatalog: buildPlaceholderCruiseCatalog(37),
      cruiseLines: [
        { name: "Holland America Line" },
        { name: "Princess Cruises" },
        { name: "Celebrity Cruises" },
        { name: "Norwegian Cruise Line" },
        { name: "Royal Caribbean" },
        { name: "Carnival Cruise Line" }
      ],
      goodToKnow: [
        { label: "Currency", value: "USD" },
        { label: "Voltage", value: "120V" },
        { label: "Language", value: "English" },
        { label: "Tipping", value: "Customary onboard" },
        { label: "Climate", value: "Cool summer" },
        { label: "Walking Level", value: "Moderate" }
      ],
      faqs: [
        {
          q: "When is the best time to cruise Alaska?",
          a: "Most sailings run from May to August. June and July usually offer the longest daylight and strongest wildlife viewing, while May and September can feel quieter with more changeable weather."
        },
        {
          q: "Is Alaska a good first cruise?",
          a: "Yes — especially if you prefer scenery over nightlife. Choose a well-reviewed ship with a classic Inside Passage itinerary, pack layers, and keep shore days flexible for weather."
        },
        {
          q: "Do I need a visa or ESTA from Australia?",
          a: "Most Australia and New Zealand travellers need an ESTA for the United States when itineraries include US ports or fly/cruise combinations. Always confirm your own documents before booking."
        },
        {
          q: "Can Paul find a better price than the brochure fare?",
          a: "Often, yes. Brochure fares are a starting point. Share your dates, cabin preference and travel party and Paul can check current offers, amenity packages and the best available rate."
        }
      ]
    }
  };

  function getDestination(slug) {
    const key = String(slug || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-");
    return DESTINATIONS[key] || null;
  }

  function listSlugs() {
    return Object.keys(DESTINATIONS);
  }

  function getCruiseCatalog(dest) {
    if (dest?.cruiseCatalog) return dest.cruiseCatalog;
    // Legacy fallback
    const sailings = Array.isArray(dest?.cruises) ? dest.cruises : [];
    return {
      totalCount: sailings.length,
      pageSize: CRUISE_PAGE_SIZE,
      source: "placeholder",
      sailings
    };
  }

  root.DestinationPageData = {
    CONTACT_EMAIL,
    QUOTE_URL,
    CRUISE_PAGE_SIZE,
    SUITABILITY,
    DESTINATIONS,
    getDestination,
    listSlugs,
    contactMailto,
    resolvePortImage,
    getCruiseCatalog
  };
})(typeof window !== "undefined" ? window : globalThis);
