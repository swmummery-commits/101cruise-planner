import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import "../js/newsletter-heading-case.js";

const { eyebrow, headline } = globalThis.NewsletterHeadingCase;
assert.equal(eyebrow("What people are saying"), "WHAT PEOPLE ARE SAYING");
assert.equal(headline("an escape on MSC's newest ship"), "An Escape On MSC's Newest Ship");
assert.equal(headline("sydney–auckland aboard m/S Europa"), "Sydney–Auckland Aboard M/S Europa");

const editor = readFileSync(new URL("../js/admin-featured-itinerary.js", import.meta.url), "utf8");
const coordinates = editor.slice(editor.indexOf("  function coordinateEditsAreDirty"),
  editor.indexOf("  function renderCoordinateSaveState"));
const dirty = runInNewContext(coordinates + "\ncoordinateEditsAreDirty");
assert.equal(dirty("0.000", "130.100", { latitude: 0, longitude: 130.1 }), false);
assert.equal(dirty("", "130.100", { latitude: 0, longitude: 130.1 }), true);
assert.equal(dirty("", "", { latitude: null, longitude: null }), false);
assert.equal(dirty("0", "130.2", { latitude: 0, longitude: 130.1 }), true);

const saveUi = editor.slice(editor.indexOf("  function portNeedsCoordinates"),
  editor.indexOf("  function renderCoordinateSaveState"));
const { state, pending } = runInNewContext(saveUi + "\n({ state: coordinateSaveState, pending: coordinateSaves })", {
  I: () => ({ isAtSeaStopType: () => false })
});
const stop = { port_id: "port", port: { latitude: 0, longitude: 130.1 } };
assert.equal(state(stop, "0", "130.1").label, "✓ Saved");
assert.equal(state(stop, "0", "131").disabled, false);
pending.add("port");
assert.equal(state(stop, "0", "131").label, "Saving…");
assert.equal(state(stop, "0", "131").disabled, true);
pending.delete("port");
assert.equal(state(stop, "0", "131").label, "Save coordinates");

const server = readFileSync(new URL("../netlify/functions/route-map-generate.js", import.meta.url), "utf8");
const routeSource = server.slice(server.indexOf("async function ensureRouteObject"),
  server.indexOf("function mapAssetError"));
let calculated = 0;
let signature = "previous";
const cached = { itinerary_signature: "previous", route_data: { stops: [{}], legs: [{ simplified_coordinates: [[1, 2], [3, 4]] }] } };
const route = runInNewContext(routeSource + "\nensureRouteObject", {
  supabaseRequest: {}, supabaseGet: {},
  loadStructuredItinerary: async () => ({ ok: true, annotated: [{}] }),
  loadMarineRouteRow: async () => cached,
  buildRoutableStops: () => ({ errors: [], routableStops: [{}] }),
  buildMarineItinerarySignature: () => signature,
  routeObjectEndpointsPlausible: () => true,
  routeObjectAvoidsLand: () => true,
  generateMarineRouteForCruise: async (_get, _id, options) => {
    assert.ok(options.loadedItinerary.ok);
    calculated += 1;
    return { ok: true, routeObject: cached.route_data };
  },
  saveMarineRouteRow: async () => {}
});
assert.equal((await route("cruise")).reused_existing, true);
assert.equal(calculated, 0);
signature = "coordinates-changed";
assert.equal((await route("cruise")).reused_existing, false);
assert.equal(calculated, 1);
console.log("Newsletter heading, coordinate and route reuse checks passed");
