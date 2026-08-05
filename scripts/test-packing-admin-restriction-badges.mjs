/**
 * Packing Admin item cards: baggage restriction badges must not say "Any location".
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

assert.ok(adminJs.includes("function getPackingRestrictionBadge"), "badge helper exists");
assert.ok(adminJs.includes("function renderPackingItemCard"), "card renderer exists");
assert.ok(
  !/restrictionLabel\s*=\s*[\s\S]*?["']Any location["']/.test(adminJs),
  "card renderer no longer assigns Any location label"
);

const helperSrc = [
  extractFunction(adminJs, "getPackingRestrictionBadge"),
  extractFunction(adminJs, "isEssentialPackingItem"),
  extractFunction(adminJs, "formatPackingPrintValue"),
  extractFunction(adminJs, "formatPackingRule"),
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
  this.renderPackingItemCard = renderPackingItemCard;`,
  sandbox
);

const { getPackingRestrictionBadge, renderPackingItemCard } = sandbox;

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
assert.ok(unrestrictedCard.includes("Applies to:"), "Applies to summary present");
assert.ok(unrestrictedCard.includes("Destinations: Alaska"), "destinations shown in Applies to");
assert.ok(unrestrictedCard.includes("Climates: Cold, Polar"), "climates shown in Applies to");
assert.ok(!unrestrictedCard.includes("All destinations"), "does not invent All destinations badge");

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
assert.ok(checkedCard.includes("Climates: Cold"), "climate restriction remains in Applies to");
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
assert.ok(nullRestrictionCard.includes("Destinations: Alaska"), "destination-restricted Applies to remains");

console.log("test-packing-admin-restriction-badges: all assertions passed");
