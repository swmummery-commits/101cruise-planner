/**
 * Promotional social pack templates and savings display.
 * Run: node scripts/test-social-pack-promo.mjs
 */

import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const { computeFareSavings, savingsLabel, normaliseSavingsDisplay } = require(
  path.join(root, "netlify/functions/lib/social-pack-savings.js")
);
const { normaliseTemplate, isPromoTemplate, templateHasMap } = require(
  path.join(root, "netlify/functions/lib/social-pack-template.js")
);
const { normaliseRouteMapStyle } = require(path.join(root, "netlify/functions/lib/route-map-style.js"));
const { renderRouteDealSvg, renderPriceShockSvg, portLines } = require(
  path.join(root, "netlify/functions/lib/social-pack-promo.js")
);

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: String(error.message || error) });
  }
}

const model = {
  template: "route_deal",
  lineName: "Example Line",
  shipName: "Example Pursuit",
  departurePort: "Singapore",
  arrivalPort: "Sydney, Australia",
  departingLabel: "DEPARTING 14 NOVEMBER 2026",
  nightsLabel: "20 NIGHTS",
  routeMapStyle: "social",
  savingsDisplay: "percentage",
  staffFare: {
    retailFare: 18956,
    staffFare: 2799,
    savings: computeFareSavings(18956, 2799)
  },
  ports: ["Singapore", "Semarang", "Benoa", "Darwin", "Cairns", "Airlie Beach", "Mooloolaba", "Sydney"]
};

test("savings maths", () => {
  const savings = computeFareSavings(19000, 2843);
  assert(savings.available, "both fares available");
  assert(savings.dollarSaving === 16157, `dollar ${savings.dollarSaving}`);
  assert(savings.percentSaving === 85, `percent ${savings.percentSaving}`);
  assert(savings.percentLabel === "SAVE 85%");
  assert(savings.dollarLabel === "SAVE $16,157");
  assert(savingsLabel(savings, "percentage") === "SAVE 85%");
  assert(savingsLabel(savings, "dollar") === "SAVE $16,157");
  assert(normaliseSavingsDisplay("Dollar Saving") === "dollar");
  assert(!computeFareSavings(null, 100).available);
  assert(normaliseRouteMapStyle(undefined) === "classic");
  assert(normaliseRouteMapStyle("social") === "social");
  assert(normaliseTemplate("route-deal") === "route_deal");
  assert(normaliseTemplate("unknown") === "classic");
  assert(isPromoTemplate("price_shock") && !isPromoTemplate("classic"));
  assert(templateHasMap("route_deal") && templateHasMap("ship_journey"));
  assert(!templateHasMap("price_shock") && !templateHasMap("classic"));
});

test("route deal follows map-then-panel hierarchy", () => {
  const portrait = renderRouteDealSvg(model, "portrait", "");
  const square = renderRouteDealSvg({ ...model, savingsDisplay: "dollar" }, "square", "");
  assert(portrait.includes('height="1350"'), "portrait canvas");
  assert(square.includes('height="1080"'), "square canvas");
  assert(portrait.includes("Example Pursuit"), "ship headline");
  assert(portrait.includes("Singapore to Sydney, Australia"), "origin to destination");
  assert(portrait.includes("14 NOVEMBER 2026"), "departure date");
  assert(portrait.includes("20 nights"), "nights");
  assert(portrait.includes(">from<"), "from label");
  assert(portrait.includes("$2,799"), "airline staff fare");
  assert(portrait.includes("Retail"), "retail label");
  assert(portrait.includes("$18,956"), "retail fare");
  assert(portrait.includes("SAVE 85%"), "percentage badge");
  assert(square.includes("SAVE $"), "dollar badge follows the display choice");
  assert(portrait.includes("101 CRUISE"), "101 branding");
  assert(portrait.includes("EXAMPLE LINE"), "cruise line chip");
  assert(portrait.includes('font-size="32"'), "101 wordmark is larger than the cruise-line chip");
  assert(portrait.includes('font-size="15"'), "cruise line chip stays small");
  assert(!/6 STAR|Cruise Club|AZAMARA/i.test(portrait), "does not copy the reference");
});

test("long itineraries stay on a limited number of lines", () => {
  const lines = portLines(
    ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve"],
    { maxLines: 3, maxChars: 28, omitted: 0 }
  );
  assert(lines.length <= 3, `lines ${lines.length}`);
  assert(lines[lines.length - 1].includes("more"), lines.join(" | "));
});

test("price shock keeps the fare as the hero", () => {
  const svg = renderPriceShockSvg({ ...model, template: "price_shock", savingsDisplay: "percentage" }, "portrait");
  assert(svg.includes("$2,799"));
  assert(svg.includes("SAVE 85%"));
  assert(svg.includes("101 CRUISE"));
});

const failed = results.filter((row) => !row.ok);
for (const row of results) {
  console.log(`${row.ok ? "ok" : "FAIL"}  ${row.name}${row.error ? ` — ${row.error}` : ""}`);
}
if (failed.length) {
  process.exit(1);
}
