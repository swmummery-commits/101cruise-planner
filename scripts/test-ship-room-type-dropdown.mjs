/**
 * Ship Stateroom Breakdown room-type dropdown.
 * Uses the live Princess (Sapphire Princess) and Holland America allocations.
 * Run: node scripts/test-ship-room-type-dropdown.mjs
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

const PRINCESS = "c19f40a7-c160-4035-a845-14dada550e1f";
const HOLLAND = "a8d0e678-0cb2-4ea7-ad73-251f0eb36ea2";

const types = [
  { id: "inside", name: "Inside" },
  { id: "oceanview", name: "Oceanview" },
  { id: "balcony", name: "Balcony" },
  { id: "suite", name: "Suite" },
  { id: "mini", name: "Mini-Suite" },
  { id: "owners", name: "Owners Suite" },
  { id: "penthouse", name: "Penthouse Suite" },
  { id: "aqua", name: "AquaClass Balcony" },
  { id: "sky", name: "Sky Suite" }
];

const allocations = {
  [PRINCESS]: ["inside", "oceanview", "balcony", "suite", "mini", "owners", "penthouse"],
  [HOLLAND]: ["inside", "oceanview", "balcony", "suite", "owners"]
};

function optionValues(html) {
  return [...String(html).matchAll(/<option value="([^"]*)"/g)].map((match) => match[1]);
}

function loadShipEditor({ typesActive, allocationMap, fetchImpl }) {
  const sandbox = {
    console,
    setTimeout(fn) { sandbox.timers.push(fn); return 0; },
    timers: [],
    fetch: fetchImpl,
    stateroomTypesActive: typesActive,
    cruiseLineStateroomAllocations: allocationMap,
    document: null
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.document = {
    body: { contains: () => true },
    addEventListener() {},
    getElementById(id) {
      if (id === "ciShipLineId") return { value: sandbox.lineId || "" };
      if (id === "ciShipInlineNewStateroomType") return sandbox.input;
      if (id === "ciShipInlineStateroomMessage") return sandbox.message;
      return null;
    },
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector === "select.ci-stateroom-label") return sandbox.selects;
      if (selector === ".ci-stateroom-inline-add button") return [];
      return [];
    }
  };
  sandbox.input = { value: "", disabled: false, focus() {} };
  sandbox.message = { className: "", textContent: "" };
  sandbox.selects = [];
  sandbox.lineId = PRINCESS;
  sandbox.renderCiStateroomRow = function fallbackRow() { return ""; };
  sandbox.renderCiStateroomEditor = function fallbackEditor() { return "<div id='editor'></div>"; };

  const context = vm.createContext(sandbox);
  vm.runInContext(read("js/stateroom-types-service.js"), context, { filename: "js/stateroom-types-service.js" });
  vm.runInContext(read("js/admin-ship-stateroom-types.js"), context, { filename: "js/admin-ship-stateroom-types.js" });
  return sandbox;
}

function jsonResponse(body, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body };
}

const princessEditor = loadShipEditor({
  typesActive: types,
  allocationMap: allocations,
  fetchImpl: async () => jsonResponse({ success: false, error: "network unused" }, false)
});
princessEditor.lineId = PRINCESS;
const princessHtml = princessEditor.renderCiStateroomRow({ label: "", count: "", sqm: "" }, 0);
const princessOptions = optionValues(princessHtml);
for (const name of ["Inside", "Oceanview", "Balcony", "Suite", "Mini-Suite", "Owners Suite", "Penthouse Suite"]) {
  assert.ok(princessOptions.includes(name), `Princess dropdown includes ${name}`);
}
assert.ok(!princessOptions.includes("AquaClass Balcony"), "Princess dropdown hides an unallocated specialist");
assert.ok(princessHtml.includes("Add new room type"), "Princess dropdown can still add a genuinely new type");

const hollandEditor = loadShipEditor({
  typesActive: types,
  allocationMap: allocations,
  fetchImpl: async () => jsonResponse({ success: false, error: "network unused" }, false)
});
hollandEditor.lineId = HOLLAND;
const hollandOptions = optionValues(hollandEditor.renderCiStateroomRow({ label: "", count: "", sqm: "" }, 0));
for (const name of ["Inside", "Oceanview", "Balcony", "Suite", "Owners Suite"]) {
  assert.ok(hollandOptions.includes(name), `Holland America dropdown includes ${name}`);
}
assert.ok(!hollandOptions.includes("Mini-Suite"), "Holland America keeps Princess-only Mini-Suite out");
assert.ok(!hollandOptions.includes("AquaClass Balcony"), "Holland America keeps Celebrity specialist out");

const emptyEditor = loadShipEditor({
  typesActive: types,
  allocationMap: {},
  fetchImpl: async () => jsonResponse({ success: false, error: "network unused" }, false)
});
const emptyOptions = optionValues(emptyEditor.renderCiStateroomRow({ label: "", count: "", sqm: "" }, 0));
assert.deepEqual(emptyOptions.filter(Boolean).filter((value) => value !== "__add_new_stateroom_type__"), []);

const calls = [];
const selectEditor = loadShipEditor({
  typesActive: [],
  allocationMap: {},
  fetchImpl: async (_url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    if (body.action === "list") return jsonResponse({ success: true, stateroom_types: types });
    if (body.action === "list_line_allocations") return jsonResponse({ success: true, allocations });
    if (body.action === "add_line_allocation") {
      assert.equal(body.cruise_line_id, PRINCESS);
      assert.ok(["sky", "created-penthouse"].includes(body.stateroom_type_id));
      const next = {
        ...allocations,
        [PRINCESS]: [...allocations[PRINCESS], body.stateroom_type_id]
      };
      return jsonResponse({ success: true, allocations: next });
    }
    if (body.action === "create") {
      return jsonResponse({
        success: true,
        stateroom_type: { id: "created-penthouse", name: "Ocean Penthouse Suite" }
      });
    }
    throw new Error(`unexpected action ${body.action}`);
  }
});

const select = {
  value: "__add_new_stateroom_type__",
  innerHTML: "",
  dataset: {},
  options: [],
  closest() { return { insertAdjacentHTML() {} }; }
};
selectEditor.selects = [select];
selectEditor.lineId = PRINCESS;
selectEditor.handleCiShipStateroomTypeChange(select);
selectEditor.input.value = "Inside";
await selectEditor.saveCiShipInlineStateroomType();

assert.equal(select.value, "Inside");
assert.deepEqual(calls.map((call) => call.action), ["list", "list_line_allocations"]);
assert.ok(selectEditor.cruiseLineStateroomAllocations[PRINCESS].includes("inside"));
assert.ok(selectEditor.cruiseLineStateroomAllocations[HOLLAND].includes("inside"));
assert.match(selectEditor.message.textContent, /already allocated/);

calls.length = 0;
selectEditor.input.value = "Sky Suite";
await selectEditor.saveCiShipInlineStateroomType();
assert.equal(select.value, "Sky Suite");
assert.deepEqual(calls.map((call) => call.action), ["list", "list_line_allocations", "add_line_allocation"]);
assert.ok(!calls.some((call) => call.action === "save_line_allocations"));
assert.ok(!calls.some((call) => call.action === "create"));
assert.ok(selectEditor.cruiseLineStateroomAllocations[HOLLAND].includes("owners"));

calls.length = 0;
selectEditor.input.value = "Ocean Penthouse Suite";
await selectEditor.saveCiShipInlineStateroomType();
assert.equal(select.value, "Ocean Penthouse Suite");
assert.deepEqual(
  calls.map((call) => call.action),
  ["list", "create", "list_line_allocations", "add_line_allocation"]
);
assert.equal(calls.find((call) => call.action === "add_line_allocation").stateroom_type_id, "created-penthouse");
assert.equal(calls.find((call) => call.action === "add_line_allocation").cruise_line_id, PRINCESS);

const shipSrc = read("js/admin-ship-stateroom-types.js");
const lineSyncSrc = read("js/admin-ship-stateroom-line-sync.js");
const adminSrc = read("js/admin.js");
const fnSrc = read("netlify/functions/stateroom-types.js");
assert.doesNotMatch(shipSrc, /saveCruiseLineStateroomTypes/);
assert.doesNotMatch(shipSrc, /attachTypeToCurrentShipAndClass/);
assert.doesNotMatch(lineSyncSrc, /saveCruiseLineStateroomTypes/);
assert.match(adminSrc, /stateroomTypesLoadChain/);
assert.match(adminSrc, /retainedAllocations/);
assert.match(fnSrc, /add_line_allocation/);

const addStart = fnSrc.indexOf("async function addLineAllocation");
const addBody = fnSrc.slice(addStart, fnSrc.indexOf("exports.handler", addStart));
assert.doesNotMatch(addBody, /DELETE/);
assert.match(addBody, /method:\s*"POST"/);

console.log("test-ship-room-type-dropdown: ok");
