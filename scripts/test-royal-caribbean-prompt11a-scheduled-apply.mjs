#!/usr/bin/env node
/**
 * Royal Caribbean Prompt 11A — scheduled production apply policy + observability.
 *   npm run test:royal-caribbean-prompt11a-scheduled-apply
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import fs from "fs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const dispatch = require(path.join(root, "netlify/functions/lib/royal-caribbean-weekly-maintenance-dispatch"));
const manifest = require(path.join(root, "netlify/functions/lib/royal-caribbean-weekly-manifest"));
const mode = require(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-mode"));
const maintenance = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));
const updates = require(path.join(root, "netlify/functions/lib/royal-caribbean-weekly-updates"));

const PRODUCTION_ENV = {
  CONTEXT: "production",
  ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED: "true",
  ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED: "false"
};
const PREVIEW_ENV = { CONTEXT: "deploy-preview", ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED: "true" };
const BRANCH_ENV = { CONTEXT: "branch-deploy", ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED: "true" };
const WEEKLY_DISABLED_ENV = { CONTEXT: "production", ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED: "false" };

function mondayScheduledEvent() {
  return dispatch.scheduledEvent({
    headers: { "x-netlify-event": "schedule" },
    body: JSON.stringify({ next_run: "2026-08-17T23:00:00.000Z" })
  });
}

/** Pre-fix defect: legacy resolveDryRun always returned true when weekly enabled. */
function legacyPrefixedResolveDryRun(body = {}, env = process.env) {
  if (body.dry_run === true || body.dryRun === true) return true;
  if (body.dry_run === false || body.dryRun === false) return false;
  const weeklyEnabled =
    String(env.ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED || "").trim().toLowerCase() === "true";
  if (!weeklyEnabled) return true;
  return true;
}

