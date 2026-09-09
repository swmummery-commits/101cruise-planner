/**
 * Scheduled-maintenance dispatch leases and invocation provenance.
 *
 * Scheduled weekly work is at-least-once. A deterministic Perth-week (or Perth-date
 * for daily expiry) lease prevents a second launcher from dispatching another worker
 * or creating a misleading second run. Manual authorised runs skip the lease.
 */

const {
  perthCalendarDate,
  OPERATIONAL_TIMEZONE
} = require("./cruise-discovery-maintenance");
const {
  acquireMaintenanceDbLock,
  releaseMaintenanceDbLock,
  loadMaintenanceLockStatus
} = require("./cruise-discovery-maintenance-locks");

const WEEKLY_DISPATCH_LEASE_SECONDS = 8 * 24 * 60 * 60;
const DAILY_DISPATCH_LEASE_SECONDS = 26 * 60 * 60;
const BACKGROUND_DISPATCH_LEASE_SECONDS = 2 * 60 * 60;

function perthIsoWeek(reference = new Date()) {
  const calendar = perthCalendarDate(reference);
  const [year, month, day] = calendar.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

function scheduledWeeklyDispatchKey(lineSlug, reference = new Date()) {
  return `${lineSlug}:${perthIsoWeek(reference)}:scheduled`;
}

function scheduledDailyExpiryDispatchKey(reference = new Date()) {
  return `daily-expiry:${perthCalendarDate(reference)}:scheduled`;
}

function backgroundDispatchExecutionKey(dispatchId) {
  return `background-dispatch:${String(dispatchId || "").trim()}`;
}

function headerValue(event, name) {
  const headers = event?.headers || {};
  const lower = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === lower) return String(value || "").trim();
  }
  return "";
}

function collectInvocationProvenance(event = {}, env = process.env, extras = {}) {
  return {
    netlify_site_id: env.SITE_ID || env.NETLIFY_SITE_ID || null,
    deploy_id: env.DEPLOY_ID || null,
    commit_ref: env.COMMIT_REF || env.CACHED_COMMIT_REF || null,
    url: env.URL || null,
    deploy_prime_url: env.DEPLOY_PRIME_URL || null,
    context: env.CONTEXT || env.NETLIFY_CONTEXT || null,
    function_name: extras.function_name || env.NETLIFY_FUNCTION_NAME || null,
    aws_request_id:
      headerValue(event, "x-amzn-requestid") ||
      headerValue(event, "lambda-runtime-aws-request-id") ||
      extras.aws_request_id ||
      null,
    dispatch_id: extras.dispatch_id || null,
    netlify_event: headerValue(event, "x-netlify-event") || headerValue(event, "x-nf-event") || null
  };
}

async function claimScheduledDispatchLease(supabase, {
  periodKey,
  ownerId,
  triggerType = "scheduled",
  leaseSeconds = WEEKLY_DISPATCH_LEASE_SECONDS
} = {}) {
  if (triggerType !== "scheduled") {
    return {
      claimed: true,
      already_dispatched: false,
      skipped: true,
      reason: "manual_authorised",
      period_key: periodKey || null
    };
  }
  if (!supabase || !periodKey || !ownerId) {
    return {
      claimed: false,
      already_dispatched: false,
      skipped: true,
      reason: "invalid_dispatch_lease_parameters",
      period_key: periodKey || null
    };
  }

  const existing = await loadMaintenanceLockStatus(supabase, periodKey).catch(() => ({ held: false }));
  if (existing.held) {
    return {
      claimed: false,
      already_dispatched: true,
      reason: "already_dispatched",
      period_key: periodKey,
      lock: existing
    };
  }

  let lock;
  try {
    lock = await acquireMaintenanceDbLock(supabase, {
      lockKey: periodKey,
      ownerId,
      runId: ownerId,
      leaseSeconds
    });
  } catch (error) {
    return {
      claimed: false,
      already_dispatched: false,
      skipped: true,
      reason: "dispatch_lease_unavailable",
      period_key: periodKey,
      error: error.message || String(error)
    };
  }

  if (!lock.acquired) {
    return {
      claimed: false,
      already_dispatched: true,
      reason: "already_dispatched",
      period_key: periodKey,
      lock
    };
  }

  return {
    claimed: true,
    already_dispatched: false,
    reason: null,
    period_key: periodKey,
    lock
  };
}

async function releaseScheduledDispatchLease(supabase, { periodKey, ownerId }) {
  if (!supabase || !periodKey || !ownerId) return false;
  return releaseMaintenanceDbLock(supabase, { lockKey: periodKey, ownerId });
}

