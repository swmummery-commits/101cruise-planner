#!/usr/bin/env node
/**
 * Silversea Expedition Phase E2 — read-only semantic + eligibility simulation.
 *
 *   node scripts/run-silversea-expedition-e2-simulation.mjs
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

const REPORT_DIR = path.join(root, "reports");

const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const batch = require(path.join(root, "netlify/functions/lib/silversea-controlled-batch"));
const {
  EXPEDITION_SEMANTIC,
  SEMANTIC,
  SEMANTIC_CONFIDENCE,
  classifyExpeditionStop,
  portIdentityKey
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-semantics"));
const {
  EXPEDITION_EXCLUSIVE_BUCKETS,
  classifyExpeditionExclusiveBucket,
  evaluateExpeditionEligibility,
  evaluateHypotheticalExpeditionEligibility,
  isArcticGreenlandDestination,
  isArcticGreenlandAnalyticalGroup,
  isGalapagosGroup,
  isAntarcticaGroup,
  isKimberleyGroup,
  isPacificGroup,
  isComboSegmentProduct
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-eligibility"));
const { resolveRawPortText } = require(path.join(root, "netlify/functions/lib/discovery-departure-port"));
const { loadClassificationDestinations } = require(path.join(
  root,
  "netlify/functions/lib/destination-queries"
));
const { perthCalendarDate } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

function gitSha() {
  return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
}

function countSemanticFromInventory(inventory) {
  const counts = {};
  for (const row of inventory) {
    const key = row.semantic || row.expedition_semantic || "ambiguous";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function collectOccurrences(expRows) {
  const occurrences = [];
  for (const row of expRows) {
    const base = {
      official_sailing_id: row.official_sailing_id,
      destination: row.raw?.destination_name || null
    };
    if (row.departure_port_resolution?.status !== "resolved") {
      occurrences.push({
        ...base,
        source_name: row.raw?.departure_port,
        source_code: row.raw?.departure_port_code,
        role: "embark"
      });
    }
    if (row.arrival_port_resolution?.status !== "resolved") {
      occurrences.push({
        ...base,
        source_name: row.raw?.arrival_port,
        source_code: row.raw?.arrival_port_code,
        role: "disembark"
      });
    }
    for (const stop of row.itinerary || []) {
      if (stop.kind !== "port" || stop.port_resolution?.status === "resolved") continue;
      occurrences.push({
        ...base,
        source_name: stop.port_name,
        source_code: stop.port_code,
        role: "itinerary",
        stop
      });
    }
  }
  return occurrences;
}

function groupIdentities(occurrences) {
  const byKey = new Map();
  for (const row of occurrences) {
    const key = portIdentityKey(row.source_name, row.source_code);
    if (!byKey.has(key)) {
      byKey.set(key, {
        source_name: row.source_name,
        source_code: row.source_code,
        destinations: new Set(),
        affected_sailing_ids: new Set(),
        occurrences: 0,
        example_cruise_codes: []
      });
    }
    const bucket = byKey.get(key);
    bucket.occurrences += 1;
    if (row.destination) bucket.destinations.add(row.destination);
    if (row.official_sailing_id) bucket.affected_sailing_ids.add(row.official_sailing_id);
    if (bucket.example_cruise_codes.length < 5 && row.official_sailing_id) {
      bucket.example_cruise_codes.push(row.official_sailing_id);
    }
  }
  return [...byKey.values()]
    .map((row) => ({
      ...row,
      destinations: [...row.destinations],
      affected_sailings: row.affected_sailing_ids.size,
      affected_sailing_ids: undefined
    }))
    .sort((a, b) => b.affected_sailings - a.affected_sailings || b.occurrences - a.occurrences);
}

function classifyE1Style(entry) {
  return classifyExpeditionStop({ port_name: entry.source_name, port_code: entry.source_code });
}

function regionalFunnel(rows, today) {
  const funnel = Object.fromEntries(EXPEDITION_EXCLUSIVE_BUCKETS.map((b) => [b, 0]));
  let currentComplete = 0;
  let hypotheticalComplete = 0;
  for (const row of rows) {
    const bucket = classifyExpeditionExclusiveBucket(row, today);
    funnel[bucket] = (funnel[bucket] || 0) + 1;
    if (bucket === "expedition_e2_complete") currentComplete += 1;
    if (evaluateHypotheticalExpeditionEligibility(row, today).eligible) hypotheticalComplete += 1;
  }
  return { funnel, currentComplete, hypotheticalComplete, count: rows.length };
}

function ambiguityThresholds(inventory) {
  const buckets = { gte20: [], between10_19: [], between5_9: [], between2_4: [], eq1: [] };
  for (const row of inventory) {
    const n = row.affected_sailings;
    if (n >= 20) buckets.gte20.push(row);
    else if (n >= 10) buckets.between10_19.push(row);
    else if (n >= 5) buckets.between5_9.push(row);
    else if (n >= 2) buckets.between2_4.push(row);
    else buckets.eq1.push(row);
  }
  return buckets;
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

  const production = {
    total: existingRows.length,
    active_official: existingRows.filter((r) => r.status === "active" && r.official_sailing_id).length,
    legacy_hidden: existingRows.filter((r) => !r.official_sailing_id).length,
    recognised_expedition: existingRows.filter(
      (r) => r.status === "active" && r.official_sailing_id && /^(E4|EV|OR|WI)/i.test(String(r.official_sailing_id))
    ).length
  };

  const simulation = await adapter.simulateSilverseaInventory({
    cruiseLine: line,
    ships,
    destinations,
    existingRows,
    today,
    concurrency: 6
  });

  const expRows = simulation.products.filter(
    (row) => String(row.raw?.cruise_type || "").trim().toLowerCase() === "expedition"
  );
  const beyondCutoff = expRows.filter(
    (row) => classifyExpeditionExclusiveBucket(row, today) !== "within_21_day_cutoff" &&
      classifyExpeditionExclusiveBucket(row, today) !== "invalid_identity"
  );
  const withinCutoff = expRows.length - beyondCutoff.filter(
    (row) => classifyExpeditionExclusiveBucket(row, today) === "within_21_day_cutoff"
  ).length;

  const comboSegment = expRows.filter((row) => isComboSegmentProduct(row.raw));
  const comboIds = new Set(comboSegment.map((r) => String(r.official_sailing_id).toUpperCase()));
  const duplicateComboCheck = comboIds.size === comboSegment.length;

  const occurrences = collectOccurrences(expRows);
  const identities = groupIdentities(occurrences);

  const e2Inventory = identities.map((entry) => {
    const sample = occurrences.find(
      (o) => portIdentityKey(o.source_name, o.source_code) === portIdentityKey(entry.source_name, entry.source_code)
    );
    const stop = sample?.stop;
    if (stop) {
      return {
        ...entry,
        expedition_semantic: stop.expedition_semantic,
        semantic_confidence: stop.semantic_confidence,
        ambiguity_reason: stop.ambiguity_reason,
        semantic_rule_id: stop.semantic_rule_id,
        semantic:
          stop.semantic_confidence === SEMANTIC_CONFIDENCE.AMBIGUOUS ? "ambiguous" : stop.expedition_semantic
      };
    }
    const classified = classifyExpeditionStop(
      { port_name: entry.source_name, port_code: entry.source_code },
      { role: sample?.role || "itinerary", destination: entry.destinations?.[0] }
    );
    return {
      ...entry,
      expedition_semantic: classified.expedition_semantic,
      semantic_confidence: classified.semantic_confidence,
      ambiguity_reason: classified.ambiguity_reason,
      semantic_rule_id: classified.semantic_rule_id,
      semantic:
        classified.semantic_confidence === SEMANTIC_CONFIDENCE.AMBIGUOUS ? "ambiguous" : classified.expedition_semantic
    };
  });

  const e1StyleInventory = identities.map((entry) => {
    const c = classifyE1Style(entry);
    return {
      ...entry,
      expedition_semantic: c.expedition_semantic,
      semantic_confidence: c.semantic_confidence,
      semantic: c.semantic
    };
  });

  const semanticBefore = countSemanticFromInventory(
    e1StyleInventory.map((r) => ({
      semantic:
        r.semantic_confidence === SEMANTIC_CONFIDENCE.AMBIGUOUS
          ? SEMANTIC.AMBIGUOUS
          : r.expedition_semantic
    }))
  );
  const semanticAfter = countSemanticFromInventory(
    e2Inventory.map((r) => ({
      semantic: r.semantic_confidence === SEMANTIC_CONFIDENCE.AMBIGUOUS ? "ambiguous" : r.expedition_semantic
    }))
  );

  const ambiguousBefore = e1StyleInventory.filter((r) => r.semantic_confidence === SEMANTIC_CONFIDENCE.AMBIGUOUS).length;
  const ambiguousAfter = e2Inventory.filter((r) => r.semantic_confidence === SEMANTIC_CONFIDENCE.AMBIGUOUS);
  const sailingsAffectedByAmbiguity = new Set();
  for (const row of ambiguousAfter) {
    for (const id of row.example_cruise_codes || []) sailingsAffectedByAmbiguity.add(id);
  }

  const exclusiveFunnel = Object.fromEntries(EXPEDITION_EXCLUSIVE_BUCKETS.map((b) => [b, 0]));
  const productReports = [];
  let currentComplete = 0;
  let hypotheticalComplete = 0;

  for (const row of expRows) {
    const evalResult = evaluateExpeditionEligibility(row, today);
    const hypResult = evaluateHypotheticalExpeditionEligibility(row, today);
    const bucket = classifyExpeditionExclusiveBucket(row, today);
    exclusiveFunnel[bucket] = (exclusiveFunnel[bucket] || 0) + 1;
    if (evalResult.eligible) currentComplete += 1;
    if (hypResult.eligible) hypotheticalComplete += 1;
    productReports.push(evalResult);
  }

  const beyondOnly = expRows.filter(
    (row) => classifyExpeditionExclusiveBucket(row, today) !== "within_21_day_cutoff"
  );
  const beyondFunnel = Object.fromEntries(EXPEDITION_EXCLUSIVE_BUCKETS.map((b) => [b, 0]));
  for (const row of beyondOnly) {
    beyondFunnel[classifyExpeditionExclusiveBucket(row, today)] += 1;
  }
  const beyondSum = Object.values(beyondFunnel).reduce((a, b) => a + b, 0);

  const galapagos = expRows.filter((r) => isGalapagosGroup(r.raw));
  const antarctica = expRows.filter((r) => isAntarcticaGroup(r.raw));
  const arcticDestLabel = expRows.filter((r) => isArcticGreenlandDestination(r.raw));
  const arcticAnalytical = expRows.filter((r) => isArcticGreenlandAnalyticalGroup(r.raw));
  const kimberley = expRows.filter((r) => isKimberleyGroup(r.raw));
  const pacific = expRows.filter((r) => isPacificGroup(r.raw));

  const durationMismatch = expRows.filter((r) => r.raw?.duration_matches_dates === false);

  const conventionalInventory = e2Inventory
    .filter((r) => r.expedition_semantic === EXPEDITION_SEMANTIC.CONVENTIONAL_PORT)
    .map((r) => ({
      source_name: r.source_name,
      source_code: r.source_code,
      semantic: r.expedition_semantic,
      affected_sailings: r.affected_sailings,
      canonical_search: resolveRawPortText(r.source_name || ""),
      endpoint_impact: false,
      future_e2b_action: resolveRawPortText(r.source_name || "").status === "resolved" ? null : "create_or_alias_port"
    }));

  const gatewayInventory = e2Inventory
    .filter((r) => r.expedition_semantic === EXPEDITION_SEMANTIC.EMBARK_DISEMBARK_LOGISTICS)
    .map((r) => ({
      source_name: r.source_name,
      source_code: r.source_code,
      affected_sailings: r.affected_sailings,
      canonical_search: resolveRawPortText(r.source_name || ""),
      future_e2b_action: "create_logistics_gateway_port"
    }));

  const destBlockers = {};
  for (const row of expRows.filter((r) => r.destination_resolution?.status !== "resolved")) {
    const d = row.raw?.destination_name || "unknown";
    destBlockers[d] = (destBlockers[d] || 0) + 1;
  }

  const classicSim = simulation.products.filter(
    (r) => String(r.raw?.cruise_type || "").toLowerCase() === "classic"
  );
  const classicEligible = classicSim.filter((r) =>
    batch.isFirstBatchEligible(r) || batch.classifyExclusiveBucket(r, today, existingByOfficialId) === "classic_production_eligible"
  ).length;

  const report = {
    phase: "expedition_e2",
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    git_sha: gitSha(),
    production,
    expedition_baseline: {
      total: expRows.length,
      within_21_day_cutoff: expRows.filter(
        (r) => classifyExpeditionExclusiveBucket(r, today) === "within_21_day_cutoff"
      ).length,
      beyond_21_day_cutoff: beyondOnly.length,
      combo_segment_count: comboSegment.length,
      combo_unique_ids: comboIds.size,
      combo_collision_free: duplicateComboCheck
    },
    semantic_counts_before_e2: semanticBefore,
    semantic_counts_after_e2: semanticAfter,
    e1_reference_semantic_counts: {
      CONVENTIONAL_PORT: 5,
      EMBARK_DISEMBARK_LOGISTICS: 2,
      EXPEDITION_LANDING_SITE: 143,
      ANCHORAGE_OR_ZODIAC_SITE: 3,
      SCENIC_OR_GEOGRAPHIC_REGION: 23,
      PASSAGE_OR_TRANSIT: 1,
      LAND_EXCURSION_OR_INLAND_SITE: 4,
      AMBIGUOUS: 135
    },
    identity_inventory_scope: "all_unresolved_port_occurrences_including_endpoints",
    ambiguous_identities_before: ambiguousBefore,
    ambiguous_identities_after: ambiguousAfter.length,
    sailings_affected_by_remaining_ambiguity: sailingsAffectedByAmbiguity.size,
    ambiguity_thresholds: ambiguityThresholds(ambiguousAfter),
    exclusive_funnel_all: exclusiveFunnel,
    exclusive_funnel_beyond_cutoff: beyondFunnel,
    exclusive_funnel_beyond_reconciliation: {
      expected: beyondOnly.length,
      actual_sum: beyondSum,
      balanced: beyondSum === beyondOnly.length
    },
    e2_currently_complete: currentComplete,
    e2_hypothetical_after_e2b_e2c: hypotheticalComplete,
    duration_mismatch: durationMismatch.map((r) => ({
      cruise_code: r.official_sailing_id,
      destination: r.raw?.destination_name,
      source_duration: r.raw?.source_duration,
      calculated_nights: r.raw?.calculated_nights
    })),
    regional: {
      galapagos: regionalFunnel(galapagos, today),
      antarctica: regionalFunnel(antarctica, today),
      arctic_greenland: {
        population_definition: {
          destination_label_arctic_and_greenland: arcticDestLabel.length,
          analytical_arctic_greenland_group: arcticAnalytical.length,
          difference_reason:
            "Analytical group includes voyages with Arctic/Greenland itinerary codes (NOE*, GL*) or destination text containing ARCTIC/GREENLAND beyond the exact ARCTIC & GREENLAND destination label."
        },
        destination_label: regionalFunnel(arcticDestLabel, today),
        analytical_group: regionalFunnel(arcticAnalytical, today)
      },
      kimberley: regionalFunnel(kimberley, today),
      pacific: regionalFunnel(pacific, today)
    },
    combo_segment: {
      count: comboSegment.length,
      unique_ids: comboIds.size,
      sample_ids: comboSegment.slice(0, 10).map((r) => r.official_sailing_id),
      independent_eligibility: comboSegment.map((r) => ({
        cruise_code: r.official_sailing_id,
        bucket: classifyExpeditionExclusiveBucket(r, today)
      }))
    },
    conventional_port_inventory: conventionalInventory,
    gateway_inventory: gatewayInventory,
    destination_blockers: Object.entries(destBlockers)
      .map(([destination_name, affected_sailings]) => ({ destination_name, affected_sailings }))
      .sort((a, b) => b.affected_sailings - a.affected_sailings),
    remaining_ambiguity_inventory: ambiguousAfter,
    products: productReports,
    classic_regression: {
      classic_total: classicSim.length,
      classic_production_eligible_count: classicEligible,
      classic_eligibility_rules_changed: false
    },
    cruise_writes: { inserts: 0, updates: 0, deletes: 0 },
    reference_writes: { canonical_ports: 0, port_aliases: 0, destinations: 0 },
    weekly_maintenance: "NOT ENABLED"
  };

  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(REPORT_DIR, `silversea-expedition-e2-${stamp}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        report_path: reportPath,
        expedition_total: expRows.length,
        beyond_cutoff: beyondOnly.length,
        exclusive_funnel_beyond: beyondFunnel,
    e2_currently_complete: currentComplete,
    e2_hypothetical_after_e2b_e2c: hypotheticalComplete,
        ambiguous_after: ambiguousAfter.length,
        galapagos: report.regional.galapagos,
        antarctica: report.regional.antarctica
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
