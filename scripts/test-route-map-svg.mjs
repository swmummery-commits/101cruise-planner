/**
 * Sprint 13E Phase 3A — deterministic SVG route-map renderer tests.
 *
 * Run: npm run test:route-map-svg
 */

import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const { renderRouteMapSvg } = require(path.join(root, "netlify/functions/lib/route-map-svg.js"));
const { pointAtProgress } = require(path.join(root, "netlify/functions/lib/route-map-ship.js"));
const {
  buildRoutableStops,
  buildMarineItinerarySignature,
  buildMarineRouteObject,
  annotateItineraryStop
} = require(path.join(root, "netlify/functions/lib/marine-route-itinerary.js"));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function annotateList(rows) {
  return rows.map((row, index) =>
    annotateItineraryStop(
      {
        id: row.id || `s-${index}`,
        display_order: row.display_order ?? index + 1,
        stop_type: row.stop_type || "port_call",
        port_id: row.port_id,
        entered_port_text: row.name,
        is_overnight: row.is_overnight,
        canonical_name: row.name,
        port_latitude: row.latitude,
        port_longitude: row.longitude,
        port_status: "verified"
      },
      index
    )
  );
}

function buildFromPorts(ports, featuredCruiseId = "test") {
  const annotated = annotateList(
    ports.map((p, i) => ({
      ...p,
      stop_type: i === 0 ? "embarkation" : i === ports.length - 1 ? "disembarkation" : "port_call"
    }))
  );
  const { routableStops, warnings, errors } = buildRoutableStops(annotated);
  assert(errors.length === 0, `routable errors: ${JSON.stringify(errors)}`);
  const sig = buildMarineItinerarySignature(routableStops);
  const built = buildMarineRouteObject({
    featuredCruiseId,
    routableStops,
    itinerarySignature: sig,
    warnings
  });
  assert(built.ok, `route build failed: ${JSON.stringify(built.errors)}`);
  return built.routeObject;
}

function syntheticRoute(stops, legsSimplified) {
  return {
    version: 1,
    featured_cruise_id: "synthetic",
    itinerary_signature: "synthetic",
    stops: stops.map((s, i) => ({
      sequence: i + 1,
      port_id: s.port_id || `p-${i}`,
      name: s.name,
      latitude: s.latitude,
      longitude: s.longitude
    })),
    legs: legsSimplified.map((coords, i) => ({
      sequence: i + 1,
      simplified_coordinates: coords,
      simplified_point_count: coords.length
    })),
    totals: { port_count: stops.length, leg_count: legsSimplified.length }
  };
}

function countMarkers(svg) {
  return (svg.match(/class="port-marker"/g) || []).length;
}

function markerNumbers(svg) {
  const nums = [];
  const re = /data-sequence="(\d+)"[\s\S]*?<text[^>]*>(\d+)<\/text>/g;
  let m;
  while ((m = re.exec(svg))) nums.push(Number(m[2]));
  return nums;
}

