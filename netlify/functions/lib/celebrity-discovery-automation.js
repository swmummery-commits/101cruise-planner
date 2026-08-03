/**
 * Celebrity Cruises automatic continuation — prepared but disabled by default.
 */

const CELEBRITY_DISCOVERY_WRITE_ENABLED =
  String(process.env.CELEBRITY_DISCOVERY_WRITE_ENABLED || "").trim().toLowerCase() === "true";

const AUTOMATIC_THRESHOLDS = {
  ship_match_rate_pct: 98,
  departure_port_rate_pct: 95,
  destination_resolution_rate_pct: 90,
  write_failure_rate_pct: 2
};

function isCelebrityDiscoveryWriteEnabled() {
  return CELEBRITY_DISCOVERY_WRITE_ENABLED;
}

function isCelebrityAutomaticContinuationEnabled() {
  return String(process.env.CELEBRITY_AUTOMATIC_CONTINUATION_ENABLED || "").trim().toLowerCase() === "true";
}

function celebrityAutomaticLimits() {
  return {
    max_pages: Math.min(20, Math.max(1, Number(process.env.CELEBRITY_AUTO_MAX_PAGES) || 12)),
    max_writes: Math.min(500, Math.max(1, Number(process.env.CELEBRITY_AUTO_MAX_WRITES) || 40)),
    write_concurrency: Math.min(10, Math.max(1, Number(process.env.CELEBRITY_AUTO_WRITE_CONCURRENCY) || 5)),
    sequential_only: true,
    overlapping_batches_blocked: true
  };
}

function evaluateCelebrityQualityGate({ cruiseMetrics, manifest, writeResult } = {}) {
  const failures = [];
  const metrics = cruiseMetrics || {};
  if ((metrics.ship_match_rate_pct ?? 100) < AUTOMATIC_THRESHOLDS.ship_match_rate_pct) {
    failures.push(`ship_match_below_threshold:${metrics.ship_match_rate_pct}`);
  }
  if ((metrics.departure_port_rate_pct ?? 100) < AUTOMATIC_THRESHOLDS.departure_port_rate_pct) {
    failures.push(`departure_port_below_threshold:${metrics.departure_port_rate_pct}`);
  }
  if ((metrics.destination_resolution_rate_pct ?? 100) < AUTOMATIC_THRESHOLDS.destination_resolution_rate_pct) {
    failures.push(`destination_resolution_below_threshold:${metrics.destination_resolution_rate_pct}`);
  }
  if (manifest?.acceptance_gate && !manifest.acceptance_gate.passed) {
    failures.push(...(manifest.acceptance_gate.failures || []).map((f) => `acceptance:${f}`));
  }
  const writes = writeResult?.stats || {};
  const attempted = (writes.inserted || 0) + (writes.updated || 0) + (writes.failed || 0);
  const failureRate = attempted ? ((writes.failed || 0) / attempted) * 100 : 0;
  if (failureRate > AUTOMATIC_THRESHOLDS.write_failure_rate_pct) {
    failures.push(`write_failure_rate:${failureRate.toFixed(1)}%`);
  }
  return { passed: failures.length === 0, failures, thresholds: AUTOMATIC_THRESHOLDS };
}

function describeCelebrityAutomationArchitecture() {
  return {
    write_flag: "CELEBRITY_DISCOVERY_WRITE_ENABLED",
    continuation_flag: "CELEBRITY_AUTOMATIC_CONTINUATION_ENABLED",
    write_enabled: isCelebrityDiscoveryWriteEnabled(),
    automatic_continuation_enabled: isCelebrityAutomaticContinuationEnabled(),
    limits: celebrityAutomaticLimits()
  };
}

module.exports = {
  CELEBRITY_DISCOVERY_WRITE_ENABLED,
  AUTOMATIC_THRESHOLDS,
  isCelebrityDiscoveryWriteEnabled,
  isCelebrityAutomaticContinuationEnabled,
  celebrityAutomaticLimits,
  evaluateCelebrityQualityGate,
  describeCelebrityAutomationArchitecture
};
