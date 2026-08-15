#!/usr/bin/env node
/**
 * Global cross-line production cruise-write lock tests.
 *   npm run test:global-cruise-write-lock
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const globalLock = require(path.join(root, "netlify/functions/lib/cruise-discovery-global-write-lock"));
const locks = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks"));

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

function createMockLockSupabase({ fixedNow } = {}) {
  const store = new Map();
  const nowFn = () => (fixedNow != null ? fixedNow : Date.now());
  return {
    store,
    supabase: async function mockSupabase(restPath, options = {}) {
      const method = (options.method || "GET").toUpperCase();
      if (restPath.startsWith("rpc/acquire_cruise_discovery_maintenance_lock")) {
        const body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
        const key = body.p_lock_key;
        const owner = body.p_owner_id;
        const lease = body.p_lease_seconds || 900;
        const now = nowFn();
        const existing = store.get(key);
        if (existing && new Date(existing.expires_at).getTime() > now && existing.owner_id !== owner) {
          return {
            acquired: false,
            reason: "maintenance_lock_held",
            lock_key: key,
            owner_id: existing.owner_id,
            expires_at: existing.expires_at
          };
        }
        const expires_at = new Date(now + lease * 1000).toISOString();
        store.set(key, {
          lock_key: key,
          owner_id: owner,
          run_id: body.p_run_id || null,
          expires_at,
          acquired_at: new Date(now).toISOString()
        });
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
      if (method === "POST" && restPath === "discovered_cruises") {
        return [{ id: "cruise-test-1" }];
      }
      return [];
    }
  };
}

await test("global lock key is controlled_production_import:global", () => {
  if (globalLock.GLOBAL_CRUISE_WRITE_LOCK_KEY !== "controlled_production_import:global") {
    throw new Error(globalLock.GLOBAL_CRUISE_WRITE_LOCK_KEY);
  }
});

await test("two controlled imports: A acquires, B denied until A releases", async () => {
  const { supabase, store } = createMockLockSupabase();
  const a = await globalLock.acquireGlobalCruiseWriteLock(supabase, {
    ownerId: "run-a",
    runId: "run-a",
    operation: "controlled_batch"
  });
  if (!a.acquired) throw new Error("run-a should acquire");

  let bWrites = 0;
  const b = await globalLock.acquireGlobalCruiseWriteLock(supabase, {
    ownerId: "run-b",
    runId: "run-b",
    operation: "controlled_batch"
  });
  if (b.acquired) throw new Error("run-b should be denied");
  if (b.reason !== globalLock.GLOBAL_LOCK_DENIED_REASON) throw new Error(b.reason);
  bWrites += 0;

  await globalLock.releaseGlobalCruiseWriteLock(supabase, { ownerId: "run-a" });
  const b2 = await globalLock.acquireGlobalCruiseWriteLock(supabase, {
    ownerId: "run-b",
    runId: "run-b"
  });
  if (!b2.acquired) throw new Error("run-b should acquire after release");
  if (bWrites !== 0) throw new Error("B must perform zero writes while denied");
  if (store.size !== 1) throw new Error("expected one active lock");
});

await test("stale lease: active lease cannot be stolen; expired lease reclaims", async () => {
  const fixedStart = Date.now();
  const mockA = createMockLockSupabase({ fixedNow: fixedStart });
  await locks.acquireMaintenanceDbLock(mockA.supabase, {
    lockKey: globalLock.GLOBAL_CRUISE_WRITE_LOCK_KEY,
    ownerId: "owner-a",
    leaseSeconds: 60
  });

  const stealAttempt = await locks.acquireMaintenanceDbLock(mockA.supabase, {
    lockKey: globalLock.GLOBAL_CRUISE_WRITE_LOCK_KEY,
    ownerId: "owner-b",
    leaseSeconds: 60
  });
  if (stealAttempt.acquired) throw new Error("active lease must not be stolen");

  const expiredNow = fixedStart + 61_000;
  const mockB = createMockLockSupabase({ fixedNow: expiredNow });
  mockB.store = mockA.store;

  const reclaim = await locks.acquireMaintenanceDbLock(mockB.supabase, {
    lockKey: globalLock.GLOBAL_CRUISE_WRITE_LOCK_KEY,
    ownerId: "owner-b",
    leaseSeconds: 60
  });
  if (!reclaim.acquired) throw new Error("expired lease should be reclaimable");
});

await test("failure release: exception after acquisition still releases lock", async () => {
  const { supabase, store } = createMockLockSupabase();
  let released = false;
  try {
    await globalLock.withGlobalCruiseWriteLock(
      supabase,
      { ownerId: "fail-run", runId: "fail-run", operation: "test" },
      async () => {
        throw new Error("simulated apply failure");
      }
    );
  } catch (error) {
    if (!/simulated apply failure/.test(error.message)) throw error;
  }
  released = !store.has(globalLock.GLOBAL_CRUISE_WRITE_LOCK_KEY);
  if (!released) throw new Error("lock should be released in finally after exception");

  const next = await globalLock.acquireGlobalCruiseWriteLock(supabase, {
    ownerId: "next-run",
    runId: "next-run"
  });
  if (!next.acquired) throw new Error("lock should be available after failure release");
});

await test("preflight race: under-lock recheck blocks when state changes before apply", async () => {
  const { supabase } = createMockLockSupabase();
  let writes = 0;

  const result = await globalLock.executeControlledProductionApply(
    supabase,
    {
      runId: "race-run",
      lineSlug: "silversea-cruises",
      operation: "controlled_batch",
      performWrites: true,
      underLockRecheck: async () => {
        const conflictDetected = true;
        if (conflictDetected) {
          return { ok: false, reason: "under_lock_selected_official_ids_already_present" };
        }
        return { ok: true };
      }
    },
    async () => {
      writes += 1;
      return { stats: { inserted: 1 } };
    }
  );

  if (!result.blocked) throw new Error("apply should block when under-lock recheck fails");
  if (writes !== 0) throw new Error("writes must remain zero when recheck fails");
});

await test("scheduled vs controlled: maintenance writer blocks overlapping controlled apply", async () => {
  const { supabase } = createMockLockSupabase();
  const scheduled = await globalLock.withGlobalCruiseWriteLock(
    supabase,
    { ownerId: "hal-weekly", runId: "hal-weekly", lineSlug: "holland-america-line", operation: "scheduled_maintenance" },
    async () => {
      const overlap = await globalLock.acquireGlobalCruiseWriteLock(supabase, {
        ownerId: "silversea-batch",
        runId: "silversea-batch",
        lineSlug: "silversea-cruises"
      });
      if (overlap.acquired) throw new Error("controlled apply must not acquire during scheduled write");
      return { denied: true, reason: overlap.reason };
    }
  );
  if (!scheduled.acquired) throw new Error("scheduled writer should acquire");
  if (!scheduled.result?.denied) throw new Error("overlap should be denied");
});

await test("read-only concurrency: dry-run apply does not acquire global lock", async () => {
  const { supabase, store } = createMockLockSupabase();
  await globalLock.acquireGlobalCruiseWriteLock(supabase, { ownerId: "writer", runId: "writer" });

  const dry = await globalLock.executeControlledProductionApply(
    supabase,
    { runId: "dry-run", performWrites: false, dryRun: true },
    async () => ({ stats: { inserted: 0 }, simulated: true })
  );
  if (dry.blocked) throw new Error("dry run should not block on global lock");
  if (dry.global_lock?.global_lock_acquired) throw new Error("dry run must not acquire global lock");
  if (!dry.writeResult?.simulated) throw new Error("dry run fn should execute");
  if (store.get(globalLock.GLOBAL_CRUISE_WRITE_LOCK_KEY)?.owner_id !== "writer") {
    throw new Error("existing writer lock must remain held");
  }
});

await test("production mutation layer fails closed without global lock context", async () => {
  let threw = false;
  try {
    await globalLock.assertGlobalCruiseWriteLockHeld({ requireGlobalWriteLock: true });
  } catch (error) {
    threw = error.code === globalLock.GLOBAL_LOCK_DENIED_REASON;
  }
  if (!threw) throw new Error("assert must fail closed without global lock");
});

await test("lock ownership verified under withGlobalCruiseWriteLock context", async () => {
  const { supabase } = createMockLockSupabase();
  const wrapped = await globalLock.withGlobalCruiseWriteLock(
    supabase,
    { ownerId: "verify-run", runId: "verify-run", operation: "test" },
    async () => globalLock.assertGlobalCruiseWriteLockHeld({ requireGlobalWriteLock: true })
  );
  if (!wrapped.acquired) throw new Error("lock should acquire");
});

console.log(`\n${passed} global cruise write lock tests passed.`);
