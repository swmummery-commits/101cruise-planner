/**
 * Royal Caribbean weekly maintenance — launcher ↔ background dispatch.
 */

const {
  isRoyalCaribbeanWeeklyReconciliationEnabled,
  assertRoyalCaribbeanWeeklyMaintenanceEnabled,
  ROYAL_CARIBBEAN_WEEKLY_MAINTENANCE_RUN_TYPE
} = require("./cruise-discovery-maintenance");
const { runFromMaintenanceRunner } = require("./cruise-discovery-maintenance-runner");
const { executeWeeklyMaintenance, supabase } = require("./cruise-discovery-maintenance-cron");
const { claimOrSkipScheduledBackgroundDispatch, releaseScheduledDispatchLease } = require("./weekly-maintenance-schedule-control");

const { parseJsonBody, redactSecrets, assertCronAuth } = require("./royal-caribbean-weekly-auth");
const {
  ROYAL_CARIBBEAN_MAX_WEEKLY_WRITES,
  ROYAL_CARIBBEAN_WEEKLY_WRITE_CEILING
} = require("./royal-caribbean-weekly-health");

const ROYAL_CARIBBEAN_LINE_SLUG = "royal-caribbean-international";
const BACKGROUND_FUNCTION_NAME = "royal-caribbean-weekly-maintenance-background";
const LAUNCHER_FUNCTION_NAME = "royal-caribbean-weekly-maintenance-cron";

function cronSecret(env = process.env) {
  return String(env.DISCOVERY_CRON_SECRET || "").trim();
}

function isWeeklyReconciliationEnabled(env = process.env) {
  return (
    String(env.ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED || "").trim().toLowerCase() === "true"
  );
}

function siteBaseUrl(env = process.env) {
  return String(env.URL || env.DEPLOY_PRIME_URL || env.NETLIFY_SITE_URL || "")
    .trim()
    .replace(/\/$/, "");
}

function netlifyContext(env = process.env) {
  return String(env.CONTEXT || env.NETLIFY_CONTEXT || "").trim().toLowerCase();
}

function isNetlifyProductionContext(env = process.env) {
  return netlifyContext(env) === "production";
}

function isNetlifyNonProductionContext(env = process.env) {
  const ctx = netlifyContext(env);
  return ctx === "deploy-preview" || ctx === "branch-deploy" || ctx === "dev" || ctx === "development";
}

function isScheduledInvocation(event) {
  const headers = event?.headers || {};
  return (
    String(headers["x-netlify-event"] || headers["X-Netlify-Event"] || "").toLowerCase() === "schedule" ||
    String(headers["x-nf-event"] || headers["X-NF-Event"] || "").toLowerCase() === "schedule" ||
    String(headers["netlify-scheduled"] || headers["Netlify-Scheduled"] || "").toLowerCase() === "true"
  );
}

/** Netlify scheduled functions include ISO next_run in the POST body. */
function isNetlifyPlatformScheduledInvocation(event) {
  if (!isScheduledInvocation(event)) return false;
  const body = parseJsonBody(event);
  return typeof body.next_run === "string" && /^\d{4}-\d{2}-\d{2}T/.test(body.next_run);
}

function assertLauncherAuth(event, env = process.env) {
  if (isScheduledInvocation(event)) return;
  assertCronAuth(event, env);
}

function scheduledEvent(event = null) {
  return {
    headers: {
      ...(event?.headers || {}),
      "x-netlify-event": "schedule"
    },
    body: event?.body ?? JSON.stringify({ next_run: "2026-08-17T23:00:00.000Z" })
  };
}

function resolveDryRun(body = {}, event = null, env = process.env) {
  if (body.dry_run === true || body.dryRun === true) return true;
  if (body.dry_run === false || body.dryRun === false) return false;

  if (event && isScheduledInvocation(event)) {
    if (!isWeeklyReconciliationEnabled(env)) return true;
    if (isNetlifyNonProductionContext(env)) return true;
    if (isNetlifyPlatformScheduledInvocation(event) && isNetlifyProductionContext(env)) return false;
    return true;
  }

  return true;
}

function resolveMaxWritesPolicy(body = {}, event = null, env = process.env, { dryRun = null } = {}) {
  const ceiling = ROYAL_CARIBBEAN_MAX_WEEKLY_WRITES;
  const explicit = body.max_writes ?? body.maxWrites;
  const hasExplicit = explicit !== undefined && explicit !== null && String(explicit).trim() !== "";

  if (hasExplicit) {
    const n = Number(explicit);
    if (!Number.isFinite(n) || n < 0) {
      return { maxWrites: 0, blocked: false, reason: null };
    }
    if (n > ceiling) {
      return {
        maxWrites: Math.floor(n),
        blocked: true,
        reason: "max_writes_exceeds_weekly_ceiling"
      };
    }
    return { maxWrites: Math.floor(n), blocked: false, reason: null };
  }

  const effectiveDryRun = dryRun ?? resolveDryRun(body, event, env);
  if (effectiveDryRun) {
    return { maxWrites: 0, blocked: false, reason: null };
  }

  if (
    event &&
    isNetlifyPlatformScheduledInvocation(event) &&
    isNetlifyProductionContext(env) &&
    isWeeklyReconciliationEnabled(env)
  ) {
    return { maxWrites: ceiling, blocked: false, reason: null };
  }

  return { maxWrites: 0, blocked: false, reason: null };
}

