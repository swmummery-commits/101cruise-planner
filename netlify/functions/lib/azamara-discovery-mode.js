/**
 * Azamara Discovery execution modes and write safeguards.
 */

function isAzamaraDiscoveryWriteEnabled() {
  return String(process.env.AZAMARA_DISCOVERY_WRITE_ENABLED || "").trim().toLowerCase() === "true";
}

const VALID_MODES = new Set([
  "simulation",
  "production_read_only",
  "production_write",
  "controlled_batch",
  "full_catchup",
  "weekly_maintenance"
]);

function resolveAzamaraDiscoveryMode(requestedMode) {
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

  if (mode === "production_write" || mode === "controlled_batch" || mode === "full_catchup" || mode === "weekly_maintenance") {
    if (!isAzamaraDiscoveryWriteEnabled()) {
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

function assertAzamaraWritesAllowed(modeGate) {
  if (modeGate?.writes_allowed) return;
  const err = new Error(
    modeGate?.reason === "production_write_flag_disabled"
      ? "Azamara Discovery production_write is disabled by AZAMARA_DISCOVERY_WRITE_ENABLED"
      : "Azamara Discovery writes are not permitted in this mode"
  );
  err.code = "azamara_discovery_write_forbidden";
  err.mode = modeGate?.mode || "simulation";
  err.reason = modeGate?.reason || "read_only";
  throw err;
}

module.exports = {
  get AZAMARA_DISCOVERY_WRITE_ENABLED() {
    return isAzamaraDiscoveryWriteEnabled();
  },
  isAzamaraDiscoveryWriteEnabled,
  VALID_MODES,
  resolveAzamaraDiscoveryMode,
  assertAzamaraWritesAllowed
};
