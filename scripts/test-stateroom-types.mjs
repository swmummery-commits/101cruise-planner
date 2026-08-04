/**
 * Stateroom Types reference — seeding, validation, dropdown integration, and wiring checks.
 *
 * Run: npm run test:stateroom-types
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

function loadService() {
  const sandbox = {
    window: {},
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    console
  };
  sandbox.window = sandbox;
  vm.runInContext(read("js/stateroom-types-service.js"), vm.createContext(sandbox), {
    filename: "js/stateroom-types-service.js"
  });
  return sandbox.StateroomTypesService.__test__;
}

const Svc = loadService();
const migration = read("supabase/migrations/20260804_stateroom_types.sql");
const adminJs = read("js/admin.js");
const adminHtml = read("admin.html");
const adminUi = read("js/admin-stateroom-types.js");
const fnSrc = read("netlify/functions/stateroom-types.js");

const seedRows = [
  { name: "Inside", display_order: 1, is_active: true },
  { name: "Oceanview", display_order: 2, is_active: true },
  { name: "Balcony", display_order: 3, is_active: true },
  { name: "Concierge Class", display_order: 4, is_active: true },
  { name: "Aqua Class", display_order: 5, is_active: true },
  { name: "Suite", display_order: 6, is_active: true },
  { name: "Mini Suite", display_order: 70, is_active: false }
];

// 1. Existing room types are seeded without duplicates.
assert(/INSERT INTO public\.stateroom_types/.test(migration), "migration seeds stateroom_types");
assert(/WHERE NOT EXISTS/.test(migration), "seed is idempotent");
assert(/stateroom_types_normalized_name_uidx/.test(migration), "unique normalized_name index");
const deduped = Svc.dedupeByNormalizedName([
  ...seedRows,
  { name: "inside", display_order: 99, is_active: true },
  { name: "Balcony", display_order: 50, is_active: true }
]);
assert.equal(deduped.length, 7, "duplicate seed names collapse case-insensitively");

// 2. Duplicate names differing only by case are rejected.
const duplicateCheck = Svc.validateStateroomTypeInput({
  name: "balcony",
  is_active: true,
  existingRows: seedRows
});
assert.equal(duplicateCheck.ok, false, "case-insensitive duplicate rejected");

// 3. Leading and trailing spaces are removed.
assert.equal(Svc.trimName("  Oceanview  "), "Oceanview");
assert.equal(Svc.normalizeName("  Oceanview  "), "oceanview");
const trimmedValidation = Svc.validateStateroomTypeInput({
  name: "  Studio  ",
  is_active: true,
  existingRows: seedRows
});
assert.equal(trimmedValidation.ok, true);
assert.equal(trimmedValidation.payload.name, "Studio");
assert.equal("display_order" in trimmedValidation.payload, false, "create validation does not expose display order");

const createPayload = Svc.buildCreatePayload({
  name: "Studio",
  is_active: true,
  existingRows: seedRows
});
assert.equal(createPayload.ok, true);
assert.equal(createPayload.payload.display_order, 80);

// 4. Active stateroom types populate Room Type dropdowns.
const activeOnly = Svc.listActiveStateroomTypesFromRows(seedRows);
assert.deepEqual(
  activeOnly.map((row) => row.name),
  ["Inside", "Oceanview", "Balcony", "Concierge Class", "Aqua Class", "Suite"]
);

// 5. Inactive types do not appear in new pricing rows.
const newRowOptions = Svc.buildRoomTypeSelectOptions(activeOnly, "");
assert.ok(newRowOptions.every((opt) => !/inactive/i.test(opt.label)), "new row has no inactive labels");
assert.ok(!newRowOptions.some((opt) => opt.label === "Mini Suite"), "inactive type omitted for new row");

// 6. Existing pricing row using inactive type still displays correctly.
const existingInactiveOptions = Svc.buildRoomTypeSelectOptions(activeOnly, "Mini Suite");
const inactiveOption = existingInactiveOptions.find((opt) => opt.value === "Mini Suite");
assert.ok(inactiveOption, "inactive saved label remains selectable");
assert.match(inactiveOption.label, /inactive/i);
assert.equal(inactiveOption.selected, true);

// 7. Drag order controls dropdown ordering.
const reordered = Svc.listActiveStateroomTypesFromRows([
  { name: "Suite", display_order: 30, is_active: true },
  { name: "Inside", display_order: 10, is_active: true },
  { name: "Balcony", display_order: 20, is_active: true }
]);
assert.deepEqual(
  reordered.map((row) => row.name),
  ["Inside", "Balcony", "Suite"]
);

// 8. New type appears in pricing dropdown after creation (service list helper).
const withNewType = Svc.listActiveStateroomTypesFromRows([
  ...seedRows.filter((row) => row.is_active !== false),
  { name: "Studio", display_order: 25, is_active: true }
]);
const studioOptions = Svc.buildRoomTypeSelectOptions(withNewType, "");
assert.ok(studioOptions.some((opt) => opt.value === "Studio"), "new active type appears in dropdown");

// 9. Existing stateroom type can be edited (validation allows same id).
const rowsWithIds = seedRows.map((row, index) => ({ ...row, id: `seed-${index}` }));
const balconyRow = rowsWithIds.find((row) => row.name === "Balcony");
const editValidation = Svc.validateStateroomTypeInput({
  name: "Balcony",
  is_active: true,
  existingRows: rowsWithIds,
  editingId: balconyRow.id
});
assert.equal(editValidation.ok, true);

const reorderPayload = Svc.buildReorderPayload(["a", "b", "c"]);
assert.equal(reorderPayload.ok, true);
assert.deepEqual(
  reorderPayload.payload.map((row) => row.display_order),
  [10, 20, 30]
);

// 10 & 11. Delete behaviour is enforced server-side.
assert(/action === "delete"/.test(fnSrc), "delete action exists");
assert(/cannot be deleted/.test(fnSrc), "used type deletion blocked with message");
assert(/check_usage/.test(fnSrc), "usage check action exists");
assert(/action === "reorder"/.test(fnSrc), "reorder action exists");
assert(/room_label=ilike/.test(fnSrc), "usage check queries pricing by room label");

// 12 & 13. Existing newsletter pricing remains intact (label snapshots, no FK rewrite).
assert(!/stateroom_type_id/.test(adminJs), "pricing form does not require stateroom_type_id");
assert(/room_label:/.test(adminJs), "pricing still stores room_label snapshot");
assert(!/UPDATE public\.featured_cruise_pricing SET room_label/.test(migration), "migration does not rewrite pricing");

// 14. Mailchimp export modules unchanged — still read room_label.
const mailchimpShared = read("js/newsletter-cruise-shared.js");
assert(/room_label/.test(mailchimpShared), "newsletter shared still uses room_label");

// 15. No duplicate dropdown values appear.
const duplicateOptions = Svc.buildRoomTypeSelectOptions(
  [
    { name: "Inside", display_order: 1, is_active: true },
    { name: "inside", display_order: 2, is_active: true }
  ],
  ""
);
const values = duplicateOptions.map((opt) => opt.value).filter(Boolean);
assert.equal(new Set(values).size, values.length, "dropdown options deduped");

// 16. Controlled error state wiring.
assert(/loadError/.test(adminUi), "admin page tracks load errors");
assert(/Retry/.test(adminUi), "admin page exposes retry");
assert(/stateroomTypesLoadError/.test(adminJs), "pricing form handles load errors");

// Static wiring checks.
assert(/stateroom-types-service\.js/.test(adminHtml), "admin.html loads service");
assert(/admin-stateroom-types\.js/.test(adminHtml), "admin.html loads admin module");
assert(/stateroom-types", label: "Stateroom Types"/.test(adminJs), "admin nav includes Stateroom Types");
assert(/StateroomTypesAdmin\?\.renderPanel/.test(adminJs), "admin tab renders stateroom types panel");
assert(/loadStateroomTypesForPricing/.test(adminJs), "featured cruises load stateroom types");
assert(/<select id="fcPriceRoom-/.test(adminJs), "pricing uses room type select");
assert(!/saveFeaturedRoomTypeFromRow/.test(adminJs), "inline room type save removed");
assert(!/featured_cruise_room_types/.test(adminJs), "admin.js no longer reads legacy room types table");
assert(/renderFeaturedRoomTypeSelectOptions/.test(adminJs), "shared select builder wired");
assert(/listActiveStateroomTypes/.test(read("js/stateroom-types-service.js")), "service exposes active list");
assert(!/stateroomTypeDisplayOrder/.test(adminUi), "display order field removed from admin UI");
assert(/stateroom-type-drag-handle/.test(adminUi), "drag handle rendered");
assert(/reorderStateroomTypes/.test(read("js/stateroom-types-service.js")), "service exposes reorder");

assert.equal(Svc.nextDisplayOrder(seedRows), 80, "next display order uses max + 10");

const allocationMap = {
  "line-celebrity": ["id-inside", "id-balcony", "id-suite"],
  "line-hal": ["id-oceanview", "id-balcony"]
};
const masterTypes = [
  { id: "id-inside", name: "Inside", display_order: 1, is_active: true },
  { id: "id-oceanview", name: "Oceanview", display_order: 2, is_active: true },
  { id: "id-balcony", name: "Balcony", display_order: 3, is_active: true },
  { id: "id-suite", name: "Suite", display_order: 4, is_active: true }
];

const celebrityTypes = Svc.filterActiveTypesForCruiseLine(masterTypes, "line-celebrity", allocationMap);
assert.deepEqual(
  celebrityTypes.map((row) => row.name),
  ["Inside", "Balcony", "Suite"]
);

const fallbackTypes = Svc.filterActiveTypesForCruiseLine(masterTypes, "line-princess", allocationMap);
assert.equal(fallbackTypes.length, 4, "unconfigured line falls back to all active types");

const noLineOptions = Svc.buildRoomTypeSelectOptionsForCruiseLine(masterTypes, "", allocationMap, "");
assert.equal(noLineOptions[0].label, "Select cruise line first");

const celebrityOptions = Svc.buildRoomTypeSelectOptionsForCruiseLine(
  masterTypes,
  "line-celebrity",
  allocationMap,
  ""
);
assert.ok(!celebrityOptions.some((opt) => opt.value === "Oceanview"), "line filter hides unassigned types");

const retainedOption = Svc.buildRoomTypeSelectOptionsForCruiseLine(
  masterTypes,
  "line-celebrity",
  allocationMap,
  "Oceanview"
);
assert.ok(
  retainedOption.some((opt) => opt.value === "Oceanview" && /not on this line/i.test(opt.label)),
  "saved label outside line allocation remains visible"
);

assert(/cruise_line_stateroom_types/.test(read("supabase/migrations/20260805_cruise_line_stateroom_types.sql")));
assert(/list_line_allocations/.test(fnSrc));
assert(/save_line_allocations/.test(fnSrc));
assert(/renderCiLineStateroomTypesSection/.test(adminJs));
assert(/buildRoomTypeSelectOptionsForCruiseLine/.test(adminJs));
assert(/ci-line-stateroom-type-cb/.test(adminJs));

console.log("test-stateroom-types: ok");