function resolveMaxWrites(body = {}, event = null, env = process.env) {
  const dryRun = resolveDryRun(body, event, env);
  return resolveMaxWritesPolicy(body, event, env, { dryRun }).maxWrites;
}

function resolveWeeklyExecutionPolicy(body = {}, event = null, env = process.env) {
  const dryRun = resolveDryRun(body, event, env);
  const maxWritesPolicy = resolveMaxWritesPolicy(body, event, env, { dryRun });
  return {
    dryRun,
    maxWrites: maxWritesPolicy.maxWrites,
    blocked: maxWritesPolicy.blocked,
    reason: maxWritesPolicy.reason,
    scheduled_invocation: event ? isScheduledInvocation(event) : false,
    platform_scheduled: event ? isNetlifyPlatformScheduledInvocation(event) : false,
    production_context: isNetlifyProductionContext(env),
    weekly_reconciliation_enabled: isWeeklyReconciliationEnabled(env)
  };
}

function resolveTriggerType(event, body = {}) {
  if (body.trigger_type || body.triggerType) return String(body.trigger_type || body.triggerType);
  if (isScheduledInvocation(event)) return "scheduled";
  return "manual";
}

function resolveBackgroundExecution(body = {}, event = null, env = process.env) {
  if (body.dry_run === true || body.dryRun === true) {
    return { dryRun: true, maxWrites: 0, blocked: false, reason: null };
  }
  if (body.dry_run === false || body.dryRun === false) {
    const maxPolicy = resolveMaxWritesPolicy(body, event, env, { dryRun: false });
    if (maxPolicy.blocked) {
      return { dryRun: true, maxWrites: 0, blocked: true, reason: maxPolicy.reason };
    }
    return { dryRun: false, maxWrites: maxPolicy.maxWrites, blocked: false, reason: null };
  }
  const policy = resolveWeeklyExecutionPolicy(body, event, env);
  if (policy.blocked) {
    return { dryRun: true, maxWrites: 0, blocked: true, reason: policy.reason };
  }
  return {
    dryRun: policy.dryRun,
    maxWrites: policy.maxWrites,
    blocked: false,
    reason: null
  };
}

function buildBackgroundPayload({ dryRun, maxWrites, triggerType, dispatchId, runId }) {
  return {
    dry_run: dryRun === true,
    max_writes: maxWrites,
    trigger_type: triggerType,
    dispatch_id: dispatchId,
    run_id: runId,
    authorised_scheduled_maintenance: true
  };
}

async function dispatchRoyalCaribbeanWeeklyBackground({
  dryRun,
  maxWrites,
  triggerType,
  dispatchId,
  runId = null,
  env = process.env,
  fetchImpl = fetch
}) {
  const base = siteBaseUrl(env);
  const secret = cronSecret(env);
  if (!base) {
    const err = new Error("missing_site_url");
    err.code = "missing_site_url";
    err.statusCode = 503;
    throw err;
  }
  if (!secret) {
    const err = new Error("DISCOVERY_CRON_SECRET is not configured");
    err.code = "discovery_cron_secret_missing";
    err.statusCode = 503;
    throw err;
  }


  const scheduledClaim = await claimOrSkipScheduledBackgroundDispatch({
    supabase,
    lineSlug: "royal-caribbean-international",
    triggerType,
    dispatchId,
    dryRun
  });
  if (scheduledClaim.already_dispatched) return scheduledClaim.response;

  const url = `${base}/.netlify/functions/${BACKGROUND_FUNCTION_NAME}`;
  const payload = buildBackgroundPayload({ dryRun, maxWrites, triggerType, dispatchId, runId });

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-discovery-cron-secret": secret
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text().catch(() => "");
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: String(text).slice(0, 300) };
  }

  const accepted = response.status === 202 || response.ok;
  return {
    accepted,
    status: response.status,
    url,
    dispatch_id: dispatchId,
    run_id: runId,
    dry_run: dryRun === true,
    max_writes: maxWrites,
    trigger_type: triggerType,
    body: redactSecrets(parsed)
  };
}

