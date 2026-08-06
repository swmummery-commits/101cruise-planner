/**
 * Dedicated cruise inventory maintenance controls (independent of bulk import flags).
 */

const HAL_WEEKLY_RECONCILIATION_ENABLED =
  String(process.env.HAL_WEEKLY_RECONCILIATION_ENABLED || "").trim().toLowerCase() === "true";

const CELEBRITY_WEEKLY_RECONCILIATION_ENABLED =
  String(process.env.CELEBRITY_WEEKLY_RECONCILIATION_ENABLED || "").trim().toLowerCase() === "true";

const CRUISE_DAILY_EXPIRY_ENABLED =
  String(process.env.CRUISE_DAILY_EXPIRY_ENABLED || "").trim().toLowerCase() === "true";

const OPERATIONAL_TIMEZONE = "Australia/Perth";

const MAINTENANCE_SCHEDULES = {
  hal_weekly: {
    cron_utc: "0 18 * * 0",
    perth_display: "Monday 02:00 Australia/Perth",
    utc_display: "Sunday 18:00 UTC",
    function: "hal-weekly-maintenance-cron"
  },
  celebrity_weekly: {
    cron_utc: "0 19 * * 0",
    perth_display: "Monday 03:00 Australia/Perth",
    utc_display: "Sunday 19:00 UTC",
    function: "celebrity-weekly-maintenance-cron"
  },
  daily_expiry: {
    cron_utc: "30 17 * * *",
    perth_display: "Daily 01:30 Australia/Perth",
    utc_display: "Daily 17:30 UTC (previous calendar day relative to Perth morning)",
    function: "cruise-daily-expiry-cron"
  }
};

const HAL_WEEKLY_MAINTENANCE_RUN_TYPE = "hal_weekly_maintenance";
const CELEBRITY_WEEKLY_MAINTENANCE_RUN_TYPE = "celebrity_weekly_maintenance";
const DAILY_EXPIRY_RUN_TYPE = "daily_expiry_maintenance";

function perthCalendarDate(reference = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: OPERATIONAL_TIMEZONE }).format(reference);
}

function isHalWeeklyReconciliationEnabled() {
  return HAL_WEEKLY_RECONCILIATION_ENABLED;
}

function isCelebrityWeeklyReconciliationEnabled() {
  return CELEBRITY_WEEKLY_RECONCILIATION_ENABLED;
}

function isCruiseDailyExpiryEnabled() {
  return CRUISE_DAILY_EXPIRY_ENABLED;
}

function assertHalWeeklyMaintenanceEnabled() {
  if (!isHalWeeklyReconciliationEnabled()) {
    const err = new Error("HAL weekly maintenance is disabled (HAL_WEEKLY_RECONCILIATION_ENABLED=false)");
    err.code = "hal_weekly_maintenance_disabled";
    throw err;
  }
}

function assertCelebrityWeeklyMaintenanceEnabled() {
  if (!isCelebrityWeeklyReconciliationEnabled()) {
    const err = new Error(
      "Celebrity weekly maintenance is disabled (CELEBRITY_WEEKLY_RECONCILIATION_ENABLED=false)"
    );
    err.code = "celebrity_weekly_maintenance_disabled";
    throw err;
  }
}

function assertDailyExpiryEnabled() {
  if (!isCruiseDailyExpiryEnabled()) {
    const err = new Error("Daily expiry is disabled (CRUISE_DAILY_EXPIRY_ENABLED=false)");
    err.code = "daily_expiry_disabled";
    throw err;
  }
}

function computeFreshnessLabel(lastSuccessfulAt) {
  if (!lastSuccessfulAt) return "Stale";
  const ms = Date.now() - new Date(lastSuccessfulAt).getTime();
  const days = ms / 86400000;
  if (days <= 8) return "Current";
  if (days <= 14) return "Due";
  return "Stale";
}

function describeMaintenanceHold() {
  return {
    hal_weekly_reconciliation_enabled: isHalWeeklyReconciliationEnabled(),
    celebrity_weekly_reconciliation_enabled: isCelebrityWeeklyReconciliationEnabled(),
    cruise_daily_expiry_enabled: isCruiseDailyExpiryEnabled(),
    operational_timezone: OPERATIONAL_TIMEZONE,
    schedules: MAINTENANCE_SCHEDULES,
    bulk_import_flags_must_remain_false: [
      "CRUISE_DISCOVERY_AUTOMATION_ENABLED",
      "HAL_DISCOVERY_WRITE_ENABLED",
      "HAL_AUTOMATIC_CONTINUATION_ENABLED",
      "CELEBRITY_DISCOVERY_WRITE_ENABLED",
      "CELEBRITY_AUTOMATIC_CONTINUATION_ENABLED"
    ]
  };
}

module.exports = {
  HAL_WEEKLY_RECONCILIATION_ENABLED,
  CELEBRITY_WEEKLY_RECONCILIATION_ENABLED,
  CRUISE_DAILY_EXPIRY_ENABLED,
  OPERATIONAL_TIMEZONE,
  MAINTENANCE_SCHEDULES,
  HAL_WEEKLY_MAINTENANCE_RUN_TYPE,
  CELEBRITY_WEEKLY_MAINTENANCE_RUN_TYPE,
  DAILY_EXPIRY_RUN_TYPE,
  perthCalendarDate,
  isHalWeeklyReconciliationEnabled,
  isCelebrityWeeklyReconciliationEnabled,
  isCruiseDailyExpiryEnabled,
  assertHalWeeklyMaintenanceEnabled,
  assertCelebrityWeeklyMaintenanceEnabled,
  assertDailyExpiryEnabled,
  computeFreshnessLabel,
  describeMaintenanceHold
};
