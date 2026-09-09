/**
 * Shared weekly/daily maintenance operational statuses.
 *
 * REVIEW_REQUIRED with zero writes is not a technical failure.
 * A scheduled slot with no ledger row is MISSED, not silently absent.
 */

const OPERATIONAL_STATUSES = Object.freeze([
  "HEALTHY",
  "REVIEW_REQUIRED",
  "SOURCE_FAILURE",
  "WRITE_FAILURE",
  "MISSED_SCHEDULE",
  "DISABLED",
  "RUNNING",
  "STALE_ABANDONED",
  "BLOCKED_DUPLICATE"
]);

const DAILY_EXPIRY_SLOT_CRON_UTC = { hour: 17, minute: 30 };
const SLOT_LOOKBACK_MS = 30 * 60 * 1000;
const SLOT_LOOKAHEAD_MS = 90 * 60 * 1000;

function addCalendarDays(isoDate, days) {
  const [y, m, d] = String(isoDate).split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d + days));
  return utc.toISOString().slice(0, 10);
}

function perthDateToDailyExpiryUtc(perthDate) {
  const previous = addCalendarDays(perthDate, -1);
  return `${previous}T${String(DAILY_EXPIRY_SLOT_CRON_UTC.hour).padStart(2, "0")}:${String(
    DAILY_EXPIRY_SLOT_CRON_UTC.minute
  ).padStart(2, "0")}:00.000Z`;
}

function runMatchesExpirySlot(run, slotUtcIso) {
  const started = Date.parse(run?.started_at || run?.created_at || "");
  if (!Number.isFinite(started)) return false;
  const slot = Date.parse(slotUtcIso);
  return started >= slot - SLOT_LOOKBACK_MS && started <= slot + SLOT_LOOKAHEAD_MS;
}

function isGenuineExpiryLedgerRun(run) {
  if (!run) return false;
  if (run.stats?.run_type && run.stats.run_type !== "daily_expiry_maintenance") return false;
  if (run.stats?.already_dispatched === true) return true;
  return Boolean(run.id || run.started_at);
}

function detectMissedDailyExpirySlots(runs = [], { now = new Date(), lookbackDays = 14, perthDateFn = null } = {}) {
  const perthCalendarDate =
    perthDateFn ||
    ((reference) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Perth" }).format(reference));
  const todayPerth = perthCalendarDate(now);
  const slots = [];
  for (let i = lookbackDays; i >= 1; i -= 1) {
    const perthDate = addCalendarDays(todayPerth, -i);
    const utcStart = perthDateToDailyExpiryUtc(perthDate);
    if (Date.parse(utcStart) > now.getTime()) continue;
    const match = (runs || []).find((run) => runMatchesExpirySlot(run, utcStart) && isGenuineExpiryLedgerRun(run));
    slots.push({
      perth_date: perthDate,
      utc_start: utcStart,
      found: Boolean(match),
      status: match ? "PRESENT" : "MISSED",
      run_id: match?.id || match?.stats?.run_id || null
    });
  }
  return {
    missed: slots.filter((s) => s.status === "MISSED"),
    slots,
    latest_missed: slots.filter((s) => s.status === "MISSED").at(-1) || null
  };
}

function classifyOperationalStatus({
  enabled = true,
  running = false,
  abandoned = false,
  reviewRequired = false,
  sourceFailure = false,
  writeFailure = false,
  missedSchedule = false,
  blockedDuplicate = false
} = {}) {
  if (!enabled) return "DISABLED";
  if (running) return "RUNNING";
  if (abandoned) return "STALE_ABANDONED";
  if (blockedDuplicate) return "BLOCKED_DUPLICATE";
  if (reviewRequired) return "REVIEW_REQUIRED";
  if (sourceFailure) return "SOURCE_FAILURE";
  if (writeFailure) return "WRITE_FAILURE";
  if (missedSchedule) return "MISSED_SCHEDULE";
  return "HEALTHY";
}

function weeklyBackgroundHttpStatus(result = {}) {
  if (
    result.success === true ||
    result.review_required === true ||
    result.already_dispatched === true ||
    result.duplicate_background_invocation === true ||
    result.blocked === true
  ) {
    return 200;
  }
  return 500;
}

function isReviewRequiredZeroWrite(result = {}) {
  const writes =
    Number(result.summary?.inserts || 0) +
    Number(result.summary?.updates || 0) +
    Number(result.summary?.promoted_active || 0);
  return result.review_required === true && writes === 0;
}

module.exports = {
  OPERATIONAL_STATUSES,
  perthDateToDailyExpiryUtc,
  detectMissedDailyExpirySlots,
  classifyOperationalStatus,
  weeklyBackgroundHttpStatus,
  isReviewRequiredZeroWrite,
  runMatchesExpirySlot
};
