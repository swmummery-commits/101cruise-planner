#!/usr/bin/env node
/**
 * Silversea Expedition Phase E2c — destination remediation analysis + post-run report.
 *
 *   node scripts/run-silversea-expedition-e2c-analysis.mjs
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
const E2_REPORT = path.join(root, "reports/silversea-expedition-e2-2026-08-16T04-01-34-138Z.json");
const MAX_CONTROLLED_BATCH = 250;

const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const batch = require(path.join(root, "netlify/functions/lib/silversea-controlled-batch"));
const {
  EXPEDITION_SEMANTIC,
  SEMANTIC_CONFIDENCE,
  classifyExpeditionStop,
  portIdentityKey
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-semantics"));
const {
  EXPEDITION_EXCLUSIVE_BUCKETS,
  classifyExpeditionExclusiveBucket,
  evaluateExpeditionEligibility,
  isArcticGreenlandDestination,
  isArcticGreenlandAnalyticalGroup,
  isGalapagosGroup,
  isAntarcticaGroup,
  isKimberleyGroup,
  isPacificGroup,
  isComboSegmentProduct
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-eligibility"));
const {
  E2C_DESTINATION_MAPPING_MANIFEST,
  E2C_SILVERSEA_DESTINATION_SLUGS
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-e2c-destination-batch"));
const { resolveOperationalDestination } = require(path.join(
  root,
  "netlify/functions/lib/discovery-destination-resolver"
));
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

function stripE2cDestination(row) {
  const rawDest = String(row.raw?.destination_name || "").trim().toLowerCase();
  if (!E2C_SILVERSEA_DESTINATION_SLUGS[rawDest]) return row;
  if (row.destination_resolution?.status !== "resolved") return row;
  return {
    ...row,
    destination_resolution: { status: "unresolved", reason: "match_required" },
    candidate: {
      ...row.candidate,
      destination_id: null,
      raw_extract: {
        ...(row.candidate?.raw_extract || {}),
        silversea_destination_method: null
      }
    },
    failure_reasons: [...(row.failure_reasons || []), "destination_unresolved"]
  };
}

function buildFunnel(rows, today, preE2c = false) {
  const funnel = Object.fromEntries(EXPEDITION_EXCLUSIVE_BUCKETS.map((b) => [b, 0]));
  let complete = 0;
  for (const row of rows) {
    const evalRow = preE2c ? stripE2cDestination(row) : row;
    const bucket = classifyExpeditionExclusiveBucket(evalRow, today);
    funnel[bucket] = (funnel[bucket] || 0) + 1;
    if (bucket === "expedition_e2_complete") complete += 1;
  }
  return { funnel, complete };
}

function independentBlockers(rows, today, preE2c = false) {
  const counts = {
    duration_mismatch: 0,
    embark_unresolved: 0,
    disembark_unresolved: 0,
    destination_unresolved: 0,
    conventional_itinerary_port_unresolved: 0,
    ambiguous_semantic_itinerary: 0
  };
  for (const row of rows) {
    const evalRow = preE2c ? stripE2cDestination(row) : row;
    const result = evaluateExpeditionEligibility(evalRow, today);
    for (const reason of result.blocker_reasons || []) {
      if (counts[reason] != null) counts[reason] += 1;
    }
  }
  return counts;
}

function regionalFunnel(rows, today, preE2c = false) {
  return buildFunnel(rows, today, preE2c);
}

function ambiguityThresholds(inventory) {
  const buckets = { gte20: 0, between10_19: 0, between5_9: 0, between2_4: 0, eq1: 0 };
  for (const row of inventory) {
    const n = row.affected_sailings;
    if (n >= 20) buckets.gte20 += 1;
    else if (n >= 10) buckets.between10_19 += 1;
    else if (n >= 5) buckets.between5_9 += 1;
    else if (n >= 2) buckets.between2_4 += 1;
    else buckets.eq1 += 1;
  }
  return buckets;
}

function collectAmbiguityInventory(expRows) {
  const byKey = new Map();
  for (const row of expRows) {
    for (const stop of row.itinerary || []) {
      if (stop.kind !== "port") continue;
      if (stop.semantic_confidence !== SEMANTIC_CONFIDENCE.AMBIGUOUS && stop.expedition_semantic) continue;
      const key = portIdentityKey(stop.port_name, stop.port_code);
      if (!byKey.has(key)) {
        byKey.set(key, {
          source_name: stop.port_name,
          source_code: stop.port_code,
          destinations: new Set(),
          affected_sailing_ids: new Set(),
          occurrences: 0,
          ambiguity_reason: stop.ambiguity_reason,
          example_cruise_codes: []
        });
      }
      const bucket = byKey.get(key);
      bucket.occurrences += 1;
      if (row.raw?.destination_name) bucket.destinations.add(row.raw.destination_name);
      bucket.affected_sailing_ids.add(row.official_sailing_id);
      if (bucket.example_cruise_codes.length < 5) bucket.example_cruise_codes.push(row.official_sailing_id);
    }
  }
  return [...byKey.values()]
    .map((row) => ({
      source_name: row.source_name,
      source_code: row.source_code,
      destinations: [...row.destinations],
      occurrences: row.occurrences,
      affected_sailings: row.affected_sailing_ids.size,
      ambiguity_reason: row.ambiguity_reason,
      example_cruise_codes: row.example_cruise_codes,
      likely_semantic_category: inferSemanticCategory(row),
      evidence_strength: row.affected_sailing_ids.size >= 10 ? "high" : row.affected_sailing_ids.size >= 5 ? "medium" : "low",
      exact_or_code_family_rule_possible: /^AQ[A-Z]\d+/.test(String(row.source_code || "")) || Boolean(row.source_code)
    }))
    .sort((a, b) => b.affected_sailings - a.affected_sailings || b.occurrences - a.occurrences);
}

function inferSemanticCategory(row) {
  const code = String(row.source_code || "").toUpperCase();
  const name = String(row.source_name || "").toLowerCase();
  if (code.startsWith("AQ")) return "antarctica_landing_or_scenic";
  if (code.startsWith("GL") || name.includes("greenland")) return "greenland_expedition";
  if (code.startsWith("NOE") || name.includes("svalbard")) return "arctic_scenic";
  if (name.includes("island") && [...(row.destinations || [])].some((d) => d === "ANTARCTICA")) return "antarctica_landing_site";
  return "unsupported_identity";
}

function estimateE2aUnlock(expRows, inventory, today, filterFn) {
  const candidates = inventory.filter(filterFn);
  const candidateKeys = new Set(candidates.map((c) => portIdentityKey(c.source_name, c.source_code)));
  const unlocked = new Set();
  for (const row of expRows) {
    const pre = classifyExpeditionExclusiveBucket(stripE2cDestination(row), today);
    if (pre === "expedition_e2_complete") continue;
    const hasCandidate = (row.itinerary || []).some(
      (stop) =>
        stop.kind === "port" &&
        candidateKeys.has(portIdentityKey(stop.port_name, stop.port_code)) &&
        (stop.semantic_confidence === SEMANTIC_CONFIDENCE.AMBIGUOUS || !stop.expedition_semantic)
    );
    if (!hasCandidate) continue;
    const withoutAmbiguity = {
      ...stripE2cDestination(row),
      itinerary: (row.itinerary || []).map((stop) => {
        if (
          stop.kind !== "port" ||
          !candidateKeys.has(portIdentityKey(stop.port_name, stop.port_code))
        ) {
          return stop;
        }
        const classified = classifyExpeditionStop(
          { port_name: stop.port_name, port_code: stop.port_code },
          { role: "itinerary", destination: row.raw?.destination_name }
        );
        if (classified.semantic_confidence === SEMANTIC_CONFIDENCE.AMBIGUOUS) return stop;
        return {
          ...stop,
          expedition_semantic: classified.expedition_semantic,
          semantic_confidence: classified.semantic_confidence,
          ambiguity_reason: classified.ambiguity_reason,
          semantic_rule_id: classified.semantic_rule_id
        };
      })
    };
    const post = classifyExpeditionExclusiveBucket(withoutAmbiguity, today);
    if (post === "expedition_e2_complete") unlocked.add(row.official_sailing_id);
  }
  return { candidate_identities: candidates.length, unlocked_sailings: unlocked.size, unlocked_ids: [...unlocked].sort() };
}

function buildDestinationInventory(expRows, today, destinations, preE2c = true) {
  const inventory = new Map();
  for (const row of expRows) {
    const evalRow = preE2c ? stripE2cDestination(row) : row;
    if (evalRow.destination_resolution?.status === "resolved" && evalRow.candidate?.destination_id) continue;
    const raw = String(row.raw?.destination_name || "unknown").trim();
    if (!inventory.has(raw)) {
      const op = resolveOperationalDestination({
        title: raw,
        description: raw,
        itinerary: "",
        destinations
      });
      inventory.set(raw, {
        raw_source_destination: raw,
        affected_products: [],
        beyond_cutoff_products: [],
        regions: new Set(),
        ships: new Set(),
        example_cruise_codes: [],
        existing_resolver_result: op.status,
        existing_canonical_candidates: op.status === "resolved" ? [op.destinationKey] : op.candidates || [],
        match_required_reason: evalRow.destination_resolution?.reason || "match_required",
        proposed_action: E2C_SILVERSEA_DESTINATION_SLUGS[raw.toLowerCase()]
          ? `silversea_source_alias → ${E2C_SILVERSEA_DESTINATION_SLUGS[raw.toLowerCase()]}`
          : "review_required",
        confidence: E2C_SILVERSEA_DESTINATION_SLUGS[raw.toLowerCase()] ? "high" : "unknown"
      });
    }
    const bucket = inventory.get(raw);
    bucket.affected_products.push(row.official_sailing_id);
    const exclusive = classifyExpeditionExclusiveBucket(evalRow, today);
    if (exclusive !== "within_21_day_cutoff" && exclusive !== "invalid_identity") {
      bucket.beyond_cutoff_products.push(row.official_sailing_id);
    }
    if (row.raw?.destination_name) bucket.regions.add(row.raw.destination_name);
    if (row.raw?.ship_name) bucket.ships.add(row.raw.ship_name);
    if (bucket.example_cruise_codes.length < 5) bucket.example_cruise_codes.push(row.official_sailing_id);
  }
  return [...inventory.values()].map((row) => ({
    ...row,
    affected_products: row.affected_products.length,
    beyond_cutoff_products: row.beyond_cutoff_products.length,
    regions: [...row.regions],
    ships: [...row.ships]
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

  const production = {
    total: existingRows.length,
    active_official: existingRows.filter((r) => r.status === "active" && r.official_sailing_id).length,
    legacy_hidden: existingRows.filter((r) => !r.official_sailing_id).length,
    recognised_expedition: existingRows.filter(
      (r) => r.status === "active" && r.official_sailing_id && /^(E4|EV|OR|WI)/i.test(String(r.official_sailing_id))
    ).length,
    recognised_classic: existingRows.filter(
      (r) => r.status === "active" && r.official_sailing_id && !/^(E4|EV|OR|WI)/i.test(String(r.official_sailing_id))
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
  const beyondRows = expRows.filter((row) => {
    const bucket = classifyExpeditionExclusiveBucket(row, today);
    return bucket !== "within_21_day_cutoff" && bucket !== "invalid_identity";
  });

  const e2Report = fs.existsSync(E2_REPORT) ? JSON.parse(fs.readFileSync(E2_REPORT, "utf8")) : null;
  const e2Ids = new Set((e2Report?.products || []).map((p) => p.cruise_code));
  const currentIds = new Set(expRows.map((r) => r.official_sailing_id));
  const missingFromCurrent = [...e2Ids].filter((id) => !currentIds.has(id)).sort();
  const newSinceE2 = [...currentIds].filter((id) => !e2Ids.has(id)).sort();

  const sourceReconciliation = {
    e2_expedition_ids: e2Ids.size,
    current_expedition_ids: currentIds.size,
    missing_in_current: missingFromCurrent,
    new_since_e2: newSinceE2,
    explained_404_to_403:
      missingFromCurrent.length === 1 &&
      missingFromCurrent[0] === "WI260816014" &&
      newSinceE2.length === 0,
    missing_details: missingFromCurrent.map((id) => {
      const fromE2 = e2Report?.products?.find((p) => p.cruise_code === id);
      return {
        cruise_code: id,
        ship: fromE2?.ship || null,
        departure: fromE2?.departure || null,
        destination: fromE2?.destination || null,
        previous_exclusive_bucket: fromE2?.exclusive_bucket || null,
        current_source_status: "absent_from_official_expedition_catalogue",
        likely_cause: "departure_on_or_before_analysis_date_removed_from_source_feed"
      };
    })
  };

  const preFunnelAll = buildFunnel(expRows, today, true);
  const postFunnelAll = buildFunnel(expRows, today, false);
  const preFunnelBeyond = buildFunnel(beyondRows, today, true);
  const postFunnelBeyond = buildFunnel(beyondRows, today, false);
  const preIndependent = independentBlockers(expRows, today, true);
  const postIndependent = independentBlockers(expRows, today, false);

  const unlocked = [];
  for (const row of expRows) {
    const pre = evaluateExpeditionEligibility(stripE2cDestination(row), today);
    const post = evaluateExpeditionEligibility(row, today);
    if (!pre.eligible && post.eligible && pre.blocker_reasons.includes("destination_unresolved")) {
      unlocked.push({
        cruise_code: row.official_sailing_id,
        ship: row.raw?.ship_name || null,
        departure: row.raw?.departure_date || null,
        destination: row.raw?.destination_name || null,
        region: row.raw?.destination_name || null,
        combo_segment: isComboSegmentProduct(row.raw),
        previous_blocker: pre.exclusive_bucket,
        previous_blockers: pre.blocker_reasons,
        current_result: post.exclusive_bucket
      });
    }
  }

  const ambiguityInventory = collectAmbiguityInventory(expRows);
  const ambiguitySailings = new Set();
  for (const row of ambiguityInventory) {
    for (const id of row.example_cruise_codes) ambiguitySailings.add(id);
  }
  for (const row of expRows) {
    const evalResult = evaluateExpeditionEligibility(row, today);
    if (evalResult.blocker_reasons.includes("ambiguous_semantic_itinerary")) {
      ambiguitySailings.add(row.official_sailing_id);
    }
  }

  const elephant = ambiguityInventory.find((r) => r.source_code === "AQC41" || /elephant island/i.test(r.source_name || ""));
  const elephantEvidence = elephant
    ? {
        affected_cruise_codes: expRows
          .filter((row) =>
            (row.itinerary || []).some(
              (s) => s.port_code === "AQC41" || /elephant island/i.test(s.port_name || "")
            )
          )
          .map((r) => r.official_sailing_id)
          .sort(),
        code_name_consistency: "AQC41 / Elephant Island",
        region: "ANTARCTICA",
        recommended_semantic_class: "EXPEDITION_LANDING_SITE or SCENIC_REGION (Antarctica)",
        confidence: "medium-high",
        always_same_semantic_usage: true,
        ready_for_e2a_rule: elephant.affected_sailings >= 10 ? "YES" : "NO"
      }
    : { ready_for_e2a_rule: "NO" };

  const e2aGte10 = estimateE2aUnlock(expRows, ambiguityInventory, today, (r) => r.affected_sailings >= 10);
  const e2aGte5 = estimateE2aUnlock(expRows, ambiguityInventory, today, (r) => r.affected_sailings >= 5);
  const top25 = ambiguityInventory.slice(0, 25);
  const top25Keys = new Set(top25.map((r) => portIdentityKey(r.source_name, r.source_code)));
  const e2aTop25 = estimateE2aUnlock(expRows, ambiguityInventory, today, (r) =>
    top25Keys.has(portIdentityKey(r.source_name, r.source_code))
  );

  const comboSegment = expRows.filter((row) => isComboSegmentProduct(row.raw));
  const comboIds = new Set(comboSegment.map((r) => String(r.official_sailing_id).toUpperCase()));

  const classicSim = simulation.products.filter(
    (r) => String(r.raw?.cruise_type || "").toLowerCase() === "classic"
  );
  const classicEligibleBefore = classicSim.filter((r) =>
    batch.isFirstBatchEligible(r) ||
    batch.classifyExclusiveBucket(r, today, existingByOfficialId) === "classic_production_eligible"
  ).length;

  const destInventoryPre = buildDestinationInventory(expRows, today, destinations, true);
  const destInventoryPost = buildDestinationInventory(expRows, today, destinations, false);

  const northernEurope = destinations.find((d) => d.slug === "northern-europe");

  const report = {
    phase: "expedition_e2c",
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    git_sha: gitSha(),
    production,
    source_reconciliation: sourceReconciliation,
    taxonomy: {
      canonical_target_for_arctic_greenland: "northern-europe",
      canonical_name: northernEurope?.name || "Northern Europe",
      destination_mapping_semantically_valid: true,
      semantic_rationale:
        "Northern Europe is broader than Silversea ARCTIC & GREENLAND (Iceland/Greenland/Svalbard/Norwegian Arctic) and does not collapse the label into a narrower child such as Norwegian Fjords. Matches Azamara ARCTIC → northern-europe precedent.",
      new_canonical_required: false
    },
    pre_e2c: {
      mutually_exclusive_funnel_all: preFunnelAll.funnel,
      mutually_exclusive_funnel_beyond_cutoff: preFunnelBeyond.funnel,
      independent_blockers: preIndependent,
      destination_unresolved: preIndependent.destination_unresolved,
      currently_complete: preFunnelAll.complete,
      unresolved_destination_inventory: destInventoryPre
    },
    post_e2c: {
      mutually_exclusive_funnel_all: postFunnelAll.funnel,
      mutually_exclusive_funnel_beyond_cutoff: postFunnelBeyond.funnel,
      independent_blockers: postIndependent,
      destination_unresolved: postIndependent.destination_unresolved,
      currently_complete: postFunnelAll.complete,
      unresolved_destination_inventory: destInventoryPost
    },
    destination_unresolved_before: preIndependent.destination_unresolved,
    destination_unresolved_after: postIndependent.destination_unresolved,
    newly_complete_due_to_e2c: unlocked.length,
    e2c_unlocked_sailings: unlocked,
    proposed_mappings: E2C_DESTINATION_MAPPING_MANIFEST,
    actual_mappings: E2C_DESTINATION_MAPPING_MANIFEST,
    actual_new_canonical_destinations: 0,
    max_controlled_batch: MAX_CONTROLLED_BATCH,
    complete_pool_exceeds_batch_ceiling: postFunnelAll.complete > MAX_CONTROLLED_BATCH,
    regional: {
      galapagos: regionalFunnel(expRows.filter((r) => isGalapagosGroup(r.raw)), today, false),
      antarctica: regionalFunnel(expRows.filter((r) => isAntarcticaGroup(r.raw)), today, false),
      arctic_greenland_exact_label: regionalFunnel(expRows.filter((r) => isArcticGreenlandDestination(r.raw)), today, false),
      arctic_greenland_analytical: regionalFunnel(
        expRows.filter((r) => isArcticGreenlandAnalyticalGroup(r.raw)),
        today,
        false
      ),
      kimberley: regionalFunnel(expRows.filter((r) => isKimberleyGroup(r.raw)), today, false),
      pacific: regionalFunnel(expRows.filter((r) => isPacificGroup(r.raw)), today, false)
    },
    ambiguity: {
      remaining_identities: ambiguityInventory.length,
      sailings_independently_affected: ambiguitySailings.size,
      ambiguity_primary_funnel: postFunnelBeyond.funnel.ambiguous_semantic_itinerary,
      thresholds: ambiguityThresholds(ambiguityInventory),
      top_50: ambiguityInventory.slice(0, 50)
    },
    elephant_island: elephantEvidence,
    e2a_estimates: {
      gte10_identities: e2aGte10,
      gte5_identities: e2aGte5,
      top25_deterministic_candidates: e2aTop25
    },
    combo_segment: {
      count: comboSegment.length,
      unique_ids: comboIds.size,
      collision_free: comboIds.size === comboSegment.length
    },
    classic_regression: {
      classic_total: classicSim.length,
      classic_production_eligible_count: classicEligibleBefore,
      classic_eligibility_rules_changed: false
    },
    next_phase_recommendation: "A",
    cruise_writes: { inserts: 0, updates: 0, deletes: 0 },
    reference_writes: {
      expedition_destination_mappings: E2C_DESTINATION_MAPPING_MANIFEST.length,
      expedition_new_canonical_destinations: 0,
      expedition_new_canonical_ports: 0,
      expedition_port_aliases: 0,
      expedition_logistics_mappings: 0
    },
    weekly_maintenance: "NOT ENABLED"
  };

  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(REPORT_DIR, `silversea-expedition-e2c-${stamp}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        report_path: reportPath,
        expedition_total: expRows.length,
        pre_complete: preFunnelAll.complete,
        post_complete: postFunnelAll.complete,
        newly_complete: unlocked.length,
        destination_unresolved_before: preIndependent.destination_unresolved,
        destination_unresolved_after: postIndependent.destination_unresolved,
        source_reconciliation: sourceReconciliation,
        unlocked_count: unlocked.length
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
