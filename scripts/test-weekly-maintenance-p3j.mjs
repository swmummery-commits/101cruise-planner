#!/usr/bin/env node
/**
 * P3J tests: Disney two-phase execution, manifest-before-write, stale partial-write detection.
 *
 *   npm run test:weekly-maintenance-p3j
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const phases = require(path.join(root, "netlify/functions/lib/disney-weekly-phases"));
const apply = require(path.join(root, "netlify/functions/lib/disney-weekly-apply"));
const stale = require(path.join(root, "netlify/functions/lib/weekly-maintenance-stale-runs"));
const dispatch = require(path.join(root, "netlify/functions/lib/disney-weekly-maintenance-dispatch"));
const inventory = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const maintenance = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));
const source = require(path.join(root, "netlify/functions/lib/disney-discovery-source"));

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    failed += 1;
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
    failed += 1;
    failures.push({ name, error: error.message || String(error) });
    console.log(`✗ ${name} — ${error.message || error}`);
  }
}

test("Phase A budget leaves reserve before Netlify 900s limit", () => {
  if (phases.DISNEY_NETLIFY_BACKGROUND_LIMIT_MS !== 900000) throw new Error("platform limit");
  if (phases.DISNEY_PHASE_A_DEADLINE_MS >= phases.DISNEY_NETLIFY_BACKGROUND_LIMIT_MS) {
    throw new Error("no reserve");
  }
  if (phases.DISNEY_PHASE_A_DEADLINE_MS < source.DISNEY_SOURCE_DEADLINE_MS) {
    throw new Error("source deadline exceeds phase A budget");
  }
});

test("Phase A plan with huge backlog is controlled_catchup_required and no cap raise", () => {
  const inserts = Array.from({ length: 40 }, (_, i) => ({
    official_sailing_id: `DA${String(i).padStart(4, "0")}|2027-01-01`,
    candidate: { official_sailing_id: `DA${String(i).padStart(4, "0")}|2027-01-01`, ship_id: "s" }
  }));
  const plan = phases.buildDisneyPhaseAPlan({ inserts, cruiseLine: { id: "line" }, maxWrites: 30 });
  if (plan.terminal_status !== "controlled_catchup_required") throw new Error(plan.terminal_status);
  if (plan.batches.some((b) => b.expected_record_count > 30)) throw new Error("batch > 30");
});

test("first 30 of sorted insert queue is batch 1", () => {
  const inserts = ["DA0090|2027-01-01", "DA0001|2027-01-01", "DA0002|2027-01-01"].map((id) => ({
    official_sailing_id: id,
    candidate: { official_sailing_id: id }
  }));
  const plan = phases.buildDisneyPhaseAPlan({ inserts, cruiseLine: { id: "line" }, maxWrites: 30 });
  if (plan.payload.insert_official_sailing_ids[0] !== "DA0001|2027-01-01") {
    throw new Error(plan.payload.insert_official_sailing_ids.join(","));
  }
});

await testAsync("precommit manifest failure yields zero writes", async () => {
  const posts = [];
  const sb = async (p, options = {}) => {
    if (String(p).includes("acquire_cruise_discovery_maintenance_lock")) return { acquired: true };
    if (String(p).includes("release_cruise_discovery_maintenance_lock")) return { released: true };
    if (p === "cruise_discovery_runs" && options.method === "POST") {
      return [{ id: "batch-run" }];
    }
    if (p === "cruise_discovery_maintenance_manifests" && options.method === "POST") {
      posts.push(p);
      return [];
    }
    if (String(p).startsWith("cruise_discovery_runs?") && options.method === "PATCH") return [];
    return [];
  };
  const result = await phases.applyDisneyPhaseBBatch({
    supabase: sb,
    cruiseLine: { id: "line" },
    plan: {
      plan_hash: "abc",
      inserts: [{ official_sailing_id: "DA1|2027-01-01", candidate: { official_sailing_id: "DA1|2027-01-01" } }]
    },
    batch: { batch_number: 1, official_sailing_ids: ["DA1|2027-01-01"] },
    runId: "phase-b-test"
  });
  if (result.writes !== 0) throw new Error("writes must be 0");
  if (!String(result.reason).includes("manifest")) throw new Error(result.reason);
});

await testAsync("stale no-write becomes stale_abandoned", async () => {
  const patched = [];
  const sb = async (p, options = {}) => {
    if (p.startsWith("cruise_discovery_maintenance_locks")) {
      return [
        {
          lock_key: "disney-cruise-line:weekly",
          owner_id: "dead",
          run_id: "dead",
          expires_at: new Date(Date.now() - 3600_000).toISOString()
        }
      ];
    }
    if (p.startsWith("cruise_discovery_runs?") && (options.method || "GET") === "GET") {
      return [
        {
          id: "run-1",
          cruise_line_id: "disney",
          status: "running",
          started_at: new Date(Date.now() - 4 * 3600_000).toISOString(),
          stats: { run_type: "disney_weekly_maintenance", run_id: "dead" }
        }
      ];
    }
    if (p.startsWith("discovered_cruises")) return [];
    if (p.startsWith("cruise_discovery_maintenance_manifests")) return [];
    if (p.startsWith("cruise_discovery_runs?") && options.method === "PATCH") {
      patched.push(JSON.parse(options.body));
      return [];
    }
    return [];
  };
  const result = await stale.reconcileAbandonedMaintenanceRuns(sb, {
    lineSlug: "disney-cruise-line",
    runType: "disney_weekly_maintenance"
  });
  if (result.abandoned.length !== 1) throw new Error(String(result.abandoned.length));
  if (patched[0].stats.terminal_status !== "stale_abandoned") throw new Error(patched[0].stats.terminal_status);
  if (patched[0].stats.inventory_changed === true) throw new Error("no-write must not claim inventory change");
});

await testAsync("stale partial-write becomes partial_write_failure", async () => {
  const patched = [];
  const sb = async (p, options = {}) => {
    if (p.startsWith("cruise_discovery_maintenance_locks")) {
      return [
        {
          lock_key: "disney-cruise-line:weekly",
          owner_id: "dead",
          run_id: "dead",
          expires_at: new Date(Date.now() - 3600_000).toISOString()
        }
      ];
    }
    if (p.startsWith("cruise_discovery_runs?") && (options.method || "GET") === "GET") {
      return [
        {
          id: "run-partial",
          cruise_line_id: "disney",
          status: "running",
          started_at: new Date(Date.now() - 4 * 3600_000).toISOString(),
          stats: { run_type: "disney_weekly_maintenance", run_id: "dead", inserts: 0 }
        }
      ];
    }
    if (p.startsWith("discovered_cruises") && p.includes("created_at")) {
      return Array.from({ length: 30 }, (_, i) => ({ id: `id-${i}`, official_sailing_id: `DA${i}|2027-01-01` }));
    }
    if (p.startsWith("discovered_cruises")) return [];
    if (p.startsWith("cruise_discovery_maintenance_manifests")) return [];
    if (p.startsWith("cruise_discovery_runs?") && options.method === "PATCH") {
      patched.push(JSON.parse(options.body));
      return [];
    }
    return [];
  };
  const result = await stale.reconcileAbandonedMaintenanceRuns(sb, {
    lineSlug: "disney-cruise-line",
    runType: "disney_weekly_maintenance"
  });
  if (result.abandoned.length !== 1) throw new Error("expected abandon");
  if (patched[0].stats.terminal_status !== "partial_write_failure") throw new Error(patched[0].stats.terminal_status);
  if (patched[0].stats.inventory_changed !== true) throw new Error("must not claim zero writes");
  if (patched[0].stats.inserts !== 30) throw new Error(String(patched[0].stats.inserts));
});

await testAsync("live execution lock is not swept", async () => {
  const sb = async (p, options = {}) => {
    if (p.startsWith("cruise_discovery_maintenance_locks")) {
      return [
        {
          lock_key: "disney-cruise-line:weekly",
          owner_id: "live",
          run_id: "live",
          run_record_id: "live-1",
          expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString()
        }
      ];
    }
    if (p.startsWith("cruise_discovery_runs?") && (options.method || "GET") === "GET") {
      return [
        {
          id: "live-1",
          status: "running",
          started_at: new Date(Date.now() - 4 * 3600_000).toISOString(),
          stats: { run_type: "disney_weekly_maintenance", run_id: "live" }
        }
      ];
    }
    if (options.method === "PATCH") throw new Error("must not patch live worker");
    return [];
  };
  const result = await stale.reconcileAbandonedMaintenanceRuns(sb, {
    lineSlug: "disney-cruise-line",
    runType: "disney_weekly_maintenance"
  });
  if (result.abandoned.length) throw new Error("live worker swept");
});

await testAsync("scheduled-period lease is ignored for liveness", async () => {
  const patched = [];
  const sb = async (p, options = {}) => {
    if (p.startsWith("cruise_discovery_maintenance_locks?lock_key=")) {
      const key = decodeURIComponent(p.split("eq.")[1].split("&")[0]);
      if (key.endsWith(":scheduled")) {
        return [
          {
            lock_key: key,
            owner_id: "dispatch",
            expires_at: new Date(Date.now() + 7 * 86400_000).toISOString()
          }
        ];
      }
      if (key === "disney-cruise-line:weekly") {
        return [
          {
            lock_key: key,
            owner_id: "dead",
            run_id: "dead",
            expires_at: new Date(Date.now() - 3600_000).toISOString()
          }
        ];
      }
      return [];
    }
    if (p.startsWith("cruise_discovery_runs?") && (options.method || "GET") === "GET") {
      return [
        {
          id: "stale-period",
          cruise_line_id: "disney",
          status: "running",
          started_at: new Date(Date.now() - 4 * 3600_000).toISOString(),
          stats: { run_type: "disney_weekly_maintenance", run_id: "dead" }
        }
      ];
    }
    if (p.startsWith("discovered_cruises")) return [];
    if (p.startsWith("cruise_discovery_runs?") && options.method === "PATCH") {
      patched.push(JSON.parse(options.body));
      return [];
    }
    return [];
  };
  const result = await stale.reconcileAbandonedMaintenanceRuns(sb, {
    lineSlug: "disney-cruise-line",
    runType: "disney_weekly_maintenance"
  });
  if (result.abandoned.length !== 1) throw new Error("period lease must not keep dead worker running");
  if (patched[0].stats.dispatch_period_lease_ignored !== true) throw new Error("lease ignored flag missing");
});

test("source_current_touches are skipped unless explicitly enabled", () => {
  const src = fs.readFileSync(path.join(root, "netlify/functions/lib/disney-weekly-apply.js"), "utf8");
  if (!src.includes("includeSourceTouches === true")) throw new Error("touches must be opt-in");
});

test("Phase A source timeout path still exists in weekly runner", () => {
  const src = fs.readFileSync(path.join(root, "netlify/functions/lib/disney-weekly-maintenance.js"), "utf8");
  if (!src.includes('terminal_status: "source_unstable"')) throw new Error("timeout terminal missing");
  if (!src.includes("persistDisneySourceFreeze")) throw new Error("phase A freeze missing");
  if (src.includes("runGlobalProtectedMaintenanceWrites")) throw new Error("phase A must not write in the source worker");
});

test("21-day cutoff and timetable unchanged", () => {
  if (inventory.PUBLIC_BOOKING_CUTOFF_DAYS !== 21) throw new Error("cutoff changed");
  const toml = fs.readFileSync(path.join(root, "netlify.toml"), "utf8");
  if (!toml.includes('schedule = "0 19 * * 3"')) throw new Error("Disney Thursday cron moved");
  if (!toml.includes('schedule = "0 17 * * 4"')) throw new Error("Azamara Friday cron moved");
  if (!toml.includes('schedule = "0 19 * * 4"')) throw new Error("Silversea Friday cron moved");
  if (maintenance.MAINTENANCE_SCHEDULES.daily_expiry.cron_utc !== "30 22 * * *") throw new Error("expiry moved");
});

test("daily expiry calls all-line stale sweep", () => {
  const src = fs.readFileSync(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-cron.js"), "utf8");
  if (!src.includes("reconcileAllStaleCruiseMaintenanceRuns")) throw new Error("daily sweep missing");
});

test("accepted first-30 freeze file exists with 30 hashes", () => {
  const freeze = JSON.parse(
    fs.readFileSync(path.join(root, "reports/disney-p3j-partial-write-30-freeze-2026-09-17.json"), "utf8")
  );
  if (freeze.row_count !== 30) throw new Error(String(freeze.row_count));
  if (!freeze.freeze_hash_sha256) throw new Error("missing freeze hash");
});

test("Disney weekly cap remains 30", () => {
  if (dispatch.DISNEY_MAX_WEEKLY_WRITES !== 30) throw new Error(String(dispatch.DISNEY_MAX_WEEKLY_WRITES));
});

test("persistMaintenanceManifest JSON-stringifies body for production fetch", () => {
  const src = fs.readFileSync(
    path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-manifests.js"),
    "utf8"
  );
  if (!src.includes("body: JSON.stringify({")) throw new Error("manifest body must be JSON");
});

test("stale sweep does not delete scheduled-period leases", () => {
  const src = fs.readFileSync(path.join(root, "netlify/functions/lib/weekly-maintenance-stale-runs.js"), "utf8");
  if (src.includes("scheduledWeeklyDispatchKey") && src.includes("removeExpiredLockRow") && /removeExpiredLockRow\([^\)]*scheduledWeeklyDispatchKey/.test(src)) {
    throw new Error("must not delete schedule lease");
  }
  if (!src.includes("dispatch_period_lease_ignored")) throw new Error("period lease must be ignored for liveness");
});

test("Phase B takes a Disney weekly execution lease", () => {
  const src = fs.readFileSync(path.join(root, "netlify/functions/lib/disney-weekly-phases.js"), "utf8");
  if (!src.includes("acquireMaintenanceDbLock")) throw new Error("phase B missing execution lock");
  if (!src.includes("weeklyLockKey(DISNEY_LINE_SLUG)")) throw new Error("phase B lock key");
});

test("expansion concurrency is bounded and harvest is concurrent", () => {
  if (source.DISNEY_EXPANSION_CONCURRENCY < 4) throw new Error("expansion concurrency too low");
  if (source.DISNEY_HARVEST_PLAN_CONCURRENCY < 2) throw new Error("harvest remains fully serial");
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.error(failures);
  process.exit(1);
}
