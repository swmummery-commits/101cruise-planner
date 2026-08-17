/**
 * Read-only Princess scheduled-apply readiness evaluation.
 * Exercises APPLY quality-gate semantics without discovered_cruises mutation.
 */

const { extractPreviousEligibleTotal } = require("./princess-weekly-quality");

/**
 * Evaluate scheduled weekly apply gates using performWrites semantics but no DB writes.
 * Requires maintenance runner support for simulateApplyQualityGates.
 */
async function evaluatePrincessScheduledApplyReadiness({
  runPrincessWeeklyMaintenance,
  findPrincessAcceptedEligibleBaseline,
  supabase,
  cruiseLineId,
  runType,
  runId = `princess-readiness-${Date.now()}`
} = {}) {
  if (!runPrincessWeeklyMaintenance || !supabase) {
    throw new Error("evaluatePrincessScheduledApplyReadiness requires supabase and runner");
  }

  const baseline =
    typeof findPrincessAcceptedEligibleBaseline === "function"
      ? await findPrincessAcceptedEligibleBaseline(supabase, cruiseLineId, runType)
      : null;
  const previousEligible = extractPreviousEligibleTotal(baseline);

  const result = await runPrincessWeeklyMaintenance({
    dryRun: true,
    performWrites: false,
    simulateApplyQualityGates: true,
    maxWrites: 30,
    runId,
    supabase,
    writeMode: "weekly_maintenance",
    triggerType: "weekly_scheduled_apply_readiness",
    collectSourceDiagnostics: true
  });

  const summary = result.summary || {};
  const expansion = summary.quality_gate?.expansion_anomaly || {};
  const qualityGate = summary.quality_gate || {};

  return {
    ok: result.ok === true && qualityGate.auto_apply_permitted !== false,
    baseline_loaded: Boolean(baseline),
    baseline_run_id: baseline?.id ?? null,
    previous_eligible_total: expansion.previous_eligible_total ?? previousEligible,
    current_eligible_total: expansion.current_eligible_total ?? summary.eligible_total ?? null,
    eligible_delta: expansion.eligible_delta ?? null,
    eligible_change_pct: expansion.eligible_change_pct ?? null,
    expansion_review: qualityGate.review_required === true || expansion.passed === false,
    review_required: result.review_required === true || qualityGate.review_required === true,
    proposed_inserts: summary.proposed_inserts ?? summary.outstanding_eligible_inserts ?? null,
    proposed_updates: summary.proposed_updates ?? null,
    source_accounting_exact: qualityGate.source_accounting?.accounting?.accounting_exact ?? null,
    auto_apply_permitted: qualityGate.auto_apply_permitted === true && result.ok === true,
    quality_gate_passed: qualityGate.passed === true,
    production_writes: 0,
    raw_result: {
      ok: result.ok,
      reason: result.reason || null,
      blocked: result.blocked === true,
      failed: result.failed === true
    }
  };
}

module.exports = {
  evaluatePrincessScheduledApplyReadiness
};
