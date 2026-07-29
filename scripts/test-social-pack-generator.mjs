/**
 * Social Pack destination-design tests.
 * Run: node scripts/test-social-pack-generator.mjs
 */

import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const {
  selectPublicOffer,
  selectPublicOffers,
  sanitizePublicPricingRows,
  buildDiscountDisplay,
  normaliseRoomLabel,
  PUBLIC_PRICING_SELECT
} = require("../netlify/functions/lib/social-pack-pricing.js");
const {
  shortenHeadline,
  cruiseFolderSlug,
  formatAuDateRange,
  formatAuDepartingFull,
  buildRouteHeadline
} = require("../netlify/functions/lib/social-pack-copy.js");
const { buildPortList, buildInclusions } = require("../netlify/functions/lib/social-pack-itinerary.js");
const { buildCaption } = require("../netlify/functions/lib/social-pack-caption.js");
const {
  renderMainCruiseSvg,
  renderJourneySvg,
  renderOfferSvg,
  renderCtaSvg,
  GREEN
} = require("../netlify/functions/lib/social-pack-svg.js");
const {
  svgToPngBuffer,
  WIDTH,
  HEIGHT,
  sniffMime,
  buildSlidePlan,
  renderCruisePack
} = require("../netlify/functions/lib/social-pack-render.js");
const { buildSocialPackZip } = require("../netlify/functions/lib/social-pack-zip.js");
const { assessReadiness } = require("../netlify/functions/lib/social-pack-data.js");
const {
  resolveCanonicalDestination,
  resolveSocialBackground,
  rotationIndex,
  sortDestinationMedia,
  filterActiveDestinationMedia
} = require("../netlify/functions/lib/social-pack-destination.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function pngDims(buf) {
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    sig: buf.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  };
}

function tinyPngDataUri() {
  // 1x1 red PNG
  const buf = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  return `data:image/png;base64,${buf.toString("base64")}`;
}

