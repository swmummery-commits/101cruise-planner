/**
 * Holland America Discovery execution modes and write safeguards.
 * Missing or invalid mode defaults to read-only — never write.
 */

const HAL_DISCOVERY_WRITE_ENABLED =
  String(process.env.HAL_DISCOVERY_WRITE_ENABLED || "").trim().toLowerCase() === "true";

const VALID_MODES = new Set(["simulation", "production_read_only", "production_write", "weekly_maintenance"]);

function resolveHalDiscoveryMode(requestedMode) {
  const raw = String(requestedMode || "").trim().toLowerCase();
  const mode = VALID_MODES.has(raw) ? raw : "simulation";

  if (!raw || !VALID_MODES.has(raw)) {
    return {
      mode: "simulation",
      requested_mode: raw || null,
      writes_allowed: false,
      reason: raw ? "invalid_mode_defaults_read_only" : "missing_mode_defaults_read_only"
    };
  }

  if (mode === "weekly_maintenance") {
    const { isHalWeeklyReconciliationEnabled } = require("./cruise-discovery-maintenance");
    if (!isHalWeeklyReconciliationEnabled()) {
      return {
        mode,
        requested_mode: raw,
        writes_allowed: false,
        reason: "hal_weekly_reconciliation_disabled"
      };
    }
    return { mode, requested_mode: raw, writes_allowed: true, reason: null };
  }

  if (mode === "production_write") {
    if (!HAL_DISCOVERY_WRITE_ENABLED) {
      return {
        mode,
        requested_mode: raw,
        writes_allowed: false,
        reason: "production_write_flag_disabled"
      };
    }
    return {
      mode,
      requested_mode: raw,
      writes_allowed: true,
      reason: null
    };
  }

  return {
    mode,
    requested_mode: raw,
    writes_allowed: false,
    reason: mode === "simulation" ? "simulation_read_only" : "production_read_only"
  };
}

function assertHalWritesAllowed(modeGate) {
  if (modeGate?.writes_allowed) return;
  const err = new Error(
    modeGate?.reason === "production_write_flag_disabled"
      ? "HAL Discovery production_write is disabled by HAL_DISCOVERY_WRITE_ENABLED"
      : "HAL Discovery writes are not permitted in this mode"
  );
  err.code = "hal_discovery_write_forbidden";
  err.mode = modeGate?.mode || "simulation";
  err.reason = modeGate?.reason || "read_only";
  throw err;
}

module.exports = {
  HAL_DISCOVERY_WRITE_ENABLED,
  VALID_MODES,
  resolveHalDiscoveryMode,
  assertHalWritesAllowed
};
