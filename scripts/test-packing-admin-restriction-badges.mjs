/**
 * Packing Admin item cards: baggage badges + scannable recommended-for pills.
 *
 * Run: node scripts/test-packing-admin-restriction-badges.mjs
 *  or: npm run test:packing-admin-restriction-badges
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

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

const adminJs = read("js/admin.js");
const adminCss = read("css/admin.css");

assert.ok(adminJs.includes("function getPackingRestrictionBadge"), "badge helper exists");
assert.ok(adminJs.includes("function renderPackingAppliesPills"), "applies pills renderer exists");
assert.ok(adminJs.includes("function renderPackingItemCard"), "card renderer exists");
assert.ok(
  !/restrictionLabel\s*=\s*[\s\S]*?["']Any location["']/.test(adminJs),
  "card renderer no longer assigns Any location label"
);
assert.ok(adminCss.includes(".packing-apply-pill"), "applies pill styles present");
assert.ok(adminCss.includes(".packing-apply-destination"), "destination pill style present");
assert.ok(adminCss.includes(".packing-apply-climate"), "climate pill style present");

const helperSrc = [
  extractFunction(adminJs, "getPackingRestrictionBadge"),
  extractFunction(adminJs, "splitPackingAppliesTags"),
  extractFunction(adminJs, "getPackingAppliesTagGroups"),
  extractFunction(adminJs, "renderPackingAppliesPills"),
  extractFunction(adminJs, "isEssentialPackingItem"),
  extractFunction(adminJs, "renderPackingItemCard")
].join("\n");

const sandbox = {
  editingPackingItemId: null,
  packingReorderMode: false,
  esc: value => String(value ?? ""),
  getPackingCategoryLocalOrder: () => 1,
  getPackingCategoryName: () => "Polar & Expedition",
  console
};

vm.createContext(sandbox);
vm.runInContext(
  `${helperSrc}
; this.getPackingRestrictionBadge = getPackingRestrictionBadge;
  this.splitPackingAppliesTags = splitPackingAppliesTags;
  this.renderPackingItemCard = renderPackingItemCard;`,
  sandbox
);

const { getPackingRestrictionBadge, splitPackingAppliesTags, renderPackingItemCard } = sandbox;

assert.equal(getPackingRestrictionBadge({}), null, "unrestricted item: no badge");
assert.equal(getPackingRestrictionBadge({ packing_restriction: null }), null, "null: no badge");
assert.equal(getPackingRestrictionBadge({ packing_restriction: "" }), null, "empty: no badge");
assert.equal(getPackingRestrictionBadge({ packing_restriction: "any" }), null, "any: no badge");
const carryOnBadge = getPackingRestrictionBadge({ packing_restriction: "carry-on-only" });
assert.equal(carryOnBadge?.label, "Carry-on only");
assert.equal(carryOnBadge?.className, "carry-on");
const checkedBadge = getPackingRestrictionBadge({ packing_restriction: "checked-only" });
assert.equal(checkedBadge?.label, "Checked luggage only");
assert.equal(checkedBadge?.className, "checked-only");

assert.deepEqual(
  [...splitPackingAppliesTags("Alaska, Cold, Polar")],
  ["Alaska", "Cold", "Polar"]
);

const unrestrictedCard = renderPackingItemCard({
  id: 1,
  name: "Thermal base layers",
  category_id: 10,
  weight_kg: 0.4,
  active: true,
  packing_restriction: "any",
  destination_tags: "Alaska, Norway / Northern Europe, Canada & New England, Antarctica",
  climate_tags: "Cold, Polar"
});

assert.ok(!unrestrictedCard.includes("Any location"), "Any location absent from unrestricted card");
assert.ok(!unrestrictedCard.includes("packing-restriction-badge"), "no baggage badge for any");
assert.ok(unrestrictedCard.includes("Published"), "status badge remains");
assert.ok(unrestrictedCard.includes("Recommended for"), "recommended-for heading present");
assert.ok(unrestrictedCard.includes("packing-apply-destination"), "destination pills present");
assert.ok(unrestrictedCard.includes(">Alaska<"), "Alaska destination pill");
assert.ok(unrestrictedCard.includes("Norway / Northern Europe"), "Norway destination pill");
assert.ok(unrestrictedCard.includes("packing-apply-climate"), "climate pills present");
assert.ok(unrestrictedCard.includes(">Cold<"), "Cold climate pill");
assert.ok(unrestrictedCard.includes(">Polar<"), "Polar climate pill");
assert.ok(!unrestrictedCard.includes("<strong>Logic:</strong>"), "redundant Logic line removed");
assert.ok(!unrestrictedCard.includes("All destinations"), "does not invent All destinations for restricted item");

const carryOnCard = renderPackingItemCard({
  id: 2,
  name: "Spare lithium batteries",
  category_id: 10,
  weight_kg: 0.2,
  active: true,
  packing_restriction: "carry-on-only"
});
assert.ok(carryOnCard.includes("Carry-on only"), "carry-on badge label");
assert.ok(carryOnCard.includes("packing-restriction-badge carry-on"), "carry-on badge class");
assert.ok(carryOnCard.includes("All destinations & climates"), "broad apply pill when no tags");
assert.ok(!carryOnCard.includes("Any location"), "Any location absent from carry-on card");
assert.ok(carryOnCard.includes("Published"), "published remains on carry-on card");

const checkedCard = renderPackingItemCard({
  id: 3,
  name: "Hiking boots",
  category_id: 10,
  weight_kg: 1.2,
  active: false,
  packing_restriction: "checked-only",
  climate_tags: "Cold"
});
assert.ok(checkedCard.includes("Checked luggage only"), "checked badge label");
assert.ok(checkedCard.includes("packing-restriction-badge checked-only"), "checked badge class");
assert.ok(checkedCard.includes("Unpublished"), "unpublished status badge remains");
assert.ok(checkedCard.includes(">Cold<"), "climate pill remains");
assert.ok(!checkedCard.includes("Any location"), "Any location absent from checked card");

const nullRestrictionCard = renderPackingItemCard({
  id: 4,
  name: "Gloves",
  category_id: 10,
  weight_kg: 0.1,
  active: true,
  packing_restriction: null,
  destination_tags: "Alaska"
});
assert.ok(!nullRestrictionCard.includes("Any location"), "Any location absent when restriction null");
assert.ok(!nullRestrictionCard.includes("packing-restriction-badge"), "no badge when restriction null");
assert.ok(nullRestrictionCard.includes(">Alaska<"), "destination pill remains");

console.log("test-packing-admin-restriction-badges: all assertions passed");