async function main() {
  let passed = 0;

  // Pricing order + airline exclusion
  {
    const airlineToken = "AIRLINE_SECRET_VALUE_ZX9Q";
    const rows = [
      {
        room_label: "Singles - Balcony",
        brochure_price: 10498,
        cruise_101_price: 1498,
        display_order: 1,
        airline_price: airlineToken,
        category: "S"
      },
      {
        room_label: "Balcony",
        brochure_price: 12567,
        cruise_101_price: 1251,
        display_order: 2,
        airline_price: 2156
      },
      {
        room_label: "Suite",
        brochure_price: 20000,
        cruise_101_price: 5000,
        display_order: 3,
        airline_price: 4000
      },
      {
        room_label: "Penthouse",
        brochure_price: 30000,
        cruise_101_price: 9000,
        display_order: 4
      }
    ];
    const safe = sanitizePublicPricingRows(rows);
    assert(!("airline_price" in safe[0]), "airline stripped");
    assert(!("category" in safe[0]), "category stripped");
    assert(!JSON.stringify(safe).includes(airlineToken), "unique airline absent from sanitized");
    const offer = selectPublicOffer(rows, 10);
    assert(offer.cruise101Price === 1498, "first by display_order not lowest");
    assert(offer.roomLabel === "Singles - Balcony", "first room label");
    assert(normaliseRoomLabel("Singles - Balcony") === "SOLO BALCONY", "solo balcony label");
    assert(offer.greatDeal === true, "great deal >=85%");
    assert(!JSON.stringify(offer).includes(airlineToken), "airline value absent from offer");
    assert(!JSON.stringify(offer).includes('"S"'), "category absent");
    const offers = selectPublicOffers(rows, 10, 3);
    assert(offers.length === 3, "max three offers");
    assert(offers[2].roomLabel === "Suite", "third by display_order");
    assert(PUBLIC_PRICING_SELECT.includes("cruise_101_price"), "select includes public price");
    assert(!PUBLIC_PRICING_SELECT.includes("airline"), "select excludes airline");
    assert(!PUBLIC_PRICING_SELECT.includes("category"), "select excludes category");
    passed += 1;
  }

  // Destination resolution
  {
    assert(resolveCanonicalDestination("Barcelona, Spain") === "Barcelona", "Barcelona Spain");
    assert(resolveCanonicalDestination("Lisbon, Portugal") === "Lisbon", "Lisbon");
    assert(resolveCanonicalDestination("Singapore, Singapore") === "Singapore", "Singapore");
    assert(resolveCanonicalDestination("Fiji Islands") === "Fiji", "Fiji Islands");
    assert(resolveCanonicalDestination("New Zealand Cruises") === "New Zealand", "NZ Cruises");
    assert(resolveCanonicalDestination("Mediterranean & Aegean") === "Mediterranean", "Med alias");
    assert(resolveCanonicalDestination("South East Asia") === "Southeast Asia", "SE Asia");
    assert(resolveCanonicalDestination("Balinese spa") == null, "no Balinese substring");
    assert(resolveCanonicalDestination("Australian wines in New Zealand") == null, "no unsafe AU/NZ");
    passed += 1;
  }

  // Destination pool priority + rotation
  {
    const media = [
      {
        id: "m-med",
        media_type: "destination",
        destination_name: "Mediterranean",
        is_active: true,
        is_default: true,
        created_at: "2026-01-01",
        public_url: "https://example.com/med.jpg"
      },
      {
        id: "m-bcn-1",
        media_type: "destination",
        destination_name: "Barcelona",
        is_active: true,
        is_default: true,
        created_at: "2026-01-01",
        public_url: "https://example.com/bcn1.jpg"
      },
      {
        id: "m-bcn-2",
        media_type: "destination",
        destination_name: "Barcelona",
        is_active: true,
        is_default: false,
        created_at: "2026-01-02",
        public_url: "https://example.com/bcn2.jpg"
      },
      {
        id: "m-bcn-3",
        media_type: "destination",
        destination_name: "Barcelona",
        is_active: true,
        is_default: false,
        created_at: "2026-01-03",
        public_url: "https://example.com/bcn3.jpg"
      },
      {
        id: "m-ak",
        media_type: "destination",
        destination_name: "Alaska",
        is_active: true,
        is_default: true,
        created_at: "2026-01-01",
        public_url: "https://example.com/ak.jpg"
      }
    ];
    const cruise = {
      destination_strip: "Barcelona to Istanbul",
      departure_port: "Barcelona",
      arrival_port: "Istanbul",
      newsletter_number: 77,
      display_order: 1
    };
    const resolved = resolveSocialBackground({
      cruise,
      ports: ["Barcelona", "Palermo", "Istanbul"],
      destinationMedia: media
    });
    assert(resolved.destinationKey === "Barcelona", "exact Barcelona preferred over Med");
    assert(resolved.candidateCount === 3, "three Barcelona candidates");
    // (77 + 1 - 1) % 3 = 2 → third stable candidate
    assert(resolved.media.id === "m-bcn-3", "newsletter 77 + order 1 uses rotation formula");
    assert(!resolved.candidates.some((c) => c.id === "m-ak"), "unrelated Alaska excluded");

    const medOnly = resolveSocialBackground({
      cruise: { ...cruise, departure_port: "Unknown", arrival_port: "Nowhere", destination_strip: "" },
      ports: [],
      destinationMedia: media.filter((m) => m.destination_name === "Mediterranean")
    });
    assert(medOnly.status === "blocked" || medOnly.source === "featured_hero", "no unsafe regional alone without keys");

    const arrivalWins = resolveSocialBackground({
      cruise: {
        destination_strip: "",
        departure_port: "Unknown Port",
        arrival_port: "Barcelona",
        newsletter_number: 78,
        display_order: 1
      },
      ports: [],
      destinationMedia: media
    });
    assert(arrivalWins.destinationKey === "Barcelona", "arrival exact");
    // (78 + 1 - 1) % 3 = 0 → first candidate
    assert(arrivalWins.media.id === "m-bcn-1", "newsletter 78 rotation index 0");

    const offset = resolveSocialBackground({
      cruise: { ...cruise, newsletter_number: 77, display_order: 2 },
      ports: ["Barcelona"],
      destinationMedia: media
    });
    // (77 + 2 - 1) % 3 = 78 % 3 = 0
    assert(offset.media.id === "m-bcn-1", "same issue second cruise offsets");

    assert(rotationIndex({ newsletterNumber: 77, displayOrder: 1, count: 3 }) === 2, "rot 77");
    assert(rotationIndex({ newsletterNumber: 78, displayOrder: 1, count: 3 }) === 0, "rot 78");
    assert(rotationIndex({ newsletterNumber: 79, displayOrder: 1, count: 3 }) === 1, "rot 79");
    assert(rotationIndex({ newsletterNumber: 80, displayOrder: 1, count: 3 }) === 2, "rot 80");
    // Sequential issues still cycle the pool (78,79,80,81 → 0,1,2,0)
    assert(rotationIndex({ newsletterNumber: 81, displayOrder: 1, count: 3 }) === 0, "rot 81 cycles");

    const manual = resolveSocialBackground({
      cruise,
      ports: ["Barcelona"],
      destinationMedia: media,
      manualMediaId: "m-bcn-3"
    });
    assert(manual.media.id === "m-bcn-3", "manual override");
    assert(manual.matchRole === "manual", "manual role");

    const sorted = sortDestinationMedia(filterActiveDestinationMedia(media, "Barcelona"));
    assert(sorted[0].id === "m-bcn-1", "default first then created_at");
    passed += 1;
  }

  // Ship fallback only when empty
  {
    const fb = resolveSocialBackground({
      cruise: { departure_port: "Nowhere", arrival_port: "Else", newsletter_number: 1, display_order: 1 },
      ports: [],
      destinationMedia: [],
      featuredHeroUrl: null,
      shipHero: { url: "https://example.com/ship.jpg" }
    });
    assert(fb.source === "ship_hero", "ship fallback last");
    passed += 1;
  }

  // Dates + route headline
  {
    assert(formatAuDepartingFull("2026-08-17") === "DEPARTING 17 AUGUST 2026", "full AU departing");
    assert(buildRouteHeadline("Barcelona, Spain", "Istanbul, Turkey") === "BARCELONA TO ISTANBUL", "route");
    assert(GREEN === "#8DD9BF", "campaign green");
    passed += 1;
  }

  // Headline truncation still works
  {
    const long =
      "Mediterranean masterpieces meet timeless Aegean treasures on an unforgettable luxury voyage to enchanting Istanbul and beyond";
    const short = shortenHeadline(long);
    assert(short.split(/\s+/).length <= 12, "word cap");
    passed += 1;
  }

  // Ports
  {
    const ports = buildPortList({
      itinerarySummary:
        "Barcelona, Spain | Palermo, Sicily, Italy | Syracuse, Sicily | Argostoli | Gythion | Paros | Piraeus | Kusadasi | Bozcaada | Istanbul, Turkey",
      maxPorts: 16
    });
    assert(ports.ports[0].toLowerCase().includes("barcelona"), "starts barcelona");
    assert(ports.ports[ports.ports.length - 1].toLowerCase().includes("istanbul"), "ends istanbul");
    passed += 1;
  }

  // Render destination-first SVGs + PNGs
  {
    const model = {
      routeHeadline: "BARCELONA TO ISTANBUL",
      aboardLine: "ABOARD OCEANIA SIRENA",
      nightsLabel: "10 NIGHTS",
      departingLabel: "DEPARTING 17 AUGUST 2026",
      dateRangeFull: "17–27 AUGUST 2026",
      journeyArrow: "BARCELONA → ISTANBUL",
      lineName: "Oceania Cruises",
      shipName: "Sirena",
      ports: ["Barcelona", "Palermo", "Paros", "Athens", "Kusadasi", "Istanbul"],
      treatment: "soft",
      slideTreatments: { main: "soft", journey: "soft", offer: "strong", cta: "strong" },
      backgroundDataUri: tinyPngDataUri(),
      heroDataUri: tinyPngDataUri(),
      brandLogoDataUri: tinyPngDataUri(),
      offers: [
        {
          roomLabel: "Singles - Balcony",
          roomLabelDisplay: "SOLO BALCONY",
          roomSlug: "solo-balcony",
          brochureLabel: "US$10,498",
          priceLabel: "US$1,498",
          saveLabel: "SAVE US$9,000",
          cruise101Price: 1498,
          brochurePrice: 10498
        }
      ],
      offer: {
        roomLabel: "Singles - Balcony",
        roomLabelDisplay: "SOLO BALCONY",
        roomSlug: "solo-balcony",
        brochureLabel: "US$10,498",
        priceLabel: "US$1,498",
        saveLabel: "SAVE US$9,000",
        cruise101Price: 1498
      },
      primaryInclusion: "Beverage package",
      inclusions: ["Beverage package"],
      folderSlug: "01-oceania-sirena-barcelona"
    };

    const airlineToken = "AIRLINE_SECRET_VALUE_ZX9Q";
    const mainSvg = renderMainCruiseSvg(model);
    const journeySvg = renderJourneySvg(model);
    const offerSvg = renderOfferSvg(model, 0);
    const ctaSvg = renderCtaSvg(model);
    assert(!/#ffffff"\/>\s*<style>/.test(mainSvg) || !mainSvg.includes('fill="#ffffff"/>\n  <style>'), "not white page frame");
    assert(mainSvg.includes("#8DD9BF"), "green footer main");
    assert(mainSvg.includes("fill-opacity"), "treatment overlay present");
    assert(!mainSvg.includes(airlineToken), "no airline in main");
    assert(!offerSvg.toLowerCase().includes("airline"), "no airline word in offer");
    assert(offerSvg.includes("101CRUISE PRICE"), "public price panel");
    assert(ctaSvg.includes("TALK TO PAUL"), "cta copy");
    assert(ctaSvg.includes("Get your cruise on"), "cta script compromise text");

    for (const [label, svg] of [
      ["clear", renderMainCruiseSvg({ ...model, treatment: "clear", slideTreatments: { main: "clear" } })],
      ["soft", mainSvg],
      ["strong", renderMainCruiseSvg({ ...model, treatment: "strong", slideTreatments: { main: "strong" } })]
    ]) {
      const png = svgToPngBuffer(svg);
      const dims = pngDims(png.png);
      assert(dims.sig && dims.width === WIDTH && dims.height === HEIGHT, `${label} png size`);
    }

    const pack = await renderCruisePack(model, { forbiddenStrings: [airlineToken] });
    assert(pack.slides["01-main-cruise.png"], "main slide name");
    assert(pack.slides["02-journey.png"], "journey slide");
    assert(pack.slides["03-offer-solo-balcony.png"], "offer slug filename");
    assert(pack.slides["final-call-to-action.png"], "cta slide");
    assert(Object.keys(pack.slides).length === 4, "1 offer → 4 slides");
    const joined = Object.values(pack.svgs).join("\n");
    assert(!joined.includes(airlineToken), "airline absent from all svgs");

    const zip = await buildSocialPackZip({
      newsletterNumber: 77,
      packs: [{ ...model, id: "x", caption: buildCaption(model), slides: pack.slides, readiness: { warnings: [] } }]
    });
    assert(zip.filename.includes("77"), "zip name");
    assert(!JSON.stringify(zip.manifest).includes(airlineToken), "manifest clean");
    assert(!JSON.stringify(zip.manifest).toLowerCase().includes("airline_price"), "no airline_price key");
    passed += 1;
  }

  // Slide plan max 3 offers
  {
    const offers = [1, 2, 3, 4].map((i) => ({ roomSlug: `room-${i}` }));
    const plan = buildSlidePlan({ offers });
    assert(plan.filter((p) => p.kind === "offer").length === 3, "max 3 offers in plan");
    assert(plan[plan.length - 1].key === "final-call-to-action.png", "cta last");
    passed += 1;
  }

  // Readiness + folder slug + sniff
  {
    assert(
      assessReadiness({
        backgroundUrl: "https://x",
        destinationStrip: "A",
        departureDate: "2026-01-01",
        returnDate: "2026-01-10",
        lineName: "L",
        shipName: "S",
        offers: [{ cruise101Price: 1 }]
      }).status === "ready_fallback_map",
      "ready without map"
    );
    assert(cruiseFolderSlug({ index: 1, lineName: "Oceania", shipName: "Sirena", destinationStrip: "Barcelona to Istanbul" }).startsWith("01-"), "folder");
    assert(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])) === "image/jpeg", "jpeg sniff");
    assert(WIDTH === 1080 && HEIGHT === 1350, "portrait dims");
    passed += 1;
  }

  // No font files added
  {
    const fonts = fs.readdirSync(root).filter((f) => /\.(ttf|otf|woff2?)$/i.test(f));
    assert(fonts.length === 0, "no bundled font at root");
    passed += 1;
  }

  // Source guards
  {
    const dataSrc = fs.readFileSync(path.join(root, "netlify/functions/lib/social-pack-data.js"), "utf8");
    assert(!/airline_price/.test(dataSrc) || /never select airline_price/i.test(dataSrc), "data comments only");
    assert(!/select=[^`]*airline/i.test(dataSrc), "no airline in select");
    const genSrc = fs.readFileSync(path.join(root, "netlify/functions/social-pack-generate.js"), "utf8");
    assert(/requireAdmin/.test(genSrc), "admin auth required");
    assert(/Never writes/.test(genSrc), "no write promise");
    passed += 1;
  }

  console.log(`test-social-pack-generator: ${passed} groups ok`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
