#!/usr/bin/env node
/**
 * Silversea Phase 4C — port remediation analysis and eligibility recheck.
 *
 *   node scripts/run-silversea-phase4c-port-remediation.mjs
 *   node scripts/run-silversea-phase4c-port-remediation.mjs --after-apply --write-frozen
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { execSync } from "child_process";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
  require("dotenv").config({ path: path.join(root, ".env.local") });
} catch {
  /* optional */
}

const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const batch = require(path.join(root, "netlify/functions/lib/silversea-controlled-batch"));
const {
  groupUnresolvedPortOccurrences,
  classifyUnresolvedPortIdentity
} = require(path.join(root, "netlify/functions/lib/silversea-port-remediation"));
const {
  PHASE4C_CANONICAL_PORT_CREATES,
  PHASE4C_EXISTING_PORT_ALIASES,
  PHASE4C_SILVERSEA_ADAPTER_ALIASES
} = require(path.join(root, "netlify/functions/lib/silversea-phase4c-port-batch"));
const { loadPortsCatalogue } = require(path.join(root, "netlify/functions/lib/discovery-departure-port"));
const { loadClassificationDestinations } = require(path.join(
  root,
  "netlify/functions/lib/destination-queries"
));
const { perthCalendarDate } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const REPORT_DIR = path.join(root, "reports");
const FIXTURE_DIR = path.join(root, "scripts/fixtures/silversea");
const AFTER_APPLY = process.argv.includes("--after-apply");
const WRITE_FROZEN = process.argv.includes("--write-frozen");

function gitSha() {
  return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
}

function collectUnresolved(classicRows, today, existingByOfficialId) {
  const occurrences = [];
  for (const row of classicRows) {
    const bucket = batch.classifyExclusiveBucket(row, today, existingByOfficialId);
    if (
      !["classic_embark_unresolved", "classic_disembark_unresolved", "classic_itinerary_port_unresolved"].includes(
        bucket
      )
    ) {
      continue;
    }
    const base = {
      official_sailing_id: row.official_sailing_id,
      official_url: row.raw?.official_url || null,
      destination: row.raw?.destination_name || null
    };
    if (row.departure_port_resolution?.status !== "resolved") {
      occurrences.push({
        ...base,
        role: "embark",
        name: row.raw?.departure_port,
        code: row.raw?.departure_port_code
      });
    }
    if (row.arrival_port_resolution?.status !== "resolved") {
      occurrences.push({
        ...base,
        role: "disembark",
        name: row.raw?.arrival_port,
        code: row.raw?.arrival_port_code
      });
    }
    for (const stop of row.itinerary || []) {
      if (stop.kind !== "port" || stop.port_resolution?.status === "resolved") continue;
      occurrences.push({
        ...base,
        role: "itinerary",
        name: stop.port_name,
        code: stop.port_code
      });
    }
  }
  return groupUnresolvedPortOccurrences(
    occurrences.map((row) => ({
      source_name: row.name,
      source_code: row.code,
      role: row.role,
      official_sailing_id: row.official_sailing_id,
      official_url: row.official_url,
      destination: row.destination
    }))
  );
}

function portOccurrenceStats(classicRows, today, existingByOfficialId) {
  const bySailing = new Map();
  for (const row of classicRows) {
    const bucket = batch.classifyExclusiveBucket(row, today, existingByOfficialId);
    if (bucket !== "classic_itinerary_port_unresolved") continue;
    let count = 0;
    for (const stop of row.itinerary || []) {
      if (stop.kind === "port" && stop.port_resolution?.status !== "resolved") count += 1;
    }
    if (row.departure_port_resolution?.status !== "resolved") count += 1;
    if (row.arrival_port_resolution?.status !== "resolved") count += 1;
    bySailing.set(row.official_sailing_id, count);
  }
  const counts = [...bySailing.values()].sort((a, b) => a - b);
  const total = counts.reduce((s, n) => s + n, 0);
  const median =
    counts.length === 0
      ? 0
      : counts.length % 2 === 1
        ? counts[Math.floor(counts.length / 2)]
        : (counts[counts.length / 2 - 1] + counts[counts.length / 2]) / 2;
  return {
    affected_sailings: bySailing.size,
    total_unresolved_occurrences: total,
    average_per_affected_sailing: bySailing.size ? total / bySailing.size : 0,
    median_per_affected_sailing: median,
    max_on_one_sailing: counts.length ? Math.max(...counts) : 0
  };
}

