#!/usr/bin/env node
/**
 * Princess eligibility reconciliation + trade-code audits.
 *   node scripts/audit-princess-discovery-readiness.mjs
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { fetchAllPrincessRawSailings } = require(path.join(root, "netlify/functions/lib/princess-discovery-source"));
const {
  simulatePrincessInventory,
  catalogueDestinations
} = require(path.join(root, "netlify/functions/lib/princess-discovery-adapter"));
const {
  partitionByPublicBookingCutoff,
  perthCalendarDate,
  isCruisePubliclyBookable
} = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const { buildPrincessBatchManifest } = require(path.join(root, "netlify/functions/lib/princess-discovery-writes"));
const { createMaintenanceSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { runPrincessWeeklyMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-runner"
));

function bucketReasons(product) {
  const reasons = new Set(product.failure_reasons || []);
  const buckets = [];

  if (product.product_type === "cruisetour") buckets.push("cruisetour_excluded");
  if (!product.raw?.departure_date) buckets.push("invalid_date");
  if (product.within_public_cutoff) buckets.push("within_21_day_cutoff");
  if (!product.ship_resolution?.resolved) buckets.push("ship_unresolved");
  else if (product.ship_resolution?.method !== "official_line_ship_id") buckets.push("ship_not_official_code");
  if (product.departure_port_resolution?.status !== "resolved") buckets.push("departure_port_unresolved");
  if (product.destination_resolution?.status === "unresolved") buckets.push("destination_unresolved");
  if (product.destination_resolution?.status === "ambiguous") buckets.push("destination_ambiguous");
  if (!product.individual_gate?.proven) buckets.push("individual_sailing_gate");
  if (reasons.has("missing_official_identity")) buckets.push("identity_invalid");
  if ([...reasons].some((r) => r.startsWith("validation:"))) buckets.push("validation_gate");
  if ([...reasons].some((r) => r.startsWith("confidence:"))) buckets.push("low_confidence");
  if (product.complete_high_confidence) buckets.push("complete_high_confidence");

  return buckets.length ? buckets : ["other"];
}

function auditTradeCodeZ(rawGroups, expandedProducts) {
  const zProducts = expandedProducts.filter((p) => (p.trade_ids || []).includes("Z"));
  const byItinerary = new Map();
  for (const p of zProducts) {
    const id = p.itinerary_id;
    if (!byItinerary.has(id)) {
      byItinerary.set(id, {
        itinerary_id: id,
        sailings: 0,
        ships: new Set(),
        dep_ports: new Set(),
        arr_ports: new Set(),
        sample_ports: []
      });
    }
    const row = byItinerary.get(id);
    row.sailings += 1;
    row.ships.add(p.ship_code);
    row.dep_ports.add(p.departure_port_code || p.departure_port);
    row.arr_ports.add(p.arrival_port_code || p.arrival_port);
    if (row.sample_ports.length < 6) {
      row.sample_ports.push({
        departure_date: p.departure_date,
        dep: p.departure_port,
        arr: p.arrival_port,
        ship: p.ship_code
      });
    }
  }

  const patterns = [...byItinerary.values()].map((r) => ({
    itinerary_id: r.itinerary_id,
    sailings: r.sailings,
    ships: [...r.ships].sort(),
    departure_ports: [...r.dep_ports].sort(),
    arrival_ports: [...r.arr_ports].sort(),
    sample: r.sample_ports
  }));

  const auNzHints = /australia|new zealand|sydney|melbourne|brisbane|auckland|wellington|perth|fremantle|tasmania|queensland|south pacific/i;
  const asiaHints = /singapore|hong kong|tokyo|yokohama|shanghai|beijing|vietnam|thailand|japan|china|korea|taiwan|indonesia|malaysia|philippines/i;

  let auNzCount = 0;
  let asiaCount = 0;
  let mixedCount = 0;
  for (const p of zProducts) {
    const blob = [p.departure_port, p.arrival_port, ...(p.trade_ids || [])].join(" ");
    const au = auNzHints.test(blob);
    const asia = asiaHints.test(blob);
    if (au && !asia) auNzCount += 1;
    else if (asia && !au) asiaCount += 1;
    else if (au && asia) mixedCount += 1;
  }

  return {
    source_groups_with_Z: rawGroups.filter((g) => (g.trades || []).some((t) => t.id === "Z")).length,
    expanded_sailings_with_Z: zProducts.length,
    distinct_itinerary_ids: patterns.length,
    itinerary_patterns: patterns.sort((a, b) => b.sailings - a.sailings),
    region_classification: {
      australia_new_zealand_only: auNzCount,
      asia_only: asiaCount,
      mixed_or_unclear: mixedCount + (zProducts.length - auNzCount - asiaCount - mixedCount)
    },
    mapping_recommendation:
      asiaCount === 0 && mixedCount === 0
        ? "retain australia-new-zealand for trade code Z"
        : "split mapping required — do not use blanket Z mapping"
  };
}

async function main() {
  const sb = createSupabaseRest(root);
  const maintenanceSb = createMaintenanceSupabase(root);
  const today = perthCalendarDate();

  const line = (await sb.get("ci_cruise_lines?slug=eq.princess-cruises&select=id,name,slug&limit=1"))[0];
  const ships = await sb.get(
    `ci_cruise_ships?cruise_line_id=eq.${line.id}&active=eq.true&select=id,name,official_line_ship_id,cruise_line_id`
  );
  const destRows = await sb.get(
    "destinations?classification_enabled=eq.true&select=id,name,slug,status,classification_enabled"
  );
  const destinations = catalogueDestinations(destRows || []);

  const fetch = await fetchAllPrincessRawSailings({ today, futureOnly: true });
  const sim = await simulatePrincessInventory({ cruiseLine: line, ships, destinations, today });
  const products = sim.products || [];

  const ocean = products.filter((p) => p.product_type === "cruise");
  const cruisetours = products.filter((p) => p.product_type === "cruisetour");
  const { publiclyEligible, withinCutoff } = partitionByPublicBookingCutoff(
    ocean.map((p) => ({ ...p, within_public_cutoff: false })),
    (p) => p.candidate?.departure_date || p.raw?.departure_date,
    today
  );
  const withinCutoffOcean = withinCutoff.length;
  const publicOcean = ocean.filter((p) =>
    isCruisePubliclyBookable({
      departureDate: p.candidate?.departure_date || p.raw?.departure_date,
      status: "active",
      perthToday: today
    })
  );

  const completeAll = ocean.filter((p) => p.complete_high_confidence);
  const completePublic = publicOcean.filter((p) => p.complete_high_confidence);

  const exclusionCounts = {};
  for (const p of publicOcean) {
    if (p.complete_high_confidence) {
      exclusionCounts.complete_high_confidence = (exclusionCounts.complete_high_confidence || 0) + 1;
      continue;
    }
    for (const bucket of bucketReasons(p)) {
      if (bucket === "complete_high_confidence") continue;
      exclusionCounts[bucket] = (exclusionCounts[bucket] || 0) + 1;
    }
  }

  const tradeZ = auditTradeCodeZ(fetch.raw_groups || [], fetch.products || []);
  const trade0 = (fetch.products || []).filter((p) => (p.trade_ids || []).includes("0"));

  const dryRun = await runPrincessWeeklyMaintenance({
    dryRun: true,
    supabase: maintenanceSb,
    triggerType: "production_dry_run",
    maxWrites: 0
  });

  const manifest = dryRun.manifest || (await buildPrincessBatchManifest({
    products: completePublic,
    cruiseLine: line,
    destinations,
    supabase: maintenanceSb,
    runId: "audit-dry-run"
  }));

  const proposedInserts = (manifest.products || []).filter((p) => p.proposed_action === "insert_active");
  const proposedUpdates = (manifest.products || []).filter((p) => p.proposed_action === "update_exact_legacy_match");
  const unchanged = (manifest.products || []).filter((p) => p.proposed_action === "duplicate_skip");

  const reconciliation = {
    expanded_dated_sailings: fetch.products?.length || 0,
    genuine_ocean: ocean.length,
    cruisetours_excluded: cruisetours.length,
    within_21_day_cutoff: withinCutoffOcean,
    publicly_eligible_ocean: publicOcean.length,
    complete_high_confidence_all: completeAll.length,
    complete_high_confidence_public: completePublic.length,
    gap_public_to_complete: publicOcean.length - completePublic.length,
    exclusion_reason_counts_among_incomplete_public: exclusionCounts,
    exclusion_sum: Object.values(exclusionCounts).reduce((a, b) => a + b, 0)
  };

  console.log(
    JSON.stringify(
      {
        today,
        trade_code_Z_audit: tradeZ,
        trade_code_0: {
          count: trade0.length,
          sailings: trade0.map((p) => ({
            itinerary_id: p.itinerary_id,
            departure_date: p.departure_date,
            dep: p.departure_port,
            arr: p.arrival_port
          })),
          treatment: "excluded_unresolved"
        },
        eligibility_reconciliation: reconciliation,
        dry_run_summary: dryRun.summary || null,
        quality_gate: dryRun.summary?.quality_gate || null,
        proposed_inserts: proposedInserts.length,
        proposed_updates: proposedUpdates.length,
        unchanged: unchanged.length,
        ship_resolution_official_code: publicOcean.filter(
          (p) => p.ship_resolution?.method === "official_line_ship_id"
        ).length
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
