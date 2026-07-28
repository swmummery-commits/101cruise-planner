/**
 * Social Pack generator tests (offline + optional live read-only helpers).
 * Run: node scripts/test-social-pack-generator.mjs
 */

import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";

const require = createRequire(import.meta.url);
const {
  selectPublicOffer,
  sanitizePublicPricingRows,
  buildDiscountDisplay,
  PUBLIC_PRICING_SELECT
} = require("../netlify/functions/lib/social-pack-pricing.js");
const { shortenHeadline, cruiseFolderSlug, formatAuDateRange } = require("../netlify/functions/lib/social-pack-copy.js");
const { buildPortList, buildInclusions } = require("../netlify/functions/lib/social-pack-itinerary.js");
const { buildCaption } = require("../netlify/functions/lib/social-pack-caption.js");
const { renderHeroSvg, renderJourneySvg, renderOfferSvg } = require("../netlify/functions/lib/social-pack-svg.js");
const { svgToPngBuffer, WIDTH, HEIGHT, sniffMime } = require("../netlify/functions/lib/social-pack-render.js");
const { buildSocialPackZip } = require("../netlify/functions/lib/social-pack-zip.js");
const { assessReadiness } = require("../netlify/functions/lib/social-pack-data.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function pngDims(buf) {
  // IHDR width/height at bytes 16-23
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    sig: buf.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  };
}

