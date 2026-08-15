/**
 * Silversea Discovery execution modes and write safeguards.
 */

function isSilverseaDiscoveryWriteEnabled() {
  return String(process.env.SILVERSEA_DISCOVERY_WRITE_ENABLED || "").trim().toLowerCase() === "true";
}

const VALID_MODES = new Set(["simulation", "production_read_only", "production_write"]);

function resolveSilverseaDiscoveryMode(requestedMode) {
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

  if (mode === "production_write") {
    if (!isSilverseaDiscoveryWriteEnabled()) {
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

function assertSilverseaWritesAllowed(modeGate) {
  if (modeGate?.writes_allowed) return;
  const err = new Error(
    modeGate?.reason === "production_write_flag_disabled"
      ? "Silversea Discovery production_write is disabled by SILVERSEA_DISCOVERY_WRITE_ENABLED"
      : "Silversea Discovery writes are not permitted in this mode"
  );
  err.code = "silversea_discovery_write_forbidden";
  err.mode = modeGate?.mode || "simulation";
  err.reason = modeGate?.reason || "read_only";
  throw err;
}

module.exports = {
  get SILVERSEA_DISCOVERY_WRITE_ENABLED() {
    return isSilverseaDiscoveryWriteEnabled();
  },
  isSilverseaDiscoveryWriteEnabled,
  VALID_MODES,
  resolveSilverseaDiscoveryMode,
  assertSilverseaWritesAllowed
};
