/**
 * Canonical staggered weekly maintenance timetable (Australia/Perth).
 * Source of truth for monitoring. Do not change slot times here without
 * an explicit schedule change in netlify.toml / GitHub Actions.
 */

function perthCalendarDate(reference = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Perth" }).format(reference);
}

const WEEKDAY_INDEX = Object.freeze({
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
});

const WEEKLY_LINE_SCHEDULE = Object.freeze([
  {
    slug: "holland-america-line",
    key: "hal_weekly",
    label: "Holland America",
    weekday: "monday",
    perth_hour: 1,
    perth_minute: 0,
    scheduler: "netlify",
    cron_utc: "0 17 * * 0"
  },
  {
    slug: "celebrity-cruises",
    key: "celebrity_weekly",
    label: "Celebrity",
    weekday: "monday",
    perth_hour: 3,
    perth_minute: 0,
    scheduler: "netlify",
    cron_utc: "0 19 * * 0"
  },
  {
    slug: "princess-cruises",
    key: "princess_weekly",
    label: "Princess",
    weekday: "monday",
    perth_hour: 5,
    perth_minute: 0,
    scheduler: "github",
    cron_utc: "0 21 * * 0",
    netlify_scheduled: false
  },
  {
    slug: "explora-journeys",
    key: "explora_weekly",
    label: "Explora",
    weekday: "tuesday",
    perth_hour: 1,
    perth_minute: 0,
    scheduler: "netlify",
    cron_utc: "0 17 * * 1"
  },
  {
    slug: "seabourn-cruise-line",
    key: "seabourn_weekly",
    label: "Seabourn",
    weekday: "tuesday",
    perth_hour: 3,
    perth_minute: 0,
    scheduler: "netlify",
    cron_utc: "0 19 * * 1"
  },
  {
    slug: "royal-caribbean-international",
    key: "royal_caribbean_weekly",
    label: "Royal Caribbean",
    weekday: "wednesday",
    perth_hour: 1,
    perth_minute: 0,
    scheduler: "netlify",
    cron_utc: "0 17 * * 2"
  },
  {
    slug: "norwegian-cruise-line",
    key: "norwegian_weekly",
    label: "Norwegian",
    weekday: "wednesday",
    perth_hour: 3,
    perth_minute: 0,
    scheduler: "netlify",
    cron_utc: "0 19 * * 2"
  },
  {
    slug: "carnival-cruise-line",
    key: "carnival_weekly",
    label: "Carnival",
    weekday: "thursday",
    perth_hour: 1,
    perth_minute: 0,
    scheduler: "netlify",
    cron_utc: "0 17 * * 3"
  },
  {
    slug: "disney-cruise-line",
    key: "disney_weekly",
    label: "Disney",
    weekday: "thursday",
    perth_hour: 3,
    perth_minute: 0,
    scheduler: "netlify",
    cron_utc: "0 19 * * 3"
  },
  {
    slug: "azamara",
    key: "azamara_weekly",
    label: "Azamara",
    weekday: "friday",
    perth_hour: 1,
    perth_minute: 0,
    scheduler: "netlify",
    cron_utc: "0 17 * * 4"
  },
  {
    slug: "silversea-cruises",
    key: "silversea_weekly",
    label: "Silversea",
    weekday: "friday",
    perth_hour: 3,
    perth_minute: 0,
    scheduler: "netlify",
    cron_utc: "0 19 * * 4"
  }
]);

const DEFAULT_MISSED_GRACE_MS = 20 * 60 * 1000;

function addUtcDays(isoDate, days) {
  const [y, m, d] = String(isoDate).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function perthWeekdayName(reference = new Date()) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "Australia/Perth", weekday: "long" })
    .format(reference)
    .toLowerCase();
}

function perthHourMinute(reference = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Australia/Perth",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(reference);
  const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value || 0);
  return { hour, minute };
}

function thisWeekPerthDateForWeekday(weekday, reference = new Date()) {
  const today = perthCalendarDate(reference);
  const todayIdx = WEEKDAY_INDEX[perthWeekdayName(reference)];
  const targetIdx = WEEKDAY_INDEX[String(weekday || "").toLowerCase()];
  return addUtcDays(today, targetIdx - todayIdx);
}

function slotStartMs(schedule, reference = new Date()) {
  const date = thisWeekPerthDateForWeekday(schedule.weekday, reference);
  return Date.parse(`${date}T${String(schedule.perth_hour).padStart(2, "0")}:${String(schedule.perth_minute).padStart(2, "0")}:00+08:00`);
}

function formatPerthSlot(schedule) {
  const weekday = String(schedule.weekday || "").slice(0, 3).toUpperCase();
  return `${weekday} ${String(schedule.perth_hour).padStart(2, "0")}:${String(schedule.perth_minute).padStart(2, "0")}`;
}

function classifyWeeklyDueState({
  now = new Date(),
  schedule,
  scheduledExecutionExists = false,
  workerRunning = false,
  graceMs = DEFAULT_MISSED_GRACE_MS
} = {}) {
  if (!schedule) return { due_state: "NOT_DUE", reason: "unknown_schedule" };
  const start = slotStartMs(schedule, now);
  const nowMs = now.getTime();
  if (!Number.isFinite(start)) return { due_state: "NOT_DUE", reason: "invalid_slot" };
  if (nowMs < start) {
    return {
      due_state: "NOT_DUE",
      missed: false,
      slot_start_ms: start,
      perth_slot: formatPerthSlot(schedule)
    };
  }
  if (scheduledExecutionExists) {
    return {
      due_state: "COMPLETED",
      missed: false,
      slot_start_ms: start,
      perth_slot: formatPerthSlot(schedule)
    };
  }
  if (workerRunning || nowMs < start + graceMs) {
    return {
      due_state: "DUE_RUNNING",
      missed: false,
      slot_start_ms: start,
      perth_slot: formatPerthSlot(schedule)
    };
  }
  return {
    due_state: "MISSED_SCHEDULE",
    missed: true,
    slot_start_ms: start,
    perth_slot: formatPerthSlot(schedule)
  };
}

function scheduleForSlug(slug) {
  return WEEKLY_LINE_SCHEDULE.find((row) => row.slug === slug) || null;
}

module.exports = {
  WEEKLY_LINE_SCHEDULE,
  WEEKDAY_INDEX,
  DEFAULT_MISSED_GRACE_MS,
  perthWeekdayName,
  perthHourMinute,
  thisWeekPerthDateForWeekday,
  slotStartMs,
  formatPerthSlot,
  classifyWeeklyDueState,
  scheduleForSlug
};
