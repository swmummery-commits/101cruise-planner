/**
 * Royal Caribbean weekly maintenance — launcher ↔ background dispatch + branch runtime proof.
 */

const {
  isRoyalCaribbeanWeeklyReconciliationEnabled,
  assertRoyalCaribbeanWeeklyMaintenanceEnabled,
  ROYAL_CARIBBEAN_WEEKLY_MAINTENANCE_RUN_TYPE
} = require("./cruise-discovery-maintenance");
const { runFromMaintenanceRunner } = require("./cruise-discovery-maintenance-runner");
const { executeWeeklyMaintenance, supabase } = require("./cruise-discovery-maintenance-cron");
const {
  parseJsonBody,
  redactSecrets,
  buildCompactRuntimeSummary,
  assertCronAuth,
  assertBranchRuntimeProofAccess,
  isBranchRuntimeProofRequest,
  BRANCH_RUNTIME_PROOF_MODE
} = require("./royal-caribbean-runtime-proof");
const { saveRuntimeProofResult } = require("./royal-caribbean-runtime-result-store");

const ROYAL_CARIBBEAN_LINE_SLUG = "royal-caribbean-international";
const BACKGROUND_FUNCTION_NAME = "royal-caribbean-weekly-maintenance-background";
const LAUNCHER_FUNCTION_NAME = "royal-caribbean-weekly-maintenance-cron";
const RUNTIME_PROOF_LAUNCHER_FUNCTION_NAME = "royal-caribbean-runtime-proof-launcher";

function cronSecret(env = process.env) {
  return String(env.DISCOVERY_CRON_SECRET || "").trim();
}

function siteBaseUrl(env = process.env) {
  return String(env.URL || env.DEPLOY_PRIME_URL || env.NETLIFY_SITE_URL || "")
    .trim()
    .replace(/\/$/, "");
}

function isScheduledInvocation(event) {
  const headers = event?.headers || {};
  return (
    String(headers["x-netlify-event"] || headers["X-Netlify-Event"] || "").toLowerCase() === "schedule" ||
    String(headers["x-nf-event"] || headers["X-NF-Event"] || "").toLowerCase() === "schedule" ||
    String(headers["netlify-scheduled"] || headers["Netlify-Scheduled"] || "").toLowerCase() === "true"
  );
}

function assertLauncherAuth(event, env = process.env) {
  if (isScheduledInvocation(event)) return;
  assertCronAuth(event, env);
}

function resolveDryRun(body = {}, env = process.env) {
  if (body.mode === BRANCH_RUNTIME_PROOF_MODE) return true;
  if (body.dry_run === true || body.dryRun === true) return true;
  if (!isRoyalCaribbeanWeeklyReconciliationEnabled()) return true;
  return false;
}

function resolveMaxWrites(body = {}) {
  const n = Number(body.max_writes ?? body.maxWrites ?? 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function resolveTriggerType(event, body = {}) {
  if (body.trigger_type || body.triggerType) return String(body.trigger_type || body.triggerType);
  if (body.mode === BRANCH_RUNTIME_PROOF_MODE) return "branch_runtime_proof";
  if (isScheduledInvocation(event)) return "scheduled";
  return "manual";
}

function buildBackgroundPayload({ dryRun, maxWrites, triggerType, dispatchId, runId, body = {} }) {
  return {
    dry_run: dryRun === true,
    max_writes: maxWrites,
    trigger_type: triggerType,
    dispatch_id: dispatchId,
    run_id: runId,
    authorised_scheduled_maintenance: true,
    mode: body.mode || null,
    confirmation: body.confirmation || null
  };
}

async function dispatchRoyalCaribbeanWeeklyBackground({
  dryRun,
  maxWrites,
  triggerType,
  dispatchId,
  runId = null,
  body = {},
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
  const branchProofDispatch = triggerType === "branch_runtime_proof" || body.mode === BRANCH_RUNTIME_PROOF_MODE;
  if (!secret && !branchProofDispatch) {
    const err = new Error("DISCOVERY_CRON_SECRET is not configured");
    err.code = "discovery_cron_secret_missing";
    err.statusCode = 503;
    throw err;
  }

  const url = `${base}/.netlify/functions/${BACKGROUND_FUNCTION_NAME}`;
  const payload = buildBackgroundPayload({ dryRun, maxWrites, triggerType, dispatchId, runId, body });

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-discovery-cron-secret": secret || ""
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
    supabaseClient: sb
  });

  return {
    ...result,
    dispatch_id: dispatchId,
    run_id: runId || result.summary?.run_id || null,
    phase: "background_maintenance",
    status:
      result.blocked && result.already_running
        ? "already_running"
        : result.success
          ? "completed"
          : "failed"
  };
}

async function runRoyalCaribbeanRuntimeProofBackground(context = {}) {
  const runId = String(context.runId || context.run_id || "").trim();
  if (!runId) {
    const err = new Error("run_id_required");
    err.code = "run_id_required";
    err.statusCode = 400;
    throw err;
  }

  const result = await runFromMaintenanceRunner({
    dryRun: true,
    performWrites: false,
    authoritativeEnumeration: true,
    runId,
    run_id: runId,
    triggerType: context.triggerType || context.trigger_type || "branch_runtime_proof",
    supabaseClient: context.supabaseClient || context.supabase || supabase,
    useRunRecord: false
  });

  const compact = buildCompactRuntimeSummary(result, { run_id: runId });
  await saveRuntimeProofResult(runId, compact, { event: context.event || null });

  return {
    ok: result.ok === true,
    run_id: runId,
    compact,
    summary: result.summary || null,
    phase: "branch_runtime_proof",
    actual_writes: compact.actual_writes
  };
}

module.exports = {
  ROYAL_CARIBBEAN_LINE_SLUG,
  BACKGROUND_FUNCTION_NAME,
  LAUNCHER_FUNCTION_NAME,
  RUNTIME_PROOF_LAUNCHER_FUNCTION_NAME,
  parseJsonBody,
  redactSecrets,
  resolveDryRun,
  resolveMaxWrites,
  resolveTriggerType,
  assertLauncherAuth,
  assertCronAuth,
  assertBranchRuntimeProofAccess,
  isScheduledInvocation,
  dispatchRoyalCaribbeanWeeklyBackground,
  runRoyalCaribbeanWeeklyBackgroundMaintenance,
  runRoyalCaribbeanRuntimeProofBackground
};
