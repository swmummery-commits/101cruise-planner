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
    "https://www.101cruise.com.au/cruise?slug=pacific-escape",
  "absolute CTA from slug"
);
assert(
  Export.buildExploreMoreUrl({ publicSlug: "Pacific Escape!!" }) ===
    "https://www.101cruise.com.au/cruise?slug=pacific-escape",
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
    landingPageUrl: "/cruise?slug=pacific-escape",
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
  classicAirline.html.includes('href="https://www.101cruise.com.au/cruise?slug=pacific-escape"'),
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
assert(/background-color:#F7F7F7/i.test(greenAirline.html), "page background #F7F7F7");
assert(/class="cr101-outer"[^>]*background-color:#F7F7F7/i.test(greenAirline.html), "outer canvas uses page background");
assert(/cr101-gpc-fare/i.test(greenAirline.html), "green fare boxes");
assert(/background-color:#8DD9BF/i.test(greenAirline.html), "brand green boxes");
assert(/cr101-gpc-fare[\s\S]*?background-color:#8DD9BF/i.test(greenAirline.html), "fare boxes use brand green");
assert(/cr101-gpc-room-header[\s\S]*?background-color:#8DD9BF/i.test(greenAirline.html), "room headers use brand green");
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
  greenAirline.html.includes('href="https://www.101cruise.com.au/cruise?slug=pacific-escape"'),
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

/* Sprint 13C visual refinements — adaptive headers + compact info boxes */
assert(Export.greenHeaderMode(1) === "compact", "1 room → compact");
assert(Export.greenHeaderMode(3) === "compact", "3 rooms → compact");
assert(Export.greenHeaderMode(4) === "two-line", "4 rooms → two-line");

const threeRoomRows = [
  {
    room_label: "Inside",
    brochure_price: 2000,
    cruise_101_price: 1200,
    airline_price: 900,
    display_order: 1
  },
  {
    room_label: "Oceanview",
    brochure_price: 2500,
    cruise_101_price: 1500,
    airline_price: 1100,
    display_order: 2
  },
  {
    room_label: "Balcony",
    brochure_price: 3000,
    cruise_101_price: 1800,
    airline_price: 1400,
    display_order: 3
  },
  {
    room_label: "Suite Unpriced",
    brochure_price: null,
    cruise_101_price: null,
    airline_price: null,
    display_order: 4
  }
];
const threeRoomGreen = Export.generateFromModel(
  baseModel("general", {
    pricingModules: Shared.buildPricingModules(threeRoomRows, 7, { outputMode: "general" }),
    inclusionItems: [
      { key: "alcohol_package", shortLabel: "ALCOHOL PACKAGE", label: "Alcohol Package" },
      { key: "wifi", shortLabel: "ALL WIFI", label: "Wi-Fi" },
      { key: "gratuities", shortLabel: "GRATUITIES", label: "Gratuities" }
    ]
  }),
  genOpts("general", "green-price-cards", threeRoomRows)
);
assert(threeRoomGreen.ok, `3-room green should succeed: ${(threeRoomGreen.errors || []).join("; ")}`);
assert(/data-cr101-gpc-header-mode="compact"/i.test(threeRoomGreen.html), "3-room uses compact header mode");
assert(/data-cr101-gpc-room-count="3"/i.test(threeRoomGreen.html), "3 valid rooms after unpriced filtered");
assert(!/Suite Unpriced/i.test(threeRoomGreen.html), "unpriced room excluded before header mode");
const threeHeaders = threeRoomGreen.html.match(/data-cr101-gpc-header-height="(\d+)"/g) || [];
assert(threeHeaders.length === 3, "three equal compact headers");
assert(threeHeaders.every((h) => h.includes('"36"')), "compact header height 36 on all cards");
assert(!/data-cr101-gpc-header-mode="two-line"/i.test(threeRoomGreen.html), "3-room has no two-line mode");
const threeFonts = threeRoomGreen.html.match(/cr101-gpc-room-header[\s\S]*?font-size:(\d+)px/g) || [];
assert(threeFonts.length === 3, "three room-name font declarations");
assert(threeFonts.every((f) => /font-size:12px/.test(f)), "room-name font size consistent at 12px");

const fourRoomRows = [
  ...threeRoomRows.slice(0, 3),
  {
    room_label: "Concierge Class Suite",
    brochure_price: 5000,
    cruise_101_price: 3200,
    airline_price: 2800,
    display_order: 4
  }
];
const fourRoomGreen = Export.generateFromModel(
  baseModel("general", {
    pricingModules: Shared.buildPricingModules(fourRoomRows, 10, { outputMode: "general" })
  }),
  genOpts("general", "green-price-cards", fourRoomRows)
);
assert(fourRoomGreen.ok, `4-room green should succeed: ${(fourRoomGreen.errors || []).join("; ")}`);
assert(/data-cr101-gpc-header-mode="two-line"/i.test(fourRoomGreen.html), "4-room uses two-line header mode");
assert(/data-cr101-gpc-room-count="4"/i.test(fourRoomGreen.html), "4 valid rooms");
const fourHeaders = fourRoomGreen.html.match(/data-cr101-gpc-header-height="(\d+)"/g) || [];
assert(fourHeaders.length === 4, "four equal two-line headers");
assert(fourHeaders.every((h) => h.includes('"52"')), "two-line header height 52 on all cards");
assert(!/data-cr101-gpc-header-mode="compact"/i.test(fourRoomGreen.html), "4-room has no compact mode");
const fourFonts = fourRoomGreen.html.match(/cr101-gpc-room-header[\s\S]*?font-size:(\d+)px/g) || [];
assert(fourFonts.length === 4, "four room-name font declarations");
assert(fourFonts.every((f) => /font-size:12px/.test(f)), "4-room font size still 12px (not shrunk)");

assert(/cr101-gpc-includes/i.test(threeRoomGreen.html), "green Includes class");
assert(/cr101-gpc-other-info/i.test(threeRoomGreen.html), "green Other Info class");
assert(
  /cr101-gpc-includes[\s\S]*?border:1px solid #8DD9BF/i.test(threeRoomGreen.html),
  "Includes uses brand green border"
);
assert(
  /cr101-gpc-includes[\s\S]*?border-radius:12px/i.test(threeRoomGreen.html),
  "Includes uses 12px radius"
);
assert(
  /cr101-gpc-other-info[\s\S]*?border-radius:999px/i.test(threeRoomGreen.html),
  "Other Info uses pill radius"
);
assert(
  /cr101-gpc-fare[\s\S]*?border-radius:8px/i.test(threeRoomGreen.html),
  "fare boxes still 8px radius"
);
assert(
  /style="padding:12px 0 0;"[\s\S]*?cr101-gpc-includes/i.test(threeRoomGreen.html) ||
    /padding:12px 0 0;[\s\S]{0,200}cr101-gpc-includes/i.test(threeRoomGreen.html),
  "pricing→Includes spacing ~12px (no 28px gap)"
);
assert(!/padding:28px 0 0;[\s\S]{0,120}cr101-gpc-includes/i.test(threeRoomGreen.html), "no classic 28px gap under green pricing");
assert(
  /style="padding:8px 0 0;"[\s\S]{0,200}cr101-gpc-other-info/i.test(threeRoomGreen.html) ||
    /padding:8px 0 0;[\s\S]{0,200}cr101-gpc-other-info/i.test(threeRoomGreen.html),
  "Includes→Other Info spacing ~8px"
);
assert(/padding:8px 12px 0/i.test(threeRoomGreen.html), "Other Info→Disclaimer tight spacing");
assert(/background-color:#ffffff/i.test(threeRoomGreen.html) && /border:1px solid #8DD9BF/i.test(threeRoomGreen.html), "Includes white box with brand border");
assert(/background-color:#D9F2E8/i.test(threeRoomGreen.html), "Other Info soft mint background");
assert(/INCLUDES:/i.test(threeRoomGreen.html), "Includes title uses colon");
assert(/color:#245C4E/i.test(threeRoomGreen.html), "Includes/Other Info use dark brand green text");
assert(/cr101-includes-items/i.test(threeRoomGreen.html), "Includes uses icon item row");
assert(/text-align: center !important/i.test(threeRoomGreen.html), "mobile Includes row is centred");
assert(/border-left: 0 !important/i.test(threeRoomGreen.html), "mobile Includes hides vertical dividers");
assert(
  /images\/newsletter-includes\/wifi\.png/i.test(threeRoomGreen.html),
  "Includes icons are hosted PNGs"
);
assert(/cr101-includes-divider/i.test(threeRoomGreen.html), "thin green divider between Includes items");
assert(
  /border-left:1px solid #8DD9BF/i.test(threeRoomGreen.html),
  "Includes divider uses brand green"
);
assert(
  /admirable-tiramisu-d4da8a\.netlify\.app\/images\/newsletter-includes/i.test(threeRoomGreen.html),
  "Includes icons load from Netlify, not Squarespace"
);
assert(!/ · /i.test(threeRoomGreen.html.match(/cr101-gpc-includes[\s\S]*?<\/table>/i)?.[0] || ""), "Includes is not a middot text line");

/* Templates do not mutate each other */
assert(/cr101-pricing-table/i.test(classicAirline.html), "classic still classic after green");
assert(!/cr101-gpc-card/i.test(classicAirline.html), "classic has no green cards");
assert(!/cr101-pricing-table/i.test(greenAirline.html), "green has no classic pricing table");
assert(!/cr101-gpc-includes/i.test(classicAirline.html), "classic Includes unchanged (no gpc class)");
assert(!/cr101-gpc-other-info/i.test(classicAirline.html), "classic Other Info unchanged");
assert(/padding:28px 0 0;/i.test(classicAirline.html), "classic Includes spacing unchanged");
assert(!/data-cr101-gpc-header-mode=/i.test(classicAirline.html), "classic has no gpc header mode");

/* CTA / public-page validation (Sprint 13E) */
assert(
  Export.buildExploreMoreUrl({ publicSlug: "barcelona-istanbul" }) ===
    "https://www.101cruise.com.au/cruise?slug=barcelona-istanbul",
  "Explore More uses www.101cruise.com.au/cruise?slug={slug}"
);

const draftWithSlug = Export.generateFromModel(baseModel("general"), {
  ...genOpts("general", "classic-editorial"),
  publicationStatus: "draft"
});
assert(draftWithSlug.ok, "slug present allows export regardless of legacy publication status");
assert(
  draftWithSlug.html.includes('href="https://www.101cruise.com.au/cruise?slug=pacific-escape"'),
  "export with slug includes Explore More CTA"
);

const draftNoSlugNoPublic = Export.generateFromModel(
  { ...baseModel("general"), publicSlug: "", landingPageUrl: "" },
  { ...genOpts("general", "classic-editorial"), publicSlug: "", publicationStatus: "draft" }
);
assert(draftNoSlugNoPublic.ok, "draft with blank slug still exports newsletter content");
assert(!/EXPLORE MORE/i.test(draftNoSlugNoPublic.html), "blank slug omits Explore More");
assert(
  !draftNoSlugNoPublic.html.includes("/cruise?slug="),
  "blank slug emits no public cruise link"
);

const draftSoftPreview = Export.generateFromModel(baseModel("general"), {
  ...genOpts("general", "classic-editorial"),
  publicationStatus: "draft",
  softValidation: true
});
assert(draftSoftPreview.ok, `soft preview may render draft: ${(draftSoftPreview.errors || []).join("; ")}`);

const noSlug = Export.generateFromModel(
  { ...baseModel("general"), publicSlug: "", landingPageUrl: "" },
  { ...genOpts("general", "classic-editorial"), publicSlug: "" }
);
assert(noSlug.ok, "missing slug still exports (Explore More omitted)");
assert(!/EXPLORE MORE/i.test(noSlug.html), "no slug omits Explore More button");

const missingHero = Export.generateFromModel(
  { ...baseModel("general"), heroImageUrl: "" },
  genOpts("general", "classic-editorial")
);
assert(!missingHero.ok, "missing hero fails");

const missingRouteMap = Export.generateFromModel(
  { ...baseModel("general"), routeMapUrl: "", routeMapAlt: "" },
  genOpts("general", "classic-editorial")
);
assert(missingRouteMap.ok, `missing route map is optional: ${(missingRouteMap.errors || []).join("; ")}`);
assert(
  !/Route map/i.test(missingRouteMap.html || "") || !/<img[^>]+alt="Route map"/i.test(missingRouteMap.html || ""),
  "optional missing route map omits map image from HTML"
);
assert(!/alt="Route map"/i.test(missingRouteMap.html || ""), "no route map img when URL empty");

const relativeRouteMap = Export.generateFromModel(
  { ...baseModel("general"), routeMapUrl: "/assets/map.jpg" },
  genOpts("general", "classic-editorial")
);
assert(!relativeRouteMap.ok, "relative route map still fails when provided");

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
assert(/data-cr101-gpc-header-mode="compact"/i.test(fewerRooms.html), "1-room uses compact header");

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

/* ── Sprint 13C multi-cruise issue composition ─────────────────────────── */

const cruiseA = {
  model: baseModel("airline_staff", { publicSlug: "barcelona-istanbul", landingPageUrl: "/cruise?slug=barcelona-istanbul" }),
  pricingRows,
  publicationStatus: "published",
  publicSlug: "barcelona-istanbul",
  name: "Barcelona to Istanbul"
};
const cruiseB = {
  model: baseModel("airline_staff", {
    publicSlug: "bangkok-singapore",
    landingPageUrl: "/cruise?slug=bangkok-singapore",
    headline: "Bangkok to Singapore"
  }),
  pricingRows,
  publicationStatus: "published",
  publicSlug: "bangkok-singapore",
  name: "Bangkok to Singapore"
};

const issueAirline = Export.composeIssueHtml([cruiseA, cruiseB], {
  outputMode: "airline_staff",
  templateKey: "green-price-cards",
  newsletterNumber: 77
});
assert(issueAirline.ok, `issue airline should succeed: ${(issueAirline.errors || []).join("; ")}`);
assert(issueAirline.cruiseCount === 2, "issue has two cruises");
assert(!/cr101-issue-spacer/i.test(issueAirline.html), "no grey spacer between cruises");
assert(/border-top:2px dotted #c4c4c4/i.test(issueAirline.html), "dotted rule between cruises");
assert(/class="cr101-issue"[^>]*background-color:#F7F7F7/i.test(issueAirline.html), "issue canvas uses page background");
assert(
  issueAirline.html.includes('href="https://www.101cruise.com.au/cruise?slug=barcelona-istanbul"'),
  "first cruise CTA"
);
assert(
  issueAirline.html.includes('href="https://www.101cruise.com.au/cruise?slug=bangkok-singapore"'),
  "second cruise CTA"
);
assert(
  issueAirline.filename === "101cruise-newsletter-77-airline-green-price-cards.html",
  "issue filename"
);

const issueGeneral = Export.composeIssueHtml(
  [
    { ...cruiseA, model: baseModel("general", { publicSlug: "barcelona-istanbul" }) },
    { ...cruiseB, model: baseModel("general", { publicSlug: "bangkok-singapore", headline: "Bangkok to Singapore" }) }
  ],
  {
    outputMode: "general",
    templateKey: "classic-editorial",
    newsletterNumber: 77
  }
);
assert(issueGeneral.ok, `issue general should succeed: ${(issueGeneral.errors || []).join("; ")}`);
assert(!/AIRLINE STAFF PRICE/i.test(issueGeneral.html), "issue general has no airline pricing");
assert(/cr101-pricing-table/i.test(issueGeneral.html), "issue general uses classic pricing");

const issueSoft = Export.composeIssueHtml(
  [
    cruiseA,
    {
      ...cruiseB,
      publicationStatus: "draft",
      model: { ...baseModel("airline_staff", { publicSlug: "bangkok-singapore" }), heroImageUrl: "" }
    }
  ],
  {
    outputMode: "airline_staff",
    templateKey: "green-price-cards",
    newsletterNumber: 77,
    softValidation: true
  }
);
assert(issueSoft.ok, "soft issue preview can succeed with partial cruises");
assert(issueSoft.cruiseCount === 1, "soft preview keeps valid cruises only");
assert(issueSoft.warnings.length >= 1, "soft preview reports skipped cruise warnings");

const issueBlocked = Export.composeIssueHtml(
  [
    cruiseA,
    {
      ...cruiseB,
      model: { ...baseModel("airline_staff", { publicSlug: "bangkok-singapore" }), heroImageUrl: "" }
    }
  ],
  {
    outputMode: "airline_staff",
    templateKey: "green-price-cards",
    newsletterNumber: 77,
    softValidation: false
  }
);
assert(!issueBlocked.ok, "hard export blocks cruise missing required assets");

const issueDraftWithSlug = Export.composeIssueHtml(
  [
    {
      ...cruiseA,
      publicationStatus: "draft"
    }
  ],
  {
    outputMode: "airline_staff",
    templateKey: "green-price-cards",
    newsletterNumber: 77,
    softValidation: false
  }
);
assert(issueDraftWithSlug.ok, "issue export succeeds when slug is present (publication status ignored)");
assert(
  issueDraftWithSlug.html.includes('href="https://www.101cruise.com.au/cruise?slug=barcelona-istanbul"'),
  "issue export includes Explore More when slug present"
);

const issueNoSlug = Export.composeIssueHtml(
  [
    {
      ...cruiseA,
      model: { ...baseModel("airline_staff"), publicSlug: "", landingPageUrl: "" },
      publicSlug: ""
    }
  ],
  {
    outputMode: "airline_staff",
    templateKey: "green-price-cards",
    newsletterNumber: 77,
    softValidation: false
  }
);
assert(issueNoSlug.ok, "issue export succeeds without slug");
assert(!/EXPLORE MORE/i.test(issueNoSlug.html), "issue export omits Explore More without slug");

const issueDraftSoft = Export.composeIssueHtml(
  [
    {
      ...cruiseA,
      publicationStatus: "draft"
    }
  ],
  {
    outputMode: "airline_staff",
    templateKey: "green-price-cards",
    newsletterNumber: 77,
    softValidation: true
  }
);
assert(issueDraftSoft.ok, "soft issue preview can still render draft cruises");

const emptyIssue = Export.composeIssueHtml([], {
  outputMode: "general",
  templateKey: "classic-editorial",
  newsletterNumber: 77
});
assert(!emptyIssue.ok, "empty issue fails");

/* Price-per-day display rule (<= USD $150 inclusive) */
const buildDiscountDisplay = Shared.buildDiscountDisplay;

const d14999 = buildDiscountDisplay(5000, 1049.93, 7);
assert(d14999.showPerDay === true && d14999.perDay <= 150, "$149.99/day shows (1049.93 / 7 nights)");

const d150 = buildDiscountDisplay(5000, 1050, 7);
assert(d150.showPerDay === true && d150.perDay === 150, "exactly $150/day shows");

const d15001 = buildDiscountDisplay(5000, 1050.07, 7);
assert(d15001.showPerDay === false, "$150.01/day hidden");

const dMissingPrice = buildDiscountDisplay(5000, null, 7);
assert(dMissingPrice.showPerDay === false, "missing price hides per day");

const dZeroPrice = buildDiscountDisplay(5000, 0, 7);
assert(dZeroPrice.showPerDay === false, "zero price hides per day");

const dMissingNights = buildDiscountDisplay(5000, 1050, null);
assert(dMissingNights.showPerDay === false, "missing nights hides per day");

const dZeroNights = buildDiscountDisplay(5000, 1050, 0);
assert(dZeroNights.showPerDay === false, "zero nights hides per day");

const dInvalidNights = buildDiscountDisplay(5000, 1050, "abc");
assert(dInvalidNights.showPerDay === false, "invalid nights hides per day");

const d7499pct = buildDiscountDisplay(10000, 2501, 7);
assert(d7499pct.showPercentOff === false && d7499pct.percentOff == null, "raw 74.99% off hidden");

const d75pct = buildDiscountDisplay(400, 100, 7);
assert(d75pct.showPercentOff === true && d75pct.percentOff === 75, "raw exactly 75.00% off displays");

const d7501pct = buildDiscountDisplay(10000, 2499, 7);
assert(d7501pct.showPercentOff === true && d7501pct.percentOff === 75, "raw 75.01% off displays as rounded 75%");

const d76pct = buildDiscountDisplay(400, 96, 7);
assert(d76pct.showPercentOff === true && d76pct.percentOff === 76, "76% off displays");

const dMissingBrochure = buildDiscountDisplay(null, 100, 7);
assert(dMissingBrochure.showPercentOff === false && dMissingBrochure.percentOff == null, "missing brochure hides percent off");

const perDayRows = [
  {
    room_label: "Inside",
    brochure_price: 5000,
    cruise_101_price: 1049.93,
    airline_price: 1050,
    display_order: 1
  },
  {
    room_label: "Balcony",
    brochure_price: 5000,
    cruise_101_price: 1050.07,
    airline_price: 1050.07,
    display_order: 2
  }
];
const perDayClassic = Export.generateFromModel(
  {
    ...baseModel("airline_staff"),
    pricingModules: Shared.buildPricingModules(perDayRows, 7, { outputMode: "airline_staff" })
  },
  { ...genOpts("airline_staff", "classic-editorial"), pricingRows: perDayRows }
);
assert(perDayClassic.ok, `per-day classic export ok: ${(perDayClassic.errors || []).join("; ")}`);
assert(/>\$150\/day</i.test(perDayClassic.html), "$149.99/day renders as rounded $150/day");
assert(/>\$150\/day</i.test(perDayClassic.html), "exact $150/day renders");
assert(!/>\$150\.01\/day</i.test(perDayClassic.html), "$150.01/day omitted from HTML");

const perDayGreen = Export.generateFromModel(
  {
    ...baseModel("general"),
    pricingModules: Shared.buildPricingModules(perDayRows, 7, { outputMode: "general" })
  },
  { ...genOpts("general", "green-price-cards"), pricingRows: perDayRows }
);
assert(perDayGreen.ok, `per-day green export ok: ${(perDayGreen.errors || []).join("; ")}`);
assert(/>\$150\/day</i.test(perDayGreen.html), "green template shows qualifying per-day values");
assert(!perDayGreen.html.includes("$150.01/day"), "green template omits over-threshold per day");

console.log("mailchimp-export offline checks passed");
console.log({
  classicAirlineBytes: classicAirline.html.length,
  classicGeneralBytes: classicGeneral.html.length,
  greenAirlineBytes: greenAirline.html.length,
  greenGeneralBytes: greenGeneral.html.length,
  issueAirlineBytes: issueAirline.html.length,
  filenames: [
    classicAirline.filename,
    classicGeneral.filename,
    greenAirline.filename,
    greenGeneral.filename,
    issueAirline.filename,
    issueGeneral.filename
  ]
});
