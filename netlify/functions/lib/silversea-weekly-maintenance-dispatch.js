/**
 * Silversea weekly maintenance — launcher ↔ background dispatch.
 */

const {
  runSilverseaWeeklyMaintenance,
  LINE_SLUG,
  RUN_TYPE
} = require("./silversea-weekly-maintenance");
const { supabase } = require("./cruise-discovery-ops");
const { claimOrSkipScheduledBackgroundDispatch, releaseScheduledDispatchLease } = require("./weekly-maintenance-schedule-control");

const { RUN_STATUS } = require("./cruise-discovery-controlled-production-run");
const {
  assertSilverseaWeeklyMaintenanceEnabled,
  SILVERSEA_WEEKLY_MAINTENANCE_RUN_TYPE
} = require("./cruise-discovery-maintenance");
const { executeWeeklyMaintenance } = require("./cruise-discovery-maintenance-cron");
const {
  assertSilverseaWeeklyAuth,
  assertCronAuth,
  cronSecret,
  isScheduledInvocation,
  isNetlifyPlatformScheduledInvocation,
  parseJsonBody,
  redactSecrets
} = require("./silversea-weekly-auth");

const BACKGROUND_FUNCTION_NAME = "silversea-weekly-maintenance-background";
const LAUNCHER_FUNCTION_NAME = "silversea-weekly-maintenance-cron";

function siteBaseUrl(env = process.env) {
  return String(env.URL || env.DEPLOY_PRIME_URL || env.NETLIFY_SITE_URL || "")
    .trim()
    .replace(/\/$/, "");
}

function resolveDryRun(body = {}, env = process.env) {
  if (body.dry_run === true || body.dryRun === true) return true;
  const enabled =
    String(env.SILVERSEA_WEEKLY_RECONCILIATION_ENABLED || "").trim().toLowerCase() === "true";
  if (!enabled) return true;
  if (body.dry_run === false || body.dryRun === false) return false;
  return !isNetlifyPlatformScheduledInvocation({ body, headers: { "x-netlify-event": "schedule" } });
}

function resolveTriggerType(event, body = {}) {
  if (body.trigger_type || body.triggerType) return String(body.trigger_type || body.triggerType);
  if (isNetlifyPlatformScheduledInvocation(event)) return "scheduled";
  return "manual";
}

async function dispatchSilverseaWeeklyBackground({
  dryRun,
  triggerType,
  dispatchId,
  nextRun = null,
  platformScheduled = false,
  env = process.env,
  fetchImpl = fetch
}) {
  const base = siteBaseUrl(env);
  const secret = cronSecret(env);
  if (!base) {
    const err = new Error("missing_site_url");
    err.statusCode = 503;
    throw err;
  }
  if (!secret) {
    const err = new Error("DISCOVERY_CRON_SECRET is not configured");
    err.statusCode = 503;
    throw err;
  }


  const scheduledClaim = await claimOrSkipScheduledBackgroundDispatch({
    supabase,
    lineSlug: "silversea-cruises",
    triggerType,
    dispatchId,
    dryRun
  });
  if (scheduledClaim.already_dispatched) return scheduledClaim.response;

  const url = `${base}/.netlify/functions/${BACKGROUND_FUNCTION_NAME}`;
  const payload = {
    dry_run: dryRun === true,
    trigger_type: triggerType,
    dispatch_id: dispatchId,
    authorised_scheduled_maintenance: platformScheduled === true,
    next_run: nextRun
  };

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-discovery-cron-secret": secret
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text().catch(() => "");
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: String(text).slice(0, 300) };
  }

  return {
    accepted: response.status === 202 || response.ok,
    status: response.status,
    url,
    dispatch_id: dispatchId,
    dry_run: dryRun === true,
    body
  };
}