function enrichRoyalCaribbeanMaintenanceStats(summary = {}, extra = {}) {
  const policy = summary.source_absence_policy || {};
  return {
    source_snapshot_id: summary.source_snapshot_id || summary.snapshot_id || null,
    union_sailing_identities: summary.union_sailing_identities ?? null,
    recognised_existing_eligible: summary.recognised_existing_eligible_sailings ?? null,
    proposed_inserts: summary.proposed_inserts ?? 0,
    proposed_updates: summary.proposed_updates ?? 0,
    weekly_maintenance_healthy: summary.weekly_maintenance_healthy ?? null,
    royal_caribbean_source_enumeration_ok: summary.royal_caribbean_source_enumeration_ok ?? null,
    reconciliation_arithmetic_ok: summary.reconciliation_arithmetic_ok ?? null,
    source_absent_candidate_count: policy.source_absent_candidate_count ?? summary.source_absent_active ?? null,
    source_absent_action_eligible_count: policy.source_absent_action_eligible_count ?? null,
    cutoff_candidate_count: Array.isArray(summary.production_cutoff_candidates)
      ? summary.production_cutoff_candidates.length
      : null,
    weekly_manifest_hash: summary.weekly_manifest_hash ?? null,
    actual_writes: summary.actual_writes ?? 0,
    production_cruise_inserts: summary.production_cruise_inserts ?? 0,
    production_cruise_updates: summary.production_cruise_updates ?? 0,
    production_expiry_changes: summary.production_expiry_changes ?? 0,
    dry_run: summary.dry_run === true,
    failure_reason: summary.failure_reason ?? null,
    ...extra
  };
}

async function runRoyalCaribbeanWeeklyBackgroundMaintenance({
  dryRun,
  maxWrites,
  triggerType,
  dispatchId = null,
  runId = null,
  supabaseClient = null
}) {
  const sb = supabaseClient || supabase;
  const lines = await sb(
    `ci_cruise_lines?slug=eq.${encodeURIComponent(ROYAL_CARIBBEAN_LINE_SLUG)}&select=id,name,slug&limit=1`
  );
  const line = lines?.[0];
  if (!line) {
    const err = new Error("Royal Caribbean line not found");
    err.statusCode = 404;
    err.code = "royal_caribbean_line_not_found";
    throw err;
  }

  const started = Date.now();
  const result = await executeWeeklyMaintenance({
    lineSlug: ROYAL_CARIBBEAN_LINE_SLUG,
    cruiseLineId: line.id,
    runType: ROYAL_CARIBBEAN_WEEKLY_MAINTENANCE_RUN_TYPE,
    assertEnabled: assertRoyalCaribbeanWeeklyMaintenanceEnabled,
    runMaintenance: (opts) =>
      runFromMaintenanceRunner({
        ...opts,
        useRunRecord: false,
        supabaseClient: sb
      }),
    dryRun,
    maxWrites,
    triggerType,
    supabaseClient: sb,
    statsEnricher: (summary, extra) => enrichRoyalCaribbeanMaintenanceStats(summary, extra)
  });

  const summary = result.summary || {};
  console.info(
    "royal-caribbean-weekly-maintenance-background summary",
    redactSecrets({
      dispatch_id: dispatchId,
      run_id: result.run_id || runId || summary.run_id || null,
      run_record_id: result.run_record_id || null,
      trigger_type: triggerType,
      dry_run: dryRun === true,
      weekly_maintenance_healthy: summary.weekly_maintenance_healthy ?? null,
      royal_caribbean_source_enumeration_ok: summary.royal_caribbean_source_enumeration_ok ?? null,
      proposed_inserts: summary.proposed_inserts ?? null,
      proposed_updates: summary.proposed_updates ?? null,
      actual_writes: summary.actual_writes ?? 0,
      elapsed_ms: Date.now() - started
    })
  );

  return {
    ...result,
    dispatch_id: dispatchId,
    run_id: runId || result.run_id || summary.run_id || null,
    phase: "background_maintenance",
    status:
      result.blocked && result.already_running
        ? "already_running"
        : result.success
          ? "completed"
          : "failed"
  };
}

module.exports = {
  ROYAL_CARIBBEAN_LINE_SLUG,
  ROYAL_CARIBBEAN_MAX_WEEKLY_WRITES,
  ROYAL_CARIBBEAN_WEEKLY_WRITE_CEILING,
  BACKGROUND_FUNCTION_NAME,
  LAUNCHER_FUNCTION_NAME,
  parseJsonBody,
  redactSecrets,
  netlifyContext,
  isNetlifyProductionContext,
  isNetlifyNonProductionContext,
  isScheduledInvocation,
  isNetlifyPlatformScheduledInvocation,
  scheduledEvent,
  resolveDryRun,
  resolveMaxWrites,
  resolveMaxWritesPolicy,
  resolveWeeklyExecutionPolicy,
  resolveBackgroundExecution,
  resolveTriggerType,
  buildBackgroundPayload,
  assertLauncherAuth,
  assertCronAuth,
  dispatchRoyalCaribbeanWeeklyBackground,
  runRoyalCaribbeanWeeklyBackgroundMaintenance,
  enrichRoyalCaribbeanMaintenanceStats
};
