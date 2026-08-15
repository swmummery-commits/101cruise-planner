/**
 * Carnival Cruise Line Discovery execution modes and write safeguards.
 */

function isCarnivalDiscoveryWriteEnabled() {
  return String(process.env.CARNIVAL_DISCOVERY_WRITE_ENABLED || "").trim().toLowerCase() === "true";
}

const VALID_MODES = new Set(["simulation", "production_read_only", "production_write", "controlled_batch"]);

function resolveCarnivalDiscoveryMode(requestedMode) {
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

  if (mode === "production_write" || mode === "controlled_batch") {
    if (!isCarnivalDiscoveryWriteEnabled()) {
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

function assertCarnivalWritesAllowed(modeGate) {
  if (modeGate?.writes_allowed) return;
  const err = new Error(
    modeGate?.reason === "production_write_flag_disabled"
      ? "Carnival Discovery production_write is disabled by CARNIVAL_DISCOVERY_WRITE_ENABLED"
      : "Carnival Discovery writes are not permitted in this mode"
  );
  err.code = "carnival_discovery_write_forbidden";
  err.mode = modeGate?.mode || "simulation";
  err.reason = modeGate?.reason || "read_only";
  throw err;
}

module.exports = {
  get CARNIVAL_DISCOVERY_WRITE_ENABLED() {
    return isCarnivalDiscoveryWriteEnabled();
  },
  isCarnivalDiscoveryWriteEnabled,
  VALID_MODES,
  resolveCarnivalDiscoveryMode,
  assertCarnivalWritesAllowed
};
