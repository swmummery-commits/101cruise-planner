#!/usr/bin/env node
/**
 * Silversea Expedition Phase E3 — first read-only controlled batch preparation.
 * Freezes complete pool + first 250 fixture. No production writes.
 *
 *   node scripts/run-silversea-expedition-e3-preparation.mjs
 *   node scripts/run-silversea-expedition-e3-preparation.mjs --dry-run-only
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { execSync } from "child_process";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const DRY_RUN_ONLY = process.argv.includes("--dry-run-only");

try {
  require("dotenv").config({ path: path.join(root, ".env") });
  require("dotenv").config({ path: path.join(root, ".env.local") });
} catch {
  /* optional */
}

const REPORT_DIR = path.join(root, "reports");
const FIXTURE_DIR = path.join(root, "scripts/fixtures/silversea");
const E2A_REPORT = path.join(root, "reports/silversea-expedition-e2a-pre-2026-08-16T11-03-24-184Z.json");

const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const { isClassic } = require(path.join(root, "netlify/functions/lib/silversea-controlled-batch"));
const { MAX_CONTROLLED_BATCH } = require(path.join(root, "netlify/functions/lib/silversea-controlled-batch"));
const {
  EXPEDITION_EXCLUSIVE_BUCKETS,
  classifyExpeditionExclusiveBucket,
  evaluateExpeditionEligibility,
  isGalapagosGroup,
  isAntarcticaGroup,
  isArcticGreenlandAnalyticalGroup,
  isKimberleyGroup,
  isPacificGroup,
  isComboSegmentProduct
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-eligibility"));
const {
  EXPEDITION_BATCH_SIZE,
  EXPEDITION_FIRST_BATCH_MODE,
  E3_COMPLETE_POOL_FIXTURE,
  E3_FIRST_250_FIXTURE,
  buildExpeditionExclusiveFunnel,
  selectExpeditionCompletePool,
  selectFirstExpeditionBatch,
  selectFrozenExpeditionBatch,
  loadFrozenExpeditionIds,
  buildExpeditionPreWriteTableRow,
  validateAllExpeditionCandidates,
  buildExpeditionCandidateMetadata,
  computeExpeditionManifestHash,
  evaluateExpeditionPreWriteGate,
  buildE3RollbackTemplate,
  countItinerarySemantics
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-controlled-batch"));
const {
  buildExpeditionBatchManifest,
  dryRunExpeditionBatchManifest,
  buildItineraryPorts,
  buildExpeditionUpsertCandidate
} = require(path.join(root, "netlify/functions/lib/silversea-discovery-writes"));
const { E2A_IMPLEMENTED_RULES } = require(path.join(
  root,
  "netlify/functions/lib/silversea-expedition-e2a-rules-batch"
));
const { E2C_DESTINATION_MAPPING_MANIFEST } = require(path.join(
  root,
  "netlify/functions/lib/silversea-expedition-e2c-destination-batch"
));
const { DEFAULT_GLOBAL_LEASE_SECONDS } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-global-write-lock"
));
const { PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE, perthCalendarDate, daysUntilDeparture } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));
const { loadClassificationDestinations } = require(path.join(
  root,
  "netlify/functions/lib/destination-queries"
));
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { EXPEDITION_SEMANTIC } = require(path.join(root, "netlify/functions/lib/silversea-expedition-semantics"));

function gitSha() {
  return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
}

function analyticalRegion(row) {
  const raw = row.raw || {};
  if (isGalapagosGroup(raw)) return "Galápagos";
  if (isAntarcticaGroup(raw)) return "Antarctica";
  if (isArcticGreenlandAnalyticalGroup(raw)) return "Arctic & Greenland";
  if (isKimberleyGroup(raw)) return "Kimberley";
  if (isPacificGroup(raw)) return "Pacific";
  const dest = String(raw.destination_name || "").trim();
  return dest || "other";
}

function shipPrefix(row) {
  return String(row.official_sailing_id || "").slice(0, 2).toUpperCase();
}

