#!/usr/bin/env node
/**
 * Developer-only: render an SVG route map from a persisted Route Object.
 *
 * Usage:
 *   npm run render:route-map -- <featured_cruise_id>
 *   npm run render:route-map -- --fixture-med
 *   npm run render:route-map -- --fixture-dateline
 *
 * Writes to tmp/route-map-previews/ (gitignored). HOLD DEPLOY — SVG only.
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
  buildRoutableStops,
  buildMarineItinerarySignature,
  buildMarineRouteObject,
  annotateItineraryStop
} = require(path.join(root, "netlify/functions/lib/marine-route-itinerary.js"));
const { loadMarineRouteRow } = require(path.join(root, "netlify/functions/lib/marine-route-persist.js"));
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const PREVIEW_DIR = path.join(root, "tmp/route-map-previews");

const MED_FIXTURE = [
  { id: "stop-1", display_order: 1, stop_type: "embarkation", port_id: "port-barcelona", canonical_name: "Barcelona", latitude: 41.3584, longitude: 2.1686, is_overnight: false },
  { id: "stop-2", display_order: 2, stop_type: "port_call", port_id: "port-marseille", canonical_name: "Marseille", latitude: 43.2965, longitude: 5.3698, is_overnight: false },
  { id: "stop-3", display_order: 3, stop_type: "at_sea", port_id: null, canonical_name: null, latitude: null, longitude: null, is_overnight: false },
  { id: "stop-4", display_order: 4, stop_type: "port_call", port_id: "port-genoa", canonical_name: "Genoa", latitude: 44.4056, longitude: 8.9463, is_overnight: false },
  { id: "stop-5", display_order: 5, stop_type: "overnight_port", port_id: "port-rome", canonical_name: "Rome (Civitavecchia)", latitude: 42.093, longitude: 11.79, is_overnight: true },
  { id: "stop-6", display_order: 6, stop_type: "port_call", port_id: "port-rome", canonical_name: "Rome (Civitavecchia)", latitude: 42.093, longitude: 11.79, is_overnight: true },
  { id: "stop-7", display_order: 7, stop_type: "port_call", port_id: "port-naples", canonical_name: "Naples", latitude: 40.836, longitude: 14.257, is_overnight: false },
  { id: "stop-8", display_order: 8, stop_type: "disembarkation", port_id: "port-athens", canonical_name: "Athens (Piraeus)", latitude: 37.9445, longitude: 23.6403, is_overnight: false }
];

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const positional = args.filter((a) => !a.startsWith("--"));
  return {
    featuredCruiseId: positional[0] || null,
    fixtureMed: flags.has("--fixture-med"),
    fixtureDateline: flags.has("--fixture-dateline")
  };
}

function annotateFixture(rows) {
  return rows.map((row, index) =>
    annotateItineraryStop(
      {
        id: row.id || `s-${index}`,
        display_order: row.display_order ?? index + 1,
        stop_type: row.stop_type,
        port_id: row.port_id,
        entered_port_text: row.canonical_name,
        is_overnight: row.is_overnight,
        canonical_name: row.canonical_name,
        port_latitude: row.latitude,
        port_longitude: row.longitude,
        port_status: "verified"
      },
      index
    )
  );
}

function buildFixtureRouteObject(rows, featuredCruiseId) {
  const annotated = annotateFixture(rows);
  const { routableStops, warnings, errors } = buildRoutableStops(annotated);
  if (errors.length) {
    return { ok: false, errors, routeObject: null };
  }
  const itinerarySignature = buildMarineItinerarySignature(routableStops);
  return buildMarineRouteObject({
    featuredCruiseId,
    routableStops,
    itinerarySignature,
    warnings
  });
}

function buildDatelineFixtureRouteObject() {
  // Synthetic Pacific crossing using stored simplified geometry only (no live routing required).
  const stops = [
    { sequence: 1, port_id: "port-suva", name: "Suva", latitude: -18.13, longitude: 178.42 },
    { sequence: 2, port_id: "port-pago", name: "Pago Pago", latitude: -14.28, longitude: -170.7 }
  ];
  const simplified = [];
  for (let i = 0; i <= 20; i += 1) {
    const t = i / 20;
    let lon = 178.42 + t * ((-170.7 + 360) - 178.42);
    if (lon > 180) lon -= 360;
    const lat = -18.13 + t * (-14.28 - -18.13);
    simplified.push([lon, lat]);
  }
  return {
    ok: true,
    routeObject: {
      version: 1,
      featured_cruise_id: "fixture-dateline",
      itinerary_signature: "fixture:dateline",
      stops,
      legs: [
        {
          sequence: 1,
          from_port_id: "port-suva",
          to_port_id: "port-pago",
          from_name: "Suva",
          to_name: "Pago Pago",
          simplified_coordinates: simplified,
          simplified_point_count: simplified.length
        }
      ],
      totals: { port_count: 2, leg_count: 1, simplified_point_count: simplified.length }
    }
  };
}

function writePreview(fileStem, svg) {
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  const outputPath = path.join(PREVIEW_DIR, `${fileStem}.svg`);
  fs.writeFileSync(outputPath, svg, "utf8");
  return outputPath;
}

async function main() {
  const started = Date.now();
  const args = parseArgs(process.argv);
  let routeObject = null;
  let featuredCruiseId = args.featuredCruiseId;
  let errors = [];

  try {
    if (args.fixtureDateline) {
      featuredCruiseId = "fixture-dateline";
      const built = buildDatelineFixtureRouteObject();
      routeObject = built.routeObject;
    } else if (args.fixtureMed) {
      featuredCruiseId = "fixture-med";
      const built = buildFixtureRouteObject(MED_FIXTURE, featuredCruiseId);
      if (!built.ok) {
        errors = built.errors || [];
      } else {
        routeObject = built.routeObject;
      }
    } else if (featuredCruiseId) {
      const rest = createSupabaseRest(root);
      const existing = await loadMarineRouteRow(rest.request.bind(rest), featuredCruiseId);
      if (!existing) {
        errors = [
          { code: "route_not_found", message: `No persisted Route Object for ${featuredCruiseId}` }
        ];
      } else {
        routeObject = existing.route_data || existing;
      }
    } else {
      errors = [
        {
          code: "usage",
          message:
            "Usage: npm run render:route-map -- <featured_cruise_id> | --fixture-med | --fixture-dateline"
        }
      ];
    }
  } catch (error) {
    errors = [{ code: "load_failed", message: String(error.message || error) }];
  }

  if (errors.length || !routeObject) {
    const report = {
      ok: false,
      featured_cruise_id: featuredCruiseId,
      itinerary_signature: null,
      output_path: null,
      width: null,
      height: null,
      stop_count: 0,
      leg_count: 0,
      label_collision_warnings: [],
      ship_progress: null,
      runtime_ms: Date.now() - started,
      errors
    };
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const rendered = renderRouteMapSvg(routeObject, {});
  if (!rendered.ok || !rendered.svg) {
    const report = {
      ok: false,
      featured_cruise_id: featuredCruiseId,
      itinerary_signature: routeObject.itinerary_signature || null,
      output_path: null,
      width: rendered.meta?.width || null,
      height: rendered.meta?.height || null,
      stop_count: rendered.meta?.stop_count || 0,
      leg_count: rendered.meta?.leg_count || 0,
      label_collision_warnings: (rendered.warnings || []).filter((w) => w.code === "label_collision"),
      ship_progress: null,
      runtime_ms: Date.now() - started,
      errors: rendered.errors || []
    };
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const outputPath = writePreview(featuredCruiseId, rendered.svg);
  const report = {
    ok: true,
    featured_cruise_id: featuredCruiseId,
    itinerary_signature: routeObject.itinerary_signature || rendered.meta.itinerary_signature,
    output_path: path.relative(root, outputPath),
    width: rendered.meta.width,
    height: rendered.meta.height,
    stop_count: rendered.meta.stop_count,
    leg_count: rendered.meta.leg_count,
    label_collision_warnings: (rendered.warnings || []).filter((w) =>
      ["label_collision", "label_clipped"].includes(w.code)
    ),
    ship_progress: rendered.meta.ship_progress,
    runtime_ms: Date.now() - started,
    errors: []
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.log(
    JSON.stringify(
      {
        ok: false,
        errors: [{ code: "fatal", message: String(error.message || error) }]
      },
      null,
      2
    )
  );
  process.exit(1);
});
