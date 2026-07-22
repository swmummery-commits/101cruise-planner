/**
 * Lightweight offline checks for Sprint 13A/13B Mailchimp HTML POC.
 * Run: node scripts/test-mailchimp-export.mjs
 *   or: npm run test:mailchimp-export
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
assert(Export.TEMPLATES.CLASSIC_EDITORIAL === "classic-editorial", "classic key");
assert(Export.TEMPLATES.GREEN_PRICE_CARDS === "green-price-cards", "green key");

assert(Export.isPublicImageUrl("https://cdn.example.com/hero.jpg"), "accept https image");
assert(!Export.isPublicImageUrl("/assets/hero.jpg"), "reject relative image");
assert(!Export.isPublicImageUrl("blob:http://localhost/x"), "reject blob");
assert(!Export.isPublicImageUrl("data:image/png;base64,xx"), "reject data uri");
assert(!Export.isPublicImageUrl("http://localhost:8888/x.jpg"), "reject localhost");
assert(!Export.isPublicImageUrl("https://www.101cruise.com.au/admin"), "reject admin path");

assert(
  Export.buildExploreMoreUrl({ publicSlug: "pacific-escape" }) ===
    "https://www.101cruise.com.au/cruise/pacific-escape",
  "absolute CTA from slug"
);
assert(
  Export.buildExploreMoreUrl({ publicSlug: "Pacific Escape!!" }) ===
    "https://www.101cruise.com.au/cruise/pacific-escape",
  "slugify CTA"
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

/** High discount so % OFF appears (>75%). */
const highDiscountRows = [
  {
    room_label: "Concierge Class",
    brochure_price: 14598,
    cruise_101_price: 1498,
    airline_price: 2498,
    display_order: 1
  },
  {
    room_label: "Balcony",
    brochure_price: 1000,
    cruise_101_price: 800,
    airline_price: 750,
    display_order: 2
  }
];

function baseModel(outputMode, extras = {}) {
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
    publicSlug: "pacific-escape",
    routeMapUrl: "https://example.supabase.co/storage/v1/object/public/cruise-media/map.jpg",
    routeMapAlt: "Route map",
    pricingModules: modules,
    inclusionItems: [{ key: "wifi", shortLabel: "ALL WIFI", label: "Wi-Fi" }],
    otherInformation: "Book by 31 July",
    disclaimerText: "All prices are per person in USD and subject to availability",
    nights: 7,
    outputMode,
    ...extras
  };
}

const genOpts = (outputMode, templateKey, rows = pricingRows) => ({
  outputMode,
  templateKey,
  pricingRows: rows,
  publicationStatus: "published",
  publicSlug: "pacific-escape"
});

/* ── Classic Editorial ─────────────────────────────────────────────────── */

const classicAirline = Export.generateFromModel(baseModel("airline_staff"), genOpts("airline_staff", "classic-editorial"));
assert(classicAirline.ok, `classic airline should succeed: ${(classicAirline.errors || []).join("; ")}`);
assert(
  classicAirline.filename === "101cruise-mailchimp-airline-classic-editorial-poc.html",
  "classic airline filename"
);
assert(classicAirline.templateKey === "classic-editorial", "classic template key");
assert(!/<!DOCTYPE/i.test(classicAirline.html), "no doctype");
assert(!/<html[\s>]/i.test(classicAirline.html), "no html tag");
assert(!/<head[\s>]/i.test(classicAirline.html), "no head tag");
assert(!/<body[\s>]/i.test(classicAirline.html), "no body tag");
assert(!/<script[\s>]/i.test(classicAirline.html), "no script tag");
assert(!/\son[a-z]+\s*=/i.test(classicAirline.html), "no event handlers");
assert(/AIRLINE STAFF PRICE/i.test(classicAirline.html), "airline prices present");
assert(/101CRUISE PRICE/i.test(classicAirline.html), "101cruise prices present");
assert(/cr101-pricing-table/i.test(classicAirline.html), "classic pricing structure");
assert(!/Suite/i.test(classicAirline.html), "blank-priced Suite excluded");
assert(/max-width:600px/i.test(classicAirline.html), "max width 600");
assert(/width="600"/i.test(classicAirline.html), "width attr 600");
assert(/&lt;script&gt;/i.test(classicAirline.html), "script in headline escaped");
assert(
  classicAirline.html.includes('href="https://www.101cruise.com.au/cruise/pacific-escape"'),
  "classic absolute CTA with slug"
);
assert(/role="presentation"/i.test(classicAirline.html), "presentation tables");
assert(/data-cr101-template="classic-editorial"/i.test(classicAirline.html), "classic marker");

const classicGeneral = Export.generateFromModel(baseModel("general"), genOpts("general", "classic-editorial"));
assert(classicGeneral.ok, `classic general should succeed: ${(classicGeneral.errors || []).join("; ")}`);
assert(
  classicGeneral.filename === "101cruise-mailchimp-general-classic-editorial-poc.html",
  "classic general filename"
);
assert(!/AIRLINE STAFF PRICE/i.test(classicGeneral.html), "classic general has no airline label");
assert(!/airline staff/i.test(classicGeneral.html), "no airline remnant text");

/* ── Green Price Cards ─────────────────────────────────────────────────── */

