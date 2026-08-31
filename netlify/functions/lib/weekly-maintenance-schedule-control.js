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
  releaseMaintenanceDbLock
} = require("./cruise-discovery-maintenance-locks");

const WEEKLY_DISPATCH_LEASE_SECONDS = 8 * 24 * 60 * 60;
const DAILY_DISPATCH_LEASE_SECONDS = 26 * 60 * 60;

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
      claimed: true,
      already_dispatched: false,
      skipped: true,
      reason: "invalid_dispatch_lease_parameters",
      period_key: periodKey || null
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
      claimed: true,
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

module.exports = {
  OPERATIONAL_TIMEZONE,
  WEEKLY_DISPATCH_LEASE_SECONDS,
  DAILY_DISPATCH_LEASE_SECONDS,
  perthIsoWeek,
  scheduledWeeklyDispatchKey,
  scheduledDailyExpiryDispatchKey,
  collectInvocationProvenance,
  claimScheduledDispatchLease,
  releaseScheduledDispatchLease,
  withScheduledDispatchLease,
  claimOrSkipScheduledBackgroundDispatch,
  alreadyDispatchedHttpResponse
};
