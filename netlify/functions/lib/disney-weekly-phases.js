/**
 * Disney two-phase weekly execution: read-only source freeze, then bounded apply.
 * Phase A never writes discovered_cruises. Phase B writes only from a frozen plan
 * after a rollback manifest exists.
 */

const crypto = require("crypto");
const { persistMaintenanceManifest } = require("./cruise-discovery-maintenance-manifests");
const { runGlobalProtectedMaintenanceWrites } = require("./cruise-discovery-global-write-lock");
const { createMaintenanceRun, finalizeMaintenanceRun } = require("./cruise-discovery-maintenance-tracking");
const {
  acquireMaintenanceDbLock,
  releaseMaintenanceDbLock,
  weeklyLockKey
} = require("./cruise-discovery-maintenance-locks");
const {
  DISNEY_MAX_WEEKLY_MATERIAL_WRITES,
  boundMaterialActions
} = require("./disney-weekly-update-policy");
const { enhanceDisneyCandidate } = require("./disney-discovery-writes");
const { applyDisneyWeeklyMaintenanceWrites } = require("./disney-weekly-apply");
const { DISNEY_WEEKLY_MAINTENANCE_RUN_TYPE } = require("./cruise-discovery-maintenance");

const DISNEY_LINE_SLUG = "disney-cruise-line";
const DISNEY_NETLIFY_BACKGROUND_LIMIT_MS = 900000;
const DISNEY_PHASE_A_RESERVE_MS = 120000;
const DISNEY_PHASE_B_BUDGET_MS = 180000;
const DISNEY_PHASE_A_DEADLINE_MS = DISNEY_NETLIFY_BACKGROUND_LIMIT_MS - DISNEY_PHASE_A_RESERVE_MS;
const DISNEY_SOURCE_FREEZE_MANIFEST = "disney_source_freeze";
const DISNEY_PRECOMMIT_MANIFEST = "disney_precommit_batch";
const DISNEY_PHASE_B_RUN_TYPE = "disney_weekly_phase_b_batch";

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(",")}}`;
}

function hashDisneyPlan(payload) {
  return crypto.createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function compactInsertEntry(entry, cruiseLine) {
  const normalised = entry.normalised || entry;
  const candidate = entry.candidate || enhanceDisneyCandidate(normalised, cruiseLine, { mode: "weekly_maintenance" });
  return {
    official_sailing_id: entry.official_sailing_id || candidate?.official_sailing_id,
    candidate,
    ship_id: candidate?.ship_id || null,
    destination_id: candidate?.destination_id || null,
    departure_date: candidate?.departure_date || null,
    return_date: candidate?.return_date || null,
    nights: candidate?.nights ?? null,
    departure_port: candidate?.departure_port || null,
    official_url: candidate?.official_url || null,
    source_url: candidate?.source_url || null
  };
}

function buildDisneyPhaseAPlan({
  inserts = [],
  cruiseLine,
  qualityGate = {},
  collapseGuard = {},
  eligibleTotal = 0,
  sourceTotal = 0,
  stageTimings = [],
  apiCalls = null,
  snapshotId = null,
  review = [],
  maxWrites = DISNEY_MAX_WEEKLY_MATERIAL_WRITES
} = {}) {
  const compactInserts = inserts
    .map((entry) => compactInsertEntry(entry, cruiseLine))
    .filter((row) => row.candidate)
    .sort((a, b) => String(a.official_sailing_id || "").localeCompare(String(b.official_sailing_id || "")));
  const bounded = boundMaterialActions(
    compactInserts.map((row) => ({ ...row, action: "insert" })),
    maxWrites
  );
  const remainingIds = compactInserts.map((row) => row.official_sailing_id);
  const batches = [];
  for (let i = 0; i < remainingIds.length; i += maxWrites) {
    batches.push({
      batch_number: batches.length + 1,
      official_sailing_ids: remainingIds.slice(i, i + maxWrites),
      expected_record_count: remainingIds.slice(i, i + maxWrites).length
    });
  }
  const payload = {
    mode: "disney_phase_a_source_freeze",
    cruise_line_slug: DISNEY_LINE_SLUG,
    snapshot_id: snapshotId,
    eligible_total: eligibleTotal,
    source_total: sourceTotal,
    insert_official_sailing_ids: remainingIds,
    review_official_sailing_ids: (review || []).map((row) => row.official_sailing_id).filter(Boolean),
    batch_cap: maxWrites
  };
  const planHash = hashDisneyPlan(payload);
  const backlogExceedsCap = compactInserts.length > maxWrites;
  return {
    plan_hash: planHash,
    payload,
    inserts: compactInserts,
    batches,
    backlog_exceeds_normal_cap: backlogExceedsCap,
    terminal_status: backlogExceedsCap ? "controlled_catchup_required" : "source_frozen",
    quality_gate: qualityGate,
    collapse_guard: collapseGuard,
    stage_timings: stageTimings,
    api_calls: apiCalls,
    material_actions_total: bounded.material_actions_total,
    material_actions_deferred: bounded.material_actions_deferred
  };
}

async function persistDisneySourceFreeze(supabase, { runId, runRecordId, cruiseLineId, plan, triggerType = "scheduled" }) {
  if (!supabase || !plan) return { skipped: true, reason: "missing_plan" };
  const row = await persistMaintenanceManifest(supabase, {
    manifestType: DISNEY_SOURCE_FREEZE_MANIFEST,
    manifest: {
      run_id: runId,
      run_record_id: runRecordId,
      cruise_line_id: cruiseLineId,
      cruise_line_slug: DISNEY_LINE_SLUG,
      trigger_type: triggerType,
      plan_hash: plan.plan_hash,
      snapshot_id: plan.payload?.snapshot_id || null,
      insert_official_sailing_ids: plan.payload?.insert_official_sailing_ids || [],
      review_official_sailing_ids: plan.payload?.review_official_sailing_ids || [],
      batches: plan.batches,
      inserts: plan.inserts,
      quality_gate: plan.quality_gate,
      stage_timings: plan.stage_timings,
      api_calls: plan.api_calls,
      terminal_status: plan.terminal_status
    }
  });
  return { skipped: false, manifest_record_id: row?.id || null, plan_hash: plan.plan_hash };
}

async function persistDisneyPrecommitManifest(supabase, params) {
  const {
    runId,
    runRecordId,
    cruiseLineId,
    planHash,
    batchNumber,
    inserts = [],
    triggerType = "incident_recovery"
  } = params;
  if (!supabase) return { skipped: true, reason: "missing_supabase" };
  if (!runRecordId) return { skipped: true, reason: "ledger_batch_run_missing" };
  const planned = (inserts || []).map((row) => ({
    official_sailing_id: row.official_sailing_id,
    discovered_cruise_id: null,
    before_state: "ABSENT",
    proposed_action: "insert_active"
  }));
  if (!planned.length) return { skipped: true, reason: "empty_batch" };
  const row = await persistMaintenanceManifest(supabase, {
    manifestType: DISNEY_PRECOMMIT_MANIFEST,
    manifest: {
      run_id: runId,
      run_record_id: runRecordId,
      cruise_line_id: cruiseLineId,
      cruise_line_slug: DISNEY_LINE_SLUG,
      trigger_type: triggerType,
      plan_hash: planHash,
      batch_number: batchNumber,
      created_before_commit: true,
      inserted_record_ids: [],
      planned_inserts: planned,
      official_sailing_ids: planned.map((row) => row.official_sailing_id)
    }
  });
  if (!row?.id) return { skipped: true, reason: "manifest_persist_failed" };
  return { skipped: false, manifest_record_id: row.id, planned_count: planned.length };
}

async function applyDisneyPhaseBBatch({
  supabase,
  cruiseLine,
  plan,
  batch,
  runId,
  triggerType = "incident_recovery",
  originalRunRecordId = null
}) {
  if (!plan?.plan_hash) {
    return { ok: false, reason: "missing_plan_hash", writes: 0 };
  }
  const batchInserts = (plan.inserts || []).filter((row) =>
    (batch.official_sailing_ids || []).includes(row.official_sailing_id)
  );
  if (batchInserts.length > DISNEY_MAX_WEEKLY_MATERIAL_WRITES) {
    return { ok: false, reason: "batch_exceeds_cap_30", writes: 0 };
  }
  const lock = await acquireMaintenanceDbLock(supabase, {
    lockKey: weeklyLockKey(DISNEY_LINE_SLUG),
    ownerId: runId,
    runId
  });
  if (!lock.acquired) {
    return { ok: false, reason: lock.reason || "maintenance_lock_held", writes: 0 };
  }
  try {
  const batchRun = await createMaintenanceRun(supabase, {
    cruiseLineId: cruiseLine.id,
    runId,
    runType: DISNEY_PHASE_B_RUN_TYPE,
    triggerType,
    stats: {
      plan_hash: plan.plan_hash,
      batch_number: batch.batch_number,
      original_run_record_id: originalRunRecordId,
      phase: "B"
    }
  });
  if (!batchRun?.id) {
    return { ok: false, reason: "ledger_batch_run_creation_failed", writes: 0 };
  }

  const precommit = await persistDisneyPrecommitManifest(supabase, {
    runId,
    runRecordId: batchRun.id,
    cruiseLineId: cruiseLine.id,
    planHash: plan.plan_hash,
    batchNumber: batch.batch_number,
    inserts: batchInserts,
    triggerType
  });
  if (precommit.skipped) {
    await finalizeMaintenanceRun(supabase, batchRun.id, {
      status: "failed",
      stats: { ...batchRun.stats, failure_reason: precommit.reason, inserts: 0, inventory_changed: false },
      errorMessage: precommit.reason
    });
    return { ok: false, reason: precommit.reason, writes: 0, run_record_id: batchRun.id };
  }

  const protectedWrites = await runGlobalProtectedMaintenanceWrites(supabase, {
    runId,
    runRecordId: batchRun.id,
    lineSlug: DISNEY_LINE_SLUG,
    operation: "disney_phase_b_batch",
    underLockRecheck: async () => {
      for (const entry of batchInserts) {
        const existing = await supabase(
          `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(cruiseLine.id)}&official_sailing_id=eq.${encodeURIComponent(entry.official_sailing_id)}&select=id&limit=1`
        );
        if (existing?.[0]?.id) {
          return { ok: false, reason: `under_lock_official_id_exists:${entry.official_sailing_id}` };
        }
      }
      return { ok: true };
    },
    writeFn: async () =>
      applyDisneyWeeklyMaintenanceWrites({
        manifest: {
          inserts: batchInserts.map((row) => ({
            official_sailing_id: row.official_sailing_id,
            candidate: row.candidate,
            normalised: { eligibility: { production_eligible: true }, candidate: row.candidate, raw: {} }
          })),
          safe_updates: [],
          source_absence_hides: [],
          source_current_touches: [],
          reactivations: []
        },
        supabase,
        cruiseLine,
        performWrites: true,
        runId,
        maxMaterialWrites: DISNEY_MAX_WEEKLY_MATERIAL_WRITES,
        includeSourceTouches: false
      })
  });

  if (protectedWrites.blocked) {
    await finalizeMaintenanceRun(supabase, batchRun.id, {
      status: "failed",
      stats: { failure_reason: protectedWrites.reason, inserts: 0, inventory_changed: false },
      errorMessage: protectedWrites.reason
    });
    return { ok: false, reason: protectedWrites.reason, writes: 0, run_record_id: batchRun.id, precommit_manifest_id: precommit.manifest_record_id };
  }

  const stats = protectedWrites.writeResult?.stats || {};
  const insertedIds = (stats.write_details || []).map((row) => row.discovered_cruise_id).filter(Boolean);
  const failed = Number(stats.failed || 0);
  await finalizeMaintenanceRun(supabase, batchRun.id, {
    status: failed > 0 ? "failed" : "completed",
    stats: {
      plan_hash: plan.plan_hash,
      batch_number: batch.batch_number,
      phase: "B",
      inserts: stats.inserted || 0,
      failed_writes: failed,
      inventory_changed: (stats.inserted || 0) > 0,
      committed_material_writes: stats.inserted || 0,
      precommit_manifest_id: precommit.manifest_record_id,
      inserted_record_ids: insertedIds
    },
    errorMessage: failed > 0 ? "phase_b_batch_failed" : null
  });

  return {
    ok: failed === 0,
    writes: stats.inserted || 0,
    failed,
    run_record_id: batchRun.id,
    precommit_manifest_id: precommit.manifest_record_id,
    inserted_record_ids: insertedIds,
    stats
  };
  } finally {
    await releaseMaintenanceDbLock(supabase, {
      lockKey: weeklyLockKey(DISNEY_LINE_SLUG),
      ownerId: runId
    });
  }
}

module.exports = {
  DISNEY_LINE_SLUG,
  DISNEY_NETLIFY_BACKGROUND_LIMIT_MS,
  DISNEY_PHASE_A_RESERVE_MS,
  DISNEY_PHASE_A_DEADLINE_MS,
  DISNEY_PHASE_B_BUDGET_MS,
  DISNEY_SOURCE_FREEZE_MANIFEST,
  DISNEY_PRECOMMIT_MANIFEST,
  DISNEY_PHASE_B_RUN_TYPE,
  hashDisneyPlan,
  compactInsertEntry,
  buildDisneyPhaseAPlan,
  persistDisneySourceFreeze,
  persistDisneyPrecommitManifest,
  applyDisneyPhaseBBatch
};
