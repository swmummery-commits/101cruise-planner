/**
 * Developer-only marine routing test (JSON only — no graphics).
 *
 * Usage:
 *   node scripts/test-marine-route.mjs
 *
 * Feeds a Mediterranean sample itinerary through the offline MARNET engine
 * and prints a JSON report (legs, distances, sanity checks).
 */

import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const { routeMarineItinerary } = require(path.join(root, "netlify/functions/lib/marine-route.js"));

/** Approximate cruise-port coordinates (WGS84). Rome uses Civitavecchia. */
const MED_ITINERARY = [
  { id: "port-barcelona", name: "Barcelona", latitude: 41.3584, longitude: 2.1686 },
  { id: "port-marseille", name: "Marseille", latitude: 43.2965, longitude: 5.3698 },
  { id: "port-genoa", name: "Genoa", latitude: 44.4056, longitude: 8.9463 },
  { id: "port-rome", name: "Rome (Civitavecchia)", latitude: 42.093, longitude: 11.79 },
  { id: "port-naples", name: "Naples", latitude: 40.836, longitude: 14.257 },
  { id: "port-athens", name: "Athens (Piraeus)", latitude: 37.9445, longitude: 23.6403 }
];

function haversineNm(lon1, lat1, lon2, lat2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3440.065; // Earth radius in nautical miles (mean)
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Crude inland check for Genoa → Rome: interior Tuscany/Umbria sample box,
 * kept east of the Tyrrhenian coastal strip so harbour approaches do not false-positive.
 */
function pointLooksInlandCentralItaly(lon, lat) {
  return lon >= 11.6 && lon <= 12.9 && lat >= 42.9 && lat <= 43.8;
}

function analyseLeg(leg) {
  const poly = leg.polyline || [];
  const first = poly[0];
  const last = poly[poly.length - 1];
  const gc =
    first && last ? haversineNm(first[0], first[1], last[0], last[1]) : null;
  const inlandHits = poly.filter(([lon, lat]) => pointLooksInlandCentralItaly(lon, lat)).length;

  return {
    from: leg.from_name,
    to: leg.to_name,
    from_port_id: leg.from_port_id,
    to_port_id: leg.to_port_id,
    distance_nm: leg.distance_nm,
    distance_km: leg.distance_km,
    waypoints: leg.waypoints,
    coordinate_count: poly.length,
    great_circle_nm: gc,
    sea_route_vs_gc_ratio:
      gc && leg.distance_nm != null && gc > 0 ? Number((leg.distance_nm / gc).toFixed(3)) : null,
    inland_central_italy_hits: inlandHits,
    sample_midpoint: poly.length ? poly[Math.floor(poly.length / 2)] : null
  };
}

function verifyOrder(result) {
  const names = MED_ITINERARY.map((p) => p.name);
  const legOrder = result.legs.map((l) => `${l.from_name}→${l.to_name}`);
  const expected = [];
  for (let i = 0; i < names.length - 1; i += 1) {
    expected.push(`${names[i]}→${names[i + 1]}`);
  }
  return {
    preserved: JSON.stringify(legOrder) === JSON.stringify(expected),
    expected,
    actual: legOrder
  };
}

function main() {
  const started = Date.now();
  const result = routeMarineItinerary(MED_ITINERARY);
  const elapsed_ms = Date.now() - started;

  const order = verifyOrder(result);
  const legAnalyses = result.legs.map(analyseLeg);
  const genoaRome = legAnalyses.find((l) => l.from?.startsWith("Genoa") && l.to?.includes("Rome"));

  const checks = {
    ok: result.ok,
    order_preserved: order.preserved,
    all_legs_have_polyline: result.legs.every((l) => Array.isArray(l.polyline) && l.polyline.length > 1),
    sea_route_not_shorter_than_gc: legAnalyses.every(
      (l) => l.sea_route_vs_gc_ratio == null || l.sea_route_vs_gc_ratio >= 0.98
    ),
    genoa_rome_avoids_central_italy_box: genoaRome
      ? genoaRome.inland_central_italy_hits === 0
      : null
  };

  const report = {
    test: "mediterranean-marine-route",
    engine: result.summary.engine,
    elapsed_ms,
    input_ports: MED_ITINERARY.map((p) => ({
      id: p.id,
      name: p.name,
      latitude: p.latitude,
      longitude: p.longitude
    })),
    summary: result.summary,
    checks,
    order,
    errors: result.errors,
    legs: result.legs.map((leg) => ({
      from_port_id: leg.from_port_id,
      to_port_id: leg.to_port_id,
      from_name: leg.from_name,
      to_name: leg.to_name,
      distance_nm: leg.distance_nm,
      distance_km: leg.distance_km,
      waypoints: leg.waypoints,
      polyline_coordinate_count: leg.polyline.length,
      polyline: leg.polyline
    })),
    leg_analysis: legAnalyses
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!result.ok || !checks.order_preserved || !checks.all_legs_have_polyline) {
    process.exitCode = 1;
  }
}

main();
