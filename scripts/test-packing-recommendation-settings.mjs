/**
 * Packing Assistant: cruise-level recommendation settings + traveller baggage only.
 *
 * Run: node scripts/test-packing-recommendation-settings.mjs
 *  or: npm run test:packing-recommendation-settings
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => fs.readFileSync(path.join(root, rel), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `expected function ${name}`);
  let i = start;
  let depth = 0;
  let started = false;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") {
      depth += 1;
      started = true;
    } else if (ch === "}") {
      depth -= 1;
      if (started && depth === 0) {
        i += 1;
        break;
      }
    }
  }
  return source.slice(start, i);
}

const plannerJs = read("js/planner.js");
const plannerCss = read("css/planner.css");
const customerPacking = read("netlify/functions/customer-packing.js");
const productDoc = read("docs/living-bible-updates/packing-applicability-product-design.md");
const techDoc = read("docs/living-bible-updates/packing-applicability-technical.md");

// UI contract
assert.ok(!plannerJs.includes("Who is travelling?"), "Who is travelling removed");
assert.ok(!plannerJs.includes("packingTravellerType"), "packingTravellerType control removed");
assert.ok(plannerJs.includes("Adjust recommendations"), "cruise-level adjust control present");
assert.ok(plannerJs.includes("Use booking destination"), "use booking destination action present");
assert.ok(plannerJs.includes("baggage allowances"), "traveller baggage heading present");
assert.ok(plannerJs.includes("renderPackingRecommendationContext"), "cruise-level context renderer present");
assert.ok(plannerJs.includes("savePackingRecommendationPreferences"), "focused recommendation save present");
assert.ok(plannerJs.includes("savePackingBaggageAllowances"), "focused baggage save present");
assert.ok(plannerJs.includes('return ""'), "cabin controls return empty when cabin profile");
assert.match(
  plannerJs,
  /function renderPackingControls[\s\S]*?if \(profile\?\.profile_type === "cabin"\) return ""/,
  "Cabin has no traveller settings card"
);
assert.ok(!/function renderPackingControls[\s\S]*?packingDestination/.test(plannerJs), "destination not inside traveller controls");
assert.ok(plannerJs.includes("Destination not recognised"), "unrecognised destination copy");
assert.ok(!/return "Mediterranean \/ Greek Isles";\s*\}/.test(plannerJs), "unsafe Mediterranean fallback removed");
assert.ok(plannerCss.includes(".packing-recommendation-context"), "recommendation context CSS present");
assert.ok(customerPacking.includes("save_preferences"), "customer-packing still supports preferences");
assert.ok(productDoc.includes("booking-derived"), "product docs updated");
assert.ok(techDoc.includes("never silently default"), "technical docs updated");

const helperSrc = [
  extractFunction(plannerJs, "getDashboardValue"),
  extractFunction(plannerJs, "getTravellerSummary"),
  extractFunction(plannerJs, "getDefaultPackingDestination"),
  extractFunction(plannerJs, "getDefaultDressCode"),
  extractFunction(plannerJs, "getDefaultTravellerType"),
  extractFunction(plannerJs, "splitRuleTags"),
  extractFunction(plannerJs, "ruleMatches"),
  extractFunction(plannerJs, "packingItemApplies"),
  extractFunction(plannerJs, "getClimateFromDestination"),
  extractFunction(plannerJs, "resolvePackingRecommendationContext"),
  extractFunction(plannerJs, "renderPackingControls"),
  extractFunction(plannerJs, "renderPackingRecommendationContext")
].join("\n");

const sandbox = {
  packingRecommendationsOpen: false,
  PACKING_DESTINATIONS: [
    "Caribbean / Bahamas",
    "Mediterranean / Greek Isles",
    "Alaska",
    "Norway / Northern Europe"
  ],
  escapeHtml: value => String(value ?? ""),
  console
};
vm.createContext(sandbox);
vm.runInContext(
  `${helperSrc}
; this.getDefaultPackingDestination = getDefaultPackingDestination;
  this.getDefaultTravellerType = getDefaultTravellerType;
  this.getClimateFromDestination = getClimateFromDestination;
  this.packingItemApplies = packingItemApplies;
  this.resolvePackingRecommendationContext = resolvePackingRecommendationContext;
  this.renderPackingControls = renderPackingControls;
  this.renderPackingRecommendationContext = renderPackingRecommendationContext;`,
  sandbox
);

const {
  getDefaultPackingDestination,
  getDefaultTravellerType,
  getClimateFromDestination,
  packingItemApplies,
  resolvePackingRecommendationContext,
  renderPackingControls,
  renderPackingRecommendationContext
} = sandbox;

// Traveller type from booking
assert.equal(getDefaultTravellerType({ traveller_count: 1 }), "Solo");
assert.equal(getDefaultTravellerType({ traveller_count: 2 }), "Couple");
assert.equal(getDefaultTravellerType({ traveller_count: 4 }), "Family");
assert.equal(getDefaultTravellerType({ traveller_names: "Ann and child" }), "Family");

// Destination from booking; no Mediterranean guess
assert.equal(getDefaultPackingDestination({ arrival_port: "Juneau, Alaska" }), "Alaska");
assert.equal(getDefaultPackingDestination({ cruise_region: "Caribbean" }), "Caribbean / Bahamas");
assert.equal(getDefaultPackingDestination({ arrival_port: "Unknown Port XYZ" }), null);
assert.equal(getDefaultPackingDestination({}), null);
assert.equal(getClimateFromDestination(""), "");
assert.equal(getClimateFromDestination(null), "");
assert.equal(getClimateFromDestination("Alaska"), "Cold");

const bookingCruise = {
  ship_name: "Millennium",
  cruise_line: "Celebrity Cruises",
  arrival_port: "Santorini, Greece",
  traveller_count: 2
};
const bookingCtx = resolvePackingRecommendationContext(bookingCruise, null);
assert.equal(bookingCtx.destination, "Mediterranean / Greek Isles");
assert.equal(bookingCtx.travellerType, "Couple");
assert.equal(bookingCtx.hasDestinationOverride, false);

const overrideCtx = resolvePackingRecommendationContext(bookingCruise, { destination: "Alaska", dress_code: "Casual" });
assert.equal(overrideCtx.destination, "Alaska");
assert.equal(overrideCtx.hasDestinationOverride, true);
assert.equal(overrideCtx.dressCode, "Casual");
assert.equal(overrideCtx.climate, "Cold");

const unknownCtx = resolvePackingRecommendationContext({ ship_name: "Mystery", traveller_count: 2 }, null);
assert.equal(unknownCtx.destination, "");
assert.equal(unknownCtx.destinationLabel, "Destination not recognised");
assert.equal(unknownCtx.climate, "");
assert.equal(unknownCtx.destinationRecognised, false);

// packingItemApplies still filters; unknown destination excludes destination-specific items
assert.equal(
  packingItemApplies({ destination_tags: null, climate_tags: null, traveller_types: null, dress_codes: null, cruise_line_tags: null }, unknownCtx),
  true,
  "broad items still apply"
);
assert.equal(
  packingItemApplies({ destination_tags: "Alaska", climate_tags: null, traveller_types: null, dress_codes: null, cruise_line_tags: null }, unknownCtx),
  false,
  "destination-specific excluded when destination unknown"
);
assert.equal(
  packingItemApplies({ climate_tags: "Cold", destination_tags: null, traveller_types: null, dress_codes: null, cruise_line_tags: null }, unknownCtx),
  false,
  "climate-specific excluded when climate unknown"
);
assert.equal(
  packingItemApplies({ destination_tags: "Alaska", climate_tags: "Cold", traveller_types: "Couple", dress_codes: "Casual", cruise_line_tags: "Celebrity Cruises" }, overrideCtx),
  true,
  "override destination filters correctly"
);
assert.equal(
  packingItemApplies({ dress_codes: "Formal", destination_tags: null, climate_tags: null, traveller_types: null, cruise_line_tags: null }, overrideCtx),
  false,
  "dress override filters"
);
assert.equal(
  packingItemApplies({ cruise_line_tags: "Celebrity Cruises", destination_tags: null, climate_tags: null, traveller_types: null, dress_codes: null }, overrideCtx),
  true,
  "cruise line still filters"
);

// Traveller type feeds packingItemApplies even without saved prefs
assert.equal(
  packingItemApplies({ traveller_types: "Solo", destination_tags: null, climate_tags: null, dress_codes: null, cruise_line_tags: null }, bookingCtx),
  false
);
assert.equal(
  packingItemApplies({ traveller_types: "Couple", destination_tags: null, climate_tags: null, dress_codes: null, cruise_line_tags: null }, bookingCtx),
  true
);

const stephenCard = renderPackingControls(null, bookingCruise, {
  profile_key: "stephen",
  profile_name: "Stephen",
  profile_type: "traveller",
  checked_baggage_allowance_kg: 23,
  cabin_baggage_allowance_kg: 7
});
assert.ok(stephenCard.includes("Stephen's baggage allowances"), "Stephen baggage heading");
assert.ok(stephenCard.includes("packingCheckedBaggageAllowance"), "Stephen checked field");
assert.ok(stephenCard.includes("packingCabinBaggageAllowance"), "Stephen cabin field");
assert.ok(!stephenCard.includes("Who is travelling?"), "no traveller type in Stephen card");
assert.ok(!stephenCard.includes("packingDestination"), "no destination in Stephen card");
assert.ok(!stephenCard.includes("packingDressCode"), "no dress in Stephen card");

const paulCard = renderPackingControls(null, bookingCruise, {
  profile_key: "paul",
  profile_name: "Paul",
  profile_type: "traveller",
  checked_baggage_allowance_kg: 20,
  cabin_baggage_allowance_kg: 5
});
assert.ok(paulCard.includes("Paul's baggage allowances"), "Paul baggage heading");
assert.ok(paulCard.includes('value="20"'), "Paul checked allowance isolated");
assert.ok(stephenCard.includes('value="23"'), "Stephen checked allowance isolated");

const cabinCard = renderPackingControls(null, bookingCruise, {
  profile_key: "cabin",
  profile_name: "Cabin",
  profile_type: "cabin"
});
assert.equal(cabinCard, "", "Cabin has no settings card");

sandbox.packingRecommendationsOpen = false;
const contextClosed = renderPackingRecommendationContext(bookingCruise, bookingCtx);
assert.ok(contextClosed.includes("Adjust recommendations"), "adjust control once");
assert.ok(contextClosed.includes("Millennium"), "ship in context");
assert.ok(contextClosed.includes("Mediterranean / Greek Isles"), "booking destination in context");
assert.ok(!contextClosed.includes("packingDestination"), "destination select hidden when collapsed");

sandbox.packingRecommendationsOpen = true;
const contextOpen = renderPackingRecommendationContext(bookingCruise, overrideCtx);
assert.ok(contextOpen.includes("packingDestination"), "destination select once when open");
assert.ok(contextOpen.includes("packingDressCode"), "dress select once when open");
assert.ok(contextOpen.includes("Use booking destination"), "clear override action");
assert.ok((contextOpen.match(/id="packingDestination"/g) || []).length === 1, "destination control not duplicated");
assert.ok((contextOpen.match(/id="packingDressCode"/g) || []).length === 1, "dress control not duplicated");

assert.ok(plannerJs.includes("user_packing_v2_profiles"), "v2 profiles preserved");
assert.ok(plannerJs.includes("user_packing_v2_state"), "v2 state preserved");
assert.ok(plannerJs.includes("activePackingProfileKey"), "active profile key preserved");
assert.ok(plannerJs.includes('profile_name: "Cabin"'), "Cabin profile preserved");
assert.match(plannerJs, /onConflict:\s*"user_id,cruise_key,profile_key,item_key"/, "state isolation preserved");

console.log("test-packing-recommendation-settings: all assertions passed");
