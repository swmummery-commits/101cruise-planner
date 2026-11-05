#!/usr/bin/env node
/**
 * Featured cruise + room save: persisted ids, retries, and rollback.
 * Uses an in-memory database. Does not touch customer records.
 */
import { executeCruiseSaveBundle, planPricingSync, planStopRows, isPersistedRowId } from "../netlify/functions/lib/cruise-save-bundle.js";

function assert(label, ok) {
  if (!ok) throw new Error(label);
  console.log("ok:", label);
}

const ROOM_A = "11111111-1111-4111-8111-111111111111";
const ROOM_B = "22222222-2222-4222-8222-222222222222";
const ROOM_STALE = "33333333-3333-4333-8333-333333333333";
const CRUISE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CRUISE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function memoryIo(seed = {}) {
  const state = {
    cruises: new Map((seed.cruises || []).map((row) => [row.id, { ...row }])),
    pricing: (seed.pricing || []).map((row) => ({ ...row })),
    stops: (seed.stops || []).map((row) => ({ ...row })),
    seq: 1
  };
  const calls = { inserts: 0, pricingWrites: 0 };

  function nextId() {
    state.seq += 1;
    return `00000000-0000-4000-8000-${String(state.seq).padStart(12, "0")}`;
  }

  const io = {
    calls,
    state,
    async findCruiseByClientKey(key) {
      for (const row of state.cruises.values()) {
        if (row.editor_client_key === key) return { ...row };
      }
      return null;
    },
    async getCruise(id) {
      const row = state.cruises.get(id);
      return row ? { ...row } : null;
    },
    async saveCruise({ id, cruise, clientSaveKey }) {
      const now = new Date(Date.now() + state.seq).toISOString();
      if (!id) {
        calls.inserts += 1;
        const row = {
          ...cruise,
          id: nextId(),
          editor_client_key: clientSaveKey || null,
          updated_at: now
        };
        state.cruises.set(row.id, row);
        return { row: { ...row }, created: true, stripped: [] };
      }
      const existing = state.cruises.get(id);
      if (!existing) throw new Error("missing cruise");
      const row = {
        ...existing,
        ...cruise,
        id,
        editor_client_key: clientSaveKey || existing.editor_client_key || null,
        updated_at: now
      };
      state.cruises.set(id, row);
      return { row: { ...row }, created: false, stripped: [] };
    },
    async updateCruise(id, patch) {
      const existing = state.cruises.get(id);
      if (!existing) throw new Error("missing cruise");
      const row = { ...existing, ...patch, id, updated_at: new Date(Date.now() + state.seq).toISOString() };
      state.cruises.set(id, row);
      return { ...row };
    },
    async deleteCruise(id) {
      state.cruises.delete(id);
      state.pricing = state.pricing.filter((row) => row.featured_cruise_id !== id);
      state.stops = state.stops.filter((row) => row.featured_cruise_id !== id);
    },
    async listPricing(cruiseId) {
      return state.pricing.filter((row) => row.featured_cruise_id === cruiseId).map((row) => ({ ...row }));
    },
    async insertPricing(rows) {
      calls.pricingWrites += 1;
      const created = rows.map((row) => ({ ...row, id: row.id && isPersistedRowId(row.id) ? row.id : nextId() }));
      state.pricing.push(...created);
      return created.map((row) => ({ ...row }));
    },
    async updatePricing(id, patch) {
      calls.pricingWrites += 1;
      const index = state.pricing.findIndex((row) => row.id === id);
      if (index < 0) throw new Error(`room id not found: ${id}`);
      state.pricing[index] = { ...state.pricing[index], ...patch, id };
      return { ...state.pricing[index] };
    },
    async deletePricing(ids) {
      const drop = new Set(ids);
      state.pricing = state.pricing.filter((row) => !drop.has(row.id));
    },
    async listStops(cruiseId) {
      return state.stops.filter((row) => row.featured_cruise_id === cruiseId).map((row) => ({ ...row }));
    },
    async insertStops(rows) {
      const created = rows.map((row) => ({ ...row, id: nextId() }));
      state.stops.push(...created);
      return created.map((row) => ({ ...row }));
    },
    async deleteStops(ids) {
      const drop = new Set(ids);
      state.stops = state.stops.filter((row) => !drop.has(row.id));
    }
  };
  return io;
}

assert("temporary room ids are not database ids", isPersistedRowId("price-171000-ab") === false);
assert("a stored room id is recognised", isPersistedRowId(ROOM_A) === true);