function summariseEligibility(classicRows, today, existingByOfficialId) {
  const funnel = batch.buildExclusiveClassificationFunnel(classicRows, { today, existingByOfficialId });
  const newEligible = classicRows
    .filter((row) => batch.classifyExclusiveBucket(row, today, existingByOfficialId) === "classic_production_eligible")
    .sort((a, b) => batch.candidateSortKey(a).localeCompare(batch.candidateSortKey(b)));
  return {
    funnel: funnel.counts,
    itinerary_port_unresolved: funnel.counts.classic_itinerary_port_unresolved,
    embark_unresolved: funnel.counts.classic_embark_unresolved,
    disembark_unresolved: funnel.counts.classic_disembark_unresolved,
    destination_unresolved: funnel.counts.classic_destination_unresolved,
    fully_eligible: funnel.counts.classic_production_eligible,
    recognised_existing: funnel.counts.recognised_existing_official_id,
    new_eligible_ids: newEligible.map((row) => row.official_sailing_id)
  };
}

function hasUnresolvedPort(row) {
  if (row.departure_port_resolution?.status !== "resolved") return true;
  if (row.arrival_port_resolution?.status !== "resolved") return true;
  return (row.itinerary || []).some((stop) => stop.kind === "port" && stop.port_resolution?.status !== "resolved");
}

function durationMismatchReview(classicRows) {
  const rows = classicRows.filter((row) => row.raw?.duration_matches_dates !== true);
  return rows.map((row) => ({
    official_sailing_id: row.official_sailing_id,
    ship: row.raw?.ship_name || null,
    departure: row.raw?.departure_date || row.candidate?.departure_date || null,
    arrival: row.raw?.arrival_date || null,
    source_duration: row.raw?.duration_nights ?? row.raw?.nights ?? null,
    calculated_nights: row.raw?.calculated_nights ?? null,
    port_blocked: hasUnresolvedPort(row) ? "YES" : "NO"
  }));
}