function assertValidSvg(svg) {
  assert(typeof svg === "string" && svg.startsWith("<svg "), "svg should start with <svg");
  assert(svg.endsWith("</svg>"), "svg should end with </svg>");
  // Allow the SVG xmlns namespace only — no remote assets, fonts, CSS, or images.
  const urls = svg.match(/https?:\/\/[^"'>\s]+/gi) || [];
  const disallowed = urls.filter((u) => u !== "http://www.w3.org/2000/svg");
  assert(disallowed.length === 0, `svg must not contain external URLs: ${disallowed.join(", ")}`);
  assert(!/<script/i.test(svg), "svg must not contain scripts");
  assert(/id="sea-background"/.test(svg), "missing sea background");
  assert(/id="land"/.test(svg), "missing land group");
  assert(/id="marine-route"/.test(svg), "missing marine route");
  assert(/id="route-arrows"/.test(svg), "missing route arrows");
  assert(/id="ship"/.test(svg), "missing ship group");
  assert(/id="port-markers"/.test(svg), "missing port markers");
  assert(/id="port-labels"/.test(svg), "missing port labels");
  assert(/id="ocean"/.test(svg), "missing ocean group");
  assert(/#8DD9BF/.test(svg), "brand green should appear in SVG");
}

function routePathPointCount(svg) {
  const m = svg.match(/id="marine-route" d="([^"]+)"/);
  assert(m, "marine-route path missing");
  return (m[1].match(/[ML]/g) || []).length;
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

const MED_PORTS = [
  { name: "Barcelona", port_id: "p-bcn", latitude: 41.3584, longitude: 2.1686 },
  { name: "Marseille", port_id: "p-mrs", latitude: 43.2965, longitude: 5.3698 },
  { name: "Genoa", port_id: "p-goa", latitude: 44.4056, longitude: 8.9463 },
  { name: "Rome", port_id: "p-rome", latitude: 42.093, longitude: 11.79 },
  { name: "Naples", port_id: "p-nap", latitude: 40.836, longitude: 14.257 },
  { name: "Athens", port_id: "p-ath", latitude: 37.9445, longitude: 23.6403 }
];

const IST_PORTS = [
  { name: "Barcelona", port_id: "p-bcn", latitude: 41.3584, longitude: 2.1686 },
  { name: "Palermo", port_id: "p-pal", latitude: 38.139, longitude: 13.373 },
  { name: "Syracuse", port_id: "p-syr", latitude: 37.0755, longitude: 15.2866 },
  { name: "Argostoli", port_id: "p-arg", latitude: 38.179, longitude: 20.489 },
  { name: "Gythio", port_id: "p-gyth", latitude: 36.759, longitude: 22.566 },
  { name: "Paros", port_id: "p-par", latitude: 37.085, longitude: 25.15 },
  { name: "Piraeus", port_id: "p-pir", latitude: 37.9445, longitude: 23.6403 },
  { name: "Kusadasi", port_id: "p-kus", latitude: 37.86, longitude: 27.26 },
  { name: "Bozcaada", port_id: "p-boz", latitude: 39.835, longitude: 26.07 },
  { name: "Istanbul", port_id: "p-ist", latitude: 41.015, longitude: 28.979 }
];

test("A Mediterranean fixture", () => {
  const route = buildFromPorts(MED_PORTS, "fixture-med");
  const a = renderRouteMapSvg(route);
  const b = renderRouteMapSvg(route);
  assert(a.ok, `render failed: ${JSON.stringify(a.errors)}`);
  assertValidSvg(a.svg);
  assert(a.meta.width === 1200 && a.meta.height === 675, "default 16:9 size");
  assert(countMarkers(a.svg) === 6, "expected 6 markers");
  assert(JSON.stringify(markerNumbers(a.svg)) === JSON.stringify([1, 2, 3, 4, 5, 6]), "numbering");
  assert(a.svg === b.svg, "byte-for-byte deterministic");
  assert(routePathPointCount(a.svg) > MED_PORTS.length, "route must not be port-to-port straight lines only");
});

test("B Real Barcelona-to-Istanbul Route Object geometry", () => {
  const route = buildFromPorts(IST_PORTS, "c737f890-9547-4a68-8fb3-23dbf8216e2d");
  const rendered = renderRouteMapSvg(route);
  assert(rendered.ok, JSON.stringify(rendered.errors));
  assertValidSvg(rendered.svg);
  assert(countMarkers(rendered.svg) === 10, "10 markers");
  assert(rendered.meta.leg_count === 9, "9 legs");
  assert(routePathPointCount(rendered.svg) >= 20, "marine polyline retained");
});

test("C Dense itinerary with nearby ports", () => {
  const ports = [
    { name: "Piraeus", port_id: "a", latitude: 37.9445, longitude: 23.6403 },
    { name: "Aegina", port_id: "b", latitude: 37.746, longitude: 23.428 },
    { name: "Poros", port_id: "c", latitude: 37.499, longitude: 23.454 },
    { name: "Hydra", port_id: "d", latitude: 37.349, longitude: 23.466 },
    { name: "Spetses", port_id: "e", latitude: 37.262, longitude: 23.158 }
  ];
  const route = buildFromPorts(ports, "dense-aegean");
  const rendered = renderRouteMapSvg(route);
  assert(rendered.ok, JSON.stringify(rendered.errors));
  assert(countMarkers(rendered.svg) === 5, "5 markers");
  // May warn on collisions — that is acceptable; still must render
  assertValidSvg(rendered.svg);
});

test("D Repeated port call (genuine separate calls stay numbered)", () => {
  const stops = [
    { name: "Barcelona", latitude: 41.3584, longitude: 2.1686, port_id: "bcn" },
    { name: "Palma", latitude: 39.5696, longitude: 2.6502, port_id: "pmi" },
    { name: "Barcelona", latitude: 41.3584, longitude: 2.1686, port_id: "bcn" }
  ];
  // Build synthetic multi-leg geometry (not overnight collapse — separate calls)
  const legs = [
    [
      [2.1686, 41.3584],
      [2.3, 40.8],
      [2.6502, 39.5696]
    ],
    [
      [2.6502, 39.5696],
      [2.3, 40.8],
      [2.1686, 41.3584]
    ]
  ];
  const route = syntheticRoute(stops, legs);
  const rendered = renderRouteMapSvg(route);
  assert(rendered.ok, JSON.stringify(rendered.errors));
  assert(countMarkers(rendered.svg) === 3, "3 markers for repeated call");
  assert(JSON.stringify(markerNumbers(rendered.svg)) === JSON.stringify([1, 2, 3]));
});

test("E More than nine ports", () => {
  const route = buildFromPorts(IST_PORTS);
  const rendered = renderRouteMapSvg(route);
  assert(rendered.ok);
  assert(countMarkers(rendered.svg) === 10);
  assert(markerNumbers(rendered.svg).includes(10), "two-digit marker");
});

test("F More than twenty ports", () => {
  const ports = [];
  for (let i = 0; i < 22; i += 1) {
    ports.push({
      name: `Port ${i + 1}`,
      port_id: `p-${i}`,
      latitude: 36 + (i % 5) * 0.4,
      longitude: 10 + i * 0.55
    });
  }
  // Synthetic polyline visiting each port with midpoints (avoid full marine routing cost)
  const legs = [];
  for (let i = 1; i < ports.length; i += 1) {
    const a = ports[i - 1];
    const b = ports[i];
    legs.push([
      [a.longitude, a.latitude],
      [(a.longitude + b.longitude) / 2 + 0.15, (a.latitude + b.latitude) / 2 - 0.1],
      [b.longitude, b.latitude]
    ]);
  }
  const route = syntheticRoute(ports, legs);
  const rendered = renderRouteMapSvg(route);
  assert(rendered.ok, JSON.stringify(rendered.errors));
  assert(countMarkers(rendered.svg) === 22, "22 markers");
  assert(markerNumbers(rendered.svg).includes(22), "marker 22 present");
});

test("G Antimeridian route", () => {
  const stops = [
    { name: "Suva", latitude: -18.13, longitude: 178.42, port_id: "suva" },
    { name: "Pago Pago", latitude: -14.28, longitude: -170.7, port_id: "pago" }
  ];
  const simplified = [];
  for (let i = 0; i <= 24; i += 1) {
    const t = i / 24;
    let lon = 178.42 + t * (189.3 - 178.42);
    if (lon > 180) lon -= 360;
    simplified.push([lon, -18.13 + t * 3.85]);
  }
  const route = syntheticRoute(stops, [simplified]);
  const rendered = renderRouteMapSvg(route);
  assert(rendered.ok, JSON.stringify(rendered.errors));
  assertValidSvg(rendered.svg);
  assert(countMarkers(rendered.svg) === 2);
});

test("H Very short itinerary", () => {
  const ports = [
    { name: "Nice", port_id: "nice", latitude: 43.695, longitude: 7.266 },
    { name: "Monaco", port_id: "mon", latitude: 43.738, longitude: 7.427 }
  ];
  const route = buildFromPorts(ports, "short");
  const rendered = renderRouteMapSvg(route);
  assert(rendered.ok, JSON.stringify(rendered.errors));
  assert(countMarkers(rendered.svg) === 2);
  // min span should prevent absurd over-zoom — viewBox still 1200x675
  assert(rendered.meta.width === 1200);
});

test("I Very wide itinerary", () => {
  const ports = [
    { name: "Miami", port_id: "mia", latitude: 25.778, longitude: -80.18 },
    { name: "Lisbon", port_id: "lis", latitude: 38.72, longitude: -9.14 },
    { name: "Barcelona", port_id: "bcn", latitude: 41.3584, longitude: 2.1686 }
  ];
  const route = buildFromPorts(ports, "wide");
  const rendered = renderRouteMapSvg(route);
  assert(rendered.ok, JSON.stringify(rendered.errors));
  assertValidSvg(rendered.svg);
  assert(countMarkers(rendered.svg) === 3);
});

test("J Ship direction follows route", () => {
  const route = buildFromPorts(MED_PORTS);
  const rendered = renderRouteMapSvg(route, { shipProgress: 0.55 });
  assert(rendered.ok);
  assert((rendered.svg.match(/id="ship"/g) || []).length === 1, "one ship group");
  assert(/rotate\(-?\d+(\.\d+)?\)/.test(rendered.svg), "ship has rotation");
  // Eastbound Med legs should generally have angle with |angle| < 90 often; at least finite
  assert(Number.isFinite(rendered.meta.ship_angle_deg), "ship angle present");
  // Local tangent sanity on a simple rightward path
  const sample = pointAtProgress(
    [
      [0, 0],
      [100, 0]
    ],
    0.5
  );
  assert(sample.angleDeg === 0, "rightward path angle 0");
});

test("K Label clipping kept within soft bounds / warned", () => {
  const route = buildFromPorts(IST_PORTS);
  const rendered = renderRouteMapSvg(route);
  assert(rendered.ok);
  // Extract label text elements and ensure coordinates are finite numbers inside generous bounds
  const textRe = /<text x="([-0-9.]+)" y="([-0-9.]+)"[^>]*>/g;
  let m;
  while ((m = textRe.exec(rendered.svg))) {
    const x = Number(m[1]);
    const y = Number(m[2]);
    assert(Number.isFinite(x) && Number.isFinite(y), "label coords finite");
    // Allow small overflow but not absurd
    assert(x > -80 && x < 1280 && y > -40 && y < 720, `label far outside viewBox: ${x},${y}`);
  }
});

test("L Missing or malformed Route Object geometry", () => {
  const missing = renderRouteMapSvg(null);
  assert(!missing.ok && missing.errors[0].code === "missing_route_object");

  const empty = renderRouteMapSvg({ stops: [], legs: [] });
  assert(!empty.ok);

  const badLeg = renderRouteMapSvg({
    stops: [
      { sequence: 1, name: "A", latitude: 1, longitude: 1, port_id: "a" },
      { sequence: 2, name: "B", latitude: 2, longitude: 2, port_id: "b" }
    ],
    legs: [{ simplified_coordinates: [[1, 1]] }]
  });
  assert(!badLeg.ok);
});

const failed = results.filter((r) => !r.ok);
console.log(
  JSON.stringify(
    {
      ok: failed.length === 0,
      passed: results.filter((r) => r.ok).length,
      failed: failed.length,
      results
    },
    null,
    2
  )
);
process.exit(failed.length ? 1 : 0);
