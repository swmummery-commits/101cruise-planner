#!/usr/bin/env node
/**
 * Silversea Expedition Phase E2a — voyage-level ambiguity + closure analysis.
 *
 *   node scripts/run-silversea-expedition-e2a-analysis.mjs
 *   node scripts/run-silversea-expedition-e2a-analysis.mjs --post
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { execSync } from "child_process";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const POST = process.argv.includes("--post");

try {
  require("dotenv").config({ path: path.join(root, ".env") });
  require("dotenv").config({ path: path.join(root, ".env.local") });
} catch {
  /* optional */
}

const REPORT_DIR = path.join(root, "reports");
const MAX_RULES = 30;

const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
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
  EXPEDITION_SEMANTIC,
  SEMANTIC_CONFIDENCE,
  classifyExpeditionStop,
  portIdentityKey
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-semantics"));
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

function buildFunnel(rows, today) {
  const funnel = Object.fromEntries(EXPEDITION_EXCLUSIVE_BUCKETS.map((b) => [b, 0]));
  let complete = 0;
  for (const row of rows) {
    const bucket = classifyExpeditionExclusiveBucket(row, today);
    funnel[bucket] = (funnel[bucket] || 0) + 1;
    if (bucket === "expedition_e2_complete") complete += 1;
  }
  return { funnel, complete };
}

function independentBlockers(rows, today) {
  const counts = {
    duration_mismatch: 0,
    embark_unresolved: 0,
    disembark_unresolved: 0,
    destination_unresolved: 0,
    conventional_itinerary_port_unresolved: 0,
    ambiguous_semantic_itinerary: 0
  };
  for (const row of rows) {
    const result = evaluateExpeditionEligibility(row, today);
    for (const reason of result.blocker_reasons || []) {
      if (counts[reason] != null) counts[reason] += 1;
    }
  }
  return counts;
}

function ambiguousStops(row) {
  return (row.itinerary || []).filter(
    (s) =>
      s.kind === "port" &&
      (s.semantic_confidence === SEMANTIC_CONFIDENCE.AMBIGUOUS || !s.expedition_semantic)
  );
}

function ambiguitySignature(row) {
  return ambiguousStops(row)
    .map((s) => portIdentityKey(s.port_name, s.port_code))
    .sort()
    .join("||");
}

