#!/usr/bin/env node
/**
 * Silversea Phase 4 — Classic port remediation analysis and eligibility recheck.
 *
 *   node scripts/run-silversea-phase4-port-remediation.mjs
 *   node scripts/run-silversea-phase4-port-remediation.mjs --after-apply
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
  APPROVED_CATALOGUE_ALIAS_WRITES,
  classifyUnresolvedPortIdentity,
  groupUnresolvedPortOccurrences
} = require(path.join(root, "netlify/functions/lib/silversea-port-remediation"));
const { loadClassificationDestinations } = require(path.join(
  root,
  "netlify/functions/lib/destination-queries"
));
const { perthCalendarDate } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { loadPortsCatalogue } = require(path.join(root, "netlify/functions/lib/discovery-departure-port"));

const REPORT_DIR = path.join(root, "reports");
const AFTER_APPLY = process.argv.includes("--after-apply");

function gitSha() {
  return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
}

function collectClassicUnresolvedOccurrences(classicRows, today, existingByOfficialId) {
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
      if (stop.kind !== "port") continue;
      if (stop.port_resolution?.status !== "resolved") {
        occurrences.push({
          ...base,
          role: "itinerary",
          name: stop.port_name,
          code: stop.port_code
        });
      }
    }
  }
  return occurrences;
}

function summariseEligibility(classicRows, today, existingByOfficialId) {
  const funnel = batch.buildExclusiveClassificationFunnel(classicRows, { today, existingByOfficialId });
  const beyondCutoff = classicRows.filter((row) => {
    const bucket = batch.classifyExclusiveBucket(row, today, existingByOfficialId);
    return !["departed", "within_21_day_cutoff", "invalid_identity"].includes(bucket);
  });
  const newEligible = beyondCutoff.filter(
    (row) => batch.classifyExclusiveBucket(row, today, existingByOfficialId) === "classic_production_eligible"
  );
  return {
    classic_total: classicRows.length,
    beyond_cutoff: beyondCutoff.length,
    funnel: funnel.counts,
    itinerary_port_unresolved: funnel.counts.classic_itinerary_port_unresolved,
    embark_unresolved: funnel.counts.classic_embark_unresolved,
    disembark_unresolved: funnel.counts.classic_disembark_unresolved,
    destination_unresolved: funnel.counts.classic_destination_unresolved,
    fully_eligible: funnel.counts.classic_production_eligible,
    recognised_existing: funnel.counts.recognised_existing_official_id,
    new_eligible_ids: newEligible.map((row) => row.official_sailing_id).sort()
  };
}

function classifyGroupedPorts(grouped, ports) {
  const buckets = {
    EXISTING_CANONICAL_ALIAS: [],
    EXISTING_ALIAS_ALREADY_PRESENT_BUT_RESOLVER_FAILURE: [],
    NEW_CANONICAL_PORT_REQUIRED: [],
    NON_PORT_ITINERARY_ENTRY: [],
    AMBIGUOUS: []
  };
  for (const row of grouped) {
    const classification = classifyUnresolvedPortIdentity(row, ports);
    buckets[classification].push({ ...row, classification });
  }
  return buckets;
}

async function loadContext() {
  const rest = createSupabaseRest(root);
  const line = (
    await rest.get(`ci_cruise_lines?slug=eq.${adapter.LINE_SLUG}&select=id,name,slug&limit=1`)
  )?.[0];
  if (!line) throw new Error(`Cruise line not found: ${adapter.LINE_SLUG}`);

  const destinations = adapter.catalogueDestinations(await loadClassificationDestinations(async (q) => rest.get(q)));
  const ships = await rest.get(
    `ci_cruise_ships?cruise_line_id=eq.${line.id}&select=id,name,cruise_line_id,official_line_ship_id`
  );
  const existingRows = await rest.get(
    `discovered_cruises?cruise_line_id=eq.${line.id}&select=id,status,official_sailing_id,official_url,source_url,departure_date,review_reason`
  );
  return { line, destinations, ships, existingRows };
}

async function main() {
  const startedAt = new Date().toISOString();
  const today = perthCalendarDate();
  const { line, destinations, ships, existingRows } = await loadContext();
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
  const occurrences = collectClassicUnresolvedOccurrences(classicRows, today, existingByOfficialId);
  const grouped = groupUnresolvedPortOccurrences(
    occurrences.map((row) => ({
      source_name: row.name,
      source_code: row.code,
      role: row.role,
      official_sailing_id: row.official_sailing_id,
      official_url: row.official_url,
      destination: row.destination
    }))
  );
  const ports = loadPortsCatalogue();
  const classified = classifyGroupedPorts(grouped, ports);

  const newEligibleCount = eligibility.new_eligible_ids.length;
  let recommendedBatch = 0;
  if (newEligibleCount >= 250) recommendedBatch = 250;
  else if (newEligibleCount >= 100) recommendedBatch = newEligibleCount;
  else recommendedBatch = newEligibleCount;

  const report = {
    phase: AFTER_APPLY ? "after_apply" : "baseline_or_current",
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    git_sha: gitSha(),
    silversea_production: {
      total: existingRows.length,
      active: existingRows.filter((row) => row.status === "active").length,
      official_ids: existingRows.filter((row) => row.official_sailing_id && row.status === "active").length,
      legacy_hidden: existingRows.filter((row) => !row.official_sailing_id).length
    },
    eligibility,
    unique_unresolved_identities: grouped.length,
    grouped_unresolved_ports: grouped.slice(0, 100),
    classification_summary: Object.fromEntries(
      Object.entries(classified).map(([key, rows]) => [key, rows.length])
    ),
    alias_candidates: classified.EXISTING_CANONICAL_ALIAS,
    resolver_failures: classified.EXISTING_ALIAS_ALREADY_PRESENT_BUT_RESOLVER_FAILURE,
    new_canonical_required: classified.NEW_CANONICAL_PORT_REQUIRED.slice(0, 50),
    non_port_entries: classified.NON_PORT_ITINERARY_ENTRY,
    ambiguous_mappings: classified.AMBIGUOUS.slice(0, 50),
    proposed_alias_writes: APPROVED_CATALOGUE_ALIAS_WRITES,
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
  const reportPath = path.join(REPORT_DIR, `silversea-phase4-${suffix}-${stamp}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ report_path: reportPath, ...report }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
