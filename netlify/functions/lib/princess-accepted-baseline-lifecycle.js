/**
 * Princess accepted eligible-inventory baseline lifecycle.
 * Healthy scheduled weekly runs advance the rolling comparison baseline.
 */

const { PRINCESS_WEEKLY_WRITE_CAP } = require("./princess-weekly-quality");

const PRINCESS_HEALTHY_SCHEDULED_BASELINE_REASON = "healthy_scheduled_princess_maintenance";
const PRINCESS_P3_BASELINE_REASON = "incident_p3_controlled_remediation_complete";

const BASELINE_BLOCKED_TRIGGER_TYPES = new Set([
  "incident_p2_controlled_batch",
  "incident_p3_controlled_remediation",
  "incident_p3_baseline_acceptance",
  "incident_p3_post_batch_idempotency",
  "incident_p3_final_reconciliation",
  "weekly_dry_run",
  "weekly_post_write_reconciliation",
  "weekly_scheduled_apply_readiness",
  "weekly_manual_apply",
  "manual"
]);

const BASELINE_ALLOWED_SCHEDULED_TRIGGER_TYPES = new Set(["scheduled", "weekly_scheduled_apply"]);

function buildPrincessAcceptedBaselineStats(summary = {}, { acceptedAt = null, reason = null } = {}) {
  const eligibleTotal = summary.eligible_total ?? null;
  const eligibleHash = summary.snapshot_id ?? summary.source_snapshot_id ?? null;
  return {
    accepted_inventory_baseline: true,
    accepted_eligible_total: eligibleTotal,
    accepted_eligible_hash: eligibleHash,
    accepted_at: acceptedAt || new Date().toISOString(),
    accepted_reason: reason || PRINCESS_HEALTHY_SCHEDULED_BASELINE_REASON
  };
}

function selectLatestPrincessAcceptedBaseline(runs = [], runType) {
  const accepted = (runs || [])
    .filter((r) => r.stats?.run_type === runType && r.stats?.accepted_inventory_baseline === true)
    .sort((a, b) => {
      const ta = new Date(a.stats?.accepted_at || a.finished_at || a.created_at || 0).getTime();
      const tb = new Date(b.stats?.accepted_at || b.finished_at || b.created_at || 0).getTime();
      return tb - ta;
    });
  return accepted[0] || null;
}

function resolvePrincessAcceptedBaselineLookup(runs = [], runType, legacyFallback = null) {
  const accepted = selectLatestPrincessAcceptedBaseline(runs, runType);
  if (accepted) {
    return {
      baseline: accepted,
      baseline_source: "accepted_baseline",
      baseline_run_id: accepted.id,
      baseline_eligible_total: accepted.stats?.accepted_eligible_total ?? accepted.stats?.eligible_total ?? null,
      baseline_eligible_hash:
        accepted.stats?.accepted_eligible_hash ?? accepted.stats?.source_snapshot_id ?? null,
      baseline_accepted_at: accepted.stats?.accepted_at || accepted.finished_at || null,
      baseline_reason: accepted.stats?.accepted_reason || null
    };
  }
  if (legacyFallback) {
    return {
      baseline: legacyFallback,
      baseline_source: "legacy_fallback",
      baseline_run_id: legacyFallback.id,
      baseline_eligible_total:
        legacyFallback.stats?.accepted_eligible_total ??
        legacyFallback.stats?.eligible_total ??
        legacyFallback.stats?.official_eligible_total ??
        null,
      baseline_eligible_hash:
        legacyFallback.stats?.accepted_eligible_hash ??
        legacyFallback.stats?.source_snapshot_id ??
        null,
      baseline_accepted_at: legacyFallback.finished_at || null,
      baseline_reason: "legacy_scheduled_fallback"
    };
  }
  return {
    baseline: null,
    baseline_source: "none",
    baseline_run_id: null,
    baseline_eligible_total: null,
    baseline_eligible_hash: null,
    baseline_accepted_at: null,
    baseline_reason: null
  };
}