async function runSilverseaWeeklyForExecutor(context = {}) {
  const report = await runSilverseaWeeklyMaintenance({
    supabase: context.supabase,
    dryRun: context.dryRun !== false,
    performWrites: context.performWrites === true,
    runId: context.runId
  });
  const blocked = report.status === RUN_STATUS.BLOCKED || report.status === "BLOCKED";
  const ok =
    report.status === "DRY_RUN_COMPLETE" ||
    report.status === RUN_STATUS.COMPLETE ||
    report.status === "COMPLETE";
  const identity = report.orchestration?.identity_reconciliation || {};
  const actions = report.orchestration?.action_summary || {};
  const source = report.source || {};
  const inventory = report.production_inventory || {};
  const gates = report.orchestration?.gates || {};
  const sourceHealthy = gates.source_healthy === true || source.health === "PASS";
  return {
    ok,
    success: ok,
    blocked,
    review_required: false,
    reason: report.block_reason || report.status || null,
    summary: {
      run_type: SILVERSEA_WEEKLY_MAINTENANCE_RUN_TYPE,
      run_id: context.runId,
      line_slug: LINE_SLUG,
      dry_run: context.dryRun !== false,
      eligible_total:
        source.summary?.eligible_beyond_cutoff ??
        (Number(identity.source_and_production || 0) + Number(identity.source_only || 0) || null),
      official_source_total: source.summary?.catalogue_nodes ?? source.summary?.unique_cruise_codes ?? null,
      active_production_total:
        inventory.active ??
        (Number(inventory.classic_active || 0) + Number(inventory.expedition_active || 0) || null),
      proposed_inserts: actions.INSERT_ELIGIBLE_PROPOSALS ?? report.plan?.counts?.insert ?? 0,
      proposed_updates: actions.UPDATE_ELIGIBLE_PROPOSALS ?? report.plan?.counts?.update ?? 0,
      source_absent_active: actions.SOURCE_ABSENT ?? 0,
      inserts: report.writes?.inserts ?? 0,
      updates: report.writes?.updates ?? 0,
      inventory_changed: (report.writes?.inserts || 0) + (report.writes?.updates || 0) > 0,
      silversea_report_status: report.status,
      source_healthy: sourceHealthy,
      quality_gate: {
        passed: sourceHealthy && gates.identity_complete !== false,
        source_healthy: sourceHealthy,
        identity_complete: gates.identity_complete === true,
        source_health: source.health || null
      },
      bounded_plan_counts: report.plan?.counts || null
    },
    report
  };
}

async function runSilverseaWeeklyBackgroundMaintenance({
  dryRun = true,
  triggerType = "background",
  dispatchId = null,
  supabaseClient = supabase
} = {}) {
  const sb = supabaseClient || supabase;
  const lines = await sb(`ci_cruise_lines?slug=eq.${encodeURIComponent(LINE_SLUG)}&select=id,name,slug&limit=1`);
  const line = lines?.[0];
  if (!line) {
    const err = new Error("Silversea line not found");
    err.statusCode = 404;
    throw err;
  }

  const result = await executeWeeklyMaintenance({
    lineSlug: LINE_SLUG,
    cruiseLineId: line.id,
    runType: SILVERSEA_WEEKLY_MAINTENANCE_RUN_TYPE || RUN_TYPE,
    assertEnabled: assertSilverseaWeeklyMaintenanceEnabled,
    runMaintenance: runSilverseaWeeklyForExecutor,
    dryRun: dryRun !== false,
    maxWrites: 1,
    triggerType,
    supabaseClient: sb,
    statsEnricher: (summary, extra) => ({ ...extra, dispatch_id: dispatchId })
  });

  return {
    ...result,
    line_slug: LINE_SLUG,
    run_type: RUN_TYPE,
    trigger_type: triggerType,
    dispatch_id: dispatchId,
    dry_run: dryRun !== false,
    report: result.summary || null
  };
}

module.exports = {
  BACKGROUND_FUNCTION_NAME,
  LAUNCHER_FUNCTION_NAME,
  resolveDryRun,
  resolveTriggerType,
  dispatchSilverseaWeeklyBackground,
  runSilverseaWeeklyBackgroundMaintenance,
  assertSilverseaWeeklyAuth,
  assertCronAuth,
  parseJsonBody,
  redactSecrets,
  isScheduledInvocation,
  isNetlifyPlatformScheduledInvocation
};
