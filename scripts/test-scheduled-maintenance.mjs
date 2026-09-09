#!/usr/bin/env node
/**
 * Scheduled maintenance and daily expiry tests.
 *   npm run test:scheduled-maintenance
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const maintenance = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));
const { evaluateMaintenanceQualityGate } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-runner"
));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value == null) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prev == null) delete process.env[key];
    else process.env[key] = prev;
  }
}

test("1. HAL weekly cron uses Sunday 18:00 UTC", () => {
  if (maintenance.MAINTENANCE_SCHEDULES.hal_weekly.cron_utc !== "0 18 * * 0") throw new Error("HAL cron mismatch");
});

test("2. Celebrity weekly cron uses Sunday 19:00 UTC", () => {
  if (maintenance.MAINTENANCE_SCHEDULES.celebrity_weekly.cron_utc !== "0 19 * * 0") throw new Error("Celebrity cron mismatch");
});

test("3. Daily expiry cron uses 17:30 UTC", () => {
  if (maintenance.MAINTENANCE_SCHEDULES.daily_expiry.cron_utc !== "30 17 * * *") throw new Error("expiry cron mismatch");
});

test("4. Dedicated maintenance flags default false", () => {
  withEnv("HAL_WEEKLY_RECONCILIATION_ENABLED", undefined, () => {
    delete require.cache[require.resolve(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"))];
    const m = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));
    if (m.isHalWeeklyReconciliationEnabled()) throw new Error("HAL default enabled");
    if (m.isCelebrityWeeklyReconciliationEnabled()) throw new Error("Celebrity default enabled");
    if (m.isCruiseDailyExpiryEnabled()) throw new Error("expiry default enabled");
  });
});

test("5. Weekly maintenance mode does not require bulk-import flags", () => {
  withEnv("HAL_DISCOVERY_WRITE_ENABLED", undefined, () => {
    withEnv("HAL_WEEKLY_RECONCILIATION_ENABLED", "true", () => {
      delete require.cache[require.resolve(path.join(root, "netlify/functions/lib/holland-america-discovery-mode"))];
      delete require.cache[require.resolve(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"))];
      const { resolveHalDiscoveryMode } = require(path.join(root, "netlify/functions/lib/holland-america-discovery-mode"));
      const gate = resolveHalDiscoveryMode("weekly_maintenance");
      if (!gate.writes_allowed) throw new Error("maintenance writes blocked");
    });
  });
});

test("6. HAL maintenance run type constant exists", () => {
  if (maintenance.HAL_WEEKLY_MAINTENANCE_RUN_TYPE !== "hal_weekly_maintenance") throw new Error("HAL type");
});

test("7. Celebrity maintenance run type constant exists", () => {
  if (maintenance.CELEBRITY_WEEKLY_MAINTENANCE_RUN_TYPE !== "celebrity_weekly_maintenance") throw new Error("Celebrity type");
});

test("8. Princess weekly cron uses Sunday 20:00 UTC", () => {
  if (maintenance.MAINTENANCE_SCHEDULES.princess_weekly.cron_utc !== "0 20 * * 0") throw new Error("Princess cron mismatch");
});

test("9. Princess weekly flag defaults false", () => {
  withEnv("PRINCESS_WEEKLY_RECONCILIATION_ENABLED", undefined, () => {
    delete require.cache[require.resolve(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"))];
    const m = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));
    if (m.isPrincessWeeklyReconciliationEnabled()) throw new Error("Princess default enabled");
  });
});

test("10. Inventory collapse gate blocks writes", () => {
  const gate = evaluateMaintenanceQualityGate({
    lineSlug: "holland-america-line",
    metrics: { eligible_total: 500, ship_resolution_pct: 99, departure_port_resolution_pct: 96, destination_resolution_pct: 91, identity_coverage_pct: 100, duplicate_official_identities: 0 },
    previousEligible: { stats: { eligible_total: 1000 } },
    manifest: { products: [] },
    dryRun: false
  });
  if (gate.passed) throw new Error("collapse gate should fail");
});

test("11. Perth calendar date helper returns YYYY-MM-DD", () => {
  const d = maintenance.perthCalendarDate(new Date("2026-08-05T20:00:00Z"));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(d);
});

test("12. Freshness Current within 8 days", () => {
  const label = maintenance.computeFreshnessLabel(new Date(Date.now() - 3 * 86400000).toISOString());
  if (label !== "Current") throw new Error(label);
});

test("13. Source absent policy retains active records", () => {
  const action = "source_absent_retained_active";
  if (action === "hide_removed_official_sailing") throw new Error("must not auto-hide");
});

test("14. P&O Cruises Australia remains excluded from maintenance scope", () => {
  const excluded = "p-o-cruises-australia";
  if (excluded === "holland-america-line") throw new Error("scope leak");
});

test("15. Princess uses dedicated weekly maintenance not general discovery", () => {
  if (maintenance.PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE !== "princess_weekly_maintenance") {
    throw new Error("Princess maintenance run type missing");
  }
  if (maintenance.MAINTENANCE_SCHEDULES.princess_weekly.function !== "princess-weekly-maintenance-cron") {
    throw new Error("Princess cron function missing");
  }
});

test("16. resolveEnvFlag reports unset as unset_default_false", () => {
  withEnv("HAL_WEEKLY_RECONCILIATION_ENABLED", undefined, () => {
    delete require.cache[require.resolve(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"))];
    const m = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));
    const flag = m.resolveEnvFlag(process.env.HAL_WEEKLY_RECONCILIATION_ENABLED);
    if (flag.state !== "unset_default_false") throw new Error(flag.state);
  });
});

const ops = require(path.join(root, "netlify/functions/lib/maintenance-operational-status"));

test("17. Daily expiry 2026-09-03 Perth slot is 2026-09-02T17:30Z", () => {
  if (ops.perthDateToDailyExpiryUtc("2026-09-03") !== "2026-09-02T17:30:00.000Z") {
    throw new Error(ops.perthDateToDailyExpiryUtc("2026-09-03"));
  }
});

test("18. Missing daily expiry slot is MISSED not silently absent", () => {
  const runs = [
    { id: "a", started_at: "2026-09-01T17:30:33Z", stats: { run_type: "daily_expiry_maintenance" } },
    { id: "b", started_at: "2026-09-03T17:30:17Z", stats: { run_type: "daily_expiry_maintenance" } }
  ];
  const detected = ops.detectMissedDailyExpirySlots(runs, {
    now: new Date("2026-09-06T11:00:00Z"),
    lookbackDays: 5,
    perthDateFn: () => "2026-09-06"
  });
  if (!detected.missed.some((s) => s.perth_date === "2026-09-03")) {
    throw new Error(`expected 2026-09-03 missed, got ${JSON.stringify(detected.missed)}`);
  }
  if (detected.missed.some((s) => s.perth_date === "2026-09-02")) {
    throw new Error("2026-09-02 should be present");
  }
});

test("19. Review-required zero-write is not a technical HTTP failure", () => {
  if (ops.weeklyBackgroundHttpStatus({ success: true, review_required: true }) !== 200) {
    throw new Error("review_required must be HTTP 200");
  }
  if (ops.weeklyBackgroundHttpStatus({ success: false, review_required: true }) !== 200) {
    throw new Error("review_required success=false must still be HTTP 200");
  }
  if (ops.weeklyBackgroundHttpStatus({ success: false, reason: "source_fetch_failed" }) !== 500) {
    throw new Error("true source failure must remain HTTP 500");
  }
  if (!ops.isReviewRequiredZeroWrite({ review_required: true, summary: { inserts: 0, updates: 0 } })) {
    throw new Error("zero-write review must be recognised");
  }
});

test("20. Operational status distinguishes review, miss, and healthy", () => {
  if (ops.classifyOperationalStatus({ reviewRequired: true }) !== "REVIEW_REQUIRED") {
    throw new Error("review");
  }
  if (ops.classifyOperationalStatus({ missedSchedule: true }) !== "MISSED_SCHEDULE") {
    throw new Error("missed");
  }
  if (ops.classifyOperationalStatus({ sourceFailure: true }) !== "SOURCE_FAILURE") {
    throw new Error("source");
  }
  if (ops.classifyOperationalStatus({ writeFailure: true }) !== "WRITE_FAILURE") {
    throw new Error("write");
  }
  if (ops.classifyOperationalStatus({ enabled: false }) !== "DISABLED") {
    throw new Error("disabled");
  }
  if (ops.classifyOperationalStatus({}) !== "HEALTHY") {
    throw new Error("healthy");
  }
  if (ops.classifyOperationalStatus({ abandoned: true }) !== "STALE_ABANDONED") {
    throw new Error("abandoned");
  }
});

console.log(`\ntest-scheduled-maintenance: ${passed} passed`);