function evaluatePrincessBaselineAcceptance({
  triggerType,
  summary = {},
  executeResult = {},
  report = {},
  maintenanceResult = {},
  dryRun = false,
  simulation = null
} = {}) {
  const failures = [];

  if (dryRun) failures.push("dry_run");
  if (!BASELINE_ALLOWED_SCHEDULED_TRIGGER_TYPES.has(triggerType)) {
    failures.push("not_scheduled_trigger");
  }
  if (BASELINE_BLOCKED_TRIGGER_TYPES.has(triggerType)) failures.push("blocked_trigger_type");
  if (executeResult.review_required === true || summary.review_required === true) {
    failures.push("review_required");
  }
  if (executeResult.blocked === true || summary.blocked === true) failures.push("blocked");
  if (executeResult.success === false) failures.push("run_not_successful");
  if (simulation?.fetch_failed) failures.push("source_fetch_failed");

  const qualityGate = summary.quality_gate || {};
  if (qualityGate.passed !== true) failures.push("quality_gate_failed");

  const sourceAccounting = qualityGate.source_accounting || summary.source_accounting || {};
  if (sourceAccounting.passed !== true) failures.push("source_accounting_failed");
  const accounting = sourceAccounting.accounting || {};
  if (accounting.accounting_exact !== true) failures.push("source_accounting_not_exact");
  if (accounting.accounting_delta != null && accounting.accounting_delta !== 0) {
    failures.push("source_accounting_delta_nonzero");
  }

  const gateFailures = qualityGate.failures || [];
  if (gateFailures.some((f) => String(f).includes("eligible_inventory_collapse"))) {
    failures.push("eligible_inventory_collapse");
  }
  if (gateFailures.includes("duplicate_official_identities")) failures.push("duplicate_official_identities");

  if (summary.reconciliation_arithmetic_ok === false) failures.push("reconciliation_arithmetic_failed");

  const inserts = Number(summary.inserts ?? 0);
  const updates = Number(summary.updates ?? 0);
  const failedWrites = Number(summary.failed_writes ?? 0);
  const materialWrites = inserts + updates;

  if (materialWrites > PRINCESS_WEEKLY_WRITE_CAP) failures.push("material_writes_exceed_cap");
  if (failedWrites > 0) failures.push("failed_writes");

  if (summary.incident_p2 || summary.incident_p3 || executeResult.summary?.incident_p3) {
    failures.push("incident_controlled_remediation");
  }

  if (materialWrites > 0) {
    const manifestOk =
      report.manifestValidation?.ok === true || report.manifestValidation?.skipped === true;
    const verifyOk =
      report.postWriteVerification?.ok === true || report.postWriteVerification?.skipped === true;
    const reconOk =
      report.postWriteReconciliation?.ok === true || report.postWriteReconciliation?.skipped === true;
    if (!manifestOk) failures.push("rollback_manifest_failed");
    if (!verifyOk) failures.push("post_write_verification_failed");
    if (!reconOk) failures.push("post_write_reconciliation_failed");
    if (!summary.rollback_manifest_id && report.manifestValidation?.skipped !== true) {
      failures.push("rollback_manifest_missing");
    }
  } else if (materialWrites === 0) {
    const zeroChange =
      summary.zero_change_apply === true ||
      executeResult.zero_change_apply === true ||
      ((summary.proposed_inserts ?? 0) === 0 && (summary.proposed_updates ?? 0) === 0);
    if (!zeroChange) failures.push("zero_change_reconciliation_invalid");
  }

  if (maintenanceResult.ok === false && materialWrites > 0) failures.push("maintenance_not_ok");

  return {
    accept: failures.length === 0,
    failures,
    material_writes: materialWrites
  };
}

async function patchMaintenanceRunAcceptedBaseline(supabase, runRecordId, summary, options = {}) {
  if (!runRecordId || !supabase) return null;
  const rows = await supabase(
    `cruise_discovery_runs?id=eq.${encodeURIComponent(runRecordId)}&select=id,stats&limit=1`
  );
  const row = rows?.[0];
  if (!row) return null;
  const acceptedFields = buildPrincessAcceptedBaselineStats(summary, options);
  const mergedStats = { ...(row.stats || {}), ...acceptedFields };
  await supabase(`cruise_discovery_runs?id=eq.${encodeURIComponent(runRecordId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ stats: mergedStats })
  });
  return { id: runRecordId, stats: mergedStats };
}

module.exports = {
  PRINCESS_HEALTHY_SCHEDULED_BASELINE_REASON,
  PRINCESS_P3_BASELINE_REASON,
  PRINCESS_WEEKLY_WRITE_CAP,
  BASELINE_BLOCKED_TRIGGER_TYPES,
  BASELINE_ALLOWED_SCHEDULED_TRIGGER_TYPES,
  buildPrincessAcceptedBaselineStats,
  selectLatestPrincessAcceptedBaseline,
  resolvePrincessAcceptedBaselineLookup,
  evaluatePrincessBaselineAcceptance,
  patchMaintenanceRunAcceptedBaseline
};
