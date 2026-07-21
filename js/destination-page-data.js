/**
 * Destination Experience — template content.
 * Sprint 11A: static placeholder data only (no live discovery / research API).
 * Shape is ready for Research Engine + Media Library wiring in a later sprint.
 */
(function (root) {
  "use strict";

  const CONTACT_EMAIL = "paul@101cruise.com.au";
  const QUOTE_URL = "https://www.101cruise.com.au/quote";

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

  const DESTINATIONS = {
    alaska: {
      slug: "alaska",
      name: "Alaska",
      summary:
        "Glaciers, wildlife and cool-climate scenic cruising through the Inside Passage — a classic bucket-list voyage for Australian travellers.",
      hero: {
        url: "/public-tools/cruise-finder/images/alaska-hero.png",
        objectPosition: "center 40%",
        alt: "Alaska cruise destination — mountain and glacier coastline"
      },
      whyCruiseHere:
        "Alaska rewards travellers who love scenery more than shopping streets. From the calm waters of the Inside Passage to tidewater glaciers and wildlife-rich shores, almost every day delivers a view you will talk about for years. Ports such as Juneau, Skagway and Ketchikan add gold-rush history, forest trails and easy shore days without rushing. Sailings typically concentrate from May through August, when daylight stretches long and wildlife is most active. For Australians, it is a longer journey — but one that feels completely different from tropical island cruising, with cooler air, dramatic light and a genuine sense of wilderness from the deck.",
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
      ports: [
        {
          name: "Juneau",
          description: "Alaska’s capital — glaciers nearby, whale watching and a walkable waterfront.",
          image: {
            url: "/public-tools/cruise-finder/images/alaska-hero.png",
            objectPosition: "center 30%",
            alt: "Juneau, Alaska — mountain coastline"
          },
          slug: "juneau"
        },
        {
          name: "Skagway",
          description: "Gold-rush town with the White Pass railway and a charming main street.",
          image: {
            url: "/public-tools/cruise-finder/images/alaska-hero.png",
            objectPosition: "left center",
            alt: "Skagway, Alaska — scenic approach"
          },
          slug: "skagway"
        },
        {
          name: "Ketchikan",
          description: "Totem poles, creek walks and rainforest scenery at the start of many itineraries.",
          image: {
            url: "/public-tools/cruise-finder/images/alaska-hero.png",
            objectPosition: "right 40%",
            alt: "Ketchikan, Alaska — forested shoreline"
          },
          slug: "ketchikan"
        },
        {
          name: "Sitka",
          description: "Russian and Tlingit heritage with quieter harbour energy and coastal trails.",
          image: {
            url: "/public-tools/cruise-finder/images/alaska-hero.png",
            objectPosition: "center 55%",
            alt: "Sitka, Alaska — harbour and peaks"
          },
          slug: "sitka"
        },
        {
          name: "Icy Strait Point",
          description: "Wildlife, zip lines and a soft adventure stop near Hoonah.",
          image: {
            url: "/public-tools/cruise-finder/images/alaska-hero.png",
            objectPosition: "center 20%",
            alt: "Icy Strait Point, Alaska"
          },
          slug: "icy-strait-point"
        }
      ],
      cruises: [
        {
          cruiseLine: "Holland America Line",
          shipName: "Koningsdam",
          duration: "7 nights",
          departureDate: "12 Jun 2027",
          itinerary: "Vancouver → Juneau → Skagway → Glacier Bay → Ketchikan → Vancouver",
          brochureFare: "From USD $1,899 pp"
        },
        {
          cruiseLine: "Princess Cruises",
          shipName: "Discovery Princess",
          duration: "7 nights",
          departureDate: "26 Jun 2027",
          itinerary: "Seattle → Ketchikan → Juneau → Skagway → Glacier Bay → Victoria → Seattle",
          brochureFare: "From USD $1,749 pp"
        },
        {
          cruiseLine: "Celebrity Cruises",
          shipName: "Celebrity Edge",
          duration: "10 nights",
          departureDate: "10 Jul 2027",
          itinerary: "Vancouver → Sitka → Juneau → Skagway → Icy Strait → Hubbard Glacier → Ketchikan → Vancouver",
          brochureFare: "From USD $2,499 pp"
        },
        {
          cruiseLine: "Norwegian Cruise Line",
          shipName: "Norwegian Bliss",
          duration: "7 nights",
          departureDate: "24 Jul 2027",
          itinerary: "Seattle → Juneau → Skagway → Glacier Bay → Ketchikan → Victoria → Seattle",
          brochureFare: "From USD $1,629 pp"
        }
      ],
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

  root.DestinationPageData = {
    CONTACT_EMAIL,
    QUOTE_URL,
    SUITABILITY,
    DESTINATIONS,
    getDestination,
    listSlugs,
    contactMailto
  };
})(typeof window !== "undefined" ? window : globalThis);