async function main() {
  const startedAt = new Date().toISOString();
  const today = perthCalendarDate();
  const rest = createSupabaseRest(root);
  const line = (
    await rest.get(`ci_cruise_lines?slug=eq.${adapter.LINE_SLUG}&select=id,name,slug&limit=1`)
  )?.[0];
  const destinations = adapter.catalogueDestinations(await loadClassificationDestinations(async (q) => rest.get(q)));
  const ships = await rest.get(
    `ci_cruise_ships?cruise_line_id=eq.${line.id}&select=id,name,cruise_line_id,official_line_ship_id`
  );
  const existingRows = await rest.get(
    `discovered_cruises?cruise_line_id=eq.${line.id}&select=id,status,official_sailing_id,official_url,source_url,departure_date,review_reason`
  );
  const existingByOfficialId = new Map(
    existingRows
      .filter((row) => row.official_sailing_id)
      .map((row) => [String(row.official_sailing_id).toUpperCase(), row])
  );

  const simulation = await adapter.simulateSilverseaInventory({
    cruiseLine: line,
    ships,
    destinations,
    existingRows,
    today,
    concurrency: 6
  });

  const classicRows = simulation.products.filter(
    (row) => String(row.raw?.cruise_type || "").trim().toLowerCase() === "classic"
  );
  const eligibility = summariseEligibility(classicRows, today, existingByOfficialId);
  const grouped = collectUnresolved(classicRows, today, existingByOfficialId);
  const occurrenceStats = portOccurrenceStats(classicRows, today, existingByOfficialId);
  const totalOccFromGrouped = grouped.reduce((sum, row) => sum + row.occurrences, 0);
  const ports = loadPortsCatalogue();
  const top75 = grouped.slice(0, 75).map((entry, index) => ({
    rank: index + 1,
    ...entry,
    embark_count: entry.roles.includes("embark") ? 1 : 0,
    disembark_count: entry.roles.includes("disembark") ? 1 : 0,
    classification: classifyUnresolvedPortIdentity(entry, ports)
  }));

  const durationRows = durationMismatchReview(classicRows);
  const durationOnly = durationRows.filter((row) => row.port_blocked === "NO").length;
  const durationAndPort = durationRows.filter((row) => row.port_blocked === "YES").length;

  const newEligibleCount = eligibility.new_eligible_ids.length;
  let recommendedBatch = 0;
  if (newEligibleCount >= 250) recommendedBatch = 250;
  else recommendedBatch = newEligibleCount;

  const report = {
    phase: AFTER_APPLY ? "after_apply" : "baseline",
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    git_sha: gitSha(),
    silversea_production: {
      total: existingRows.length,
      active: existingRows.filter((row) => row.status === "active").length,
      official_ids: existingRows.filter((row) => row.official_sailing_id && row.status === "active").length,
      legacy_hidden: existingRows.filter((row) => !row.official_sailing_id).length
    },
    port_metrics: {
      unique_unresolved_classic_port_identities: grouped.length,
      total_unresolved_classic_itinerary_occurrences: totalOccFromGrouped,
      classic_sailings_affected_by_unresolved_ports: occurrenceStats.affected_sailings,
      average_unresolved_occurrences_per_affected_sailing: occurrenceStats.average_per_affected_sailing,
      median_unresolved_occurrences_per_affected_sailing: occurrenceStats.median_per_affected_sailing,
      maximum_unresolved_occurrences_on_one_sailing: occurrenceStats.max_on_one_sailing,
      phase7_metric_explanation:
        "Phase 7 simulate summary itinerary_ports_unresolved counts TOTAL unresolved actual-port occurrences across all Silversea products (Classic+Expedition+deferred), not unique port identities."
    },
    simulate_summary: simulation.summary || null,
    eligibility,
    top75_unresolved_analysis: top75,
    proposed_phase4c: {
      new_canonical_ports: PHASE4C_CANONICAL_PORT_CREATES,
      existing_port_aliases: PHASE4C_EXISTING_PORT_ALIASES,
      silversea_adapter_mappings: PHASE4C_SILVERSEA_ADAPTER_ALIASES
    },
    duration_mismatch_review: {
      count: durationRows.length,
      duration_only_blocked: durationOnly,
      duration_and_port_blocked: durationAndPort,
      rows: durationRows
    },
    visjo_conclusion: {
      port_code: "VISJO",
      source_name: "St John",
      determination: "St John, U.S. Virgin Islands (Cruz Bay tender port)",
      evidence: [
        "VISJO port code uses VI (U.S. Virgin Islands) + SJO (St John)",
        "All 37 affected sailings are CARIBBEAN & CENTRAL AMERICA",
        "Itineraries cluster with St Thomas, Jost Van Dyke and BVI ports — not AGSJO Antigua or Newfoundland",
        "Distinct from St Johns Antigua (AGSJO) already canonical"
      ],
      action: "NEW_CANONICAL_PORT St John USVI + Silversea adapter alias st john -> St John USVI"
    },
    cruise_writes: { inserts: 0, updates: 0, deletes: 0 },
    weekly_maintenance: "NOT ENABLED",
    next_batch: {
      new_eligible_count: newEligibleCount,
      recommended_batch_size: recommendedBatch
    }
  };

  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = AFTER_APPLY ? "after" : "baseline";
  const reportPath = path.join(REPORT_DIR, `silversea-phase4c-${suffix}-${stamp}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  let frozenPath = null;
  if (WRITE_FROZEN && AFTER_APPLY && newEligibleCount > 0) {
    if (!fs.existsSync(FIXTURE_DIR)) fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    frozenPath = path.join(FIXTURE_DIR, "phase4c-frozen-eligible.json");
    fs.writeFileSync(
      frozenPath,
      `${JSON.stringify(
        {
          phase: "phase4c_frozen_eligible",
          generated_at: new Date().toISOString(),
          git_sha: gitSha(),
          expected_count: newEligibleCount,
          selection: { selected_official_sailing_ids: eligibility.new_eligible_ids }
        },
        null,
        2
      )}\n`
    );
    report.frozen_eligible_path = frozenPath;
  }

  report.report_path = reportPath;
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
