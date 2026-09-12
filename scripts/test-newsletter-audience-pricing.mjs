/**
 * Regression checks for audience-specific newsletter cabin availability.
 * Run: node scripts/test-newsletter-audience-pricing.mjs
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sandbox = {
  console,
  Intl,
  Number,
  String,
  Boolean,
  Array,
  Object,
  Math,
  JSON,
  RegExp,
  Error
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
const context = vm.createContext(sandbox);

const sharedCode = readFileSync(path.join(root, "js/newsletter-cruise-shared.js"), "utf8");
vm.runInContext(sharedCode, context, { filename: "js/newsletter-cruise-shared.js" });

const Shared = sandbox.NewsletterCruiseShared;
assert(Shared, "NewsletterCruiseShared loaded");

const rows = [
  {
    room_label: "Inside",
    brochure_price: 2709,
    cruise_101_price: 1109,
    airline_price: 899,
    display_order: 1
  },
  {
    room_label: "Oceanview",
    brochure_price: 2751,
    cruise_101_price: 1297,
    airline_price: 999,
    display_order: 2
  },
  {
    room_label: "Balcony",
    brochure_price: 3743,
    cruise_101_price: null,
    airline_price: 1499,
    display_order: 3
  },
  {
    room_label: "Mini-Suite",
    brochure_price: 3839,
    cruise_101_price: null,
    airline_price: 1699,
    display_order: 4
  },
  {
    room_label: "Brochure only",
    brochure_price: 4999,
    cruise_101_price: null,
    airline_price: null,
    display_order: 5
  },
  {
    room_label: "Zero fare",
    brochure_price: 2000,
    cruise_101_price: 0,
    airline_price: 0,
    display_order: 6
  }
];

const general = Shared.buildPricingModules(rows, 10, { outputMode: "general" });
assert(general.length === 2, `General should contain 2 rooms, got ${general.length}`);
assert(
  general.map((room) => room.roomLabel).join("|") === "Inside|Oceanview",
  "General should omit rooms without a valid 101CRUISE fare"
);
assert(
  general.every((room) => room.cruise101Price != null && room.cruise101Price > 0),
  "Every General room must have a positive 101CRUISE selling fare"
);

const airline = Shared.buildPricingModules(rows, 10, { outputMode: "airline_staff" });
assert(airline.length === 4, `Airline Staff should contain 4 rooms, got ${airline.length}`);
assert(
  airline.map((room) => room.roomLabel).join("|") === "Inside|Oceanview|Balcony|Mini-Suite",
  "Airline Staff should retain airline-only rooms but exclude brochure-only rooms"
);
assert(
  airline.every(
    (room) =>
      (room.cruise101Price != null && room.cruise101Price > 0) ||
      (room.airlinePrice != null && room.airlinePrice > 0)
  ),
  "Every Airline Staff room must have at least one positive selling fare"
);

const brochureOnlyGeneral = Shared.buildPricingModules(
  [{ room_label: "Suite", brochure_price: 5000, cruise_101_price: null, airline_price: null }],
  7,
  { outputMode: "general" }
);
assert(brochureOnlyGeneral.length === 0, "Brochure-only room must never render in General output");

const brochureOnlyAirline = Shared.buildPricingModules(
  [{ room_label: "Suite", brochure_price: 5000, cruise_101_price: null, airline_price: null }],
  7,
  { outputMode: "airline_staff" }
);
assert(
  brochureOnlyAirline.length === 0,
  "Brochure-only room must never render in Airline Staff output"
);

console.log("Newsletter audience pricing regression tests passed.");