async function claimOrSkipScheduledBackgroundDispatch({
  supabase,
  lineSlug,
  triggerType,
  dispatchId,
  dryRun = false,
  extra = {}
}) {
  const periodKey = scheduledWeeklyDispatchKey(lineSlug);
  const claim = await claimScheduledDispatchLease(supabase, {
    periodKey,
    ownerId: dispatchId,
    triggerType
  });
  if (claim.already_dispatched) {
    return {
      already_dispatched: true,
      period_key: periodKey,
      claim,
      response: {
        accepted: true,
        already_dispatched: true,
        status: 200,
        url: null,
        dispatch_id: dispatchId,
        dry_run: dryRun === true,
        trigger_type: triggerType,
        period_key: periodKey,
        body: { status: "already_dispatched" },
        ...extra
      }
    };
  }
  if (triggerType === "scheduled" && claim.claimed !== true) {
    const err = new Error(claim.reason || "dispatch_lease_unavailable");
    err.code = "dispatch_lease_unavailable";
    err.statusCode = 503;
    throw err;
  }
  return { already_dispatched: false, period_key: periodKey, claim };
}

async function withScheduledDispatchLease({
  supabase,
  lineSlug,
  triggerType,
  dispatchId,
  reference = new Date(),
  dailyExpiry = false,
  dispatch
}) {
  const periodKey = dailyExpiry
    ? scheduledDailyExpiryDispatchKey(reference)
    : scheduledWeeklyDispatchKey(lineSlug, reference);
  const leaseSeconds = dailyExpiry ? DAILY_DISPATCH_LEASE_SECONDS : WEEKLY_DISPATCH_LEASE_SECONDS;
  const claim = await claimScheduledDispatchLease(supabase, {
    periodKey,
    ownerId: dispatchId,
    triggerType,
    leaseSeconds
  });

  if (claim.already_dispatched) {
    return {
      already_dispatched: true,
      claimed: false,
      claim,
      period_key: periodKey,
      kick: null
    };
  }

  if (triggerType === "scheduled" && claim.claimed !== true) {
    return {
      already_dispatched: false,
      claimed: false,
      claim,
      period_key: periodKey,
      kick: null
    };
  }

  try {
    const kick = await dispatch();
    if (triggerType === "scheduled" && claim.claimed && kick && kick.accepted === false) {
      await releaseScheduledDispatchLease(supabase, { periodKey, ownerId: dispatchId });
    }
    return {
      already_dispatched: false,
      claimed: claim.claimed === true,
      claim,
      period_key: periodKey,
      kick
    };
  } catch (error) {
    if (triggerType === "scheduled" && claim.claimed) {
      await releaseScheduledDispatchLease(supabase, { periodKey, ownerId: dispatchId }).catch(() => null);
    }
    throw error;
  }
}

function alreadyDispatchedHttpResponse({
  dispatchId,
  periodKey,
  launcher,
  elapsedMs,
  redactSecrets = (v) => v
}) {
  return {
    statusCode: 200,
    body: JSON.stringify(
      redactSecrets({
        success: true,
        phase: "dispatch",
        status: "already_dispatched",
        already_dispatched: true,
        launcher,
        dispatch_id: dispatchId,
        period_key: periodKey,
        elapsed_ms: elapsedMs,
        note: "Schedule-period dispatch already claimed; no second background worker started."
      })
    )
  };
}

function dispatchLeaseUnavailableHttpResponse({
  dispatchId,
  periodKey,
  launcher,
  elapsedMs,
  claim = {},
  redactSecrets = (v) => v
}) {
  return {
    statusCode: 503,
    body: JSON.stringify(
      redactSecrets({
        success: false,
        phase: "dispatch",
        status: "dispatch_lease_unavailable",
        already_dispatched: false,
        claimed: false,
        launcher,
        dispatch_id: dispatchId,
        period_key: periodKey,
        reason: claim.reason || "dispatch_lease_unavailable",
        elapsed_ms: elapsedMs,
        note: "Schedule-dedupe control plane failed closed; background worker was not started."
      })
    )
  };
}

async function claimBackgroundDispatchExecutionLease(supabase, {
  dispatchId,
  ownerId = null,
  leaseSeconds = BACKGROUND_DISPATCH_LEASE_SECONDS
} = {}) {
  const id = String(dispatchId || "").trim();
  if (!id) {
    return {
      claimed: true,
      already_executed: false,
      skipped: true,
      reason: "no_dispatch_id",
      period_key: null
    };
  }
  if (!supabase) {
    return {
      claimed: false,
      already_executed: false,
      skipped: true,
      reason: "dispatch_lease_unavailable",
      period_key: backgroundDispatchExecutionKey(id)
    };
  }
  const periodKey = backgroundDispatchExecutionKey(id);
  const owner = String(ownerId || id).trim();
  const existing = await loadMaintenanceLockStatus(supabase, periodKey).catch(() => ({ held: false }));
  if (existing.held) {
    return {
      claimed: false,
      already_executed: true,
      reason: "duplicate_background_invocation",
      period_key: periodKey,
      lock: existing
    };
  }
  try {
    const lock = await acquireMaintenanceDbLock(supabase, {
      lockKey: periodKey,
      ownerId: owner,
      runId: owner,
      leaseSeconds
    });
    if (!lock.acquired) {
      return {
        claimed: false,
        already_executed: true,
        reason: "duplicate_background_invocation",
        period_key: periodKey,
        lock
      };
    }
    return {
      claimed: true,
      already_executed: false,
      reason: null,
      period_key: periodKey,
      lock
    };
  } catch (error) {
    return {
      claimed: false,
      already_executed: false,
      skipped: true,
      reason: "dispatch_lease_unavailable",
      period_key: periodKey,
      error: error.message || String(error)
    };
  }
}

