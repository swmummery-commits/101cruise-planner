/**
 * Regression: legacy Admin Smart Profiles retired; direct packing rules + traveller/Cabin profiles remain.
 *
 * Run: node scripts/test-retire-smart-profiles.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

const adminJs = read("js/admin.js");
const adminCss = read("css/admin.css");
const plannerJs = read("js/planner.js");
const productDoc = read("docs/living-bible-updates/packing-applicability-product-design.md");
const techDoc = read("docs/living-bible-updates/packing-applicability-technical.md");

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

const packingHelpers = [
  extractFunction(plannerJs, "splitRuleTags"),
  extractFunction(plannerJs, "ruleMatches"),
  extractFunction(plannerJs, "packingItemApplies")
].join("\n");

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(
  `${packingHelpers}
; this.packingItemApplies = packingItemApplies;`,
  sandbox
);

const { packingItemApplies } = sandbox;

// 1. Admin no longer renders a Smart Profiles tab
assert.ok(!adminJs.includes('label: "Smart Profiles"'), "Smart Profiles nav label removed");
assert.ok(!adminJs.includes('id: "smart-profiles"'), "smart-profiles tab id removed from nav/main tabs");
assert.ok(!adminJs.includes("renderSmartProfilesPanel"), "Smart Profiles panel renderer removed");

// 2. Admin no longer queries legacy tables
for (const table of ["smart_profile_groups", "smart_profiles", "smart_profile_members", "packing_item_profiles"]) {
  assert.ok(!adminJs.includes(`.from("${table}")`), `admin must not query ${table}`);
  assert.ok(!adminJs.includes(table), `admin must not reference ${table}`);
}

// 3. Packing Item form has no Smart Profiles selector
assert.ok(!adminJs.includes("renderPackingProfileSelector"), "packing profile selector removed");
assert.ok(!adminJs.includes("packingProfileCheckbox"), "packingProfileCheckbox removed");
assert.ok(!adminJs.includes("packingItemSmartProfileBlock"), "Smart Profile block removed from packing form");
assert.ok(adminJs.includes('id: "packingItemDestinations"'), "destination control present");
assert.ok(adminJs.includes('id: "packingItemClimates"'), "climate control present");
assert.ok(adminJs.includes('id: "packingItemTravellers"'), "traveller control present");
assert.ok(adminJs.includes('id: "packingItemDressCodes"'), "dress control present");
assert.ok(adminJs.includes('id: "packingItemCruiseLines"'), "cruise line control present");

// 4. Saving a packing item no longer writes packing_item_profiles
assert.ok(!adminJs.includes("savePackingItemProfileSelections"), "profile selection save removed");
assert.match(
  adminJs,
  /destination_tags:\s*document\.getElementById\("packingItemDestinations"\)\.value\.trim\(\)\s*\|\|\s*null/,
  "destination_tags still saved"
);
assert.match(
  adminJs,
  /climate_tags:\s*document\.getElementById\("packingItemClimates"\)\.value\.trim\(\)\s*\|\|\s*null/,
  "climate_tags still saved"
);
assert.match(
  adminJs,
  /traveller_types:\s*document\.getElementById\("packingItemTravellers"\)\.value\.trim\(\)\s*\|\|\s*null/,
  "traveller_types still saved"
);
assert.match(
  adminJs,
  /dress_codes:\s*document\.getElementById\("packingItemDressCodes"\)\.value\.trim\(\)\s*\|\|\s*null/,
  "dress_codes still saved"
);
assert.match(
  adminJs,
  /cruise_line_tags:\s*document\.getElementById\("packingItemCruiseLines"\)\.value\.trim\(\)\s*\|\|\s*null/,
  "cruise_line_tags still saved"
);

// 5. Direct packing rules still loaded via packing_items select
assert.match(
  adminJs,
  /\.from\("packing_items"\)\s*\n\s*\.select\("\*, packing_categories\(name\)"\)/,
  "packing_items still loaded with category join"
);

// 6. Customer packing filtering via packingItemApplies
const base = {
  destination: "Caribbean / Bahamas",
  climate: "Tropical",
  travellerType: "Couple",
  dressCode: "Casual",
  cruiseLine: "Holland America Line"
};

assert.equal(
  packingItemApplies({ destination_tags: null, climate_tags: null, traveller_types: null, dress_codes: null, cruise_line_tags: null }, base),
  true,
  "no rule fields applies broadly"
);
assert.equal(
  packingItemApplies({ destination_tags: "Alaska", climate_tags: null, traveller_types: null, dress_codes: null, cruise_line_tags: null }, base),
  false,
  "destination restriction excludes mismatch"
);
assert.equal(
  packingItemApplies({ destination_tags: "Caribbean / Bahamas", climate_tags: null, traveller_types: null, dress_codes: null, cruise_line_tags: null }, base),
  true,
  "destination restriction includes match"
);
assert.equal(
  packingItemApplies({ climate_tags: "Cold", destination_tags: null, traveller_types: null, dress_codes: null, cruise_line_tags: null }, base),
  false,
  "climate restriction excludes mismatch"
);
assert.equal(
  packingItemApplies({ climate_tags: "Tropical", destination_tags: null, traveller_types: null, dress_codes: null, cruise_line_tags: null }, base),
  true,
  "climate restriction includes match"
);
assert.equal(
  packingItemApplies({ traveller_types: "Solo Traveller", destination_tags: null, climate_tags: null, dress_codes: null, cruise_line_tags: null }, base),
  false,
  "traveller-type restriction excludes mismatch"
);
assert.equal(
  packingItemApplies({ traveller_types: "Couple", destination_tags: null, climate_tags: null, dress_codes: null, cruise_line_tags: null }, base),
  true,
  "traveller-type restriction includes match"
);
assert.equal(
  packingItemApplies({ dress_codes: "Formal", destination_tags: null, climate_tags: null, traveller_types: null, cruise_line_tags: null }, base),
  false,
  "dress-code restriction excludes mismatch"
);
assert.equal(
  packingItemApplies({ dress_codes: "Casual", destination_tags: null, climate_tags: null, traveller_types: null, cruise_line_tags: null }, base),
  true,
  "dress-code restriction includes match"
);
assert.equal(
  packingItemApplies({ cruise_line_tags: "Princess Cruises", destination_tags: null, climate_tags: null, traveller_types: null, dress_codes: null }, base),
  false,
  "cruise-line restriction excludes mismatch"
);
assert.equal(
  packingItemApplies({ cruise_line_tags: "Holland America Line", destination_tags: null, climate_tags: null, traveller_types: null, dress_codes: null }, base),
  true,
  "cruise-line restriction includes match"
);
assert.equal(
  packingItemApplies({
    destination_tags: "Caribbean / Bahamas",
    climate_tags: "Tropical",
    traveller_types: "Couple",
    dress_codes: "Casual",
    cruise_line_tags: "Holland America Line"
  }, base),
  true,
  "multiple simultaneous restrictions all match"
);
assert.equal(
  packingItemApplies({
    destination_tags: "Caribbean / Bahamas",
    climate_tags: "Tropical",
    traveller_types: "Couple",
    dress_codes: "Casual",
    cruise_line_tags: "Princess Cruises"
  }, base),
  false,
  "multiple simultaneous restrictions fail when one mismatches"
);

// Planner must not consume legacy Smart Profile tables
for (const table of ["smart_profiles", "smart_profile_members", "packing_item_profiles", "smart_profile_groups"]) {
  assert.ok(!plannerJs.includes(table), `planner must not reference ${table}`);
}

// 7–10. Individual traveller + Cabin packing profiles remain
assert.ok(plannerJs.includes("user_packing_v2_profiles"), "user_packing_v2_profiles retained");
assert.ok(plannerJs.includes("user_packing_v2_state"), "user_packing_v2_state retained");
assert.ok(plannerJs.includes("packingV2Profiles"), "packingV2Profiles retained");
assert.ok(plannerJs.includes("activePackingProfileKey"), "activePackingProfileKey retained");
assert.ok(plannerJs.includes('profile_name: "Cabin"'), "Cabin profile retained");
assert.ok(plannerJs.includes('profile_type: "cabin"'), "cabin profile_type retained");
assert.ok(plannerJs.includes("selectPackingProfile"), "traveller/Cabin tab selection retained");
assert.ok(plannerJs.includes("renderPackingProfileTabs"), "packing profile tabs retained");
assert.match(
  plannerJs,
  /onConflict:\s*"user_id,cruise_key,profile_key,item_key"/,
  "state remains isolated by traveller profile_key"
);

assert.match(
  plannerJs,
  /function buildPackingProfiles[\s\S]*?profile_type:\s*"traveller"[\s\S]*?profile_name:\s*"Cabin"[\s\S]*?profile_type:\s*"cabin"/,
  "buildPackingProfiles still builds traveller + Cabin profiles"
);

// 11. Retired tab redirects to packing; Admin code loads without Smart Profile table dependency
assert.match(adminJs, /if \(tab === "smart-profiles"\) return "packing"/, "retired smart-profiles tab redirects to packing");
assert.ok(!/Smart profile/i.test(adminJs), "no Smart profile load/error handling strings");

// CSS: exclusive Smart Profile selectors gone; shared packing selectors remain
assert.ok(!adminCss.includes("smart-profile"), "smart-profile CSS removed");
assert.ok(!adminCss.includes("admin-profile-selector"), "admin-profile-selector CSS removed");
assert.ok(!adminCss.includes("admin-profile-type-card"), "admin-profile-type-card CSS removed");
assert.ok(adminCss.includes(".admin-essential-field"), "essential field CSS retained");
assert.ok(adminCss.includes(".admin-section-mini-title"), "section mini title CSS retained");
assert.ok(adminCss.includes(".admin-button.danger"), "danger button CSS retained");

// Docs distinguish systems
assert.ok(productDoc.includes("Packing applicability is controlled"), "product bible update present");
assert.ok(productDoc.includes("retired"), "product bible marks Smart Profiles retired");
assert.ok(productDoc.includes("user_packing_v2_profiles"), "product bible preserves traveller profiles");
assert.ok(techDoc.includes("packingItemApplies"), "technical bible names packingItemApplies");
assert.ok(techDoc.includes("Do not drop them"), "technical bible keeps legacy tables for rollback");

console.log("test-retire-smart-profiles: all assertions passed");
