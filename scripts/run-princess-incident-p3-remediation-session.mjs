#!/usr/bin/env node
/**
 * Princess Incident P3 — serial controlled remediation of entire master plan.
 *
 *   node scripts/princess-incident-p3-create-master-plan.mjs --write
 *   PRINCESS_DISCOVERY_WRITE_ENABLED=true node scripts/run-princess-incident-p3-remediation-session.mjs \
 *     --apply --confirm=PRINCESS-INCIDENT-P3-CONTROLLED-REMEDIATION
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
  require("dotenv").config({ path: path.join(root, ".env.local") });
} catch {
  /* optional */
}

const CONFIRM = "PRINCESS-INCIDENT-P3-CONTROLLED-REMEDIATION";
const MASTER_PATH = path.join(root, "reports/princess-incident-p3-master-plan.json");
const P2_FREEZE_PATH = path.join(root, "reports/princess-incident-p2-batch-1-freeze.json");

const p3 = require(path.join(root, "scripts/lib/princess-incident-p3-lib.cjs"));
const { createMaintenanceSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { runPrincessWeeklyMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-runner"
));
const {
  createMaintenanceRun,
  finalizeMaintenanceRun,
  buildMaintenanceRunStats,
  resolveMaintenanceRunStatus
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-tracking"));
const { PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance"
));
const postWriteVerification = require(path.join(
  root,
  "netlify/functions/lib/princess-post-write-verification"
));
const {
  comparePrincessLiveCandidateToFreeze,
  hashPrincessFrozenBatch,
  hashPrincessFrozenCandidate,
  canonicalPrincessWritePayloadForHash
} = require(path.join(root, "netlify/functions/lib/princess-frozen-payload"));
const { officialProductKey } = require(path.join(root, "netlify/functions/lib/princess-discovery-adapter"));
const { buildPrincessUpsertCandidate } = require(path.join(
  root,
  "netlify/functions/lib/princess-discovery-writes"
));

function parseArgs(argv) {
  const args = { apply: false, confirm: null };
  for (const arg of argv.slice(2)) {
    if (arg === "--apply") args.apply = true;
    if (arg.startsWith("--confirm=")) args.confirm = arg.split("=")[1];
  }
  return args;
}

function loadMasterPlan() {
  if (!fs.existsSync(MASTER_PATH)) throw new Error(`Missing ${MASTER_PATH}`);
  const plan = JSON.parse(fs.readFileSync(MASTER_PATH, "utf8"));
  if (!plan.immutable) throw new Error("Master plan not marked immutable");
  return plan;
}

function loadBatchFreeze(batchNum) {
  const id = String(batchNum).padStart(2, "0");
  const p = path.join(root, `reports/princess-incident-p3-batch-${id}-freeze.json`);
  if (!fs.existsSync(p)) throw new Error(`Missing freeze ${p}`);
  const freeze = JSON.parse(fs.readFileSync(p, "utf8"));
  const recomputed = hashPrincessFrozenBatch(freeze.candidates);
  if (recomputed !== freeze.batch_hash) throw new Error(`Batch ${id} hash mismatch`);
  return freeze;
}

function verifyFrozenRow(row, frozen) {
  const live = buildPrincessUpsertCandidate(row, { id: frozen.write_payload.cruise_line_id });
  return comparePrincessLiveCandidateToFreeze({ liveCandidate: live, frozenCandidate: frozen });
}

async function liveBatchValidation(ctx, freeze, productionKeys) {
  const { adapter, sim, line } = ctx;
  const eligible = (sim.products || []).filter((p) => {
    const id = officialProductKey(p.raw);
    return (
      id &&
      p.complete_high_confidence &&
      adapter.isEligiblePrincessCruise(p.product_type) &&
      freeze.candidates.some((c) => c.official_sailing_id === id)
    );
  });
  const mismatches = [];
  for (const frozen of freeze.candidates) {
    const row = eligible.find((p) => officialProductKey(p.raw) === frozen.official_sailing_id);
    if (!row) {
      mismatches.push({ id: frozen.official_sailing_id, error: "missing_from_source" });
      continue;
    }
    const cmp = verifyFrozenRow(row, frozen);
    if (!cmp.ok) mismatches.push({ id: frozen.official_sailing_id, ...cmp });
    if (productionKeys.has(frozen.official_sailing_id)) {
      mismatches.push({ id: frozen.official_sailing_id, error: "already_in_production" });
    }
  }
  const liveHashes = freeze.candidates.map((f) => {
    const row = eligible.find((p) => officialProductKey(p.raw) === f.official_sailing_id);
    const live = row ? buildPrincessUpsertCandidate(row, line) : null;
    return live ? hashPrincessFrozenCandidate(live) : null;
  });
  const liveBatchHash = hashPrincessFrozenBatch(
    liveHashes.filter(Boolean).map((h, i) => ({ candidate_hash: h, write_payload: freeze.candidates[i].write_payload }))
  );
  return {
    ok: mismatches.length === 0,
    mismatches,
    live_batch_hash: hashPrincessFrozenBatch(
      freeze.candidates.map((f, i) => {
        const row = eligible.find((p) => officialProductKey(p.raw) === f.official_sailing_id);
        const live = row ? buildPrincessUpsertCandidate(row, line) : f.write_payload;
        return { write_payload: live || f.write_payload };
      })
    ),
    frozen_batch_hash: freeze.batch_hash
  };
}

