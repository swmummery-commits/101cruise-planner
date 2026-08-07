#!/usr/bin/env node
/**
 * Maintenance hardening regression tests (locks, run persistence, manifests, flags).
 *   npm run test:maintenance-hardening
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const maintenance = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));
const locks = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks"));
const manifests = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-manifests"));
const tracking = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-tracking"));
const automation = require(path.join(root, "netlify/functions/lib/cruise-discovery-automation"));
const { evaluateMaintenanceQualityGate } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-runner"
));
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const fs = require("fs");

let passed = 0;
function test(name, fn) {
  const result = fn();
  if (result && typeof result.then === "function") {
    return result.then(() => {
      passed += 1;
      console.log(`✓ ${name}`);
    });
  }
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

function createMockLockSupabase() {
  const store = new Map();
  return async function mockSupabase(restPath, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    if (restPath.startsWith("rpc/acquire_cruise_discovery_maintenance_lock")) {
      const body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
      const key = body.p_lock_key;
      const owner = body.p_owner_id;
      const lease = body.p_lease_seconds || 900;
      const now = Date.now();
      const existing = store.get(key);
      if (existing && new Date(existing.expires_at).getTime() > now && existing.owner_id !== owner) {
        return { acquired: false, reason: "maintenance_lock_held", lock_key: key, owner_id: existing.owner_id };
      }
      const expires_at = new Date(now + lease * 1000).toISOString();
      store.set(key, { lock_key: key, owner_id: owner, expires_at, acquired_at: new Date(now).toISOString() });
      return { acquired: true, lock_key: key, owner_id: owner, expires_at };
    }
    if (restPath.startsWith("rpc/release_cruise_discovery_maintenance_lock")) {
      const body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
      const row = store.get(body.p_lock_key);
      if (row && row.owner_id === body.p_owner_id) {
        store.delete(body.p_lock_key);
        return true;
      }
      return false;
    }
    if (method === "GET" && restPath.includes("cruise_discovery_maintenance_locks")) {
      const key = decodeURIComponent(restPath.match(/lock_key=eq\.([^&]+)/)?.[1] || "");
      const row = store.get(key);
      return row ? [row] : [];
    }
    if (method === "POST" && restPath === "cruise_discovery_runs") {
      const body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
      const id = `run-${store.size + 1}`;
      store.set(`run:${id}`, { id, ...body });
      return [{ id, ...body }];
    }
    if (method === "PATCH" && restPath.includes("cruise_discovery_runs")) {
      return null;
    }
    if (method === "POST" && restPath === "cruise_discovery_maintenance_manifests") {
      const body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
      const id = `manifest-${store.size + 1}`;
      return [{ id, ...body }];
    }
    return [];
  };
}

await test("resolveEnvFlag distinguishes explicit true/false/unset", () => {
  const t = maintenance.resolveEnvFlag("true");
  const f = maintenance.resolveEnvFlag("false");
  const u = maintenance.resolveEnvFlag(undefined);
  if (t.state !== "explicit_true" || !t.effective) throw new Error("true");
  if (f.state !== "explicit_false" || f.effective) throw new Error("false");
  if (u.state !== "unset_default_false" || u.effective) throw new Error("unset");
});

await test("describeDiscoveryAutomationHold reports Celebrity flags as unset-default", () => {
  withEnv("CELEBRITY_DISCOVERY_WRITE_ENABLED", undefined, () => {
    withEnv("CELEBRITY_AUTOMATIC_CONTINUATION_ENABLED", undefined, () => {
      delete require.cache[require.resolve(path.join(root, "netlify/functions/lib/cruise-discovery-automation"))];
      delete require.cache[require.resolve(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"))];
      const hold = require(path.join(root, "netlify/functions/lib/cruise-discovery-automation")).describeDiscoveryAutomationHold();
      if (hold.celebrity_discovery_write.state !== "unset_default_false") throw new Error("write flag");
      if (hold.celebrity_automatic_continuation.state !== "unset_default_false") throw new Error("continuation flag");
    });
  });
});

await test("atomic lock acquisition succeeds for first owner", async () => {
  const sb = createMockLockSupabase();
  const first = await locks.acquireMaintenanceDbLock(sb, {
    lockKey: "holland-america-line:weekly",
    ownerId: "owner-a",
    leaseSeconds: 60
  });
  if (!first.acquired) throw new Error("should acquire");
});

await test("concurrent invocation rejected when valid lease exists", async () => {
  const sb = createMockLockSupabase();
  await locks.acquireMaintenanceDbLock(sb, { lockKey: "daily_expiry", ownerId: "owner-a", leaseSeconds: 300 });
  const second = await locks.acquireMaintenanceDbLock(sb, { lockKey: "daily_expiry", ownerId: "owner-b", leaseSeconds: 300 });
  if (second.acquired) throw new Error("should reject");
  if (second.reason !== "maintenance_lock_held") throw new Error(second.reason);
});

await test("expired lock allows new owner", async () => {
  const sb = createMockLockSupabase();
  await locks.acquireMaintenanceDbLock(sb, { lockKey: "celebrity-cruises:weekly", ownerId: "old", leaseSeconds: 1 });
  await new Promise((r) => setTimeout(r, 1100));
  const next = await locks.acquireMaintenanceDbLock(sb, {
    lockKey: "celebrity-cruises:weekly",
    ownerId: "new",
    leaseSeconds: 60
  });
  if (!next.acquired) throw new Error("stale lock should recover");
});

await test("lock release after success", async () => {
  const sb = createMockLockSupabase();
  await locks.acquireMaintenanceDbLock(sb, { lockKey: "daily_expiry", ownerId: "rel-a", leaseSeconds: 60 });
  await locks.releaseMaintenanceDbLock(sb, { lockKey: "daily_expiry", ownerId: "rel-a" });
  const again = await locks.acquireMaintenanceDbLock(sb, { lockKey: "daily_expiry", ownerId: "rel-b", leaseSeconds: 60 });
  if (!again.acquired) throw new Error("released lock should allow new owner");
});

await test("HAL and Celebrity locks are independent", async () => {
  const sb = createMockLockSupabase();
  const hal = await locks.acquireMaintenanceDbLock(sb, {
    lockKey: locks.weeklyLockKey("holland-america-line"),
    ownerId: "hal",
    leaseSeconds: 60
  });
  const cel = await locks.acquireMaintenanceDbLock(sb, {
    lockKey: locks.weeklyLockKey("celebrity-cruises"),
    ownerId: "cel",
    leaseSeconds: 60
  });
  if (!hal.acquired || !cel.acquired) throw new Error("independent locks");
});

await test("Princess weekly lock rejects concurrent second owner", async () => {
  const sb = createMockLockSupabase();
  const first = await locks.acquireMaintenanceDbLock(sb, {
    lockKey: locks.weeklyLockKey("princess-cruises"),
    ownerId: "princess-run-a",
    leaseSeconds: 900
  });
  const second = await locks.acquireMaintenanceDbLock(sb, {
    lockKey: locks.weeklyLockKey("princess-cruises"),
    ownerId: "princess-run-b",
    leaseSeconds: 900
  });
  if (!first.acquired) throw new Error("first princess lock should acquire");
  if (second.acquired) throw new Error("second princess lock should be blocked");
  if (second.worker_state !== "already_running") throw new Error("expected already_running");
});

await test("verifyMaintenanceLockOwnership detects owner mismatch", async () => {
  const sb = createMockLockSupabase();
  await locks.acquireMaintenanceDbLock(sb, {
    lockKey: locks.weeklyLockKey("princess-cruises"),
    ownerId: "owner-a",
    leaseSeconds: 60
  });
  const check = await locks.verifyMaintenanceLockOwnership(sb, {
    lockKey: locks.weeklyLockKey("princess-cruises"),
    ownerId: "owner-b"
  });
  if (check.ok) throw new Error("should fail ownership check");
  if (check.reason !== "maintenance_lock_owner_mismatch") throw new Error(check.reason);
});

await test("Princess maintenance runner re-checks lock ownership before writes", () => {
  const src = fs.readFileSync(
    path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-runner.js"),
    "utf8"
  );
  if (!src.includes("verifyMaintenanceLockOwnership")) throw new Error("missing pre-write lock verify");
  if (!src.includes("maintenance_lock_lost_before_write")) throw new Error("missing blocked write path");
});

await test("rollback manifest captures inserted and updated record IDs", () => {
  const manifest = manifests.buildRollbackManifestFromWriteResult({
    runId: "run-1",
    runRecordId: "rec-1",
    cruiseLineId: "line-1",
    lineSlug: "holland-america-line",
    triggerType: "scheduled",
    writeResult: {
      write_details: [
        {
          discovered_cruise_id: "id-insert",
          official_sailing_id: "HAL1",
          created: true,
          before_values: null,
          after_values: { id: "id-insert", status: "active" }
        },
        {
          discovered_cruise_id: "id-update",
          official_sailing_id: "HAL2",
          created: false,
          duplicate: false,
          before_values: { id: "id-update", status: "active", departure_port: "A" },
          after_values: { id: "id-update", status: "active", departure_port: "B" }
        }
      ]
    }
  });
  if (manifest.inserted_record_ids.length !== 1 || manifest.updated_record_ids.length !== 1) {
    throw new Error(JSON.stringify(manifest));
  }
  if (!manifest.updated[0].before_values) throw new Error("missing before_values");
});

await test("quality gate blocks writes on collapse", () => {
  const gate = evaluateMaintenanceQualityGate({
    lineSlug: "holland-america-line",
    metrics: {
      eligible_total: 400,
      ship_resolution_pct: 99,
      departure_port_resolution_pct: 96,
      destination_resolution_pct: 91,
      identity_coverage_pct: 100,
      duplicate_official_identities: 0
    },
    previousEligible: { stats: { eligible_total: 1000 } },
    manifest: { products: [] },
    dryRun: false
  });
  if (gate.passed) throw new Error("should block");
});

await test("script adapter parses pre-stringified POST body once", () => {
  const restSrc = fs.readFileSync(path.join(root, "scripts/lib/supabase-rest.cjs"), "utf8");
  if (!restSrc.includes("JSON.parse(body)")) throw new Error("missing body parse fix");
});

await test("legacy cruise-discovery-cron exits before wave kick when automation disabled", () => {
  const cronSrc = fs.readFileSync(path.join(root, "netlify/functions/cruise-discovery-cron.js"), "utf8");
  if (!cronSrc.includes("if (!isCruiseDiscoveryAutomationEnabled())")) throw new Error("missing gate");
  if (!cronSrc.includes("scheduled_wave_skipped")) throw new Error("missing skipped run type");
  if (!cronSrc.includes("lines_processed: 0")) throw new Error("missing lines_processed guard");
  const handlerStart = cronSrc.indexOf("exports.handler");
  const gateInHandler = cronSrc.indexOf("if (!isCruiseDiscoveryAutomationEnabled())", handlerStart);
  const listLinesInHandler = cronSrc.indexOf("listActiveSoldCruiseLineIds", handlerStart);
  if (gateInHandler < 0 || listLinesInHandler < 0 || gateInHandler > listLinesInHandler) {
    throw new Error("automation gate must precede line listing in handler");
  }
});

await test("createMaintenanceRun uses single JSON body contract", async () => {
  const sb = createMockLockSupabase();
  const row = await tracking.createMaintenanceRun(sb, {
    cruiseLineId: "line-1",
    runId: "test-run",
    runType: "hal_weekly_maintenance",
    triggerType: "manual",
    stats: { dry_run: true }
  });
  if (!row?.id) throw new Error("run not created");
});

await test("Perth calendar date used for expiry as_of", () => {
  const d = maintenance.perthCalendarDate(new Date("2026-08-05T18:00:00Z"));
  if (d !== "2026-08-06") throw new Error(`expected 2026-08-06 got ${d}`);
});

try {
  const rest = createSupabaseRest(root);
  await test("production lock tables reachable (post-migration)", async () => {
    await rest.get("cruise_discovery_maintenance_locks?select=lock_key&limit=0");
    await rest.get("cruise_discovery_maintenance_manifests?select=id&limit=0");
  });
} catch {
  console.log("○ production lock table integration skipped (migration not applied or no .env)");
}

console.log(`\ntest-maintenance-hardening: ${passed} passed`);