function collectIdentityInventory(expRows) {
  const byKey = new Map();
  for (const row of expRows) {
    for (const stop of ambiguousStops(row)) {
      const key = portIdentityKey(stop.port_name, stop.port_code);
      if (!byKey.has(key)) {
        byKey.set(key, {
          source_name: stop.port_name,
          source_code: stop.port_code || null,
          destinations: new Set(),
          regions: new Set(),
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
  return [...byKey.values()].map((row) => ({
    ...row,
    destinations: [...row.destinations],
    affected_sailings: row.affected_sailing_ids.size,
    identity_impact: row.affected_sailing_ids.size
  }));
}

function classifyCandidate(identity) {
  const code = String(identity.source_code || "").toUpperCase();
  const name = String(identity.source_name || "");
  if (!code) return "NEEDS_MULTIPLE_CONTEXT_FIELDS";
  if (code === "AQC41" && /elephant island/i.test(name)) return "DETERMINISTIC_EXACT_RULE";
  if (/^AQ[CEI]/.test(code) && identity.destinations.includes("ANTARCTICA")) return "DETERMINISTIC_CODE_FAMILY_RULE";
  if (/^AUK/.test(code) && identity.destinations.includes("KIMBERLEY")) return "DETERMINISTIC_CODE_FAMILY_RULE";
  if (/^NOE|^GLE|^GLJ|^GLG/.test(code)) return "DETERMINISTIC_CODE_FAMILY_RULE";
  if (/^GB[ELFSIM]|^GBP/.test(code)) return "GENUINELY_AMBIGUOUS";
  if (/^AU[A-Z]/.test(code) && !identity.destinations.includes("KIMBERLEY")) return "GENUINELY_AMBIGUOUS";
  if (/^CA[A-Z]/.test(code)) return "GENUINELY_AMBIGUOUS";
  if (identity.ambiguity_reason === "conflicting_code_name") return "SOURCE_ANOMALY";
  if (identity.ambiguity_reason === "uncertain_port_vs_landing") return "NEEDS_MULTIPLE_CONTEXT_FIELDS";
  return "GENUINELY_AMBIGUOUS";
}

function reclassifyStop(stop, context) {
  const fresh = classifyExpeditionStop(
    { port_name: stop.port_name, port_code: stop.port_code, port_resolution: stop.port_resolution },
    { ...context, role: stop.role || "itinerary", destination: context.destination }
  );
  return {
    ...stop,
    expedition_semantic: fresh.expedition_semantic,
    semantic_confidence: fresh.semantic_confidence,
    semantic_source: fresh.semantic_source,
    semantic_rule_id: fresh.semantic_rule_id,
    ambiguity_reason: fresh.ambiguity_reason
  };
}

function evaluateRowWithFreshSemantics(row, today) {
  const context = { destination: row.raw?.destination_name };
  const itinerary = (row.itinerary || []).map((stop) =>
    stop.kind === "port" ? reclassifyStop(stop, context) : stop
  );
  return {
    ...row,
    itinerary,
    complete_high_confidence: true,
    failure_reasons: (row.failure_reasons || []).filter(
      (r) => !String(r).startsWith("validation:") && r !== "ambiguous_semantic_itinerary"
    )
  };
}

function individualClosureValue(expRows, identityKey, today) {
  let count = 0;
  for (const row of expRows) {
    if (classifyExpeditionExclusiveBucket(row, today) === "expedition_e2_complete") continue;
    const amb = ambiguousStops(row);
    if (!amb.some((s) => portIdentityKey(s.port_name, s.port_code) === identityKey)) continue;
    if (amb.length !== 1) continue;
    const hyp = evaluateRowWithFreshSemantics(row, today);
    if (classifyExpeditionExclusiveBucket(hyp, today) === "expedition_e2_complete") count += 1;
  }
  return count;
}

function clusterClosureValue(expRows, clusterKeys, today) {
  let count = 0;
  for (const row of expRows) {
    if (classifyExpeditionExclusiveBucket(row, today) === "expedition_e2_complete") continue;
    const ambKeys = new Set(ambiguousStops(row).map((s) => portIdentityKey(s.port_name, s.port_code)));
    for (const k of clusterKeys) {
      if (!ambKeys.has(k)) continue;
    }
    if (clusterKeys.some((k) => !ambKeys.has(k))) continue;
    const hyp = evaluateRowWithFreshSemantics(row, today);
    if (classifyExpeditionExclusiveBucket(hyp, today) === "expedition_e2_complete") count += 1;
  }
  return count;
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

function regionalFunnel(rows, today) {
  return buildFunnel(rows, today);
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
    `discovered_cruises?cruise_line_id=eq.${line.id}&select=id,status,official_sailing_id,departure_date,review_reason`
  );

  const production = {
    total: existingRows.length,
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
  const beyondRows = expRows.filter((row) => {
    const bucket = classifyExpeditionExclusiveBucket(row, today);
    return bucket !== "within_21_day_cutoff" && bucket !== "invalid_identity";
  });

  const beforeFunnel = buildFunnel(expRows, today);
  const beforeBeyond = buildFunnel(beyondRows, today);
  const beforeIndependent = independentBlockers(expRows, today);

  const ambVoyages = expRows.filter(
    (row) => classifyExpeditionExclusiveBucket(row, today) === "ambiguous_semantic_itinerary"
  );
  const ambBeyond = beyondRows.filter(
    (row) => classifyExpeditionExclusiveBucket(row, today) === "ambiguous_semantic_itinerary"
  );

  const voyageMatrix = ambBeyond.map((row) => {
    const amb = ambiguousStops(row);
    const evalResult = evaluateExpeditionEligibility(row, today);
    return {
      cruise_code: row.official_sailing_id,
      ship: row.raw?.ship_name || null,
      departure: row.raw?.departure_date || null,
      destination: row.raw?.destination_name || null,
      combo_segment: isComboSegmentProduct(row.raw),
      ambiguous_identity_count: amb.length,
      ambiguous_names: amb.map((s) => s.port_name),
      ambiguous_codes: amb.map((s) => s.port_code || null),
      ambiguity_reasons: amb.map((s) => s.ambiguity_reason),
      deterministic_stop_count: (row.itinerary || []).filter(
        (s) => s.kind === "port" && s.semantic_confidence === SEMANTIC_CONFIDENCE.DETERMINISTIC
      ).length,
      duration_match: row.raw?.duration_matches_dates === true,
      other_blockers: evalResult.blocker_reasons.filter((r) => r !== "ambiguous_semantic_itinerary"),
      ambiguity_signature: ambiguitySignature(row)
    };
  });

  const clusterMap = new Map();
  for (const voyage of voyageMatrix) {
    const sig = voyage.ambiguity_signature || "NONE";
    if (!clusterMap.has(sig)) {
      clusterMap.set(sig, {
        ambiguity_signature: sig,
        identity_keys: sig.split("||").filter(Boolean),
        voyages: [],
        cruise_codes: []
      });
    }
    const bucket = clusterMap.get(sig);
    bucket.voyages.push(voyage);
    bucket.cruise_codes.push(voyage.cruise_code);
  }

  const clusters = [...clusterMap.values()]
    .map((c) => ({
      ...c,
      voyage_count: c.voyages.length,
      cluster_closure_value: clusterClosureValue(expRows, c.identity_keys, today)
    }))
    .sort((a, b) => b.cluster_closure_value - a.cluster_closure_value || b.voyage_count - a.voyage_count);

  let inventory = collectIdentityInventory(expRows);
  inventory = inventory
    .map((row) => {
      const key = portIdentityKey(row.source_name, row.source_code);
      return {
        ...row,
        identity_key: key,
        candidate_class: classifyCandidate(row),
        individual_closure_value: individualClosureValue(expRows, key, today),
        fresh_classification: classifyExpeditionStop(
          { port_name: row.source_name, port_code: row.source_code },
          { destination: row.destinations[0] }
        )
      };
    })
    .sort(
      (a, b) =>
        b.individual_closure_value - a.individual_closure_value ||
        b.affected_sailings - a.affected_sailings ||
        b.occurrences - a.occurrences
    );

  const aqcMembers = inventory.filter((r) => String(r.source_code || "").startsWith("AQC"));
  const aqiMembers = inventory.filter((r) => String(r.source_code || "").startsWith("AQI"));

  const postRows = expRows.map((row) => evaluateRowWithFreshSemantics(row, today));
  const afterFunnel = buildFunnel(postRows, today);
  const afterBeyond = buildFunnel(
    postRows.filter((row) => {
      const bucket = classifyExpeditionExclusiveBucket(row, today);
      return bucket !== "within_21_day_cutoff" && bucket !== "invalid_identity";
    }),
    today
  );
  const afterIndependent = independentBlockers(postRows, today);
  const afterInventory = collectIdentityInventory(postRows);

  const newlyComplete = [];
  for (const row of expRows) {
    const before = classifyExpeditionExclusiveBucket(row, today);
    const after = classifyExpeditionExclusiveBucket(evaluateRowWithFreshSemantics(row, today), today);
    if (before !== "expedition_e2_complete" && after === "expedition_e2_complete") {
      newlyComplete.push({
        cruise_code: row.official_sailing_id,
        ship: row.raw?.ship_name,
        departure: row.raw?.departure_date,
        destination: row.raw?.destination_name,
        ambiguity_cluster_before: ambiguitySignature(row),
        ambiguity_identities_before: ambiguousStops(row).map((s) => ({
          name: s.port_name,
          code: s.port_code
        }))
      });
    }
  }

  const durationMismatch = expRows.filter((r) => r.raw?.duration_matches_dates === false).map((r) => ({
    cruise_code: r.official_sailing_id,
    destination: r.raw?.destination_name,
    source_duration: r.raw?.source_duration,
    calculated_nights: r.raw?.calculated_nights,
    semantic_ambiguity_remaining: ambiguousStops(r).length > 0
  }));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(REPORT_DIR, `silversea-expedition-e2a-${POST ? "post" : "pre"}-${stamp}.json`);
  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });

  const report = {
    phase: POST ? "expedition_e2a_post" : "expedition_e2a_pre",
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    git_sha: gitSha(),
    production,
    expedition: {
      total: expRows.length,
      within_cutoff: beforeFunnel.funnel.within_21_day_cutoff,
      beyond_cutoff: beyondRows.length
    },
    before: {
      mutually_exclusive_funnel_all: beforeFunnel.funnel,
      mutually_exclusive_funnel_beyond: beforeBeyond.funnel,
      independent_blockers: beforeIndependent,
      complete: beforeFunnel.complete,
      ambiguous_identities: inventory.length,
      ambiguity_affected_sailings: new Set(
        inventory.flatMap((i) => [...(i.affected_sailing_ids || [])])
      ).size || beforeIndependent.ambiguous_semantic_itinerary,
      ambiguity_primary_beyond: beforeBeyond.funnel.ambiguous_semantic_itinerary,
      ambiguity_thresholds: ambiguityThresholds(inventory)
    },
    after_simulated_with_current_code: {
      mutually_exclusive_funnel_all: afterFunnel.funnel,
      mutually_exclusive_funnel_beyond: afterBeyond.funnel,
      independent_blockers: afterIndependent,
      complete: afterFunnel.complete,
      newly_complete: newlyComplete.length,
      ambiguous_identities: afterInventory.length,
      ambiguity_primary_beyond: afterBeyond.funnel.ambiguous_semantic_itinerary
    },
    voyage_matrix_path_note: reportPath,
    ambiguity_blocked_voyage_count: ambBeyond.length,
    unique_ambiguity_clusters: clusters.length,
    top_clusters: clusters.slice(0, 30),
    voyage_matrix: voyageMatrix,
    identity_inventory: inventory,
    aqc_family: { members: aqcMembers, conclusion: aqcMembers.length === 1 ? "exact_AQC41_sufficient" : "review_each_member" },
    aqi_family: { members: aqiMembers },
    regional: {
      antarctica: {
        ambiguity_blocked: expRows.filter(
          (r) => isAntarcticaGroup(r.raw) && classifyExpeditionExclusiveBucket(r, today) === "ambiguous_semantic_itinerary"
        ).length,
        ...regionalFunnel(expRows.filter((r) => isAntarcticaGroup(r.raw)), today)
      },
      arctic_exact: regionalFunnel(expRows.filter((r) => isArcticGreenlandDestination(r.raw)), today),
      arctic_analytical: regionalFunnel(expRows.filter((r) => isArcticGreenlandAnalyticalGroup(r.raw)), today),
      kimberley: regionalFunnel(expRows.filter((r) => isKimberleyGroup(r.raw)), today),
      pacific: regionalFunnel(expRows.filter((r) => isPacificGroup(r.raw)), today),
      galapagos: regionalFunnel(expRows.filter((r) => isGalapagosGroup(r.raw)), today)
    },
    newly_complete_preview: newlyComplete,
    duration_mismatch: durationMismatch,
    combo_segment: {
      count: expRows.filter((r) => isComboSegmentProduct(r.raw)).length,
      unique_ids: new Set(expRows.filter((r) => isComboSegmentProduct(r.raw)).map((r) => r.official_sailing_id)).size
    }
  };

  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        report_path: reportPath,
        before_complete: beforeFunnel.complete,
        after_simulated_complete: afterFunnel.complete,
        newly_complete_preview: newlyComplete.length,
        amb_voyages_beyond: ambBeyond.length,
        clusters: clusters.length,
        top_cluster_closure: clusters.slice(0, 5).map((c) => ({
          voyages: c.voyage_count,
          closure: c.cluster_closure_value,
          keys: c.identity_keys.slice(0, 3)
        })),
        aqc_members: aqcMembers.map((m) => m.source_code),
        inventory_top5: inventory.slice(0, 5).map((i) => ({
          code: i.source_code,
          name: i.source_name,
          sailings: i.affected_sailings,
          individual_closure: i.individual_closure_value,
          class: i.candidate_class
        }))
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
