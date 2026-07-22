#!/usr/bin/env node
/**
 * Developer-only: generate + persist marine Route Object for a Featured Cruise.
 *
 * Usage:
 *   npm run generate:marine-route -- <featured_cruise_id> [--force]
 *   npm run generate:marine-route -- --fixture-med [--force]
 *
 * --fixture-med runs the Mediterranean sample offline (no DB itinerary required)
 * and skips persistence unless --persist-fixture is also passed (requires schema).
 *
 * HOLD DEPLOY — does not upload Media Library images or update route_map_media_id.
 */

import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const {
  buildRoutableStops,
  buildMarineItinerarySignature,
  buildMarineRouteObject,
  annotateItineraryStop,
  generateMarineRouteForCruise
} = require(path.join(root, "netlify/functions/lib/marine-route-itinerary.js"));
const { loadMarineRouteRow, saveMarineRouteRow } = require(path.join(
  root,
  "netlify/functions/lib/marine-route-persist.js"
));
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

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
    force: flags.has("--force"),
    fixtureMed: flags.has("--fixture-med"),
    persistFixture: flags.has("--persist-fixture")
  };
}

function reportFromRoute({
  ok,
  featuredCruiseId,
  itinerarySignature,
  reusedExisting,
  routeObject,
  warnings,
  errors,
  runtimeMs
}) {
  return {
    ok: Boolean(ok),
    featured_cruise_id: featuredCruiseId,
    itinerary_signature: itinerarySignature,
    reused_existing: Boolean(reusedExisting),
    stop_count: routeObject?.totals?.port_count ?? routeObject?.stops?.length ?? 0,
    leg_count: routeObject?.totals?.leg_count ?? routeObject?.legs?.length ?? 0,
    full_point_count: routeObject?.totals?.full_point_count ?? 0,
    simplified_point_count: routeObject?.totals?.simplified_point_count ?? 0,
    total_distance_nm: routeObject?.totals?.distance_nm ?? null,
    total_distance_km: routeObject?.totals?.distance_km ?? null,
    runtime_ms: runtimeMs,
    warnings: warnings || [],
    errors: errors || []
  };
}

async function runFixture(opts) {
  const started = Date.now();
  const annotated = MED_FIXTURE.map((row, index) =>
    annotateItineraryStop(
      {
        id: row.id,
        display_order: row.display_order,
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
  const normalised = buildRoutableStops(annotated);
  if (normalised.errors.length) {
    return reportFromRoute({
      ok: false,
      featuredCruiseId: "fixture-med",
      itinerarySignature: null,
      reusedExisting: false,
      routeObject: null,
      warnings: normalised.warnings,
      errors: normalised.errors,
      runtimeMs: Date.now() - started
    });
  }

  const signature = buildMarineItinerarySignature(normalised.routableStops);
  const built = buildMarineRouteObject({
    featuredCruiseId: "fixture-med",
    routableStops: normalised.routableStops,
    itinerarySignature: signature,
    simplifyPreset: "final-map",
    warnings: normalised.warnings
  });

  let reusedExisting = false;
  if (opts.persistFixture) {
    const { request, get } = createSupabaseRest(root);
    const existing = await loadMarineRouteRow(request, "fixture-med").catch(() => null);
    if (existing && existing.itinerary_signature === signature && !opts.force) {
      reusedExisting = true;
      return reportFromRoute({
        ok: true,
        featuredCruiseId: "fixture-med",
        itinerarySignature: signature,
        reusedExisting: true,
        routeObject: existing.route_data,
        warnings: existing.warnings || [],
        errors: [],
        runtimeMs: Date.now() - started
      });
    }
    if (built.ok) {
      await saveMarineRouteRow(request, {
        featuredCruiseId: "fixture-med",
        routeObject: built.routeObject,
        status: "current"
      });
    }
    void get;
  }

  return reportFromRoute({
    ok: built.ok,
    featuredCruiseId: "fixture-med",
    itinerarySignature: signature,
    reusedExisting,
    routeObject: built.routeObject,
    warnings: built.warnings,
    errors: built.errors,
    runtimeMs: Date.now() - started
  });
}

async function runCruise(featuredCruiseId, opts) {
  const started = Date.now();
  const { request, get } = createSupabaseRest(root);

  const generated = await generateMarineRouteForCruise(get, featuredCruiseId, {
    simplifyPreset: "final-map"
  });

  if (!generated.ok) {
    return reportFromRoute({
      ok: false,
      featuredCruiseId,
      itinerarySignature: generated.itinerary_signature,
      reusedExisting: false,
      routeObject: null,
      warnings: generated.warnings,
      errors: generated.errors,
      runtimeMs: Date.now() - started
    });
  }

  let existing = null;
  try {
    existing = await loadMarineRouteRow(request, featuredCruiseId);
  } catch (error) {
    const message = String(error.message || error);
    if (/does not exist|PGRST205|schema cache/i.test(message)) {
      return reportFromRoute({
        ok: false,
        featuredCruiseId,
        itinerarySignature: generated.itinerary_signature,
        reusedExisting: false,
        routeObject: generated.routeObject,
        warnings: generated.warnings,
        errors: [
          {
            code: "schema_missing",
            message:
              "featured_cruise_marine_routes is missing. Apply supabase/migrations/20260729_featured_cruise_marine_routes.sql (after 13D)."
          }
        ],
        runtimeMs: Date.now() - started
      });
    }
    throw error;
  }

  if (
    existing &&
    existing.itinerary_signature === generated.itinerary_signature &&
    existing.route_data &&
    !opts.force
  ) {
    return reportFromRoute({
      ok: true,
      featuredCruiseId,
      itinerarySignature: generated.itinerary_signature,
      reusedExisting: true,
      routeObject: existing.route_data,
      warnings: existing.warnings || generated.warnings,
      errors: [],
      runtimeMs: Date.now() - started
    });
  }

  await saveMarineRouteRow(request, {
    featuredCruiseId,
    routeObject: generated.routeObject,
    status: "current"
  });

  return reportFromRoute({
    ok: true,
    featuredCruiseId,
    itinerarySignature: generated.itinerary_signature,
    reusedExisting: false,
    routeObject: generated.routeObject,
    warnings: generated.warnings,
    errors: [],
    runtimeMs: Date.now() - started
  });
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.fixtureMed && !opts.featuredCruiseId) {
    process.stderr.write(
      "Usage: npm run generate:marine-route -- <featured_cruise_id> [--force]\n" +
        "   or: npm run generate:marine-route -- --fixture-med\n"
    );
    process.exitCode = 1;
    return;
  }

  const report = opts.fixtureMed
    ? await runFixture(opts)
    : await runCruise(opts.featuredCruiseId, opts);

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, errors: [{ message: String(error.message || error) }] }, null, 2)}\n`);
  process.exitCode = 1;
});