const tempPlan = planPricingSync({
  existingRows: [{ id: ROOM_A, room_label: "Oceanview", cruise_101_price: 1000 }],
  incomingRows: [{ id: "price-temp", room_label: "Balcony", cruise_101_price: 1400 }]
});
assert("a temporary room id is inserted", tempPlan.inserts.length === 1 && tempPlan.inserts[0].id == null);
assert("a temporary room id does not update the existing room", tempPlan.updates.length === 0 && tempPlan.deleteIds[0] === ROOM_A);

const stalePlan = planPricingSync({
  existingRows: [{ id: ROOM_A, room_label: "Oceanview" }],
  incomingRows: [{ id: ROOM_STALE, room_label: "Balcony", cruise_101_price: 1500 }]
});
assert("an unknown room id is not sent as an update", stalePlan.updates.length === 0 && stalePlan.inserts.length === 1);

const updatePlan = planPricingSync({
  existingRows: [
    { id: ROOM_A, room_label: "Oceanview" },
    { id: ROOM_B, room_label: "Balcony" }
  ],
  incomingRows: [
    { id: ROOM_A, room_label: "Oceanview", cruise_101_price: 1260 },
    { id: ROOM_B, room_label: "Balcony", cruise_101_price: 1499 },
    { room_label: "Suite", cruise_101_price: 2200 }
  ]
});
assert("known rooms are updated and a new room is inserted", updatePlan.updates.length === 2 && updatePlan.inserts.length === 1 && updatePlan.deleteIds.length === 0);

const deletePlan = planPricingSync({
  existingRows: [{ id: ROOM_A }, { id: ROOM_B }],
  incomingRows: [{ id: ROOM_A, room_label: "Oceanview", cruise_101_price: 1260 }]
});
assert("a removed room is deleted", deletePlan.deleteIds.length === 1 && deletePlan.deleteIds[0] === ROOM_B);

const stops = planStopRows([{ port_id: "tmp-port", entered_port_text: "Rome, Italy", stop_type: "port_call", display_order: 1 }]);
assert("a temporary port id is not stored", stops[0].port_id == null && stops[0].entered_port_text === "Rome, Italy");

const io = memoryIo({
  cruises: [
    { id: CRUISE_B, headline: "Leave this cruise alone", updated_at: "2026-11-01T00:00:00.000Z" }
  ],
  pricing: [{ id: "price-other", featured_cruise_id: CRUISE_B, room_label: "Inside", cruise_101_price: 800 }]
});

const created = await executeCruiseSaveBundle({
  io,
  cruise: { headline: "Mediterranean" },
  pricing: [
    { room_label: "Oceanview", brochure_price: 1926, cruise_101_price: 1260, airline_price: 1180, currency_code: "USD", display_order: 1 },
    { room_label: "Balcony", brochure_price: 1978, cruise_101_price: 1469, airline_price: 1448, currency_code: "USD", display_order: 2 }
  ],
  stops: [
    { display_order: 1, stop_type: "embarkation", entered_port_text: "Barcelona, Spain" },
    { display_order: 2, stop_type: "port_call", entered_port_text: "Rome, Italy" }
  ],
  clientSaveKey: "draft-1"
});
assert("create returns the cruise id", Boolean(created.cruise?.id));
const cruiseId = created.cruise.id;
const stored = await io.listPricing(cruiseId);
assert("both room prices were stored", stored.length === 2);
assert(
  "room prices can be read back",
  stored.find((row) => row.room_label === "Oceanview")?.cruise_101_price === 1260 &&
    stored.find((row) => row.room_label === "Balcony")?.airline_price === 1448
);
const storedStops = await io.listStops(cruiseId);
assert("itinerary stops were stored", storedStops.length === 2);

const oceanId = stored.find((row) => row.room_label === "Oceanview").id;
const balconyId = stored.find((row) => row.room_label === "Balcony").id;
const updated = await executeCruiseSaveBundle({
  io,
  id: cruiseId,
  cruise: { headline: "Mediterranean" },
  pricing: [
    { id: oceanId, room_label: "Oceanview", cruise_101_price: 1300, display_order: 1 },
    { id: balconyId, room_label: "Balcony", cruise_101_price: 1500, display_order: 2 }
  ],
  clientSaveKey: "draft-1"
});
const afterPriceChange = await io.listPricing(updated.cruise.id);
assert(
  "reopening and changing a room price updates that room",
  afterPriceChange.find((row) => row.id === oceanId)?.cruise_101_price === 1300
);
assert("the price update did not create another cruise", io.state.cruises.size === 2);

