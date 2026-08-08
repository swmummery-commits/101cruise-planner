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
  filterOffersByRoomLabels,
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
  PREVIEW_WIDTH,
  PREVIEW_HEIGHT,
  sniffMime,
  buildSlidePlan,
  renderCruisePack
} = require("../netlify/functions/lib/social-pack-render.js");
const { normaliseTemplate } = require("../netlify/functions/lib/social-pack-template.js");
const { renderPremiumDarkOfferSvg, resolvePremiumDarkRoute } = require("../netlify/functions/lib/social-pack-premium-dark.js");
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

function countWords(text) {
  return String(text || "")
    .replace(/#\w+/g, "")
    .split(/\s+/)
    .filter(Boolean).length;
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
    const offers = selectPublicOffers(rows, 10);
    assert(offers.length === 4, "one offer per cabin with public price");
    assert(offers[2].roomLabel === "Suite", "third by display_order");
    assert(offers[3].roomLabel === "Penthouse", "fourth cabin included");
    const capped = selectPublicOffers(rows, 10, 2);
    assert(capped.length === 2, "explicit limit still respected");
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
    assert(manual.candidateCount === 3, "manual keeps full pool for Next/Previous");
    assert(manual.candidates.map((m) => m.id).includes("m-bcn-1"), "pool includes siblings");
    assert(manual.rotationIndex === manual.candidates.findIndex((m) => m.id === "m-bcn-3"), "manual index in pool");
    assert(manual.source === "manual", "manual source");

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
    const offerSvg = renderOfferSvg(model, 0);
    const ctaSvg = renderCtaSvg(model);
    assert(mainSvg.includes("#8DD9BF"), "green footer main");
    assert(mainSvg.includes("fill-opacity"), "treatment overlay present");
    assert(!mainSvg.includes(airlineToken), "no airline in main");
    assert(!offerSvg.toLowerCase().includes("airline"), "no airline word in offer");
    assert(offerSvg.includes("101CRUISE PRICE"), "public price panel");
    assert(ctaSvg.includes("TALK TO PAUL"), "cta talk line");
    assert(ctaSvg.includes(">TODAY<"), "cta today line");
    assert(ctaSvg.includes("paul@101cruise.com.au"), "cta email");
    assert(ctaSvg.includes("ctaHeadlineShadow"), "cta headline shadow");
    assert(
      ctaSvg.includes("Get your cruise on") || ctaSvg.includes("get-your-cruise-on") || ctaSvg.includes("feeling_passionate"),
      "cta script artwork"
    );
    assert(offerSvg.includes("BROCHURE PRICE"), "brochure pill");
    assert(offerSvg.includes("INCLUDES"), "includes pill");
    assert(offerSvg.includes("rotate(-6"), "angled room pill");
    assert(offerSvg.includes("* Price in US dollars"), "disclaimer pill");
    assert(offerSvg.includes("fill-opacity=\"0.82\""), "translucent pills");

    // Approved treatments: pricing clear, CTA strong (main uses master soften)
    const treatedPack = await renderCruisePack({
      ...model,
      slideTreatments: { main: "soft", offer: "clear", cta: "strong" }
    });
    assert(treatedPack.slides["02-offer-solo-balcony.png"], "pricing slide present");
    assert(treatedPack.slides["final-call-to-action.png"], "cta slide present");

    // Missing brochure → omit panel
    const noBrochureSvg = renderOfferSvg(
      {
        ...model,
        offers: [
          {
            ...model.offers[0],
            showBrochure: false,
            brochureLabel: null,
            brochurePrice: null
          }
        ]
      },
      0
    );
    assert(!noBrochureSvg.includes("BROCHURE PRICE"), "omit brochure when missing");

    // Missing inclusions → omit panel
    const noInclSvg = renderOfferSvg({ ...model, inclusions: [], primaryInclusion: null }, 0);
    assert(!noInclSvg.includes(">INCLUDES<"), "omit includes when empty");

    // Long room label wraps to two lines
    const longRoomSvg = renderOfferSvg(
      {
        ...model,
        offers: [
          {
            ...model.offers[0],
            roomLabelDisplay: "PREMIUM CONCIERGE VERANDA SUITE"
          }
        ]
      },
      0
    );
    assert(longRoomSvg.includes("PREMIUM CONCIERGE") || longRoomSvg.includes("VERANDA"), "long room label present");

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
    assert(!pack.slides["02-journey.png"], "no journey slide by default");
    assert(pack.slides["02-offer-solo-balcony.png"], "offer starts at 02");
    assert(pack.slides["final-call-to-action.png"], "cta slide");
    assert(Object.keys(pack.slides).length === 3, "1 offer → main + pricing + cta");
    assert(pack.dimensions.width === WIDTH && pack.dimensions.height === HEIGHT, "export dims full");
    for (const buf of Object.values(pack.slides)) {
      const dims = pngDims(buf);
      assert(dims.width === WIDTH && dims.height === HEIGHT, "export png 1080×1350");
    }
    const joined = Object.values(pack.svgs).join("\n");
    assert(!joined.includes(airlineToken), "airline absent from all svgs");

    // Preview uses reduced raster; same SVG geometry / templates
    const previewPack = await renderCruisePack(model, {
      outputWidth: PREVIEW_WIDTH,
      outputHeight: PREVIEW_HEIGHT,
      forbiddenStrings: [airlineToken]
    });
    assert(previewPack.dimensions.width === PREVIEW_WIDTH, "preview width");
    assert(previewPack.dimensions.height === PREVIEW_HEIGHT, "preview height");
    assert(previewPack.exportDimensions.width === WIDTH, "export dims retained");
    assert(Object.keys(previewPack.slides).join() === Object.keys(pack.slides).join(), "same slide keys");
    assert(previewPack.svgs["01-main-cruise.png"] === pack.svgs["01-main-cruise.png"], "same template svg");
    let previewRaw = 0;
    for (const buf of Object.values(previewPack.slides)) {
      const dims = pngDims(buf);
      assert(dims.width === PREVIEW_WIDTH && dims.height === PREVIEW_HEIGHT, "preview png size");
      previewRaw += buf.length;
    }
    const previewB64 = Math.ceil((previewRaw * 4) / 3);
    assert(previewB64 < 5.5 * 1024 * 1024, "preview payload under safe threshold");

    // Six-slide Sirena-style preview stays safe
    const sixOffers = [1, 2, 3, 4].map((i) => ({
      ...model.offers[0],
      roomSlug: `room-${i}`,
      roomLabel: `Room ${i}`,
      roomLabelDisplay: `ROOM ${i}`
    }));
    const sixPreview = await renderCruisePack(
      { ...model, offers: sixOffers },
      { outputWidth: PREVIEW_WIDTH, outputHeight: PREVIEW_HEIGHT }
    );
    assert(Object.keys(sixPreview.slides).length === 6, "six-slide preview");
    let sixRaw = 0;
    for (const buf of Object.values(sixPreview.slides)) sixRaw += buf.length;
    assert(Math.ceil((sixRaw * 4) / 3) < 5.5 * 1024 * 1024, "six-slide preview under limit");

    // No public prices → main + cta only
    const enquiryPack = await renderCruisePack({ ...model, offers: [], offer: null });
    assert(Object.keys(enquiryPack.slides).length === 2, "no prices → main + cta only");
    assert(!Object.keys(enquiryPack.slides).some((k) => k.includes("offer")), "no offer files without prices");

    const zip = await buildSocialPackZip({
      newsletterNumber: 77,
      packs: [{ ...model, id: "x", caption: buildCaption(model), slides: pack.slides, readiness: { warnings: [] } }]
    });
    assert(zip.filename.includes("77"), "zip name");
    assert(!JSON.stringify(zip.manifest).includes(airlineToken), "manifest clean");
    assert(!JSON.stringify(zip.manifest).toLowerCase().includes("airline_price"), "no airline_price key");
    // ZIP slides remain full resolution
    for (const buf of Object.values(pack.slides)) {
      assert(pngDims(buf).width === 1080, "zip source full width");
    }

    const caption = buildCaption({
      ...model,
      shortEditorial:
        "Departing on 5 November 2026, this seven-night voyage aboard Oceania Sirena is a wonderful blend of history, culture and unforgettable scenery.",
      headline: "Mediterranean masterpieces meet timeless Aegean treasures.",
      departurePort: "Rome, Italy",
      arrivalPort: "Istanbul, Turkey",
      ports: ["Rome, Italy", "Naples", "Messina, Sicily", "Valletta", "Piraeus", "Istanbul, Turkey"],
      nights: 7,
      lineName: "Oceania Cruises",
      shipName: "Sirena"
    });
    assert(/Time to get warm\?/i.test(caption), "caption opens with conversational hook");
    assert(/Oceania Sirena/i.test(caption), "caption names ship naturally");
    assert(/Talk to Paul today/i.test(caption), "caption includes paul cta");
    assert(/get your cruise on/i.test(caption), "caption includes brand sign-off");
    assert((caption.match(/#\w+/g) || []).length === 5, "caption has five hashtags");
    assert(/#OceaniaCruises/i.test(caption), "caption includes cruise line hashtag");
    assert(countWords(caption) <= 50, "caption stays succinct");
    assert(!caption.includes("paul@101cruise.com.au"), "caption omits email");
    assert(!caption.includes("101cruise.com.au"), "caption omits website");
    assert(!caption.toLowerCase().includes("airline"), "caption no airline");
    assert(!/US\$|FROM US\$|per person in USD|Ask Paul for his best price/i.test(caption), "caption has no pricing");
    assert(!caption.includes("Includes:"), "caption omits inclusion list");
    passed += 1;
  }

  // Template selection — classic default, premium_dark offer slides
  {
    const templateModel = {
      backgroundDataUri: tinyPngDataUri(),
      brandLogoDataUri: tinyPngDataUri(),
      routeHeadline: "BARCELONA TO ISTANBUL",
      departurePort: "Barcelona, Spain",
      arrivalPort: "Istanbul, Turkey",
      inclusions: ["Wi-Fi", "Gratuities", "Alcohol Package", "All Dining"],
      offers: [
        {
          roomLabel: "Balcony",
          roomLabelDisplay: "BALCONY",
          roomSlug: "balcony",
          brochureLabel: "US$10,498",
          priceLabel: "US$1,498",
          showBrochure: true,
          brochurePrice: 10498,
          cruise101Price: 1498
        }
      ],
      offer: {
        roomLabel: "Balcony",
        roomLabelDisplay: "BALCONY",
        roomSlug: "balcony",
        brochureLabel: "US$10,498",
        priceLabel: "US$1,498",
        showBrochure: true,
        brochurePrice: 10498,
        cruise101Price: 1498
      }
    };

    assert(normaliseTemplate(undefined) === "classic", "no template → classic");
    assert(normaliseTemplate("classic") === "classic", "classic → classic");
    assert(normaliseTemplate("premium_dark") === "premium_dark", "premium_dark → premium_dark");
    assert(normaliseTemplate("premium-dark") === "premium_dark", "hyphen alias");
    assert(normaliseTemplate("unknown") === "classic", "invalid → classic");

    const classicOffer = renderOfferSvg(templateModel, 0);
    assert(classicOffer.includes("BROCHURE PRICE"), "classic retains brochure pill");
    assert(classicOffer.includes(">INCLUDES<"), "classic retains includes heading");

    const pdOffer = renderPremiumDarkOfferSvg(templateModel, 0);
    assert(pdOffer.includes("BARCELONA TO ISTANBUL"), "premium dark route");
    assert(pdOffer.includes("$10,498*") || pdOffer.includes("10,498"), "premium dark brochure price");
    assert(pdOffer.includes(GREEN), "premium dark website green");
    assert(pdOffer.includes(">BALCONY<"), "premium dark cabin type");
    assert(pdOffer.includes(">WI-FI<") || pdOffer.includes("WI-FI"), "premium dark inclusion label");
    assert(pdOffer.includes(">GRATUITIES<") || pdOffer.includes("GRATUITIES"), "premium dark gratuities");
    assert(!pdOffer.includes(">INCLUDES<"), "premium dark omits INCLUDES heading");
    assert(!pdOffer.includes("BROCHURE PRICE"), "premium dark omits brochure pill label");
    assert(!pdOffer.includes("101CRUISE PRICE"), "premium dark omits price pill label");
    assert(!pdOffer.includes("per person"), "premium dark omits per person pill copy");
    assert(pdOffer.includes("* Price in US dollars"), "premium dark disclaimer");
    assert(pdOffer.includes('stroke="#F80020"'), "red strike-through");
    assert(pdOffer.includes('stroke="#DDE2E8"'), "subtle light divider line");

    const marketingModel = {
      ...templateModel,
      headline: "Greek Isles, Mediterranean Escape on an unforgettable voyage",
      destinationStrip: "GREEK ISLES, MEDITERRANEAN ESCAPE",
      routeHeadline: "",
      departurePort: "Athens",
      arrivalPort: "Istanbul, Turkey",
      ports: ["Athens", "Santorini", "Istanbul"]
    };
    assert(resolvePremiumDarkRoute(marketingModel) === "ATHENS TO ISTANBUL", "route from itinerary ports");
    const marketingSvg = renderPremiumDarkOfferSvg(marketingModel, 0);
    assert(marketingSvg.includes("ATHENS TO ISTANBUL"), "premium dark shows endpoints not marketing");
    assert(!marketingSvg.includes("GREEK ISLES"), "premium dark excludes destination strip copy");

    const classicPack = await renderCruisePack({ ...templateModel, template: "classic" });
    const pdPack = await renderCruisePack({ ...templateModel, template: "premium_dark" });
    assert(classicPack.svgs["02-offer-balcony.png"] !== pdPack.svgs["02-offer-balcony.png"], "offer svg differs by template");
    assert(
      classicPack.svgs["01-main-cruise.png"] === pdPack.svgs["01-main-cruise.png"],
      "main slide unchanged for premium_dark"
    );
    assert(
      classicPack.svgs["final-call-to-action.png"] === pdPack.svgs["final-call-to-action.png"],
      "cta slide unchanged for premium_dark"
    );

    const invalidPack = await renderCruisePack({ ...templateModel, template: "futuristic" });
    assert(invalidPack.svgs["02-offer-balcony.png"] === classicPack.svgs["02-offer-balcony.png"], "invalid template falls back to classic");

    passed += 1;
  }

  // Room include/exclude + display_order
  {
    const rows = [
      { room_label: "Balcony", cruise_101_price: 1000, brochure_price: 2000, display_order: 2 },
      { room_label: "Suite", cruise_101_price: 3000, brochure_price: 4000, display_order: 1 },
      { room_label: "Inside", cruise_101_price: 800, brochure_price: 900, display_order: 3 }
    ];
    const offers = selectPublicOffers(rows, 7);
    assert(offers.map((o) => o.roomLabel).join(",") === "Suite,Balcony,Inside", "display_order retained");
    const filtered = filterOffersByRoomLabels(offers, ["Balcony", "Inside"]);
    assert(filtered.length === 2, "room include filter");
    assert(filtered[0].roomLabel === "Balcony", "filtered order preserved");
    assert(filterOffersByRoomLabels(offers, []).length === 0, "empty selection excludes all");
    assert(filterOffersByRoomLabels(offers, null).length === 3, "null keeps all");
    passed += 1;
  }

  // Slide plan: one offer slide per cabin; numbering from 02-
  {
    const offers = [1, 2, 3, 4].map((i) => ({ roomSlug: `room-${i}` }));
    const plan = buildSlidePlan({ offers });
    assert(plan.filter((p) => p.kind === "offer").length === 4, "one offer slide per cabin");
    assert(plan[1].key === "02-offer-room-1.png", "first offer is 02");
    assert(!plan.some((p) => p.kind === "journey"), "no journey in plan");
    assert(plan[plan.length - 1].key === "final-call-to-action.png", "cta last");
    const dupPlan = buildSlidePlan({
      offers: [
        { roomSlug: "balcony" },
        { roomSlug: "balcony" }
      ]
    });
    const offerKeys = dupPlan.filter((p) => p.kind === "offer").map((p) => p.key);
    assert(new Set(offerKeys).size === offerKeys.length, "duplicate room slugs get unique filenames");
    assert(buildSlidePlan({ offers: [] }).length === 2, "no rooms → main + cta");
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
      }).status === "ready",
      "ready with public prices"
    );
    assert(
      assessReadiness({
        backgroundUrl: "https://x",
        destinationStrip: "A",
        departureDate: "2026-01-01",
        returnDate: "2026-01-10",
        lineName: "L",
        shipName: "S",
        offers: []
      }).label.includes("No public room prices"),
      "missing price warning"
    );
    assert(cruiseFolderSlug({ index: 1, lineName: "Oceania", shipName: "Sirena", destinationStrip: "Barcelona to Istanbul" }).startsWith("01-"), "folder");
    assert(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])) === "image/jpeg", "jpeg sniff");
    assert(WIDTH === 1080 && HEIGHT === 1350, "portrait dims");
    assert(PREVIEW_WIDTH === 432 && PREVIEW_HEIGHT === 540, "preview dims");
    assert(GREEN === "#8DD9BF", "exact footer green");
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
    assert(/download_cruise/.test(genSrc), "per-cruise download");
    assert(/download_url/.test(genSrc) || /uploadZipAndSign/.test(genSrc), "signed download path");
    assert(!/airline_price/.test(PUBLIC_PRICING_SELECT), "select columns public-only");
    const exportSrc = fs.readFileSync(
      path.join(root, "netlify/functions/lib/social-pack-export-storage.js"),
      "utf8"
    );
    assert(/social-pack-exports/.test(exportSrc), "export bucket");
    assert(!/media_library/.test(exportSrc), "no media library writes in export helper");
    passed += 1;
  }

  console.log(`test-social-pack-generator: ${passed} groups ok`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
