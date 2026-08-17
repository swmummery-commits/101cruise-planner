/**
 * Princess Cruises Discovery execution modes and write safeguards.
 */

const PRINCESS_DISCOVERY_WRITE_ENABLED =
  String(process.env.PRINCESS_DISCOVERY_WRITE_ENABLED || "").trim().toLowerCase() === "true";

const VALID_MODES = new Set([
  "simulation",
  "production_read_only",
  "production_write",
  "weekly_maintenance",
  "incident_p2_controlled_batch"
]);

function resolvePrincessDiscoveryMode(requestedMode) {
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
    const { isPrincessWeeklyReconciliationEnabled } = require("./cruise-discovery-maintenance");
    if (!isPrincessWeeklyReconciliationEnabled()) {
      return {
        mode,
        requested_mode: raw,
        writes_allowed: false,
        reason: "princess_weekly_reconciliation_disabled"
      };
    }
    return { mode, requested_mode: raw, writes_allowed: true, reason: null };
  }

  if (mode === "production_write" || mode === "incident_p2_controlled_batch") {
    if (!PRINCESS_DISCOVERY_WRITE_ENABLED) {
      return {
        mode,
        requested_mode: raw,
        writes_allowed: false,
        reason: "production_write_flag_disabled"
      };
    }
    return { mode, requested_mode: raw, writes_allowed: true, reason: null };
  }

  return {
    mode,
    requested_mode: raw,
    writes_allowed: false,
    reason: mode === "simulation" ? "simulation_read_only" : "production_read_only"
  };
}

function assertPrincessWritesAllowed(modeGate) {
  if (modeGate?.writes_allowed) return;
  const err = new Error(
    modeGate?.reason === "production_write_flag_disabled"
      ? "Princess Discovery production_write is disabled by PRINCESS_DISCOVERY_WRITE_ENABLED"
      : "Princess Discovery writes are not permitted in this mode"
  );
  err.code = "princess_discovery_write_forbidden";
  err.mode = modeGate?.mode || "simulation";
  err.reason = modeGate?.reason || "read_only";
  throw err;
}

module.exports = {
  PRINCESS_DISCOVERY_WRITE_ENABLED,
  VALID_MODES,
  resolvePrincessDiscoveryMode,
  assertPrincessWritesAllowed
};
