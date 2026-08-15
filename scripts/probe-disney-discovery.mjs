#!/usr/bin/env node
/**
 * Read-only Disney Cruise Line official source probe (Phase 1).
 *
 *   node scripts/probe-disney-discovery.mjs
 *
 * Enumerates the Product Availability VAS catalogue and writes
 * reports/disney-phase1-source-discovery.json. Never writes to Supabase.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { execSync } from "child_process";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const source = require(path.join(root, "netlify/functions/lib/disney-discovery-source"));
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const OUTPUT = path.join(root, "reports/disney-phase1-source-discovery.json");
const DISNEY_LINE_ID = "8f7aadcb-7843-4060-b0cb-a60631936b3a";
const OFFICIAL_FLEET = [
  "Disney Adventure",
  "Disney Believe",
  "Disney Destiny",
  "Disney Dream",
  "Disney Fantasy",
  "Disney Magic",
  "Disney Treasure",
  "Disney Wish",
  "Disney Wonder"
];

function gitSha() {
  try {
    return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function loadDisneyDatabaseContext() {
  const sb = createSupabaseRest(root);
  const lines = await sb.get(
    `ci_cruise_lines?id=eq.${encodeURIComponent(DISNEY_LINE_ID)}&select=id,name,slug,active,sold_by_101cruise,website_url,cruise_search_url,fleet_page_url&limit=1`
  );
  const line = lines?.[0] || null;
  const ships = line
    ? await sb.fetchAll(
        `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&select=id,name,official_line_ship_id,active,ship_class&order=name.asc`
      )
    : [];

  const configuredNames = new Set((ships || []).map((s) => String(s.name || "").trim()));
  const officialFleetComparison = OFFICIAL_FLEET.map((name) => ({
    official_fleet_name: name,
    configured_in_db: configuredNames.has(name),
    note:
      name === "Disney Believe"
        ? "Fleet-page ship; zero published sailings in source probe is not a source failure"
        : null
  }));

  return {
    disney_line: line,
    configured_ships: (ships || []).map((s) => ({
      id: s.id,
      name: s.name,
      official_line_ship_id: s.official_line_ship_id,
      active: s.active,
      ship_class: s.ship_class || null
    })),
    official_fleet_comparison: officialFleetComparison,
    missing_official_fleet_ships: officialFleetComparison.filter((row) => !row.configured_in_db).map((r) => r.official_fleet_name),
    missing_source_ships: []
  };
}

function buildShipCoverage(sourceShipCounts = {}, dbShips = []) {
  const dbByName = new Map((dbShips || []).map((s) => [String(s.name || "").toLowerCase(), s]));
  return Object.entries(sourceShipCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([shipName, sailingCount]) => {
      const db = dbByName.get(shipName.toLowerCase()) || null;
      return {
        ship: shipName,
        raw_official_ship_code: null,
        future_source_sailings: sailingCount,
        database_ship_match: db?.name || null,
        database_ship_id: db?.id || null,
        status: db ? "matched" : "unknown_in_db"
      };
    });
}

function rawFieldInventory(samples = []) {
  const sample = samples[0] || {};
  return {
    official_sailing_id: sample.sailing_id || null,
    itinerary_id: sample.itinerary_id ?? null,
    ship_id_code: sample.ship_code || null,
    ship_name: sample.ship_name || null,
    departure_date: sample.departure_date || null,
    return_date: sample.return_date || null,
    number_of_nights: sample.nights ?? null,
    departure_port: null,
    arrival_final_port: null,
    itinerary_title: sample.product_name || null,
    destination_region: sample.destination_code || null,
    ports_of_call: null,
    sea_days: null,
    itinerary_sequence: null,
    booking_detail_url: null,
    currency: "AUD (request body)",
    price: null,
    specialty_cruise_theme: null,
    availability_status: {
      has_availability: sample.has_availability,
      blocked_from_booking: sample.blocked_from_booking,
      is_early_booking: sample.is_early_booking
    },
    representative_samples: samples.slice(0, 3).map((s) => ({
      official_product_key: s.official_product_key,
      sailing_id: s.sailing_id,
      departure_date: s.departure_date,
      ship_name: s.ship_name,
      ship_code: s.ship_code,
      product_id: s.product_id,
      package_code: s.package_code,
      destination_code: s.destination_code
    }))
  };
}

function buildQualityAssessment(probe, dbContext) {
  const inventory = probe.inventory || {};
  const accounting = probe.source_accounting || {};
  const reconciles = accounting.reconciles_with_monthly_advertised_sum === true;
  const enumerationGap = (probe.monthly_advertised_sum || 0) - (accounting.unique_individual_sailings || 0);

  return {
    official_source_total_gt_zero: (accounting.unique_individual_sailings || 0) > 0,
    pagination_exhausted_with_facets: (accounting.product_harvest_repeated_pages || 0) > 0,
    source_accounting_reconciles: reconciles,
    enumeration_gap_vs_monthly_sum: enumerationGap,
    duplicate_official_identities: accounting.duplicate_official_identities,
    identity_coverage_pct: accounting.identity_coverage_pct,
    ship_resolution_ready: Object.keys(inventory.ship_counts || {}).length >= 1,
    phase1_complete: reconciles && accounting.duplicate_official_identities === 0,
    recommended_future_gates: {
      official_source_total_gt_zero: true,
      pagination_exhausted: true,
      source_accounting_reconciles: true,
      no_repeated_pages_without_progress: true,
      no_zero_progress_pages: true,
      malformed_rate_max_pct: 1,
      stable_identity_coverage_pct: 100,
      duplicate_official_identities: 0,
      ship_resolution_min_pct: 98,
      departure_port_resolution_min_pct: 95,
      destination_resolution_min_pct: 90,
      catastrophic_inventory_collapse_guard: true,
      source_failure_zero_writes: true,
      incomplete_pagination_zero_writes: true,
      excessive_source_absence_zero_auto_deactivations: true
    },
    source_absence_policy_sketch: {
      never_hard_delete_on_single_failed_request: true,
      deactivate_only_after_complete_high_confidence_snapshot: true,
      distinguish: [
        "expired_by_date_or_public_cutoff",
        "source_absent_after_complete_snapshot",
        "source_temporarily_unreachable",
        "incomplete_pagination",
        "malformed_snapshot",
        "sold_out_if_authoritative",
        "cancelled_if_authoritative"
      ],
      recommend_consecutive_absence_observations: 2
    },
    architecture_reference: {
      enumeration: "Seabourn-like faceted union + pagination guards",
      template_expansion: "Royal/Celebrity-like product template -> dated sailings",
      identity: "Norwegian-like deterministic code|date key",
      weekly_reconciliation: "Seabourn-like source absence + bounded writes (future phase)"
    },
    db_prerequisites: {
      missing_official_fleet_ships: dbContext.missing_official_fleet_ships,
      ships_missing_official_line_ship_id: (dbContext.configured_ships || []).filter((s) => !s.official_line_ship_id).length
    }
  };
}

async function main() {
  const repositoryStartSha = gitSha();
  const startedAt = new Date().toISOString();

  const dbContext = await loadDisneyDatabaseContext();
  const probe = await source.probeDisneyInventory({ requestDelayMs: 100 });

  const shipCoverage = buildShipCoverage(probe.inventory?.ship_counts || {}, dbContext.configured_ships);
  const sourceShipNames = new Set(Object.keys(probe.inventory?.ship_counts || {}));
  const dbShipNames = new Set((dbContext.configured_ships || []).map((s) => s.name));
  dbContext.missing_source_ships = [...dbShipNames].filter((name) => !sourceShipNames.has(name));

  for (const row of shipCoverage) {
    const sample = probe.sailings.find((s) => s.ship_name === row.ship);
    row.raw_official_ship_code = sample?.ship_code || null;
  }

  const report = {
    phase: 1,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    repository_start_sha: repositoryStartSha,
    repository_end_sha: gitSha(),
    production_writes: 0,
    database_mutations: 0,
    disney_line: dbContext.disney_line,
    configured_ships: dbContext.configured_ships,
    official_fleet_comparison: dbContext.official_fleet_comparison,
    source: {
      official: true,
      hostname: source.SOURCE_CONTRACT.hostname,
      endpoint_type: source.SOURCE_CONTRACT.endpoint_type,
      endpoint_description: "Disney Product Availability VAS (PAVAS) powering Find a Cruise SPA",
      method: source.SOURCE_CONTRACT.method,
      pagination_type: source.SOURCE_CONTRACT.pagination,
      authentication_required: true,
      browser_session_required: false,
      filter_parameter_format: source.SOURCE_CONTRACT.filter_parameter_format
    },
    inventory: {
      raw_source_total: probe.source_accounting.raw_sailing_rows,
      unique_sailing_total: probe.source_accounting.unique_individual_sailings,
      future_total: probe.inventory.future_total,
      within_21_day_cutoff: probe.inventory.within_21_day_cutoff,
      publicly_eligible_total: probe.inventory.publicly_eligible_total,
      earliest_departure: probe.inventory.earliest_departure,
      latest_departure: probe.inventory.latest_departure,
      ship_counts: probe.inventory.ship_counts,
      product_templates: probe.harvest.unique_product_templates
    },
    identity: probe.identity,
    source_accounting: probe.source_accounting,
    date_facet_advertised_totals: probe.date_facet_advertised_totals,
    monthly_advertised_sum: probe.monthly_advertised_sum,
    raw_field_inventory: rawFieldInventory(probe.sailings),
    ship_coverage: shipCoverage,
    quality_assessment: buildQualityAssessment(probe, dbContext),
    prerequisites: [
      "Populate official_line_ship_id on ci_cruise_ships using seawareId codes (DA, DD, DF, DM, DW, WT, WD, WW)",
      "Confirm complete enumeration strategy before any production writes (current monthly-sum reconciliation gap)"
    ],
    blockers: [],
    recommendation_for_phase2: null
  };

  if (!report.quality_assessment.phase1_complete) {
    report.blockers.push({
      code: "enumeration_not_reconciled",
      detail: `Unique sailings (${report.inventory.unique_sailing_total}) do not reconcile to monthly advertised sum (${report.monthly_advertised_sum}). Resolve faceted harvest completeness before enabling writes.`
    });
    report.recommendation_for_phase2 =
      "Continue Phase 2 in read-only/dry-run mode only: refine faceted product harvest (date×night, date×ship using filterValue), prove reconciliation to monthly advertised sum with zero identity collisions, then add adapter/writes behind existing shared quality gates.";
  } else {
    report.recommendation_for_phase2 =
      "Proceed to Phase 2 adapter mapping (ships, ports, destinations) and dry-run reconciliation against discovered_cruises using shared maintenance runner patterns.";
  }

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote ${OUTPUT}`);
  console.log(
    JSON.stringify(
      {
        unique_sailings: report.inventory.unique_sailing_total,
        monthly_advertised_sum: report.monthly_advertised_sum,
        identity_collisions: report.identity.collisions,
        production_writes: report.production_writes
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