const greenAirline = Export.generateFromModel(
  baseModel("airline_staff", {
    pricingModules: Shared.buildPricingModules(highDiscountRows, 10, { outputMode: "airline_staff" })
  }),
  genOpts("airline_staff", "green-price-cards", highDiscountRows)
);
assert(greenAirline.ok, `green airline should succeed: ${(greenAirline.errors || []).join("; ")}`);
assert(
  greenAirline.filename === "101cruise-mailchimp-airline-green-price-cards-poc.html",
  "green airline filename"
);
assert(/cr101-gpc-card/i.test(greenAirline.html), "green card structure");
assert(/cr101-gpc-fare/i.test(greenAirline.html), "green fare boxes");
assert(/background-color:#8DD9BF/i.test(greenAirline.html), "brand green boxes");
assert(/color:#FFFFFF/i.test(greenAirline.html), "white fare text");
assert(/cr101-gpc-room-header/i.test(greenAirline.html), "room header present");
assert(/text-align:center/i.test(greenAirline.html), "centred text present");
assert(/AIRLINE STAFF PRICE/i.test(greenAirline.html), "airline fare present");
assert(/% OFF/i.test(greenAirline.html), "% OFF when rule allows");
assert(/83% OFF|82% OFF|84% OFF/i.test(greenAirline.html), "high airline discount % OFF");
assert(!/Exclusive Save/i.test(greenAirline.html), "no Exclusive Save");
assert(!/background-color:#e5ebe8/i.test(greenAirline.html), "no grey separator between fare boxes");
assert(/background-color:#000000/i.test(greenAirline.html), "black Explore More");
assert(
  greenAirline.html.includes('href="https://www.101cruise.com.au/cruise/pacific-escape"'),
  "green absolute CTA"
);
assert(/display:inline-block;padding:14px 32px/i.test(greenAirline.html), "CTA padding on anchor");
assert(/cr101-gpc-column/i.test(greenAirline.html), "green mobile stack class");
assert(/@media only screen and \(max-width: 620px\)/i.test(greenAirline.html), "green media query");
assert(!/height:\s*[4-9]\d{2}px/i.test(greenAirline.html), "no large fixed card heights");

const greenGeneral = Export.generateFromModel(
  baseModel("general", {
    pricingModules: Shared.buildPricingModules(highDiscountRows, 10, { outputMode: "general" })
  }),
  genOpts("general", "green-price-cards", highDiscountRows)
);
assert(greenGeneral.ok, `green general should succeed: ${(greenGeneral.errors || []).join("; ")}`);
assert(
  greenGeneral.filename === "101cruise-mailchimp-general-green-price-cards-poc.html",
  "green general filename"
);
assert(!/AIRLINE STAFF PRICE/i.test(greenGeneral.html), "green general no airline");
assert(!/% OFF/i.test(greenGeneral.html), "green general no % OFF");
assert(/101CRUISE PRICE/i.test(greenGeneral.html), "green general has 101cruise box");
assert(/BROCHURE PRICE/i.test(greenGeneral.html), "brochure outside green boxes");

/* Templates do not mutate each other */
assert(/cr101-pricing-table/i.test(classicAirline.html), "classic still classic after green");
assert(!/cr101-gpc-card/i.test(classicAirline.html), "classic has no green cards");
assert(!/cr101-pricing-table/i.test(greenAirline.html), "green has no classic pricing table");

/* CTA validation */
const draftBlocked = Export.generateFromModel(baseModel("general"), {
  ...genOpts("general", "classic-editorial"),
  publicationStatus: "draft"
});
assert(!draftBlocked.ok, "draft publication blocks export");
assert(draftBlocked.errors.some((e) => /Publish/i.test(e)), "publish validation message");

const noSlug = Export.generateFromModel(
  { ...baseModel("general"), publicSlug: "", landingPageUrl: "" },
  { ...genOpts("general", "classic-editorial"), publicSlug: "" }
);
assert(!noSlug.ok, "missing slug blocks export");

const missingHero = Export.generateFromModel(
  { ...baseModel("general"), heroImageUrl: "" },
  genOpts("general", "classic-editorial")
);
assert(!missingHero.ok, "missing hero fails");

const relativeHero = Export.generateFromModel(
  { ...baseModel("general"), heroImageUrl: "/assets/hero.jpg" },
  genOpts("general", "classic-editorial")
);
assert(!relativeHero.ok, "relative hero fails");

const noAirlinePrices = Export.generateFromModel(baseModel("airline_staff"), {
  ...genOpts("airline_staff", "classic-editorial"),
  pricingRows: [
    {
      room_label: "Inside",
      brochure_price: 2000,
      cruise_101_price: 1200,
      airline_price: null,
      display_order: 1
    }
  ]
});
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
    ...genOpts("general", "green-price-cards"),
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
assert((fewerRooms.html.match(/class="cr101-gpc-column/g) || []).length === 1, "one green pricing column");

/* % OFF suppressed below threshold */
const lowDiscount = Export.generateFromModel(
  baseModel("airline_staff", {
    pricingModules: Shared.buildPricingModules(
      [
        {
          room_label: "Inside",
          brochure_price: 1000,
          cruise_101_price: 900,
          airline_price: 850,
          display_order: 1
        }
      ],
      7,
      { outputMode: "airline_staff" }
    )
  }),
  {
    ...genOpts("airline_staff", "green-price-cards"),
    pricingRows: [
      {
        room_label: "Inside",
        brochure_price: 1000,
        cruise_101_price: 900,
        airline_price: 850,
        display_order: 1
      }
    ]
  }
);
assert(lowDiscount.ok, "low discount still exports");
assert(!/% OFF/i.test(lowDiscount.html), "% OFF suppressed under threshold");

console.log("mailchimp-export offline checks passed");
console.log({
  classicAirlineBytes: classicAirline.html.length,
  classicGeneralBytes: classicGeneral.html.length,
  greenAirlineBytes: greenAirline.html.length,
  greenGeneralBytes: greenGeneral.html.length,
  filenames: [
    classicAirline.filename,
    classicGeneral.filename,
    greenAirline.filename,
    greenGeneral.filename
  ]
});