async function verifyInsertedAgainstFreeze(sb, insertedDetails, freezeCandidates) {
  const ids = insertedDetails.map((d) => d.discovered_cruise_id).filter(Boolean);
  if (!ids.length) return { ok: true, issues: [] };
  const rows = await sb(
    `discovered_cruises?id=in.(${ids.join(",")})&select=id,cruise_line_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,itinerary,status,official_sailing_id,external_key,identity_key,official_url,source_url,raw_extract,match_confidence`
  );
  const byOfficial = new Map(freezeCandidates.map((c) => [c.official_sailing_id, c]));
  const issues = [];
  for (const row of rows || []) {
    const frozen = byOfficial.get(row.official_sailing_id);
    if (!frozen) {
      issues.push({ id: row.id, error: "no_frozen_match" });
      continue;
    }
    const frozenPayload = frozen.write_payload;
    const canonical = canonicalPrincessWritePayloadForHash(row);
    const frozenCanonical = canonicalPrincessWritePayloadForHash(frozenPayload);
    for (const key of Object.keys(frozenCanonical)) {
      if (JSON.stringify(canonical[key]) !== JSON.stringify(frozenCanonical[key])) {
        issues.push({ id: row.id, field: key, production: canonical[key], frozen: frozenCanonical[key] });
      }
    }
  }
  return { ok: issues.length === 0, verified: rows?.length || 0, issues };
}