function legacyPrefixedResolveMaxWrites(body = {}) {
  const n = Number(body.max_writes ?? body.maxWrites ?? 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    failures.push({ name, error: error.message || String(error) });
    console.log(`✗ ${name} — ${error.message || error}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    failures.push({ name, error: error.message || String(error) });
    console.log(`✗ ${name} — ${error.message || error}`);
  }
}

console.log("--- Pre-fix defect proof (legacy behaviour) ---");

test("pre-fix: scheduled production + weekly enabled resolved dry_run=true", () => {
  const event = mondayScheduledEvent();
  if (legacyPrefixedResolveDryRun({}, PRODUCTION_ENV) !== true) {
    throw new Error("legacy dry_run should always be true without explicit false");
  }
  if (dispatch.resolveDryRun({}, event, PRODUCTION_ENV) !== false) {
    throw new Error("post-fix should be false for scheduled production apply");
  }
});

test("pre-fix: scheduled with no max_writes resolved max_writes=0", () => {
  if (legacyPrefixedResolveMaxWrites({}) !== 0) throw new Error("legacy default was 0");
  const event = mondayScheduledEvent();
  if (dispatch.resolveMaxWrites({}, event, PRODUCTION_ENV) !== 150) {
    throw new Error("post-fix should default to 150");
  }
});

console.log("\n--- Scheduled production policy ---");

test("1. scheduled + production + weekly enabled + no body => dry_run=false", () => {
  const event = mondayScheduledEvent();
  if (dispatch.resolveDryRun({}, event, PRODUCTION_ENV) !== false) throw new Error("expected apply");
});

test("2. scheduled + production + weekly enabled + no max_writes => max_writes=150", () => {
  const event = mondayScheduledEvent();
  if (dispatch.resolveMaxWrites({}, event, PRODUCTION_ENV) !== 150) throw new Error("expected 150");
});

test("3. scheduled + production + weekly disabled => dry-run", () => {
  const event = mondayScheduledEvent();
  if (dispatch.resolveDryRun({}, event, WEEKLY_DISABLED_ENV) !== true) throw new Error("expected dry-run");
  if (dispatch.resolveMaxWrites({}, event, WEEKLY_DISABLED_ENV) !== 0) throw new Error("expected 0 writes cap");
});

test("4. scheduled + preview context => dry-run", () => {
  const event = mondayScheduledEvent();
  if (dispatch.resolveDryRun({}, event, PREVIEW_ENV) !== true) throw new Error("preview must dry-run");
});

test("5. scheduled + branch context => dry-run", () => {
  const event = mondayScheduledEvent();
  if (dispatch.resolveDryRun({}, event, BRANCH_ENV) !== true) throw new Error("branch must dry-run");
});

console.log("\n--- Manual invocation policy ---");

test("6. manual + no dry_run => dry-run", () => {
  if (dispatch.resolveDryRun({}, null, PRODUCTION_ENV) !== true) throw new Error("manual default dry-run");
});

test("7. manual + explicit dry_run=true => dry-run", () => {
  if (dispatch.resolveDryRun({ dry_run: true }, null, PRODUCTION_ENV) !== true) throw new Error("explicit true");
});

test("8. manual + explicit dry_run=false => may apply (policy only)", () => {
  if (dispatch.resolveDryRun({ dry_run: false }, null, PRODUCTION_ENV) !== false) {
    throw new Error("explicit false must pass through resolveDryRun");
  }
});

console.log("\n--- Ceiling enforcement (manifest validation) ---");

function makeManifest(counts) {
  const mk = (n, kind) =>
    Array.from({ length: n }, (_, i) => ({
      official_sailing_id: `${kind}-${i}`,
      ...(kind === "update" ? { safe_fields: ["official_url"] } : {}),
      ...(kind === "cutoff" ? { id: `id-${i}` } : {}),
      ...(kind === "absence" ? { discovered_cruise_id: `dc-${i}` } : {})
    }));
  return {
    mode: "royal_caribbean_weekly_maintenance",
    perth_today: "2026-08-17",
    source_snapshot_id: "snap-1",
    inserts: mk(counts.inserts || 0, "insert"),
    updates: mk(counts.updates || 0, "update"),
    cutoff_hides: mk(counts.cutoff || 0, "cutoff"),
    source_absence_hides: mk(counts.absence || 0, "absence")
  };
}

test("9. inserts=100 passes ceiling", () => {
  const r = manifest.validateFrozenWeeklyManifest(makeManifest({ inserts: 100 }));
  if (!r.passed) throw new Error(r.failures.join(","));
});

test("10. inserts=101 blocks", () => {
  const r = manifest.validateFrozenWeeklyManifest(makeManifest({ inserts: 101 }));
  if (r.passed) throw new Error("expected block");
});

test("11. updates=50 passes", () => {
  const r = manifest.validateFrozenWeeklyManifest(makeManifest({ updates: 50 }));
  if (!r.passed) throw new Error(r.failures.join(","));
});

test("12. updates=51 blocks", () => {
  const r = manifest.validateFrozenWeeklyManifest(makeManifest({ updates: 51 }));
  if (r.passed) throw new Error("expected block");
});

test("13. source absence=20 passes", () => {
  const r = manifest.validateFrozenWeeklyManifest(makeManifest({ absence: 20 }));
  if (!r.passed) throw new Error(r.failures.join(","));
});

test("14. source absence=21 blocks", () => {
  const r = manifest.validateFrozenWeeklyManifest(makeManifest({ absence: 21 }));
  if (r.passed) throw new Error("expected block");
});

test("15. total=150 passes", () => {
  const r = manifest.validateFrozenWeeklyManifest(makeManifest({ inserts: 100, updates: 50 }));
  if (!r.passed) throw new Error(r.failures.join(","));
});

test("16. total=151 blocks", () => {
  const r = manifest.validateFrozenWeeklyManifest(makeManifest({ inserts: 100, updates: 51 }));
  if (r.passed) throw new Error("expected block");
});

test("16b. explicit max_writes=151 blocks apply at dispatch layer", () => {
  const policy = dispatch.resolveMaxWritesPolicy({ max_writes: 151 }, mondayScheduledEvent(), PRODUCTION_ENV, {
    dryRun: false
  });
  if (!policy.blocked) throw new Error("expected blocked");
});

console.log("\n--- Observability ---");

await testAsync("17. outer weekly execution creates one maintenance record", async () => {
  const trackingPath = path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-tracking.js");
  const cronPath = path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-cron.js");
  let createCount = 0;
  let finalizeCount = 0;

  const trackingMod = require(trackingPath);
  const origCreate = trackingMod.createMaintenanceRun;
  const origFinalize = trackingMod.finalizeMaintenanceRun;
  trackingMod.createMaintenanceRun = async () => {
    createCount += 1;
    return { id: "run-record-1" };
  };
  trackingMod.finalizeMaintenanceRun = async () => {
    finalizeCount += 1;
  };

  delete require.cache[cronPath];
  const cronMod = require(cronPath);

  try {
    const sb = async () => [{ id: "line-rc", slug: "royal-caribbean-international" }];
    await cronMod.executeWeeklyMaintenance({
      lineSlug: "royal-caribbean-international",
      cruiseLineId: "line-rc",
      runType: maintenance.ROYAL_CARIBBEAN_WEEKLY_MAINTENANCE_RUN_TYPE,
      assertEnabled: () => {},
      runMaintenance: async () => ({
        ok: true,
        summary: { proposed_inserts: 0, proposed_updates: 0, weekly_maintenance_healthy: true }
      }),
      dryRun: true,
      maxWrites: 0,
      triggerType: "scheduled",
      supabaseClient: sb,
      statsEnricher: dispatch.enrichRoyalCaribbeanMaintenanceStats
    });
    if (createCount !== 1) throw new Error(`expected 1 create got ${createCount}`);
    if (finalizeCount !== 1) throw new Error(`expected 1 finalize got ${finalizeCount}`);
  } finally {
    trackingMod.createMaintenanceRun = origCreate;
    trackingMod.finalizeMaintenanceRun = origFinalize;
    delete require.cache[cronPath];
    require(cronPath);
  }
});

test("18. inner useRunRecord=false does not create duplicate (runner has no inner create)", () => {
  const dispatchSrc = fs.readFileSync(
    path.join(root, "netlify/functions/lib/royal-caribbean-weekly-maintenance-dispatch.js"),
    "utf8"
  );
  const runnerSrc = fs.readFileSync(
    path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-runner.js"),
    "utf8"
  );
  if (!dispatchSrc.includes("useRunRecord: false")) throw new Error("dispatch must pass useRunRecord:false");
  if (runnerSrc.includes("createMaintenanceRun")) throw new Error("runner must not create maintenance runs");
});

test("19. scheduled trigger stored as scheduled", () => {
  const event = mondayScheduledEvent();
  if (dispatch.resolveTriggerType(event, {}) !== "scheduled") throw new Error("expected scheduled");
});

await testAsync("20. completed run finalises stats", async () => {
  const trackingPath = path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-tracking.js");
  const cronPath = path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-cron.js");
  let finalStats = null;
  const trackingMod = require(trackingPath);
  const origFinalize = trackingMod.finalizeMaintenanceRun;
  trackingMod.finalizeMaintenanceRun = async (_sb, _id, payload) => {
    finalStats = payload.stats;
  };
  trackingMod.createMaintenanceRun = async () => ({ id: "run-record-1" });

  delete require.cache[cronPath];
  const cronMod = require(cronPath);

  try {
    const sb = async () => [{ id: "line-rc", slug: "royal-caribbean-international" }];
    await cronMod.executeWeeklyMaintenance({
      lineSlug: "royal-caribbean-international",
      cruiseLineId: "line-rc",
      runType: maintenance.ROYAL_CARIBBEAN_WEEKLY_MAINTENANCE_RUN_TYPE,
      assertEnabled: () => {},
      runMaintenance: async () => ({
        ok: true,
        summary: {
          source_snapshot_id: "snap-abc",
          proposed_inserts: 2,
          proposed_updates: 1,
          weekly_maintenance_healthy: true,
          royal_caribbean_source_enumeration_ok: true
        }
      }),
      dryRun: true,
      triggerType: "scheduled",
      supabaseClient: sb,
      statsEnricher: dispatch.enrichRoyalCaribbeanMaintenanceStats
    });
    if (!finalStats) throw new Error("stats not finalised");
    if (finalStats.trigger_type !== "scheduled") throw new Error("missing trigger_type");
    if (finalStats.source_snapshot_id !== "snap-abc") throw new Error("missing source_snapshot_id");
  } finally {
    trackingMod.finalizeMaintenanceRun = origFinalize;
    delete require.cache[cronPath];
    require(cronPath);
  }
});

await testAsync("21. failed run records failure", async () => {
  const trackingPath = path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-tracking.js");
  const cronPath = path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-cron.js");
  let finalPayload = null;
  const trackingMod = require(trackingPath);
  const origFinalize = trackingMod.finalizeMaintenanceRun;
  trackingMod.finalizeMaintenanceRun = async (_sb, _id, payload) => {
    finalPayload = payload;
  };
  trackingMod.createMaintenanceRun = async () => ({ id: "run-record-1" });

  delete require.cache[cronPath];
  const cronMod = require(cronPath);

  try {
    const sb = async () => [{ id: "line-rc", slug: "royal-caribbean-international" }];
    await cronMod.executeWeeklyMaintenance({
      lineSlug: "royal-caribbean-international",
      cruiseLineId: "line-rc",
      runType: maintenance.ROYAL_CARIBBEAN_WEEKLY_MAINTENANCE_RUN_TYPE,
      assertEnabled: () => {},
      runMaintenance: async () => ({
        ok: false,
        reason: "source_enumeration_unhealthy",
        summary: { failure_reason: "source_enumeration_unhealthy" }
      }),
      dryRun: true,
      triggerType: "scheduled",
      supabaseClient: sb
    });
    if (finalPayload?.status !== "failed") throw new Error("expected failed status");
    if (!finalPayload?.errorMessage) throw new Error("expected error message");
  } finally {
    trackingMod.finalizeMaintenanceRun = origFinalize;
    delete require.cache[cronPath];
    require(cronPath);
  }
});

test("22. no secret fields serialized in redactSecrets", () => {
  const out = dispatch.redactSecrets({
    dispatch_id: "d1",
    x_discovery_cron_secret: "super-secret",
    DISCOVERY_CRON_SECRET: "super-secret",
    dry_run: false
  });
  const json = JSON.stringify(out);
  if (json.includes("super-secret")) throw new Error("secret leaked");
});

console.log("\n--- Safety ---");

test("23. bulk discovery write flag remains false", () => {
  if (mode.ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED !== false) throw new Error("bulk flag must be off");
  const bulk = mode.resolveRoyalCaribbeanDiscoveryMode("production_write");
  if (bulk.writes_allowed) throw new Error("production_write must stay blocked without bulk flag");
  const controlled = mode.resolveRoyalCaribbeanDiscoveryMode("controlled_batch");
  if (controlled.writes_allowed) throw new Error("controlled_batch must stay blocked without bulk flag");
});

test("24. identity mutation forbidden", () => {
  if (updates.assertNoIdentityMutation("A", "B") !== false) throw new Error("mutation forbidden");
});

test("25. unhealthy enumeration blocks writes in dry-run health", () => {
  const reconciliation = require(path.join(root, "netlify/functions/lib/royal-caribbean-reconciliation-summary"));
  const result = reconciliation.evaluateRoyalCaribbeanDryRunHealth({
    simulation: { ok: true, products: [] },
    arithmetic: { reconciliation_arithmetic_ok: true },
    manifest: { products: [] },
    actualWrites: 0,
    enumerationHealth: { royal_caribbean_source_enumeration_ok: false }
  });
  if (result.passed) throw new Error("unhealthy enumeration must block");
});

test("26. no hard delete in weekly apply path", () => {
  const applySrc = fs.readFileSync(
    path.join(root, "netlify/functions/lib/royal-caribbean-weekly-apply.js"),
    "utf8"
  );
  if (/method:\s*['"]DELETE['"]/i.test(applySrc)) throw new Error("hard DELETE found in weekly apply");
  if (!applySrc.includes("hide") && !applySrc.includes("expired")) {
    throw new Error("expected hide/expiry semantics");
  }
});

console.log("\n--- Monday dispatch payload simulation ---");

test("Monday Netlify scheduled event resolves apply payload", () => {
  const event = mondayScheduledEvent();
  const policy = dispatch.resolveWeeklyExecutionPolicy({}, event, PRODUCTION_ENV);
  if (policy.scheduled_invocation !== true) throw new Error("scheduled_invocation must be true");
  if (policy.platform_scheduled !== true) throw new Error("platform_scheduled must be true");
  if (policy.dryRun !== false) throw new Error("dry_run must be false");
  if (policy.maxWrites !== 150) throw new Error("max_writes must be 150");
  if (dispatch.resolveTriggerType(event, {}) !== "scheduled") throw new Error("trigger must be scheduled");

  const payload = dispatch.buildBackgroundPayload({
    dryRun: policy.dryRun,
    maxWrites: policy.maxWrites,
    triggerType: "scheduled",
    dispatchId: "sim-dispatch",
    runId: null
  });
  if (payload.dry_run !== false || payload.max_writes !== 150) throw new Error("payload mismatch");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
