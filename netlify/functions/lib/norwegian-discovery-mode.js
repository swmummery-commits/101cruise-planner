/**
 * Norwegian Cruise Line discovery execution modes and write safeguards.
 */

const NORWEGIAN_DISCOVERY_WRITE_ENABLED =
  String(process.env.NORWEGIAN_DISCOVERY_WRITE_ENABLED || "").trim().toLowerCase() === "true";

const NORWEGIAN_ENRICHMENT_WRITE_ENABLED =
  String(process.env.NORWEGIAN_ENRICHMENT_WRITE_ENABLED || "").trim().toLowerCase() === "true";

const NORWEGIAN_WEEKLY_RECONCILIATION_ENABLED =
  String(process.env.NORWEGIAN_WEEKLY_RECONCILIATION_ENABLED || "").trim().toLowerCase() === "true";

const VALID_MODES = new Set([
  "simulation",
  "production_read_only",
  "production_write",
  "controlled_batch",
  "controlled_enrichment",
  "weekly_maintenance"
]);

function resolveNorwegianDiscoveryMode(requestedMode) {
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

  if (
    mode === "production_write" ||
    mode === "controlled_batch" ||
    mode === "controlled_enrichment" ||
    mode === "weekly_maintenance"
  ) {
    if (mode === "controlled_enrichment") {
      if (!NORWEGIAN_ENRICHMENT_WRITE_ENABLED) {
        return {
          mode,
          requested_mode: raw,
          writes_allowed: false,
          reason: "enrichment_write_flag_disabled"
        };
      }
      return { mode, requested_mode: raw, writes_allowed: true, reason: null };
    }
    if (mode === "weekly_maintenance") {
      if (!NORWEGIAN_WEEKLY_RECONCILIATION_ENABLED) {
        return {
          mode,
          requested_mode: raw,
          writes_allowed: false,
          reason: "weekly_reconciliation_disabled"
        };
      }
      return { mode, requested_mode: raw, writes_allowed: true, reason: null };
    }
    if (!NORWEGIAN_DISCOVERY_WRITE_ENABLED) {
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

function assertNorwegianWritesAllowed(modeGate) {
  if (modeGate?.writes_allowed) return;
  const err = new Error(
    modeGate?.reason === "production_write_flag_disabled"
      ? "Norwegian Discovery production_write is disabled by NORWEGIAN_DISCOVERY_WRITE_ENABLED"
      : "Norwegian Discovery writes are not permitted in this mode"
  );
  err.code = "norwegian_discovery_write_forbidden";
  err.mode = modeGate?.mode || "simulation";
  err.reason = modeGate?.reason || "read_only";
  throw err;
}

module.exports = {
  NORWEGIAN_DISCOVERY_WRITE_ENABLED,
  NORWEGIAN_ENRICHMENT_WRITE_ENABLED,
  NORWEGIAN_WEEKLY_RECONCILIATION_ENABLED,
  VALID_MODES,
  resolveNorwegianDiscoveryMode,
  assertNorwegianWritesAllowed
};
