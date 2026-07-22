/**
 * Lightweight offline checks for Sprint 13A Mailchimp HTML POC.
 * Run: node scripts/test-mailchimp-export.mjs
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const sandbox = {
  console,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  Intl,
  Number,
  String,
  Boolean,
  Array,
  Object,
  Math,
  JSON,
  RegExp,
  Error,
  module: { exports: {} },
  exports: {}
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
const context = vm.createContext(sandbox);

function load(rel) {
  const code = readFileSync(path.join(root, rel), "utf8");
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  vm.runInContext(code, context, { filename: rel });
}

load("js/newsletter-typography.js");
load("js/newsletter-cruise-shared.js");
load("js/newsletter-mailchimp-export.js");

const Export = sandbox.NewsletterMailchimpExport;
const Shared = sandbox.NewsletterCruiseShared;

assert(Export, "NewsletterMailchimpExport loaded");
assert(Shared, "NewsletterCruiseShared loaded");

assert(Export.isPublicImageUrl("https://cdn.example.com/hero.jpg"), "accept https image");
assert(!Export.isPublicImageUrl("/assets/hero.jpg"), "reject relative image");
assert(!Export.isPublicImageUrl("blob:http://localhost/x"), "reject blob");
assert(!Export.isPublicImageUrl("data:image/png;base64,xx"), "reject data uri");
assert(!Export.isPublicImageUrl("http://localhost:8888/x.jpg"), "reject localhost");
assert(!Export.isPublicImageUrl("https://www.101cruise.com.au/admin"), "reject admin path");

assert(
  Export.toAbsolutePublicUrl("/cruise/sample-slug") ===
    "https://www.101cruise.com.au/cruise/sample-slug",
  "absolute CTA from slug path"
);

const pricingRows = [
  {
    room_label: "Inside",
    brochure_price: 2000,
    cruise_101_price: 1200,
    airline_price: 900,
    display_order: 1
  },
  {
    room_label: "Balcony",
    brochure_price: 3000,
    cruise_101_price: 1800,
    airline_price: 1400,
    display_order: 2
  },
  {
    room_label: "Suite",
    brochure_price: null,
    cruise_101_price: null,
    airline_price: null,
    display_order: 3
  },
  {
    room_label: "Oceanview",
    brochure_price: 2500,
    cruise_101_price: 1500,
    airline_price: 1100,
    display_order: 4
  }
];

function baseModel(outputMode) {
  const modules = Shared.buildPricingModules(pricingRows, 7, { outputMode });
  return {
    destinationStrip: "SYDNEY TO SYDNEY",
    headline: "Pacific Escape with <script>alert(1)</script>",
    heroImageUrl: "https://example.supabase.co/storage/v1/object/public/cruise-media/hero.jpg",
    heroImageAlt: "Hero",
    datesLine: "MON JAN 1 TO MON JAN 8, 2027",
    nightsShipLine: "7 NIGHTS | CARNIVAL CRUISE LINE CARNIVAL SPLENDOR",
    portsJoined: "Sydney | Noumea | Mystery Island",
    description: "A short editorial with <b>tags</b> & ampersands.",
    descriptionParagraphs: ["A short editorial with <b>tags</b> & ampersands."],
    exploreMoreLabel: "EXPLORE MORE",
    landingPageUrl: "/cruise/pacific-escape",
    routeMapUrl: "https://example.supabase.co/storage/v1/object/public/cruise-media/map.jpg",
    routeMapAlt: "Route map",
    pricingModules: modules,
    inclusionItems: [{ key: "wifi", shortLabel: "ALL WIFI", label: "Wi-Fi" }],
    otherInformation: "Book by 31 July",
    disclaimerText: "All prices are per person in USD and subject to availability",
    nights: 7,
    outputMode
  };
}

const airline = Export.generateFromModel(baseModel("airline_staff"), {
  outputMode: "airline_staff",
  pricingRows
});
assert(airline.ok, `airline should succeed: ${(airline.errors || []).join("; ")}`);
assert(airline.filename === "101cruise-mailchimp-airline-poc.html", "airline filename");
assert(!/<!DOCTYPE/i.test(airline.html), "no doctype");
assert(!/<html[\s>]/i.test(airline.html), "no html tag");
assert(!/<head[\s>]/i.test(airline.html), "no head tag");
assert(!/<body[\s>]/i.test(airline.html), "no body tag");
assert(!/<script[\s>]/i.test(airline.html), "no script tag");
assert(!/\son[a-z]+\s*=/i.test(airline.html), "no event handlers");
assert(/AIRLINE STAFF PRICE/i.test(airline.html), "airline prices present");
assert(/101CRUISE PRICE/i.test(airline.html), "101cruise prices present");
assert(!/Suite/i.test(airline.html), "blank-priced Suite excluded");
assert(/max-width:600px/i.test(airline.html), "max width 600");
assert(/width="600"/i.test(airline.html), "width attr 600");
assert(/&lt;script&gt;/i.test(airline.html), "script in headline escaped");
assert(/&lt;b&gt;tags&lt;\/b&gt;/i.test(airline.html), "editorial tags escaped");
assert(/&amp; ampersands/i.test(airline.html), "ampersand escaped");
assert(
  airline.html.includes('href="https://www.101cruise.com.au/cruise/pacific-escape"'),
  "absolute CTA"
);
assert(/role="presentation"/i.test(airline.html), "presentation tables");
assert(/cr101-pricing-column/i.test(airline.html), "scoped pricing class");

const general = Export.generateFromModel(baseModel("general"), {
  outputMode: "general",
  pricingRows
});
assert(general.ok, `general should succeed: ${(general.errors || []).join("; ")}`);
assert(general.filename === "101cruise-mailchimp-general-poc.html", "general filename");
assert(!/AIRLINE STAFF PRICE/i.test(general.html), "general has no airline label");
assert(!/\$900\b/.test(general.html) || /\$1,?200/.test(general.html), "general uses 101 prices");
// Ensure airline-only values from fixture are not lingering as labels
assert(!/airline staff/i.test(general.html), "no airline remnant text");

const missingHero = Export.generateFromModel(
  { ...baseModel("general"), heroImageUrl: "" },
  { outputMode: "general", pricingRows }
);
assert(!missingHero.ok, "missing hero fails");
assert(
  missingHero.errors.some((e) => /hero image/i.test(e)),
  "hero validation message"
);

const relativeHero = Export.generateFromModel(
  { ...baseModel("general"), heroImageUrl: "/assets/hero.jpg" },
  { outputMode: "general", pricingRows }
);
assert(!relativeHero.ok, "relative hero fails");

const noAirlinePrices = Export.generateFromModel(
  baseModel("airline_staff"),
  {
    outputMode: "airline_staff",
    pricingRows: [
      {
        room_label: "Inside",
        brochure_price: 2000,
        cruise_101_price: 1200,
        airline_price: null,
        display_order: 1
      }
    ]
  }
);
assert(!noAirlinePrices.ok, "airline mode without airline prices fails");

const fewerRooms = Export.generateFromModel(
  {
    ...baseModel("general"),
    pricingModules: Shared.buildPricingModules(
      [
        {
          room_label: "Balcony",
          brochure_price: 3000,
          cruise_101_price: 1800,
          airline_price: 1400,
          display_order: 1
        }
      ],
      7,
      { outputMode: "general" }
    )
  },
  {
    outputMode: "general",
    pricingRows: [
      {
        room_label: "Balcony",
        brochure_price: 3000,
        cruise_101_price: 1800,
        airline_price: 1400,
        display_order: 1
      }
    ]
  }
);
assert(fewerRooms.ok, "single room still valid");
assert(
  (fewerRooms.html.match(/class="cr101-pricing-column/g) || []).length === 1,
  "one pricing column"
);

console.log("mailchimp-export offline checks passed");
console.log({
  airlineBytes: airline.html.length,
  generalBytes: general.html.length,
  airlineFilename: airline.filename,
  generalFilename: general.filename
});
