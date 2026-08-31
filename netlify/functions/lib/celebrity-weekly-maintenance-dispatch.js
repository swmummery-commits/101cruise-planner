/**
 * Celebrity weekly maintenance — thin launcher ↔ background dispatch.
 */

const {
  assertCelebrityWeeklyMaintenanceEnabled,
  CELEBRITY_WEEKLY_MAINTENANCE_RUN_TYPE,
  isCelebrityWeeklyReconciliationEnabled
} = require("./cruise-discovery-maintenance");
const { runCelebrityWeeklyMaintenance } = require("./cruise-discovery-maintenance-runner");
const { createThinWeeklyDispatch } = require("./weekly-maintenance-thin-dispatch");

const dispatch = createThinWeeklyDispatch({
  lineSlug: "celebrity-cruises",
  runType: CELEBRITY_WEEKLY_MAINTENANCE_RUN_TYPE,
  assertEnabled: assertCelebrityWeeklyMaintenanceEnabled,
  isEnabled: isCelebrityWeeklyReconciliationEnabled,
  runMaintenance: runCelebrityWeeklyMaintenance,
  maxWrites: 100,
  launcherFunctionName: "celebrity-weekly-maintenance-cron",
  backgroundFunctionName: "celebrity-weekly-maintenance-background"
});

module.exports = {
  ...dispatch,
  CELEBRITY_LINE_SLUG: "celebrity-cruises",
  dispatchCelebrityWeeklyBackground: dispatch.dispatchWeeklyBackground,
  runCelebrityWeeklyBackgroundMaintenance: dispatch.runWeeklyBackgroundMaintenance
};
