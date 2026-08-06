/**
 * Server-side Discovery automation hold controls.
 * Defaults false — operational instructions alone do not enable scheduled Discovery.
 */

const CRUISE_DISCOVERY_AUTOMATION_ENABLED =
  String(process.env.CRUISE_DISCOVERY_AUTOMATION_ENABLED || "").trim().toLowerCase() === "true";

const CRUISE_DISCOVERY_EXPIRE_SAILED_ENABLED =
  String(process.env.CRUISE_DISCOVERY_EXPIRE_SAILED_ENABLED || "").trim().toLowerCase() === "true";

function isCruiseDiscoveryAutomationEnabled() {
  return CRUISE_DISCOVERY_AUTOMATION_ENABLED;
}

function isCruiseDiscoveryExpireSailedEnabled() {
  return CRUISE_DISCOVERY_EXPIRE_SAILED_ENABLED;
}

function assertCruiseDiscoveryAutomationEnabled(action = "full_discovery") {
  if (isCruiseDiscoveryAutomationEnabled()) return;
  const err = new Error(
    `Cruise Discovery ${action} is disabled by CRUISE_DISCOVERY_AUTOMATION_ENABLED`
  );
  err.statusCode = 409;
  err.code = "discovery_automation_disabled";
  throw err;
}

function assertExpireSailedEnabled() {
  if (isCruiseDiscoveryExpireSailedEnabled()) return;
  const err = new Error(
    "expire_sailed is disabled by CRUISE_DISCOVERY_EXPIRE_SAILED_ENABLED"
  );
  err.statusCode = 409;
  err.code = "expire_sailed_disabled";
  throw err;
}

function describeDiscoveryAutomationHold() {
  const { describeMaintenanceHold } = require("./cruise-discovery-maintenance");
  return {
    automation_enabled: isCruiseDiscoveryAutomationEnabled(),
    expire_sailed_enabled: isCruiseDiscoveryExpireSailedEnabled(),
    scheduled_function: "cruise-discovery-cron",
    schedule: "0 6 * * 1 (Monday 06:00 UTC)",
    wave_worker: "cruise-discovery-wave-background",
    note: "General Full Discovery remains disabled unless CRUISE_DISCOVERY_AUTOMATION_ENABLED=true.",
    dedicated_maintenance: describeMaintenanceHold()
  };
}

module.exports = {
  CRUISE_DISCOVERY_AUTOMATION_ENABLED,
  CRUISE_DISCOVERY_EXPIRE_SAILED_ENABLED,
  isCruiseDiscoveryAutomationEnabled,
  isCruiseDiscoveryExpireSailedEnabled,
  assertCruiseDiscoveryAutomationEnabled,
  assertExpireSailedEnabled,
  describeDiscoveryAutomationHold
};
