/**
 * Dedicated cruise inventory maintenance controls (independent of bulk import flags).
 */

const HAL_WEEKLY_RECONCILIATION_ENABLED =
  String(process.env.HAL_WEEKLY_RECONCILIATION_ENABLED || "").trim().toLowerCase() === "true";

const CELEBRITY_WEEKLY_RECONCILIATION_ENABLED =
  String(process.env.CELEBRITY_WEEKLY_RECONCILIATION_ENABLED || "").trim().toLowerCase() === "true";

const PRINCESS_WEEKLY_RECONCILIATION_ENABLED =
  String(process.env.PRINCESS_WEEKLY_RECONCILIATION_ENABLED || "").trim().toLowerCase() === "true";

const EXPLORA_WEEKLY_RECONCILIATION_ENABLED =
  String(process.env.EXPLORA_WEEKLY_RECONCILIATION_ENABLED || "").trim().toLowerCase() === "true";

const SEABOURN_WEEKLY_RECONCILIATION_ENABLED =
  String(process.env.SEABOURN_WEEKLY_RECONCILIATION_ENABLED || "").trim().toLowerCase() === "true";

const ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED =
  String(process.env.ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED || "").trim().toLowerCase() === "true";

const NORWEGIAN_WEEKLY_RECONCILIATION_ENABLED =
  String(process.env.NORWEGIAN_WEEKLY_RECONCILIATION_ENABLED || "").trim().toLowerCase() === "true";

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
  princess_weekly: {
    cron_utc: "0 20 * * 0",
    perth_display: "Monday 04:00 Australia/Perth",
    utc_display: "Sunday 20:00 UTC",
    function: "princess-weekly-maintenance-cron"
  },
  /**
   * Explora weekly launcher is registered in netlify.toml.
   * Long-running work runs in the background worker.
   */
  explora_weekly: {
    cron_utc: "0 21 * * 0",
    perth_display: "Monday 05:00 Australia/Perth",
    utc_display: "Sunday 21:00 UTC",
    function: "explora-weekly-maintenance-cron",
    background_function: "explora-weekly-maintenance-background",
    schedule_registered: true
  },
  /**
   * Seabourn weekly maintenance — intended Sunday 22:00 UTC after Prompt 7 enablement.
   */
  seabourn_weekly: {
    cron_utc: "0 22 * * 0",
    perth_display: "Monday 06:00 Australia/Perth",
    utc_display: "Sunday 22:00 UTC",
    function: "seabourn-weekly-maintenance-cron",
    background_function: "seabourn-weekly-maintenance-background",
    schedule_registered: true
  },
  /**
   * Royal Caribbean weekly maintenance — Sunday 23:00 UTC (Monday 07:00 Perth).
   * One hour after Seabourn (22:00 UTC) to avoid launcher collision.
   */
  royal_caribbean_weekly: {
    cron_utc: "0 23 * * 0",
    perth_display: "Monday 07:00 Australia/Perth",
    utc_display: "Sunday 23:00 UTC",
    function: "royal-caribbean-weekly-maintenance-cron",
    background_function: "royal-caribbean-weekly-maintenance-background",
    schedule_registered: true
  },
  /**
   * Norwegian weekly maintenance — Monday 00:00 UTC (Monday 08:00 Perth).
   * One hour after Royal Caribbean (23:00 UTC) to avoid launcher collision.
   */
  norwegian_weekly: {
    cron_utc: "0 0 * * 1",
    perth_display: "Monday 08:00 Australia/Perth",
    utc_display: "Monday 00:00 UTC",
    function: "norwegian-weekly-maintenance-cron",
    background_function: "norwegian-weekly-maintenance-background",
    schedule_registered: true
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
const PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE = "princess_weekly_maintenance";
const EXPLORA_WEEKLY_MAINTENANCE_RUN_TYPE = "explora_weekly_maintenance";
const SEABOURN_WEEKLY_MAINTENANCE_RUN_TYPE = "seabourn_weekly_maintenance";
const ROYAL_CARIBBEAN_WEEKLY_MAINTENANCE_RUN_TYPE = "royal_caribbean_weekly_maintenance";
const NORWEGIAN_WEEKLY_MAINTENANCE_RUN_TYPE = "norwegian_weekly_maintenance";
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

function isPrincessWeeklyReconciliationEnabled() {
  return PRINCESS_WEEKLY_RECONCILIATION_ENABLED;
}

function isExploraWeeklyReconciliationEnabled() {
  return EXPLORA_WEEKLY_RECONCILIATION_ENABLED;
}

function isSeabournWeeklyReconciliationEnabled() {
  return SEABOURN_WEEKLY_RECONCILIATION_ENABLED;
}

function isRoyalCaribbeanWeeklyReconciliationEnabled() {
  return ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED;
}

function isNorwegianWeeklyReconciliationEnabled() {
  return NORWEGIAN_WEEKLY_RECONCILIATION_ENABLED;
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

function assertPrincessWeeklyMaintenanceEnabled() {
  if (!isPrincessWeeklyReconciliationEnabled()) {
    const err = new Error(
      "Princess weekly maintenance is disabled (PRINCESS_WEEKLY_RECONCILIATION_ENABLED=false)"
    );
    err.code = "princess_weekly_maintenance_disabled";
    throw err;
  }
}

function assertExploraWeeklyMaintenanceEnabled() {
  if (!isExploraWeeklyReconciliationEnabled()) {
    const err = new Error(
      "Explora weekly maintenance is disabled (EXPLORA_WEEKLY_RECONCILIATION_ENABLED=false)"
    );
    err.code = "explora_weekly_maintenance_disabled";
    throw err;
  }
}

function assertSeabournWeeklyMaintenanceEnabled() {
  if (!isSeabournWeeklyReconciliationEnabled()) {
    const err = new Error(
      "Seabourn weekly maintenance is disabled (SEABOURN_WEEKLY_RECONCILIATION_ENABLED=false)"
    );
    err.code = "seabourn_weekly_maintenance_disabled";
    throw err;
  }
}

function assertRoyalCaribbeanWeeklyMaintenanceEnabled() {
  if (!isRoyalCaribbeanWeeklyReconciliationEnabled()) {
    const err = new Error(
      "Royal Caribbean weekly maintenance is disabled (ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED=false)"
    );
    err.code = "royal_caribbean_weekly_maintenance_disabled";
    throw err;
  }
}

function assertNorwegianWeeklyMaintenanceEnabled() {
  if (!isNorwegianWeeklyReconciliationEnabled()) {
    const err = new Error(
      "Norwegian weekly maintenance is disabled (NORWEGIAN_WEEKLY_RECONCILIATION_ENABLED=false)"
    );
    err.code = "norwegian_weekly_maintenance_disabled";
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

function resolveEnvFlag(rawValue) {
  const trimmed = String(rawValue ?? "").trim().toLowerCase();
  if (trimmed === "true") {
    return { state: "explicit_true", effective: true, raw: "true" };
  }
  if (trimmed === "false") {
    return { state: "explicit_false", effective: false, raw: "false" };
  }
  return { state: "unset_default_false", effective: false, raw: null };
}

function describeMaintenanceHold() {
  return {
    hal_weekly_reconciliation: resolveEnvFlag(process.env.HAL_WEEKLY_RECONCILIATION_ENABLED),
    celebrity_weekly_reconciliation: resolveEnvFlag(process.env.CELEBRITY_WEEKLY_RECONCILIATION_ENABLED),
    princess_weekly_reconciliation: resolveEnvFlag(process.env.PRINCESS_WEEKLY_RECONCILIATION_ENABLED),
    explora_weekly_reconciliation: resolveEnvFlag(process.env.EXPLORA_WEEKLY_RECONCILIATION_ENABLED),
    seabourn_weekly_reconciliation: resolveEnvFlag(process.env.SEABOURN_WEEKLY_RECONCILIATION_ENABLED),
    royal_caribbean_weekly_reconciliation: resolveEnvFlag(process.env.ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED),
    norwegian_weekly_reconciliation: resolveEnvFlag(process.env.NORWEGIAN_WEEKLY_RECONCILIATION_ENABLED),
    cruise_daily_expiry: resolveEnvFlag(process.env.CRUISE_DAILY_EXPIRY_ENABLED),
    hal_weekly_reconciliation_enabled: isHalWeeklyReconciliationEnabled(),
    celebrity_weekly_reconciliation_enabled: isCelebrityWeeklyReconciliationEnabled(),
    princess_weekly_reconciliation_enabled: isPrincessWeeklyReconciliationEnabled(),
    explora_weekly_reconciliation_enabled: isExploraWeeklyReconciliationEnabled(),
    seabourn_weekly_reconciliation_enabled: isSeabournWeeklyReconciliationEnabled(),
    royal_caribbean_weekly_reconciliation_enabled: isRoyalCaribbeanWeeklyReconciliationEnabled(),
    norwegian_weekly_reconciliation_enabled: isNorwegianWeeklyReconciliationEnabled(),
    cruise_daily_expiry_enabled: isCruiseDailyExpiryEnabled(),
    operational_timezone: OPERATIONAL_TIMEZONE,
    schedules: MAINTENANCE_SCHEDULES,
    bulk_import_flags_must_remain_false: [
      "CRUISE_DISCOVERY_AUTOMATION_ENABLED",
      "HAL_DISCOVERY_WRITE_ENABLED",
      "HAL_AUTOMATIC_CONTINUATION_ENABLED",
      "CELEBRITY_DISCOVERY_WRITE_ENABLED",
      "CELEBRITY_AUTOMATIC_CONTINUATION_ENABLED",
      "PRINCESS_DISCOVERY_WRITE_ENABLED",
      "EXPLORA_DISCOVERY_WRITE_ENABLED",
      "SEABOURN_DISCOVERY_WRITE_ENABLED",
      "ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED",
      "NORWEGIAN_DISCOVERY_WRITE_ENABLED"
    ]
  };
}

module.exports = {
  HAL_WEEKLY_RECONCILIATION_ENABLED,
  CELEBRITY_WEEKLY_RECONCILIATION_ENABLED,
  PRINCESS_WEEKLY_RECONCILIATION_ENABLED,
  EXPLORA_WEEKLY_RECONCILIATION_ENABLED,
  SEABOURN_WEEKLY_RECONCILIATION_ENABLED,
  ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED,
  NORWEGIAN_WEEKLY_RECONCILIATION_ENABLED,
  CRUISE_DAILY_EXPIRY_ENABLED,
  OPERATIONAL_TIMEZONE,
  MAINTENANCE_SCHEDULES,
  HAL_WEEKLY_MAINTENANCE_RUN_TYPE,
  CELEBRITY_WEEKLY_MAINTENANCE_RUN_TYPE,
  PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
  EXPLORA_WEEKLY_MAINTENANCE_RUN_TYPE,
  SEABOURN_WEEKLY_MAINTENANCE_RUN_TYPE,
  ROYAL_CARIBBEAN_WEEKLY_MAINTENANCE_RUN_TYPE,
  NORWEGIAN_WEEKLY_MAINTENANCE_RUN_TYPE,
  DAILY_EXPIRY_RUN_TYPE,
  perthCalendarDate,
  isHalWeeklyReconciliationEnabled,
  isCelebrityWeeklyReconciliationEnabled,
  isPrincessWeeklyReconciliationEnabled,
  isExploraWeeklyReconciliationEnabled,
  isSeabournWeeklyReconciliationEnabled,
  isRoyalCaribbeanWeeklyReconciliationEnabled,
  isNorwegianWeeklyReconciliationEnabled,
  isCruiseDailyExpiryEnabled,
  assertHalWeeklyMaintenanceEnabled,
  assertCelebrityWeeklyMaintenanceEnabled,
  assertPrincessWeeklyMaintenanceEnabled,
  assertExploraWeeklyMaintenanceEnabled,
  assertSeabournWeeklyMaintenanceEnabled,
  assertRoyalCaribbeanWeeklyMaintenanceEnabled,
  assertNorwegianWeeklyMaintenanceEnabled,
  assertDailyExpiryEnabled,
  computeFreshnessLabel,
  resolveEnvFlag,
  describeMaintenanceHold
};
