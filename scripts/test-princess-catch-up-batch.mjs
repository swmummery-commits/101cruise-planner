#!/usr/bin/env node
/**
 * Princess catch-up batch safeguard tests.
 *   node scripts/test-princess-catch-up-batch.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const locks = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks"));
const writes = require(path.join(root, "netlify/functions/lib/princess-discovery-writes"));

const batchSrc = fs.readFileSync(path.join(root, "scripts/run-princess-first-production-batch.mjs"), "utf8");
const runnerSrc = fs.readFileSync(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-runner.js"),
  "utf8"
);

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

test("next-batch requires --expected-active-count", () => {
  if (!batchSrc.includes('expectedActiveCount == null')) throw new Error("missing active count guard");
  if (!batchSrc.includes("--expected-active-count=")) throw new Error("missing arg parser");
});

test("next-batch requires --expected-snapshot-id", () => {
  if (!batchSrc.includes('!args.expectedSnapshotId')) throw new Error("missing snapshot guard");
});

test("next-batch apply requires --max-writes capped at 100", () => {
  if (!batchSrc.includes("CATCHUP_MAX = 100")) throw new Error("missing catchup max");
  if (!batchSrc.includes("args.maxWrites > CATCHUP_MAX")) throw new Error("missing max cap check");
});

test("first-batch apply blocked without --next-batch when active >= 20", () => {
  if (!batchSrc.includes("countsBefore.princess_active >= FIRST_BATCH_MAX")) {
    throw new Error("missing first batch guard");
  }
  if (!batchSrc.includes("Use --next-batch with explicit checkpoints")) throw new Error("missing message");
});

test("preflight aborts on active count mismatch with zero writes", () => {
  if (!batchSrc.includes("expected_active_count_mismatch")) throw new Error("missing mismatch abort");
  if (!batchSrc.includes("phase: \"preflight_abort\"")) throw new Error("missing abort phase");
  if (!batchSrc.includes("rollback_manifest_id: null")) throw new Error("missing manifest guard on abort");
});

test("preflight aborts on snapshot mismatch", () => {
  if (!batchSrc.includes("expected_snapshot_id_mismatch")) throw new Error("missing snapshot mismatch");
});

test("deterministic Princess write ordering by official sailing identity", () => {
  if (!runnerSrc.includes(".sort((a, b) =>")) throw new Error("missing sort");
  if (!runnerSrc.includes("localeCompare(kb)")) throw new Error("missing localeCompare ordering");
});

test("Princess writer rejects null cruise_line_id", () => {
  let threw = false;
  try {
    writes.assertPrincessWriteCandidate(
      { ship_id: "s1", cruise_line_id: null, official_sailing_id: "A|B|2026-09-01" },
      { id: "line-1" }
    );
  } catch (error) {
    threw = error.code === "princess_write_candidate_missing_cruise_line_id";
  }
  if (!threw) throw new Error("expected validation error");
});

test("catch-up idempotency uses catch_up_idempotency_verification trigger", () => {
  if (!batchSrc.includes("catch_up_idempotency_verification")) throw new Error("missing trigger");
  if (!batchSrc.includes("--catch-up-idempotency")) throw new Error("missing flag");
});

test("Princess lock blocks concurrent second owner", async () => {
  const store = new Map();
  const sb = async (restPath, options = {}) => {
    const method = options.method || "GET";
    if (restPath.startsWith("rpc/acquire_cruise_discovery_maintenance_lock")) {
      const body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
      const key = body.p_lock_key;
      const owner = body.p_owner_id;
      const row = store.get(key);
      const now = Date.now();
      if (row && new Date(row.expires_at).getTime() > now && row.owner_id !== owner) {
        return { acquired: false, reason: "maintenance_lock_held", owner_id: row.owner_id };
      }
      const expires = new Date(now + 900000).toISOString();
      store.set(key, { lock_key: key, owner_id: owner, expires_at: expires });
      return { acquired: true, lock_key: key, owner_id: owner, expires_at: expires };
    }
    if (method === "GET" && restPath.includes("cruise_discovery_maintenance_locks")) {
      const key = decodeURIComponent(restPath.split("lock_key=eq.")[1]?.split("&")[0] || "");
      const row = store.get(key);
      return row ? [row] : [];
    }
    return [];
  };
  const key = locks.weeklyLockKey("princess-cruises");
  const first = await locks.acquireMaintenanceDbLock(sb, { lockKey: key, ownerId: "a", leaseSeconds: 900 });
  const second = await locks.acquireMaintenanceDbLock(sb, { lockKey: key, ownerId: "b", leaseSeconds: 900 });
  if (!first.acquired || second.acquired) throw new Error("concurrent lock should block");
});

console.log(`\ntest-princess-catch-up-batch: ${passed} passed`);