const withSuite = await executeCruiseSaveBundle({
  io,
  id: cruiseId,
  cruise: { headline: "Mediterranean" },
  pricing: [
    { id: oceanId, room_label: "Oceanview", cruise_101_price: 1300, display_order: 1 },
    { id: balconyId, room_label: "Balcony", cruise_101_price: 1500, display_order: 2 },
    { id: "price-new-local", room_label: "Suite", cruise_101_price: 2400, display_order: 3 }
  ],
  clientSaveKey: "draft-1"
});
const afterAdd = await io.listPricing(withSuite.cruise.id);
assert("a new room category is added", afterAdd.some((row) => row.room_label === "Suite" && row.cruise_101_price === 2400));
assert("the new room did not reuse the temporary id", afterAdd.every((row) => row.id !== "price-new-local"));

await executeCruiseSaveBundle({
  io,
  id: cruiseId,
  cruise: { headline: "Mediterranean" },
  pricing: [
    { id: oceanId, room_label: "Oceanview", cruise_101_price: 1300, display_order: 1 },
    { id: balconyId, room_label: "Balcony", cruise_101_price: 1500, display_order: 2 }
  ],
  clientSaveKey: "draft-1"
});
const afterDelete = await io.listPricing(cruiseId);
assert("deleting a room category removes only that room", afterDelete.length === 2 && afterDelete.every((row) => row.room_label !== "Suite"));

const retry = await executeCruiseSaveBundle({
  io,
  cruise: { headline: "Mediterranean retry" },
  pricing: [{ id: oceanId, room_label: "Oceanview", cruise_101_price: 1310, display_order: 1 }],
  clientSaveKey: "draft-1"
});
assert("a retry with the same draft key updates the original cruise", retry.cruise.id === cruiseId && retry.created === false);
assert("the unrelated cruise was not changed", io.state.cruises.get(CRUISE_B)?.headline === "Leave this cruise alone");
assert("the unrelated cruise rooms were not changed", (await io.listPricing(CRUISE_B))[0].cruise_101_price === 800);

const failing = memoryIo({
  cruises: [{ id: CRUISE_A, headline: "Original", updated_at: "2026-11-01T00:00:00.000Z", editor_client_key: "edit-1" }],
  pricing: [{ id: ROOM_A, featured_cruise_id: CRUISE_A, room_label: "Oceanview", cruise_101_price: 1000, display_order: 1 }]
});
failing.updatePricing = async () => {
  throw Object.assign(new Error("database unavailable"), { statusCode: 500 });
};
let failed = null;
try {
  await executeCruiseSaveBundle({
    io: failing,
    id: CRUISE_A,
    cruise: { headline: "Should roll back" },
    pricing: [{ id: ROOM_A, room_label: "Oceanview", cruise_101_price: 1800, display_order: 1 }],
    clientSaveKey: "edit-1"
  });
} catch (error) {
  failed = error;
}
assert("a pricing failure is not reported as a successful save", failed && failed.rolledBack === true);
assert("the cruise headline is restored after a failed room save", failing.state.cruises.get(CRUISE_A)?.headline === "Original");
assert("the previous room price is restored", (await failing.listPricing(CRUISE_A))[0].cruise_101_price === 1000);

const overlapping = memoryIo();
let releaseSave;
const saveGate = new Promise((resolve) => {
  releaseSave = resolve;
});
const originalSave = overlapping.saveCruise;
let saveCalls = 0;
overlapping.saveCruise = async (args) => {
  saveCalls += 1;
  if (saveCalls === 1) await saveGate;
  return originalSave(args);
};
const firstSave = executeCruiseSaveBundle({
  io: overlapping,
  cruise: { headline: "Once" },
  pricing: [{ room_label: "Oceanview", cruise_101_price: 1100, display_order: 1 }],
  clientSaveKey: "double-click"
});
const secondSave = executeCruiseSaveBundle({
  io: overlapping,
  cruise: { headline: "Once" },
  pricing: [{ room_label: "Oceanview", cruise_101_price: 1100, display_order: 1 }],
  clientSaveKey: "double-click"
});
releaseSave();
const [firstResult, secondResult] = await Promise.all([firstSave, secondSave]);
assert("a double save shares one write", saveCalls === 1 && firstResult.cruise.id === secondResult.cruise.id);
assert("a double save does not create two cruises", overlapping.state.cruises.size === 1);

console.log("test-cruise-save-bundle.mjs: all checks passed");