async function runBatch({ batchNum, freeze, masterPlan, sb, preExistingSnap, apply }) {
  const batchLabel = freeze.batch_label || `P3-${String(batchNum).padStart(2, "0")}`;
  const runId = `princess-incident-p3-${batchLabel}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const result = {
    batch_number: batchNum,
    batch_label: batchLabel,
    batch_size: freeze.batch_size,
    batch_hash: freeze.batch_hash,
    resolver_remediated: freeze.candidates.filter((c) => c.resolver_remediated).length,
    old_rule_missing: freeze.candidates.filter((c) => c.old_rule_eligible_current_production_missing).length
  };

  const countsBefore = await p3.loadDeps(root).batchLib.baselineCounts(root);
  const productionRows = await p3.loadAllPrincessRows(sb);
  const productionKeys = new Set(productionRows.map((r) => r.official_sailing_id).filter(Boolean));

  const ctx = await p3.runPrincessSimulation(root);
  const liveVal = await liveBatchValidation({ ...ctx, root }, freeze, productionKeys);
  result.live_hash_match = liveVal.live_batch_hash === liveVal.frozen_batch_hash;
  result.live_validation = liveVal;
  if (!liveVal.ok || !result.live_hash_match) {
    result.stopped = true;
    result.reason = "live_to_freeze_mismatch";
    return result;
  }

  const collisions = await p3.collisionAuditProduction(sb, freeze.candidates);
  result.collisions = collisions;
  if (!collisions.pass) {
    result.stopped = true;
    result.reason = "pre_write_collision";
    return result;
  }

  if (!apply) {
    result.dry_run_only = true;
    return result;
  }

  const frozenBatchRecheck = async ({ supabase, line }) => {
    const freshCtx = await p3.runPrincessSimulation(root);
    const freshVal = await liveBatchValidation({ ...freshCtx, root }, freeze, productionKeys);
    const freshCollisions = await p3.collisionAuditProduction(supabase, freeze.candidates);
    if (!freshVal.ok || freshVal.live_batch_hash !== freeze.batch_hash) {
      return { ok: false, reason: "under_lock_payload_mismatch", freshVal };
    }
    if (!freshCollisions.pass) {
      return { ok: false, reason: "under_lock_collision", freshCollisions };
    }
    return { ok: true };
  };

  const dbRun = await createMaintenanceRun(sb, {
    cruiseLineId: p3.PRINCESS_LINE_ID,
    runId,
    runType: PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
    triggerType: "incident_p3_controlled_remediation",
    stats: {
      line_slug: "princess-cruises",
      incident_p3: true,
      batch_number: batchNum,
      master_plan_hash: masterPlan.master_plan_hash,
      batch_hash: freeze.batch_hash
    }
  });

  const maintenance = await runPrincessWeeklyMaintenance({
    dryRun: false,
    performWrites: true,
    writeMode: "incident_p3_controlled_remediation",
    incidentP3ControlledRemediation: true,
    insertOnly: true,
    frozenOfficialSailingIds: freeze.candidates.map((c) => c.official_sailing_id),
    frozenBatchRecheck,
    maxWrites: p3.P3_BATCH_MAX_WRITES,
    runId,
    runRecordId: dbRun?.id || null,
    supabase: sb,
    triggerType: "incident_p3_controlled_remediation",
    collectSourceDiagnostics: true
  });

  const writeStats = maintenance.write_result?.stats || {};
  result.global_lock = maintenance.summary?.global_lock || null;
  result.attempted = (writeStats.inserted || 0) + (writeStats.updated || 0) + (writeStats.failed || 0);
  result.inserted = writeStats.inserted || 0;
  result.updated = writeStats.updated || 0;
  result.failed = writeStats.failed || 0;
  result.rollback_manifest_id = maintenance.summary?.rollback_manifest_id || null;

  const countsAfter = await p3.loadDeps(root).batchLib.baselineCounts(root);
  result.counts_before = countsBefore;
  result.counts_after = countsAfter;
  result.active_delta = countsAfter.princess_active - countsBefore.princess_active;

  const insertedDetails = maintenance.write_result?.write_details || [];
  result.verification = await verifyInsertedAgainstFreeze(sb, insertedDetails, freeze.candidates);

  const postRows = await p3.loadAllPrincessRows(sb);
  result.immutability = p3.verifyPreExistingImmutability(preExistingSnap, postRows);

  const idempotency = await runPrincessWeeklyMaintenance({
    dryRun: true,
    performWrites: false,
    maxWrites: 0,
    runId: `${runId}-idempotency`,
    supabase: sb,
    writeMode: "production_read_only",
    triggerType: "incident_p3_post_batch_idempotency"
  });
  result.idempotency = {
    ok: idempotency.ok === true,
    outstanding: idempotency.summary?.outstanding_eligible_inserts ?? null,
    proposed_updates: idempotency.summary?.proposed_updates ?? null
  };

  await finalizeMaintenanceRun(sb, dbRun.id, {
    status: resolveMaintenanceRunStatus({ ok: maintenance.ok, summary: maintenance.summary }),
    stats: buildMaintenanceRunStats(maintenance.summary || {}, {
      incident_p3: true,
      batch_number: batchNum,
      batch_hash: freeze.batch_hash,
      rollback_manifest_id: result.rollback_manifest_id
    }),
    errorMessage: maintenance.ok ? null : maintenance.reason
  });

  const pass =
    maintenance.ok &&
    result.inserted === freeze.batch_size &&
    result.updated === 0 &&
    result.failed === 0 &&
    result.verification.ok &&
    result.immutability.ok &&
    result.idempotency.ok &&
    result.active_delta === freeze.batch_size &&
    result.rollback_manifest_id;

  result.batch_pass = Boolean(pass);
  if (!pass) {
    result.stopped = true;
    result.reason = maintenance.reason || "batch_gate_failed";
  }

  const outPath = path.join(
    root,
    `reports/princess-incident-p3-batch-${String(batchNum).padStart(2, "0")}-result.json`
  );
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.apply) {
    if (args.confirm !== CONFIRM) throw new Error(`--apply requires --confirm=${CONFIRM}`);
    if (String(process.env.PRINCESS_DISCOVERY_WRITE_ENABLED || "").toLowerCase() !== "true") {
      throw new Error("PRINCESS_DISCOVERY_WRITE_ENABLED=true required");
    }
  }

  const masterPlan = loadMasterPlan();
  const sb = createMaintenanceSupabase(root);
  const preExistingRows = await p3.loadAllPrincessRows(sb);
  const preExistingSnap = p3.snapshotProductionCanonical(preExistingRows);

  const p2Freeze = JSON.parse(fs.readFileSync(P2_FREEZE_PATH, "utf8"));
  const p2Ids = p2Freeze.candidates.map((c) => c.official_sailing_id);
  const p2Verify = p2Ids.every((id) => preExistingSnap.has(id));
  if (!p2Verify) throw new Error("P2 identities missing from production");

  const csr = preExistingRows.find((r) => r.official_sailing_id === "CSR07H|KP|2027-02-28");
  if (!csr || csr.status !== "active") throw new Error("CSR07H not active");

  const batchResults = [];
  let stopped = false;
  let stopReason = null;

  for (let b = 1; b <= masterPlan.batch_count; b++) {
    const freeze = loadBatchFreeze(b);
    if (freeze.batch_size > p3.P3_BATCH_MAX_WRITES) throw new Error(`Batch ${b} exceeds cap`);

    console.error(`Processing batch ${b}/${masterPlan.batch_count} (${freeze.batch_size} sailings)…`);
    const batchResult = await runBatch({
      batchNum: b,
      freeze,
      masterPlan,
      sb,
      preExistingSnap,
      apply: args.apply
    });
    batchResults.push(batchResult);

    if (batchResult.stopped) {
      stopped = true;
      stopReason = batchResult.reason;
      break;
    }
  }

  const totalInserted = batchResults.reduce((s, r) => s + (r.inserted || 0), 0);
  const cumulative = {
    generated_at: new Date().toISOString(),
    repository_sha: execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim(),
    master_plan_hash: masterPlan.master_plan_hash,
    batches_completed: batchResults.filter((r) => r.batch_pass).length,
    batches_attempted: batchResults.length,
    total_inserted: totalInserted,
    stopped,
    stop_reason: stopReason,
    batch_results: batchResults
  };

  if (args.apply && !stopped && batchResults.length === masterPlan.batch_count) {
    const ctx = await p3.runPrincessSimulation(root);
    const finalRecon = await runPrincessWeeklyMaintenance({
      dryRun: true,
      performWrites: false,
      maxWrites: 0,
      runId: `princess-p3-final-reconciliation`,
      supabase: sb,
      writeMode: "production_read_only",
      triggerType: "incident_p3_final_reconciliation"
    });
    const weeklyNormal = await runPrincessWeeklyMaintenance({
      dryRun: true,
      performWrites: false,
      maxWrites: 0,
      runId: `princess-p3-weekly-readiness`,
      supabase: sb,
      writeMode: "weekly_maintenance",
      triggerType: "weekly_scheduled_apply"
    });

    const baselineRunId = `princess-p3-baseline-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const baselineDbRun = await createMaintenanceRun(sb, {
      cruiseLineId: p3.PRINCESS_LINE_ID,
      runId: baselineRunId,
      runType: PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
      triggerType: "incident_p3_baseline_acceptance",
      stats: { line_slug: "princess-cruises", incident_p3: true }
    });
    const eligibleTotal = finalRecon.summary?.eligible_total ?? null;
    const snapshotId = finalRecon.summary?.snapshot_id ?? null;
    await finalizeMaintenanceRun(sb, baselineDbRun.id, {
      status: "completed",
      stats: {
        run_type: PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
        trigger_type: "incident_p3_baseline_acceptance",
        accepted_inventory_baseline: true,
        accepted_eligible_total: eligibleTotal,
        accepted_eligible_hash: snapshotId,
        accepted_at: new Date().toISOString(),
        accepted_reason: "incident_p3_controlled_remediation_complete",
        incident_p3_complete: true,
        eligible_total: eligibleTotal
      },
      errorMessage: null
    });
    cumulative.accepted_baseline = {
      eligible_total: eligibleTotal,
      eligible_hash: snapshotId,
      recorded: true
    };

    cumulative.final_reconciliation = {
      outstanding: finalRecon.summary?.outstanding_eligible_inserts ?? null,
      proposed_updates: finalRecon.summary?.proposed_updates ?? null,
      eligible: finalRecon.summary?.eligible_total ?? null,
      active: finalRecon.summary?.active_production_total ?? null
    };
    cumulative.weekly_readiness = {
      review_required: weeklyNormal.review_required === true,
      expansion_anomaly: weeklyNormal.summary?.quality_gate?.expansion_anomaly ?? null,
      proposed_inserts: weeklyNormal.summary?.outstanding_eligible_inserts ?? null,
      proposed_updates: weeklyNormal.summary?.proposed_updates ?? null,
      quality_gate_passed: weeklyNormal.summary?.quality_gate?.passed ?? null
    };
    cumulative.p3_complete = true;
  }

  const out = path.join(root, "reports/princess-weekly-incident-p3-complete-remediation.json");
  fs.writeFileSync(out, JSON.stringify(cumulative, null, 2));
  console.log(JSON.stringify(cumulative, null, 2));

  if (stopped) process.exit(5);
  if (args.apply && cumulative.p3_complete) process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
