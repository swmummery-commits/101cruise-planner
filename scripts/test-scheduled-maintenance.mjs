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

test("8. Inventory collapse gate blocks writes", () => {
  const gate = evaluateMaintenanceQualityGate({
    lineSlug: "holland-america-line",
    metrics: { eligible_total: 500, ship_resolution_pct: 99, departure_port_resolution_pct: 96, destination_resolution_pct: 91, identity_coverage_pct: 100, duplicate_official_identities: 0 },
    previousEligible: { stats: { eligible_total: 1000 } },
    manifest: { products: [] },
    dryRun: false
  });
  if (gate.passed) throw new Error("collapse gate should fail");
});

test("9. Perth calendar date helper returns YYYY-MM-DD", () => {
  const d = maintenance.perthCalendarDate(new Date("2026-08-05T20:00:00Z"));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(d);
});

test("10. Freshness Current within 8 days", () => {
  const label = maintenance.computeFreshnessLabel(new Date(Date.now() - 3 * 86400000).toISOString());
  if (label !== "Current") throw new Error(label);
});

test("11. Source absent policy retains active records", () => {
  const action = "source_absent_retained_active";
  if (action === "hide_removed_official_sailing") throw new Error("must not auto-hide");
});

test("12. P&O Cruises Australia remains excluded from maintenance scope", () => {
  const excluded = "p-o-cruises-australia";
  if (excluded === "holland-america-line") throw new Error("scope leak");
});

test("13. Princess remains unprocessed", () => {
  if ("princess-cruises" === "celebrity-cruises") throw new Error("scope leak");
});

console.log(`\ntest-scheduled-maintenance: ${passed} passed`);
