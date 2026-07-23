/**
 * Sprint 13E Phase 4B — route-map workflow tests (offline; mocked Storage).
 *
 * Covers: SVG/PNG render, Supabase Storage upload paths & content-types,
 * overwrite on regeneration, preview URLs, missing bucket, upload failure,
 * DB metadata shape, no writes to /var/task/generated-assets.
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
  ROUTE_MAP_STORAGE_BUCKET,
  ROUTE_MAP_CACHE_CONTROL,
  saveRouteMapAssets,
  saveRouteMapAssetsLocal,
  svgToPngBuffer,
  storageObjectPaths,
  publicObjectUrl,
  displayUrls,
  projectRoot
} = require(path.join(root, "netlify/functions/lib/route-map-assets.js"));
const {
  buildRoutableStops,
  buildMarineItinerarySignature,
  buildMarineRouteObject,
  annotateItineraryStop
} = require(path.join(root, "netlify/functions/lib/marine-route-itinerary.js"));

const TEST_ID = "00000000-0000-4000-8000-workflowtest0001";
const FAKE_SUPABASE = "https://example.supabase.co";
const FAKE_KEY = "test-service-role-key";
const results = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      results.push({ name, ok: true });
    })
    .catch((error) => {
      results.push({ name, ok: false, error: String(error.message || error) });
    });
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

function createMockFetch(recorder, behavior = {}) {
  return async (url, options = {}) => {
    const entry = {
      url: String(url),
      method: options.method || "GET",
      headers: { ...(options.headers || {}) },
      body: options.body
    };
    recorder.push(entry);

    if (behavior.failUrl && String(url).includes(behavior.failUrl)) {
      return {
        ok: false,
        status: behavior.failStatus || 500,
        text: async () => JSON.stringify({ message: behavior.failMessage || "upload failed" })
      };
    }
    if (behavior.missingBucket) {
      return {
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ message: "Bucket not found", statusCode: "404" })
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ Key: entry.url })
    };
  };
}

function assertNoVarTaskWrites() {
  const varTask = path.join("/var/task/generated-assets", TEST_ID);
  assert(!fs.existsSync(varTask), "must not write /var/task/generated-assets");
}

async function main() {
  const localDir = path.join(projectRoot(), "generated-assets", TEST_ID);
  if (fs.existsSync(localDir)) fs.rmSync(localDir, { recursive: true, force: true });

  await test("A render SVG from Route Object", () => {
    const route = buildMedRoute();
    const rendered = renderRouteMapSvg(route);
    assert(rendered.ok, JSON.stringify(rendered.errors));
    assert(rendered.svg.startsWith("<svg "), "valid svg start");
    assert(rendered.svg.includes('id="marine-route"'), "has route");
  });

  await test("B PNG conversion dimensions ~2000px wide", async () => {
    const route = buildMedRoute();
    const rendered = renderRouteMapSvg(route);
    const { buffer, width, height } = await svgToPngBuffer(rendered.svg, { width: 2000 });
    assert(buffer.length > 1000, "png buffer non-trivial");
    assert(width === 2000, `expected width 2000, got ${width}`);
    assert(height === Math.round((2000 * 675) / 1200), `expected 16:9 height, got ${height}`);
  });

  await test("B2 PNG includes label/number glyphs when fonts are loaded", async () => {
    const labelSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80">
  <rect width="240" height="80" fill="#3E7FA8"/>
  <text x="24" y="36" font-family="ui-sans-serif, system-ui, sans-serif" font-size="18" font-weight="700" fill="#FFFFFF">9 Barcelona</text>
  <text x="24" y="62" font-family="ui-sans-serif, system-ui, sans-serif" font-size="14" font-weight="500" fill="#FFFFFF">Piraeus</text>
</svg>`;
    const withFonts = await svgToPngBuffer(labelSvg, { width: 480 });
    const withoutFonts = await svgToPngBuffer(labelSvg, {
      width: 480,
      fontFiles: []
    }).catch(() => null);
    // Empty fontFiles throws png_fonts_missing — compare against explicit no-system-font render via native opts path
    const { Resvg } = require("@resvg/resvg-js");
    const bare = new Resvg(labelSvg, {
      fitTo: { mode: "width", value: 480 },
      font: { loadSystemFonts: false }
    })
      .render()
      .asPng();
    assert(withFonts.buffer.length > bare.length + 500, "font-backed PNG should be larger than glyphless PNG");
    assert(withoutFonts === null, "missing fontFiles should fail closed");
  });

  await test("C storage object paths are stable", () => {
    const paths = storageObjectPaths(TEST_ID);
    assert(paths.svg_path === `${TEST_ID}/route-map.svg`, "svg object path");
    assert(paths.png_path === `${TEST_ID}/route-map.png`, "png object path");
  });

  await test("D preview URL generation from canonical paths", () => {
    const url = publicObjectUrl(`${TEST_ID}/route-map.svg`, {
      supabaseUrl: FAKE_SUPABASE,
      cacheBust: 12345
    });
    assert(
      url ===
        `${FAKE_SUPABASE}/storage/v1/object/public/${ROUTE_MAP_STORAGE_BUCKET}/${TEST_ID}/route-map.svg?t=12345`,
      `unexpected url: ${url}`
    );
    assert(publicObjectUrl("generated-assets/x/route-map.svg", { supabaseUrl: FAKE_SUPABASE }) === null, "legacy local");
    const urls = displayUrls(TEST_ID, { supabaseUrl: FAKE_SUPABASE, cacheBust: 99 });
    assert(urls.svg_url.includes("route-map.svg?t=99"), "display svg");
    assert(urls.png_url.includes("route-map.png?t=99"), "display png");
  });

  await test("E SVG + PNG upload with correct content types", async () => {
    const recorder = [];
    const route = buildMedRoute();
    const rendered = renderRouteMapSvg(route);
    const saved = await saveRouteMapAssets(TEST_ID, rendered.svg, {
      pngWidth: 2000,
      supabaseUrl: FAKE_SUPABASE,
      serviceRoleKey: FAKE_KEY,
      fetchImpl: createMockFetch(recorder)
    });
    assert(recorder.length === 2, `expected 2 uploads, got ${recorder.length}`);
    assert(recorder[0].headers["Content-Type"] === "image/svg+xml", "svg content-type");
    assert(recorder[1].headers["Content-Type"] === "image/png", "png content-type");
    assert(recorder[0].headers["x-upsert"] === "true", "svg upsert");
    assert(recorder[1].headers["x-upsert"] === "true", "png upsert");
    assert(recorder[0].headers["cache-control"] === ROUTE_MAP_CACHE_CONTROL, "cache-control");
    assert(/inline/i.test(recorder[0].headers["content-disposition"] || ""), "svg inline disposition");
    assert(/inline/i.test(recorder[1].headers["content-disposition"] || ""), "png inline disposition");
    assert(recorder[0].url.includes(`/${ROUTE_MAP_STORAGE_BUCKET}/${TEST_ID}/route-map.svg`), "svg url path");
    assert(recorder[1].url.includes(`/${ROUTE_MAP_STORAGE_BUCKET}/${TEST_ID}/route-map.png`), "png url path");
    assert(saved.svg_path === `${TEST_ID}/route-map.svg`, "db svg path");
    assert(saved.png_path === `${TEST_ID}/route-map.png`, "db png path");
    assert(saved.storage_bucket === ROUTE_MAP_STORAGE_BUCKET, "bucket");
    assert(saved.renderer_version === ROUTE_MAP_RENDERER_VERSION, "renderer version");
    assert(saved.width === 2000, "width");
    assert(saved.svg_url.includes("object/public/"), "public svg url");
    assert(saved.png_url.includes("object/public/"), "public png url");
    assertNoVarTaskWrites();
    assert(!fs.existsSync(path.join(projectRoot(), "generated-assets", TEST_ID)), "no default local write");
  });

  await test("F regenerate overwrites same object paths", async () => {
    const recorder = [];
    const route = buildMedRoute();
    const rendered = renderRouteMapSvg(route);
    const first = await saveRouteMapAssets(TEST_ID, rendered.svg, {
      pngWidth: 1800,
      supabaseUrl: FAKE_SUPABASE,
      serviceRoleKey: FAKE_KEY,
      fetchImpl: createMockFetch(recorder)
    });
    const second = await saveRouteMapAssets(TEST_ID, rendered.svg, {
      pngWidth: 2000,
      supabaseUrl: FAKE_SUPABASE,
      serviceRoleKey: FAKE_KEY,
      fetchImpl: createMockFetch(recorder)
    });
    assert(first.svg_path === second.svg_path, "same svg path");
    assert(first.png_path === second.png_path, "same png path");
    assert(second.width === 2000, "second width");
    const svgUploads = recorder.filter((r) => r.url.includes("route-map.svg"));
    assert(svgUploads.length === 2, "two svg upserts");
    assert(svgUploads.every((r) => r.headers["x-upsert"] === "true"), "all upsert");
  });

  await test("G missing bucket surfaces clear error", async () => {
    const recorder = [];
    const route = buildMedRoute();
    const rendered = renderRouteMapSvg(route);
    let threw = false;
    try {
      await saveRouteMapAssets(TEST_ID, rendered.svg, {
        pngWidth: 1200,
        supabaseUrl: FAKE_SUPABASE,
        serviceRoleKey: FAKE_KEY,
        fetchImpl: createMockFetch(recorder, { missingBucket: true })
      });
    } catch (error) {
      threw = true;
      assert(error.code === "bucket_missing", `code=${error.code}`);
      assert(/featured-cruise-route-maps/i.test(error.message), "mentions bucket");
    }
    assert(threw, "should throw");
  });

  await test("H PNG upload failure reports partial SVG success", async () => {
    const recorder = [];
    const route = buildMedRoute();
    const rendered = renderRouteMapSvg(route);
    let threw = false;
    try {
      await saveRouteMapAssets(TEST_ID, rendered.svg, {
        pngWidth: 1200,
        supabaseUrl: FAKE_SUPABASE,
        serviceRoleKey: FAKE_KEY,
        fetchImpl: createMockFetch(recorder, {
          failUrl: "route-map.png",
          failMessage: "png rejected"
        })
      });
    } catch (error) {
      threw = true;
      assert(error.partial?.svg === true, "svg partial true");
      assert(error.partial?.png === false, "png partial false");
      assert(/PNG upload failed after SVG/i.test(error.message), error.message);
    }
    assert(threw, "should throw");
  });

  await test("I missing credentials error", async () => {
    const route = buildMedRoute();
    const rendered = renderRouteMapSvg(route);
    let threw = false;
    try {
      await saveRouteMapAssets(TEST_ID, rendered.svg, {
        pngWidth: 800,
        supabaseUrl: "",
        serviceRoleKey: "",
        fetchImpl: createMockFetch([])
      });
    } catch (error) {
      threw = true;
      assert(error.code === "supabase_credentials_missing", `code=${error.code}`);
    }
    assert(threw, "should throw");
  });

  await test("J database metadata payload shape", async () => {
    const recorder = [];
    const route = buildMedRoute();
    const rendered = renderRouteMapSvg(route);
    const saved = await saveRouteMapAssets(TEST_ID, rendered.svg, {
      pngWidth: 1600,
      supabaseUrl: FAKE_SUPABASE,
      serviceRoleKey: FAKE_KEY,
      fetchImpl: createMockFetch(recorder)
    });
    // Fields written by route-map-generate updateCruiseAssetMetadata
    const meta = {
      route_map_svg_path: saved.svg_path,
      route_map_png_path: saved.png_path,
      route_map_generated_at: saved.generated_at,
      route_map_renderer_version: saved.renderer_version,
      route_map_width: saved.width,
      route_map_height: saved.height
    };
    assert(!meta.route_map_svg_path.startsWith("http"), "store path not URL");
    assert(!meta.route_map_png_path.includes("?"), "no signed query in DB path");
    assert(meta.route_map_svg_path.endsWith("/route-map.svg"), "svg path");
    assert(Number.isFinite(meta.route_map_width), "width");
    assert(meta.route_map_renderer_version === ROUTE_MAP_RENDERER_VERSION, "version");
  });

  await test("K local fallback still works for developers", async () => {
    const route = buildMedRoute();
    const rendered = renderRouteMapSvg(route);
    const saved = await saveRouteMapAssetsLocal(TEST_ID, rendered.svg, { pngWidth: 1200 });
    assert(fs.existsSync(saved.svg_abs), "local svg");
    assert(fs.existsSync(saved.png_abs), "local png");
    assert(saved.local_fallback === true, "flag");
    fs.rmSync(path.join(projectRoot(), "generated-assets", TEST_ID), {
      recursive: true,
      force: true
    });
  });

  await test("N wasm PNG fallback when native binding is unavailable", async () => {
    const Module = require("module");
    const assetsPath = path.join(root, "netlify/functions/lib/route-map-assets.js");
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === "@resvg/resvg-js") {
        throw new Error("Cannot find module '@resvg/resvg-js-linux-x64-gnu'");
      }
      return originalLoad.apply(this, arguments);
    };
    try {
      delete require.cache[assetsPath];
      try {
        delete require.cache[require.resolve("@resvg/resvg-js")];
      } catch {
        /* not resolved yet */
      }
      const fresh = require(assetsPath);
      const route = buildMedRoute();
      const rendered = renderRouteMapSvg(route);
      const result = await fresh.svgToPngBuffer(rendered.svg, { width: 800 });
      assert(result.engine === "wasm", `expected wasm engine, got ${result.engine}`);
      assert(result.width === 800, `width ${result.width}`);
      assert(result.buffer.length > 100, "png buffer");
    } finally {
      Module._load = originalLoad;
      delete require.cache[assetsPath];
      require(assetsPath);
    }
  });

  await test("L invalid SVG rejected", async () => {
    let threw = false;
    try {
      await saveRouteMapAssets(TEST_ID, "not-an-svg", {
        supabaseUrl: FAKE_SUPABASE,
        serviceRoleKey: FAKE_KEY,
        fetchImpl: createMockFetch([])
      });
    } catch (error) {
      threw = true;
      assert(error.code === "invalid_svg", "invalid_svg code");
    }
    assert(threw, "should throw");
  });

  await test("M missing / malformed Route Object fails SVG render", () => {
    const missing = renderRouteMapSvg(null);
    assert(!missing.ok, "null route fails");
    const bad = renderRouteMapSvg({ stops: [], legs: [] });
    assert(!bad.ok, "empty route fails");
  });

  const failed = results.filter((r) => !r.ok);
  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0,
        passed: results.filter((r) => r.ok).length,
        failed: failed.length,
        renderer_version: ROUTE_MAP_RENDERER_VERSION,
        storage_bucket: ROUTE_MAP_STORAGE_BUCKET,
        results
      },
      null,
      2
    )
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
