/**
 * Holland America automatic continuation — prepared but disabled by default.
 */

const { evaluateAcceptanceGate } = require("./holland-america-discovery-writes");

const DEFAULT_AUTO_PAGES = 12;
const DEFAULT_AUTO_MAX_WRITES = 100;
const DEFAULT_WRITE_CONCURRENCY = 5;

const AUTOMATIC_STOP_THRESHOLDS = {
  write_failure_rate_pct: 2,
  ship_match_rate_pct: 98,
  departure_port_rate_pct: 90,
  destination_resolution_rate_pct: 85
};

function isHalAutomaticContinuationEnabled() {
  return String(process.env.HAL_AUTOMATIC_CONTINUATION_ENABLED || "").toLowerCase() === "true";
}

function halAutomaticLimits() {
  return {
    max_pages: Math.min(20, Math.max(1, Number(process.env.HAL_AUTO_MAX_PAGES) || DEFAULT_AUTO_PAGES)),
    max_writes: Math.min(500, Math.max(1, Number(process.env.HAL_AUTO_MAX_WRITES) || DEFAULT_AUTO_MAX_WRITES)),
    write_concurrency: Math.min(
      10,
      Math.max(1, Number(process.env.HAL_AUTO_WRITE_CONCURRENCY) || DEFAULT_WRITE_CONCURRENCY)
    ),
    sequential_only: true,
    overlapping_batches_blocked: true
  };
}

function evaluateAutomaticQualityGate({ manifest, stats, cruiseMetrics, writeResult } = {}) {
  const failures = [];
  const gate = manifest?.acceptance_gate
    ? manifest.acceptance_gate
    : manifest
      ? evaluateAcceptanceGate(manifest)
      : { passed: true, failures: [] };
  if (!gate.passed) {
    failures.push(...(gate.failures || []).map((f) => `acceptance_gate:${f}`));
  }

  const metrics = cruiseMetrics || {};
  const writes = writeResult?.stats || {};
  const attempted = (writes.inserted || 0) + (writes.updated || 0) + (writes.failed || 0);
  const failureRate = attempted ? ((writes.failed || 0) / attempted) * 100 : 0;

  if ((stats?.product_type_cruisetour || 0) > 0 && (writes.inserted || 0) > 0) {
    failures.push("cruisetour_insertion_attempted");
  }
  if (gate.failures?.includes("fairbanks_cruise_embarkation")) {
    failures.push("fairbanks_embarkation_proposed");
  }
  if (gate.failures?.includes("cruisetour_in_write_set")) {
    failures.push("cruisetour_in_write_set");
  }
  if (gate.failures?.includes("medium_or_incomplete_confidence_in_write_set")) {
    failures.push("medium_or_low_confidence_write");
  }
  if (failureRate > AUTOMATIC_STOP_THRESHOLDS.write_failure_rate_pct) {
    failures.push(`write_failure_rate:${failureRate.toFixed(1)}%`);
  }
  if ((metrics.ship_match_rate_pct ?? 100) < AUTOMATIC_STOP_THRESHOLDS.ship_match_rate_pct) {
    failures.push(`ship_match_below_threshold:${metrics.ship_match_rate_pct}`);
  }
  if ((metrics.departure_port_rate_pct ?? 100) < AUTOMATIC_STOP_THRESHOLDS.departure_port_rate_pct) {
    failures.push(`departure_port_below_threshold:${metrics.departure_port_rate_pct}`);
  }
  if ((metrics.destination_resolution_rate_pct ?? 100) < AUTOMATIC_STOP_THRESHOLDS.destination_resolution_rate_pct) {
    failures.push(`destination_resolution_below_threshold:${metrics.destination_resolution_rate_pct}`);
  }
  if ((stats?.cursor_start ?? 0) >= (stats?.next_cursor_start ?? 0) && (stats?.products_normalised || 0) > 0) {
    failures.push("cursor_failed_to_advance");
  }

  return {
    passed: failures.length === 0,
    failures,
    thresholds: AUTOMATIC_STOP_THRESHOLDS
  };
}

function describeAutomaticContinuationArchitecture() {
  return {
    enabled: isHalAutomaticContinuationEnabled(),
    worker: "hal-discovery-batch-background",
    resume_from: "last_completed_hal_run.stats.next_cursor",
    limits: halAutomaticLimits(),
    stop_conditions: [
      "cruisetour proposed for insertion",
      "Fairbanks embarkation proposed",
      "medium or low confidence write",
      "missing official HAL product identity",
      "duplicate identity conflict in write set",
      "write failure rate above 2%",
      "ship match below 98%",
      "departure-port resolution below 90%",
      "destination resolution below 85%",
      "unexpected review-item creation",
      "unexpected alias write",
      "unexpected destination-table write",
      "repeated API or database failure",
      "cursor fails to advance after successful batch"
    ],
    safeguards: [
      "HAL_AUTOMATIC_CONTINUATION_ENABLED defaults false",
      "HAL_DISCOVERY_WRITE_ENABLED required for writes",
      "overlapping run lock per run id",
      "acceptance gate before writes",
      "rollback manifest per batch (local worker)",
      "permanent alias writes remain disabled"
    ]
  };
}

module.exports = {
  DEFAULT_AUTO_PAGES,
  DEFAULT_AUTO_MAX_WRITES,
  AUTOMATIC_STOP_THRESHOLDS,
  isHalAutomaticContinuationEnabled,
  halAutomaticLimits,
  evaluateAutomaticQualityGate,
  describeAutomaticContinuationArchitecture
};