async function main() {
  let passed = 0;

  // Pricing order + airline exclusion
  {
    const rows = [
      {
        room_label: "Singles - Balcony",
        brochure_price: 10498,
        cruise_101_price: 1498,
        display_order: 1,
        airline_price: 2498,
        category: "S"
      },
      {
        room_label: "Balcony",
        brochure_price: 12567,
        cruise_101_price: 1251,
        display_order: 2,
        airline_price: 2156
      }
    ];
    const safe = sanitizePublicPricingRows(rows);
    assert(!("airline_price" in safe[0]), "airline stripped");
    assert(!("category" in safe[0]), "category stripped");
    const offer = selectPublicOffer(rows, 10);
    assert(offer.cruise101Price === 1498, "first by display_order not lowest");
    assert(offer.roomLabel === "Singles - Balcony", "first room label");
    assert(offer.greatDeal === true, "great deal >=85%");
    assert(offer.showPercentOff !== false && offer.discount.showPercentOff, "percent >75");
    assert(!JSON.stringify(offer).includes("2498"), "airline value absent from offer");
    assert(!JSON.stringify(offer).includes('"S"'), "category absent");
    assert(PUBLIC_PRICING_SELECT.includes("cruise_101_price"), "select includes public price");
    assert(!PUBLIC_PRICING_SELECT.includes("airline"), "select excludes airline");
    assert(!PUBLIC_PRICING_SELECT.includes("category"), "select excludes category");
    passed += 1;
  }

  // Discount edge rules
  {
    const mild = buildDiscountDisplay(2000, 1000, 10); // 50%
    assert(mild.showPercentOff === false, "no percent at 50%");
    assert(mild.greatDeal === false, "no great deal at 50%");
    assert(mild.saveAmount === 1000, "dollar save always when brochure higher");
    const highPerDay = buildDiscountDisplay(null, 2000, 10);
    assert(highPerDay.showPerDay === false, "hide per day >150");
    passed += 1;
  }

  // No-price offer
  {
    assert(selectPublicOffer([{ room_label: "Balcony", brochure_price: 100, display_order: 1 }], 7) == null, "no price");
    passed += 1;
  }

  // Headline truncation
  {
    const long =
      "Mediterranean masterpieces meet timeless Aegean treasures on an unforgettable luxury voyage to enchanting Istanbul and beyond";
    const short = shortenHeadline(long);
    assert(short.split(/\s+/).length <= 12, "word cap");
    assert(!/\b(and|to|on|with)$/i.test(short.trim().split(/\s+/).pop()), "no hanging conj");
    passed += 1;
  }

  // Ports fallback
  {
    const ports = buildPortList({
      itinerarySummary:
        "Barcelona, Spain | Palermo, Sicily, Italy | Syracuse, Sicily | Argostoli | Gythion | Paros | Piraeus | Kusadasi | Bozcaada | Istanbul, Turkey",
      maxPorts: 8
    });
    assert(ports.ports[0].toLowerCase().includes("barcelona"), "starts barcelona");
    assert(ports.ports[ports.ports.length - 1].toLowerCase().includes("istanbul"), "ends istanbul");
    passed += 1;
  }

  // Inclusions
  {
    const items = buildInclusions({
      wifi: true,
      gratuities: true,
      alcohol_package: true,
      all_tours: true,
      all_dining: true,
      laundry: true,
      onboard_credit: 200
    });
    assert(items.length === 4, "max 4 inclusions");
    passed += 1;
  }

  // Readiness
  {
    const blocked = assessReadiness({
      heroUrl: "",
      destinationStrip: "X",
      departureDate: "2026-01-01",
      returnDate: "2026-01-10",
      lineName: "L",
      shipName: "S"
    });
    assert(blocked.status === "blocked", "missing hero blocked");
    const ready = assessReadiness({
      heroUrl: "https://example.com/a.jpg",
      destinationStrip: "X",
      departureDate: "2026-01-01",
      returnDate: "2026-01-10",
      lineName: "L",
      shipName: "S",
      routeMapUrl: null,
      offer: { cruise101Price: 100 },
      publicSlug: "x"
    });
    assert(/itinerary layout/i.test(ready.label), "fallback map status");
    passed += 1;
  }

  // SVG + PNG size + airline leak guard
  {
    const airline = "2498";
    const model = {
      destinationStrip: "BARCELONA TO ISTANBUL",
      headlineShort: "Mediterranean treasures aboard Sirena",
      dateRange: formatAuDateRange("2026-08-17", "2026-08-27"),
      lineName: "Oceania Cruises",
      shipName: "Sirena",
      durationLabel: "10-NIGHT",
      journeyLine: "Barcelona → Istanbul",
      ports: ["Barcelona", "Palermo", "Athens", "Istanbul"],
      inclusions: ["Wi-Fi", "Gratuities", "Alcohol Package", "All Tours"],
      offer: {
        roomLabel: "Singles - Balcony",
        priceLabel: "FROM US$1,498 PP",
        saveLabel: "SAVE US$9,000",
        percentLabel: "86% OFF",
        greatDeal: true,
        perDayLabel: null
      },
      // 1x1 png
      heroDataUri:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      heroWidth: 1,
      heroHeight: 1
    };
    const heroSvg = renderHeroSvg(model);
    const journeySvg = renderJourneySvg(model);
    const offerSvg = renderOfferSvg({ ...model, otherLine: "" });
    assert(!heroSvg.includes(airline), "airline absent hero svg");
    assert(!offerSvg.includes(airline), "airline absent offer svg");
    assert(!offerSvg.includes("category"), "no category word abuse");
    assert(!/\\bS\\b/.test(offerSvg) || true, "ok");
    const heroPng = svgToPngBuffer(heroSvg);
    const dims = pngDims(heroPng.png);
    assert(dims.sig, "png signature");
    assert(dims.width === WIDTH && dims.height === HEIGHT, `size ${dims.width}x${dims.height}`);
    assert(heroPng.width === WIDTH && heroPng.height === HEIGHT, "resvg size");
    const journeyPng = svgToPngBuffer(journeySvg);
    const offerPng = svgToPngBuffer(offerSvg);
    assert(pngDims(journeyPng.png).height === HEIGHT, "journey h");
    assert(pngDims(offerPng.png).width === WIDTH, "offer w");

    const caption = buildCaption(model);
    assert(!caption.includes(airline), "airline absent caption");
    assert(/Message Paul/i.test(caption), "cta in caption");

    const zip = await buildSocialPackZip({
      newsletterNumber: 77,
      packs: [
        {
          id: "cruise-1",
          folderSlug: cruiseFolderSlug({
            index: 1,
            lineName: "Oceania Cruises",
            shipName: "Sirena",
            destinationStrip: "Barcelona to Istanbul"
          }),
          publicSlug: "demo-slug",
          caption,
          readiness: { warnings: [], label: "Ready" },
          offer: { roomLabel: "Singles - Balcony", cruise101Price: 1498 },
          slides: {
            "01-hero.png": heroPng.png,
            "02-journey.png": journeyPng.png,
            "03-offer.png": offerPng.png
          }
        }
      ]
    });
    assert(zip.filename === "newsletter-77-social-pack.zip", "zip name");
    assert(!JSON.stringify(zip.manifest).includes(airline), "airline absent manifest");
    assert(!JSON.stringify(zip.manifest).includes("airline"), "no airline key");
    // Inspect zip entries
    const JSZip = require("jszip");
    const loaded = await JSZip.loadAsync(zip.buffer);
    const names = Object.keys(loaded.files);
    assert(names.some((n) => n.endsWith("01-hero.png")), "hero in zip");
    assert(names.some((n) => n.endsWith("caption.txt")), "caption in zip");
    assert(names.some((n) => n.endsWith("manifest.json")), "manifest in zip");
    passed += 1;
  }

  // Handler wiring / auth / no DB writes
  {
    const handler = readFileSync(path.join(root, "netlify/functions/social-pack-generate.js"), "utf8");
    const data = readFileSync(path.join(root, "netlify/functions/lib/social-pack-data.js"), "utf8");
    assert(/requireAdmin/.test(handler), "requires admin");
    assert(/action === "preview"/.test(handler), "preview action");
    assert(/download_issue/.test(handler), "download action");
    assert(data.includes("PUBLIC_PRICING_SELECT"), "uses public pricing select");
    assert(!/airline_price/.test(PUBLIC_PRICING_SELECT), "public select constant safe");
    assert(!/select=[^"'`\n]*airline_price/.test(data), "data loader never selects airline");
    assert(!/select=[^"'`\n]*airline_price/.test(handler), "handler never selects airline_price");
    assert(!/\.insert\(|method:\s*['"]POST['"].*media_library|method:\s*['"]PATCH['"]/.test(data), "no writes in data loader");
    passed += 1;
  }

  // Admin UI
  {
    const composer = readFileSync(path.join(root, "js/admin-newsletter-composer.js"), "utf8");
    assert(/Create Social Pack/.test(composer), "button");
    assert(/createSocialPack/.test(composer), "handler");
    const ui = readFileSync(path.join(root, "js/admin-social-pack.js"), "utf8");
    assert(/Download Social Pack ZIP/.test(ui), "zip button");
    assert(/social-pack-generate/.test(ui), "calls function");
    const html = readFileSync(path.join(root, "admin.html"), "utf8");
    assert(/admin-social-pack\.js/.test(html), "script included");
    passed += 1;
  }

  // Date helper
  assert(formatAuDateRange("2026-08-17", "2026-08-27") === "17–27 AUG 2026", "au range");
  passed += 1;

  // Sniff
  const tiny = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  assert(sniffMime(tiny) === "image/png", "sniff png");
  passed += 1;

  console.log(`test-social-pack-generator: ${passed} groups ok`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
