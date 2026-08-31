/**
 * Holland America weekly maintenance — thin launcher ↔ background dispatch.
 */

const {
  assertHalWeeklyMaintenanceEnabled,
  HAL_WEEKLY_MAINTENANCE_RUN_TYPE,
  isHalWeeklyReconciliationEnabled
} = require("./cruise-discovery-maintenance");
const { runHalWeeklyMaintenance } = require("./cruise-discovery-maintenance-runner");
const { createThinWeeklyDispatch } = require("./weekly-maintenance-thin-dispatch");

const dispatch = createThinWeeklyDispatch({
  lineSlug: "holland-america-line",
  runType: HAL_WEEKLY_MAINTENANCE_RUN_TYPE,
  assertEnabled: assertHalWeeklyMaintenanceEnabled,
  isEnabled: isHalWeeklyReconciliationEnabled,
  runMaintenance: runHalWeeklyMaintenance,
  maxWrites: 100,
  launcherFunctionName: "hal-weekly-maintenance-cron",
  backgroundFunctionName: "hal-weekly-maintenance-background"
});

module.exports = {
  ...dispatch,
  HAL_LINE_SLUG: "holland-america-line",
  dispatchHalWeeklyBackground: dispatch.dispatchWeeklyBackground,
  runHalWeeklyBackgroundMaintenance: dispatch.runWeeklyBackgroundMaintenance
};