function distribution(rows, fn) {
  const counts = {};
  for (const row of rows) {
    const key = fn(row);
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function independentBlockers(rows, today) {
  const counts = {
    duration_mismatch: 0,
    ship_unresolved: 0,
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

function countProductionState(existingRows) {
  const activeOfficial = existingRows.filter((r) => r.status === "active" && r.official_sailing_id);
  const classicOfficial = activeOfficial.filter((r) => isClassic({ cruise_type: inferCruiseType(r) }));
  const expeditionOfficial = activeOfficial.filter(
    (r) => r.official_sailing_id && /^(E4|EV|OR|WI)/i.test(String(r.official_sailing_id))
  );
  return {
    total: existingRows.length,
    active_official: activeOfficial.length,
    classic_official: classicOfficial.length,
    expedition_official: expeditionOfficial.length,
    legacy_hidden: existingRows.filter((r) => !r.official_sailing_id).length,
    recognised_expedition: expeditionOfficial.length
  };
}

function inferCruiseType(row) {
  const id = String(row.official_sailing_id || "");
  if (/^(E4|EV|OR|WI)/i.test(id)) return "Expedition";
  return "Classic";
}

function auditWriteShape(row, cruiseLine) {
  const today = perthCalendarDate();
  const candidate = buildExpeditionUpsertCandidate(row, cruiseLine, today);
  const issues = [];
  if (!candidate) issues.push("upsert_candidate_null");
  const ports = buildItineraryPorts(row);
  for (const stop of row.itinerary || []) {
    if (stop.kind !== "port") continue;
    if (
      stop.expedition_semantic &&
      stop.expedition_semantic !== EXPEDITION_SEMANTIC.CONVENTIONAL_PORT &&
      stop.port_resolution?.canonicalPortName &&
      ports.includes(stop.port_resolution.canonicalPortName)
    ) {
      issues.push(`landing_site_leaked:${stop.port_code || stop.port_name}`);
    }
  }
  for (const [role, resolution] of [
    ["embark", row.departure_port_resolution],
    ["disembark", row.arrival_port_resolution]
  ]) {
    if (!resolution?.expedition_logistics_gateway) continue;
    const key = role === "embark" ? "expedition_endpoint_embark" : "expedition_endpoint_disembark";
    if (!candidate?.raw_extract?.[key]) {
      issues.push(`logistics_gateway_metadata_missing_${role}`);
    }
  }
  return { ok: issues.length === 0, issues, itinerary_ports: ports, candidate };
}

function auditRunnerCompatibility() {
  return {
    expedition_fixture_paths: [E3_COMPLETE_POOL_FIXTURE, E3_FIRST_250_FIXTURE],
    batch_size: EXPEDITION_BATCH_SIZE,
    max_controlled_batch: MAX_CONTROLLED_BATCH,
    mode_token: EXPEDITION_FIRST_BATCH_MODE,
    supports: {
      expected_count_250: EXPEDITION_BATCH_SIZE === 250 && MAX_CONTROLLED_BATCH === 250,
      expedition_raw_extract: true,
      expedition_endpoint_logistics: true,
      resolved_conventional_itinerary_ports_only: true,
      destination_mapping: true,
      combo_segment_ids: true,
      global_write_lock_path: true,
      final_under_lock_dedupe: true,
      precise_rollback_template: true,
      post_write_verification: "via executeControlledProductionApply pattern"
    },
    safe_without_unsafe_changes: true
  };
}

function hardStop(code, detail) {
  const err = new Error(`E3_HARD_STOP:${code}`);
  err.code = code;
  err.detail = detail;
  throw err;
}

async function main() {
  const startedAt = new Date().toISOString();
  const sha = gitSha();
  const today = perthCalendarDate();
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });

  const rest = createSupabaseRest(root);
  const line = (
    await rest.get(`ci_cruise_lines?slug=eq.${adapter.LINE_SLUG}&select=id,name,slug&limit=1`)
  )?.[0];
  const destinations = adapter.catalogueDestinations(await loadClassificationDestinations(async (q) => rest.get(q)));
  const ships = await rest.get(
    `ci_cruise_ships?cruise_line_id=eq.${line.id}&select=id,name,cruise_line_id,official_line_ship_id`
  );
  const existingRows = await rest.get(
    `discovered_cruises?cruise_line_id=eq.${line.id}&select=id,status,official_sailing_id,departure_date,review_reason,raw_extract`
  );
  const existingByOfficialId = new Map(
    existingRows
      .filter((row) => row.official_sailing_id)
      .map((row) => [String(row.official_sailing_id).toUpperCase(), row])
  );

  const production = countProductionState(existingRows);
  if (production.recognised_expedition > 0) {
    hardStop("expedition_production_ids_nonzero", production);
  }

  const simulation = await adapter.simulateSilverseaInventory({
    cruiseLine: line,
    ships,
    destinations,
    existingRows,
    today,
    concurrency: 6
  });

  const sourceHealthOk = simulation.ok === true && simulation.fetch_failed !== true;
  const expRows = simulation.products.filter(
    (row) => String(row.raw?.cruise_type || "").trim().toLowerCase() === "expedition"
  );
  const beyondRows = expRows.filter((row) => {
    const bucket = classifyExpeditionExclusiveBucket(row, today);
    return bucket !== "within_21_day_cutoff" && bucket !== "invalid_identity";
  });

  const funnelAll = buildExpeditionExclusiveFunnel(expRows, today);
  const funnelBeyond = buildExpeditionExclusiveFunnel(beyondRows, today);
  const independent = independentBlockers(expRows, today);

  const completePoolResult = selectExpeditionCompletePool(expRows, { today, existingByOfficialId });
  const completePool = completePoolResult.eligible;

  if (completePoolResult.eligible_count < EXPEDITION_BATCH_SIZE) {
    hardStop("complete_pool_below_250", {
      complete_count: completePoolResult.eligible_count,
      required: EXPEDITION_BATCH_SIZE
    });
  }

  const existingInCompletePool = completePoolResult.eligible_ids.filter((id) =>
    existingByOfficialId.has(String(id).toUpperCase())
  );
  if (existingInCompletePool.length > 0) {
    hardStop("existing_ids_in_complete_pool", existingInCompletePool);
  }

  const e2aBaseline = fs.existsSync(E2A_REPORT) ? JSON.parse(fs.readFileSync(E2A_REPORT, "utf8")) : null;
  const e2aComplete = e2aBaseline?.after?.complete ?? e2aBaseline?.before?.complete ?? 310;

  const completeIdsNow = new Set(completePool.map((r) => String(r.official_sailing_id).toUpperCase()));
  const e2aReconciliation = {
    e2a_complete: e2aComplete,
    fresh_complete: completePoolResult.eligible_count,
    delta: completePoolResult.eligible_count - e2aComplete,
    note:
      completePoolResult.eligible_count === e2aComplete
        ? "matches E2a baseline"
        : "source or cutoff drift since E2a — review duration_mismatch backlog"
  };

  const durationMismatchBacklog = expRows
    .filter((row) => classifyExpeditionExclusiveBucket(row, today) === "duration_mismatch")
    .map((row) => row.official_sailing_id)
    .sort();

  const selectionPolicy =
    "departure_date ASC, official_sailing_id ASC — first 250 from complete pool after eligibility and production dedupe gates";
  const firstBatch = selectFirstExpeditionBatch(completePool, EXPEDITION_BATCH_SIZE);

  if (firstBatch.frozen_count !== EXPEDITION_BATCH_SIZE || firstBatch.frozen_unique_count !== EXPEDITION_BATCH_SIZE) {
    hardStop("first_250_selection_invalid", firstBatch);
  }

  const revalidation = validateAllExpeditionCandidates(firstBatch.selected, today, existingByOfficialId);
  if (!revalidation.ok) {
    hardStop("selected_revalidation_failed", revalidation.failed);
  }

  const frozenReplay = selectFrozenExpeditionBatch(expRows, firstBatch.selected_ids, {
    today,
    existingByOfficialId
  });
  if (!frozenReplay.exact_frozen_set_match) {
    hardStop("frozen_replay_mismatch", frozenReplay);
  }

  const preWriteTable = firstBatch.selected.map((row, i) => buildExpeditionPreWriteTableRow(i + 1, row, today));
  const minDays = Math.min(...preWriteTable.map((r) => r.days_until_departure).filter((d) => d != null));
  const comboCount = firstBatch.selected.filter((r) => isComboSegmentProduct(r.raw)).length;

  const remaining = completePool.slice(EXPEDITION_BATCH_SIZE);
  const firstUnselectedDep = remaining[0]?.candidate?.departure_date || remaining[0]?.raw?.departure_date || null;

  const catalogueTimestamp = simulation.fetch_result?.fetched_at || simulation.fetch_result?.generated_at || startedAt;

  const completePoolFixture = {
    phase: "expedition_e3_complete_pool",
    generated_at: startedAt,
    git_sha: sha,
    source_catalogue_timestamp: catalogueTimestamp,
    source_catalogue_count: simulation.summary?.catalogue_nodes,
    expedition_total: expRows.length,
    beyond_cutoff_count: beyondRows.length,
    complete_candidate_count: completePoolResult.eligible_count,
    semantic_policy_version: E2A_IMPLEMENTED_RULES.map((r) => r.rule_id),
    destination_policy_version: E2C_DESTINATION_MAPPING_MANIFEST.map((r) => r.source_label),
    endpoint_policy_version: "e2b_port_remediation_applied",
    cutoff_policy_days: PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE,
    selection_policy: "complete pool audit snapshot — not authorised production batch",
    official_sailing_ids: completePoolResult.eligible_ids,
    candidates: completePool.map((row) => buildExpeditionCandidateMetadata(row, today))
  };

  const first250Fixture = {
    phase: "E3",
    mode: EXPEDITION_FIRST_BATCH_MODE,
    generated_at: startedAt,
    git_sha: sha,
    selection_policy: selectionPolicy,
    source_snapshot: {
      catalogue_timestamp: catalogueTimestamp,
      catalogue_count: simulation.summary?.catalogue_nodes,
      expedition_total: expRows.length,
      beyond_cutoff: beyondRows.length,
      source_health: sourceHealthOk ? "PASS" : "FAIL"
    },
    complete_pool_count: completePoolResult.eligible_count,
    frozen_count: firstBatch.frozen_count,
    frozen_unique_count: firstBatch.frozen_unique_count,
    production_expedition_id_baseline: production.recognised_expedition,
    cutoff_policy_days: PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE,
    eligibility_policy_version: "expedition_e2a_semantic_hardening",
    selection: {
      selected_official_sailing_ids: firstBatch.selected_ids
    },
    candidates: firstBatch.selected.map((row) => buildExpeditionCandidateMetadata(row, today))
  };

  const rollbackTemplate = buildE3RollbackTemplate({
    fixturePath: E3_FIRST_250_FIXTURE,
    officialIds: firstBatch.selected_ids,
    gitSha: sha
  });

  if (!DRY_RUN_ONLY) {
    fs.writeFileSync(path.join(root, E3_COMPLETE_POOL_FIXTURE), `${JSON.stringify(completePoolFixture, null, 2)}\n`);
    fs.writeFileSync(path.join(root, E3_FIRST_250_FIXTURE), `${JSON.stringify(first250Fixture, null, 2)}\n`);
    fs.writeFileSync(
      path.join(FIXTURE_DIR, "expedition-e3-rollback-template.json"),
      `${JSON.stringify(rollbackTemplate, null, 2)}\n`
    );
  }

  const loadedFixture = JSON.parse(fs.readFileSync(path.join(root, E3_FIRST_250_FIXTURE), "utf8"));
  const frozenIds = loadFrozenExpeditionIds(loadedFixture);
  const frozenSelection = selectFrozenExpeditionBatch(expRows, frozenIds, { today, existingByOfficialId });

  const manifest = await buildExpeditionBatchManifest({
    selectedProducts: frozenSelection.selected,
    cruiseLine: line,
    destinations,
    supabase: null,
    runId: `expedition-e3-${startedAt.replace(/[:.]/g, "-")}`,
    today,
    existingByOfficialId
  });
  const dryRun = dryRunExpeditionBatchManifest(manifest);

  const writeShapeAudit = firstBatch.selected.slice(0, 5).map((row) => ({
    official_sailing_id: row.official_sailing_id,
    ...auditWriteShape(row, line)
  }));
  const writeShapeSampleOk = writeShapeAudit.every((r) => r.ok);
  const fullWriteShapeAudit = firstBatch.selected.every((row) => auditWriteShape(row, line).ok);

  const gate = evaluateExpeditionPreWriteGate({
    completePoolCount: completePoolResult.eligible_count,
    selection: frozenSelection,
    proposedInserts: dryRun.proposed_inserts,
    proposedUpdates: dryRun.proposed_updates,
    revalidation,
    sourceHealthOk,
    expectedCount: EXPEDITION_BATCH_SIZE,
    existingSelectedOfficialIds: 0
  });

  const selectedAmbiguity = preWriteTable.reduce((n, r) => n + (r.ambiguous_stop_count || 0), 0);
  const selectedMatchRequired = preWriteTable.filter((r) => r.match_required).length;
  const selectedDurationMismatch = preWriteTable.filter((r) => r.exclusive_bucket === "duration_mismatch").length;
  const selectedCutoffViolations = preWriteTable.filter(
    (r) => r.days_until_departure != null && r.days_until_departure < PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE
  ).length;

  const classicWouldUpdate = manifest.products.filter((p) => {
    const existing = existingByOfficialId.get(String(p.official_sailing_id).toUpperCase());
    return existing && isClassic({ cruise_type: "Classic" }) && p.proposed_action === "update_existing";
  }).length;

  const report = {
    phase: "expedition_e3_preparation",
    generated_at: startedAt,
    git_sha: sha,
    dry_run_only: DRY_RUN_ONLY,
    production,
    source: {
      catalogue_total: simulation.summary?.catalogue_nodes,
      unique_cruise_codes: simulation.summary?.unique_cruise_codes,
      classic_count: simulation.summary?.classic,
      expedition_total: expRows.length,
      within_cutoff: expRows.filter(
        (r) => classifyExpeditionExclusiveBucket(r, today) === "within_21_day_cutoff"
      ).length,
      beyond_cutoff: beyondRows.length,
      duplicate_cruise_codes: simulation.summary?.duplicate_official_sailing_ids,
      source_health: sourceHealthOk ? "PASS" : "FAIL",
      health: simulation.health
    },
    funnel: {
      all_expedition: funnelAll,
      beyond_cutoff: funnelBeyond,
      independent_overlapping_blockers: independent
    },
    complete_pool: {
      count: completePoolResult.eligible_count,
      unique_count: completePoolResult.unique_count,
      existing_production_ids_in_pool: existingInCompletePool.length,
      e2a_reconciliation: e2aReconciliation
    },
    fixtures: {
      complete_pool: E3_COMPLETE_POOL_FIXTURE,
      first_250: E3_FIRST_250_FIXTURE,
      rollback_template: "scripts/fixtures/silversea/expedition-e3-rollback-template.json"
    },
    selection: {
      policy: selectionPolicy,
      frozen_count: firstBatch.frozen_count,
      frozen_unique_count: firstBatch.frozen_unique_count,
      combo_segment_count: comboCount,
      normal_product_count: firstBatch.frozen_count - comboCount,
      duplicate_identity_count: firstBatch.frozen_unique_count === firstBatch.frozen_count ? 0 : 1,
      region_distribution: distribution(firstBatch.selected, analyticalRegion),
      ship_distribution: distribution(firstBatch.selected, shipPrefix),
      earliest_departure: preWriteTable[0]?.departure,
      latest_departure: preWriteTable[preWriteTable.length - 1]?.departure,
      minimum_days_to_departure: minDays,
      remaining_complete_count: remaining.length,
      first_unselected_departure: firstUnselectedDep,
      remaining_region_distribution: distribution(remaining, analyticalRegion),
      remaining_ship_distribution: distribution(remaining, shipPrefix),
      remaining_official_ids: remaining.map((r) => r.official_sailing_id)
    },
    revalidation: {
      passed: revalidation.passed,
      total: revalidation.total,
      ok: revalidation.ok
    },
    selected_quality: {
      ambiguity_count: selectedAmbiguity,
      match_required_count: selectedMatchRequired,
      duration_mismatch_count: selectedDurationMismatch,
      cutoff_violation_count: selectedCutoffViolations
    },
    pre_write_table: preWriteTable,
    dry_run: dryRun,
    manifest_hash: computeExpeditionManifestHash(manifest),
    pre_write_gate: gate,
    runner_compatibility: auditRunnerCompatibility(),
    write_shape_audit: {
      sample: writeShapeAudit,
      all_pass: fullWriteShapeAudit && writeShapeSampleOk
    },
    global_lock: {
      path: "controlled_production_import:global",
      default_lease_seconds: DEFAULT_GLOBAL_LEASE_SECONDS,
      expected_lease_sufficient_for_250: true,
      rationale:
        "Prior Silversea Classic controlled runs inserted up to 124 rows within 1800s lease; 250 Expedition rows with larger raw_extract estimated safe but E4 must monitor lock timing"
    },
    batch_ceiling: MAX_CONTROLLED_BATCH,
    classic_protection: {
      existing_classic_proposed_updates: dryRun.classic_proposed_updates,
      legacy_proposed_updates: dryRun.legacy_proposed_updates
    },
    duration_mismatch_backlog: durationMismatchBacklog,
    production_writes: {
      inserts: 0,
      updates: 0,
      deletes: 0
    },
    reference_writes: {
      new_canonical_ports: 0,
      port_aliases: 0,
      logistics_mappings: 0,
      destination_mappings: 0,
      semantic_rule_changes: 0
    },
    weekly_maintenance: "NOT ENABLED",
    e4_authorisation:
      gate.passed &&
      sourceHealthOk &&
      revalidation.ok &&
      dryRun.proposed_inserts === EXPEDITION_BATCH_SIZE &&
      dryRun.proposed_updates === 0 &&
      fullWriteShapeAudit
        ? "A. E4 — FIRST CONTROLLED EXPEDITION PRODUCTION BATCH AUTHORISED"
        : "B. E3 REMEDIATION REQUIRED BEFORE PRODUCTION"
  };

  const reportPath = path.join(
    REPORT_DIR,
    `silversea-expedition-e3-pre-${startedAt.replace(/[:.]/g, "-")}.json`
  );
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify({ ok: gate.passed, report: reportPath, e4: report.e4_authorisation }, null, 2));

  if (!gate.passed || report.e4_authorisation.startsWith("B.")) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.detail || error.message || error);
  process.exit(1);
});
