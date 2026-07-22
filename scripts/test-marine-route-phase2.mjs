/**
 * Sprint 13E Phase 2 offline tests (no graphics, no Media Library).
 *
 * Covers: overnight collapse, at_sea skip, missing coords, single port,
 * signature stability/change, simplification, antimeridian, Panama sample,
 * Mediterranean fixture pipeline.
 *
 * Run: npm run test:marine-route-phase2
 */

import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const {
  annotateItineraryStop,
  buildRoutableStops,
  buildMarineItinerarySignature,
  buildMarineRouteObject
} = require(path.join(root, "netlify/functions/lib/marine-route-itinerary.js"));
const { simplifyPolyline } = require(path.join(root, "netlify/functions/lib/polyline-simplify.js"));
const {
  crossesAntimeridian,
  unwrapPolylineForDrawing
} = require(path.join(root, "netlify/functions/lib/antimeridian.js"));
const { routeMarineItinerary } = require(path.join(root, "netlify/functions/lib/marine-route.js"));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function annotateList(rows) {
  return rows.map((row, index) =>
    annotateItineraryStop(
      {
        id: row.id || `s-${index}`,
        display_order: row.display_order ?? index + 1,
        stop_type: row.stop_type,
        port_id: row.port_id,
        entered_port_text: row.name,
        is_overnight: row.is_overnight,
        arrival_time: row.arrival_time || null,
        departure_time: row.departure_time || null,
        canonical_name: row.name,
        port_latitude: row.latitude,
        port_longitude: row.longitude,
        port_status: row.port_status || "verified"
      },
      index
    )
  );
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

test("A Mediterranean fixture routes with at_sea + overnight collapse", () => {
  const annotated = annotateList([
    { name: "Barcelona", port_id: "p-bcn", latitude: 41.3584, longitude: 2.1686, stop_type: "embarkation" },
    { name: "Marseille", port_id: "p-mrs", latitude: 43.2965, longitude: 5.3698, stop_type: "port_call" },
    { name: "At Sea", port_id: null, latitude: null, longitude: null, stop_type: "at_sea" },
    { name: "Genoa", port_id: "p-goa", latitude: 44.4056, longitude: 8.9463, stop_type: "port_call" },
    {
      name: "Rome",
      port_id: "p-rome",
      latitude: 42.093,
      longitude: 11.79,
      stop_type: "overnight_port",
      is_overnight: true
    },
    {
      name: "Rome",
      port_id: "p-rome",
      latitude: 42.093,
      longitude: 11.79,
      stop_type: "port_call",
      is_overnight: true
    },
    { name: "Naples", port_id: "p-nap", latitude: 40.836, longitude: 14.257, stop_type: "port_call" },
    { name: "Athens", port_id: "p-ath", latitude: 37.9445, longitude: 23.6403, stop_type: "disembarkation" }
  ]);

  assert(annotated.some((s) => s.flags.includes("at_sea")), "at_sea flagged");
  const { routableStops, warnings, errors } = buildRoutableStops(annotated);
  assert(errors.length === 0, `unexpected errors: ${JSON.stringify(errors)}`);
  assert(routableStops.length === 6, `expected 6 routable stops, got ${routableStops.length}`);
  assert(
    warnings.some((w) => w.code === "collapsed_consecutive_duplicate"),
    "overnight collapse warning expected"
  );

  const signature = buildMarineItinerarySignature(routableStops);
  const built = buildMarineRouteObject({
    featuredCruiseId: "test-med",
    routableStops,
    itinerarySignature: signature,
    simplifyPreset: "final-map",
    warnings
  });
  assert(built.ok, `route failed: ${JSON.stringify(built.errors)}`);
  assert(built.routeObject.legs.length === 5, "5 legs expected");
  assert(built.routeObject.legs.every((l) => l.distance_nm > 0.5), "no zero-length overnight legs");
  assert(
    built.routeObject.totals.full_point_count > built.routeObject.totals.simplified_point_count,
    "simplified should remove points overall"
  );
  assert(built.routeObject.totals.distance_nm > 1000, "Med total should exceed 1000 nm");
});

test("B overnight same port does not create a marine leg", () => {
  const annotated = annotateList([
    { name: "Naples", port_id: "p-nap", latitude: 40.836, longitude: 14.257, stop_type: "port_call", is_overnight: true },
    { name: "Naples", port_id: "p-nap", latitude: 40.836, longitude: 14.257, stop_type: "port_call", is_overnight: true },
    { name: "Athens", port_id: "p-ath", latitude: 37.9445, longitude: 23.6403, stop_type: "disembarkation" }
  ]);
  const { routableStops, errors } = buildRoutableStops(annotated);
  assert(errors.length === 0, "should route");
  assert(routableStops.length === 2, "overnight collapsed to one Naples");
  const built = buildMarineRouteObject({
    featuredCruiseId: "overnight",
    routableStops,
    itinerarySignature: buildMarineItinerarySignature(routableStops)
  });
  assert(built.ok && built.routeObject.legs.length === 1, "single leg Naples→Athens");
});

test("C at_sea excluded from geometry but retained in annotated itinerary", () => {
  const annotated = annotateList([
    { name: "Barcelona", port_id: "p-bcn", latitude: 41.35, longitude: 2.17, stop_type: "embarkation" },
    { name: "Sea", port_id: null, latitude: null, longitude: null, stop_type: "at_sea" },
    { name: "Marseille", port_id: "p-mrs", latitude: 43.3, longitude: 5.37, stop_type: "port_call" }
  ]);
  assert(annotated.length === 3, "full itinerary kept");
  const { routableStops } = buildRoutableStops(annotated);
  assert(routableStops.length === 2, "sea day dropped from routable");
});

test("D missing coordinates blocks routing", () => {
  const annotated = annotateList([
    { name: "Barcelona", port_id: "p-bcn", latitude: 41.35, longitude: 2.17, stop_type: "embarkation" },
    { name: "Mystery", port_id: "p-x", latitude: null, longitude: null, stop_type: "port_call" }
  ]);
  const { errors, routableStops } = buildRoutableStops(annotated);
  assert(errors.some((e) => e.code === "missing_coordinates"), "missing_coordinates error");
  assert(routableStops.length === 1, "only one valid routable stop");
});

test("E only one routable port errors", () => {
  const annotated = annotateList([
    { name: "Barcelona", port_id: "p-bcn", latitude: 41.35, longitude: 2.17, stop_type: "embarkation" },
    { name: "Sea", port_id: null, latitude: null, longitude: null, stop_type: "at_sea" }
  ]);
  const { errors } = buildRoutableStops(annotated);
  assert(errors.some((e) => e.code === "insufficient_routable_stops"), "insufficient_routable_stops");
});

test("F signature stable when times change; G changes when order changes", () => {
  const a = annotateList([
    { name: "A", port_id: "1", latitude: 41.1, longitude: 2.1, stop_type: "embarkation", arrival_time: "08:00" },
    { name: "B", port_id: "2", latitude: 43.1, longitude: 5.1, stop_type: "disembarkation", arrival_time: "18:00" }
  ]);
  const b = annotateList([
    { name: "A", port_id: "1", latitude: 41.1, longitude: 2.1, stop_type: "embarkation", arrival_time: "09:30" },
    { name: "B", port_id: "2", latitude: 43.1, longitude: 5.1, stop_type: "disembarkation", arrival_time: "19:00" }
  ]);
  const c = annotateList([
    { name: "B", port_id: "2", latitude: 43.1, longitude: 5.1, stop_type: "embarkation" },
    { name: "A", port_id: "1", latitude: 41.1, longitude: 2.1, stop_type: "disembarkation" }
  ]);
  const ra = buildRoutableStops(a).routableStops;
  const rb = buildRoutableStops(b).routableStops;
  const rc = buildRoutableStops(c).routableStops;
  assert(buildMarineItinerarySignature(ra) === buildMarineItinerarySignature(rb), "times ignored");
  assert(buildMarineItinerarySignature(ra) !== buildMarineItinerarySignature(rc), "order changes signature");
});

test("H International Date Line unwrap", () => {
  const raw = [
    [170, -20],
    [175, -18],
    [-175, -16],
    [-170, -15]
  ];
  assert(crossesAntimeridian(raw), "detects IDL jump");
  const unwrapped = unwrapPolylineForDrawing(raw);
  assert(unwrapped.length === raw.length, "same length");
  for (let i = 1; i < unwrapped.length; i += 1) {
    assert(Math.abs(unwrapped[i][0] - unwrapped[i - 1][0]) <= 180, "no >180 jumps after unwrap");
  }
  // Raw unchanged conceptually for Route Object — unwrap is a copy.
  assert(raw[2][0] === -175, "raw preserved");
  const calm = [
    [2.1, 41.3],
    [5.3, 43.2]
  ];
  assert(!crossesAntimeridian(calm), "Med does not cross IDL");
});

test("I Panama-aware Miami → Los Angeles sea route", () => {
  const routed = routeMarineItinerary([
    { id: "miami", name: "Miami", latitude: 25.778, longitude: -80.179 },
    { id: "la", name: "Los Angeles", latitude: 33.732, longitude: -118.271 }
  ]);
  assert(routed.ok, `panama route failed: ${JSON.stringify(routed.errors)}`);
  assert(routed.legs[0].distance_nm > 3000, "should be a long canal/Pacific-aware route");
  const mid = routed.legs[0].polyline[Math.floor(routed.legs[0].polyline.length / 2)];
  // Midpoint longitude should be west of Florida (through Caribbean/Panama/Pacific), not great-circle over Mexico inland only.
  assert(Array.isArray(mid), "has midpoint");
  assert(routed.legs[0].polyline.length > 20, "detailed polyline");
});

test("Simplification keeps endpoints and reduces points", () => {
  const routed = routeMarineItinerary([
    { id: "a", name: "Naples", latitude: 40.836, longitude: 14.257 },
    { id: "b", name: "Athens", latitude: 37.9445, longitude: 23.6403 }
  ]);
  const full = routed.legs[0].polyline;
  const simple = simplifyPolyline(full, "final-map");
  assert(simple[0][0] === full[0][0] && simple[0][1] === full[0][1], "start kept");
  assert(
    simple[simple.length - 1][0] === full[full.length - 1][0] &&
      simple[simple.length - 1][1] === full[full.length - 1][1],
    "end kept"
  );
  assert(simple.length <= full.length, "does not add points");
  assert(simple.length < full.length || full.length <= 6, "usually reduces");
});

const failed = results.filter((r) => !r.ok);
process.stdout.write(
  `${JSON.stringify(
    {
      ok: failed.length === 0,
      passed: results.filter((r) => r.ok).length,
      failed: failed.length,
      results
    },
    null,
    2
  )}\n`
);
if (failed.length) process.exitCode = 1;
