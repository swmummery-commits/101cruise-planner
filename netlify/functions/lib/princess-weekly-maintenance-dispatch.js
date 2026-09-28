/**
 * Princess weekly maintenance — thin launcher ↔ background dispatch.
 * Scheduler owner is decided at cutover. This module must not introduce
 * a second independent schedule by itself.
 */

const {
  assertPrincessWeeklyMaintenanceEnabled,
  PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
  isPrincessWeeklyReconciliationEnabled
} = require("./cruise-discovery-maintenance");
const { runPrincessWeeklyMaintenance } = require("./cruise-discovery-maintenance-runner");
const { createThinWeeklyDispatch } = require("./weekly-maintenance-thin-dispatch");

const dispatch = createThinWeeklyDispatch({
  lineSlug: "princess-cruises",
  runType: PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
  assertEnabled: assertPrincessWeeklyMaintenanceEnabled,
  isEnabled: isPrincessWeeklyReconciliationEnabled,
  runMaintenance: runPrincessWeeklyMaintenance,
  maxWrites: 30,
  launcherFunctionName: "princess-weekly-maintenance-cron",
  backgroundFunctionName: "princess-weekly-maintenance-background"
});

module.exports = {
  ...dispatch,
  PRINCESS_LINE_SLUG: "princess-cruises",
  dispatchPrincessWeeklyBackground: dispatch.dispatchWeeklyBackground,
  runPrincessWeeklyBackgroundMaintenance: dispatch.runWeeklyBackgroundMaintenance
};
