/**
 * Sprint 13E Phase 4 — offline workflow tests (no Netlify, no Admin UI).
 *
 * Covers: SVG render → PNG conversion → disk save → regenerate overwrite,
 * missing/malformed route handling, PNG dimensions, SVG validity.
 *
 * Run: npm run test:route-map-workflow
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const { renderRouteMapSvg } = require(path.join(root, "netlify/functions/lib/route-map-svg.js"));
const {
  ROUTE_MAP_RENDERER_VERSION,
  saveRouteMapAssets,
  svgToPngBuffer,
  assetsExist,
  relativeAssetPaths,
  projectRoot
} = require(path.join(root, "netlify/functions/lib/route-map-assets.js"));
const {
  buildRoutableStops,
  buildMarineItinerarySignature,
  buildMarineRouteObject,
  annotateItineraryStop
} = require(path.join(root, "netlify/functions/lib/marine-route-itinerary.js"));

const TEST_ID = "00000000-0000-4000-8000-workflowtest0001";
const results = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: String(error.message || error) });
  }
}

function buildMedRoute() {
  const ports = [
    { name: "Barcelona", port_id: "p1", latitude: 41.3584, longitude: 2.1686 },
    { name: "Marseille", port_id: "p2", latitude: 43.2965, longitude: 5.3698 },
    { name: "Genoa", port_id: "p3", latitude: 44.4056, longitude: 8.9463 },
    { name: "Athens", port_id: "p4", latitude: 37.9445, longitude: 23.6403 }
  ];
  const annotated = ports.map((row, i) =>
    annotateItineraryStop(
      {
        id: `s-${i}`,
        display_order: i + 1,
        stop_type: i === 0 ? "embarkation" : i === ports.length - 1 ? "disembarkation" : "port_call",
        port_id: row.port_id,
        canonical_name: row.name,
        port_latitude: row.latitude,
        port_longitude: row.longitude,
        port_status: "verified"
      },
      i
    )
  );
  const { routableStops, warnings, errors } = buildRoutableStops(annotated);
  assert(errors.length === 0, JSON.stringify(errors));
  const built = buildMarineRouteObject({
    featuredCruiseId: TEST_ID,
    routableStops,
    itinerarySignature: buildMarineItinerarySignature(routableStops),
    warnings
  });
  assert(built.ok, JSON.stringify(built.errors));
  return built.routeObject;
}

function cleanup() {
  const dir = path.join(projectRoot(), "generated-assets", TEST_ID);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

cleanup();

test("A render SVG from Route Object", () => {
  const route = buildMedRoute();
  const rendered = renderRouteMapSvg(route);
  assert(rendered.ok, JSON.stringify(rendered.errors));
  assert(rendered.svg.startsWith("<svg "), "valid svg start");
  assert(rendered.svg.includes('id="marine-route"'), "has route");
});

test("B PNG conversion dimensions ~2000px wide", () => {
  const route = buildMedRoute();
  const rendered = renderRouteMapSvg(route);
  const { buffer, width, height } = svgToPngBuffer(rendered.svg, { width: 2000 });
  assert(buffer.length > 1000, "png buffer non-trivial");
  assert(width === 2000, `expected width 2000, got ${width}`);
  assert(height === Math.round((2000 * 675) / 1200), `expected 16:9 height, got ${height}`);
});

test("C save assets to generated-assets/<id>/", () => {
  const route = buildMedRoute();
  const rendered = renderRouteMapSvg(route);
  const saved = saveRouteMapAssets(TEST_ID, rendered.svg, { pngWidth: 2000 });
  assert(saved.renderer_version === ROUTE_MAP_RENDERER_VERSION, "renderer version");
  assert(assetsExist(TEST_ID), "assets exist on disk");
  const rel = relativeAssetPaths(TEST_ID);
  assert(saved.svg_path === rel.svg_path, "svg path");
  assert(saved.png_path === rel.png_path, "png path");
  const svgText = fs.readFileSync(saved.svg_abs, "utf8");
  assert(svgText.startsWith("<svg "), "saved svg valid");
  const png = fs.readFileSync(saved.png_abs);
  assert(png[0] === 0x89 && png[1] === 0x50, "PNG magic bytes");
});

test("D regenerate overwrites only map assets", () => {
  const extra = path.join(projectRoot(), "generated-assets", TEST_ID, "keep-me.txt");
  fs.writeFileSync(extra, "preserve", "utf8");
  const route = buildMedRoute();
  const rendered = renderRouteMapSvg(route);
  const first = saveRouteMapAssets(TEST_ID, rendered.svg, { pngWidth: 1800 });
  const second = saveRouteMapAssets(TEST_ID, rendered.svg, { pngWidth: 2000 });
  assert(fs.existsSync(extra), "unrelated file preserved");
  assert(first.width === 1800, "first width");
  assert(second.width === 2000, "second width");
  assert(second.png_bytes > 0, "second png written");
});

test("E missing / malformed Route Object fails SVG render", () => {
  const missing = renderRouteMapSvg(null);
  assert(!missing.ok, "null route fails");
  const bad = renderRouteMapSvg({ stops: [], legs: [] });
  assert(!bad.ok, "empty route fails");
});

test("F invalid SVG rejected by saveRouteMapAssets", () => {
  let threw = false;
  try {
    saveRouteMapAssets(TEST_ID, "not-an-svg");
  } catch (error) {
    threw = true;
    assert(error.code === "invalid_svg", "invalid_svg code");
  }
  assert(threw, "should throw");
});

cleanup();

const failed = results.filter((r) => !r.ok);
console.log(
  JSON.stringify(
    {
      ok: failed.length === 0,
      passed: results.filter((r) => r.ok).length,
      failed: failed.length,
      renderer_version: ROUTE_MAP_RENDERER_VERSION,
      results
    },
    null,
    2
  )
);
process.exit(failed.length ? 1 : 0);