function duplicateBackgroundInvocationResult({ dispatchId, periodKey = null } = {}) {
  return {
    ok: true,
    success: true,
    blocked: false,
    review_required: false,
    duplicate_background_invocation: true,
    already_running: false,
    reason: "duplicate_background_invocation",
    run_id: null,
    run_record_id: null,
    summary: {
      terminal_status: "duplicate_background_invocation",
      dispatch_id: dispatchId || null,
      period_key: periodKey,
      inserts: 0,
      updates: 0,
      inventory_changed: false,
      writes_performed: 0
    }
  };
}

async function handleLeasedWeeklyCron(event, {
  supabase,
  lineSlug,
  launcherFunctionName,
  backgroundFunctionName = null,
  redactSecrets,
  assertAuth,
  parseJsonBody,
  resolveDryRun,
  resolveMaxWrites = null,
  resolveTriggerType,
  dispatchBackground,
  extraDispatchArgs = {},
  earlyResponse = null
} = {}) {
  const started = Date.now();
  if (earlyResponse) return earlyResponse;
  assertAuth(event);
  const body = parseJsonBody(event);
  const dryRun = resolveDryRun(body);
  const maxWrites = resolveMaxWrites ? resolveMaxWrites(body) : undefined;
  const triggerType = resolveTriggerType(event, body);
  const dispatchId =
    extraDispatchArgs.dispatchId ||
    `${String(lineSlug || "weekly").replace(/[^a-z0-9]+/gi, "-")}-dispatch-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}`;
  const provenance = collectInvocationProvenance(event, process.env, {
    function_name: launcherFunctionName,
    dispatch_id: dispatchId
  });

  const leased = await withScheduledDispatchLease({
    supabase,
    lineSlug,
    triggerType,
    dispatchId,
    dispatch: () =>
      dispatchBackground({
        dryRun,
        maxWrites,
        triggerType,
        dispatchId,
        nextRun: body.next_run || null,
        provenance,
        ...extraDispatchArgs
      })
  });

  if (leased.already_dispatched) {
    return alreadyDispatchedHttpResponse({
      dispatchId,
      periodKey: leased.period_key,
      launcher: launcherFunctionName,
      elapsedMs: Date.now() - started,
      redactSecrets
    });
  }

  if (triggerType === "scheduled" && leased.claimed !== true) {
    return dispatchLeaseUnavailableHttpResponse({
      dispatchId,
      periodKey: leased.period_key,
      launcher: launcherFunctionName,
      elapsedMs: Date.now() - started,
      claim: leased.claim || {},
      redactSecrets
    });
  }

  const kick = leased.kick;
  const elapsed_ms = Date.now() - started;
  if (!kick?.accepted) {
    return {
      statusCode: 502,
      body: JSON.stringify(
        redactSecrets({
          success: false,
          phase: "dispatch",
          status: "dispatch_failed",
          launcher: launcherFunctionName,
          background: backgroundFunctionName,
          dispatch_id: dispatchId,
          dry_run: dryRun,
          trigger_type: triggerType,
          invocation_provenance: provenance,
          background_http_status: kick?.status || null,
          error: "background_dispatch_rejected",
          detail: kick?.body,
          elapsed_ms
        })
      )
    };
  }

  return {
    statusCode: 202,
    body: JSON.stringify(
      redactSecrets({
        success: true,
        phase: "dispatch",
        status: "dispatched",
        maintenance_status: "pending_background",
        launcher: launcherFunctionName,
        background: backgroundFunctionName,
        dispatch_id: dispatchId,
        dry_run: dryRun,
        max_writes: maxWrites,
        trigger_type: triggerType,
        invocation_provenance: provenance,
        background_http_status: kick.status,
        elapsed_ms,
        note: "Background worker owns run-record lifecycle; poll cruise_discovery_runs for completion."
      })
    )
  };
}

module.exports = {
  OPERATIONAL_TIMEZONE,
  WEEKLY_DISPATCH_LEASE_SECONDS,
  DAILY_DISPATCH_LEASE_SECONDS,
  BACKGROUND_DISPATCH_LEASE_SECONDS,
  perthIsoWeek,
  scheduledWeeklyDispatchKey,
  scheduledDailyExpiryDispatchKey,
  backgroundDispatchExecutionKey,
  collectInvocationProvenance,
  claimScheduledDispatchLease,
  releaseScheduledDispatchLease,
  withScheduledDispatchLease,
  claimOrSkipScheduledBackgroundDispatch,
  claimBackgroundDispatchExecutionLease,
  alreadyDispatchedHttpResponse,
  dispatchLeaseUnavailableHttpResponse,
  duplicateBackgroundInvocationResult,
  handleLeasedWeeklyCron
};
