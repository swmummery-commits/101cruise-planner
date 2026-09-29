#!/usr/bin/env node
/**
 * P3P hybrid zero-write rehearsal:
 * enqueue a harvest request, Mac worker claims once, freeze persisted, 0 writes.
 *
 *   node scripts/rehearse-princess-p3p-hybrid.mjs
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { spawnSync } from "child_process";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createMaintenanceSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const queue = require(path.join(root, "netlify/functions/lib/princess-harvest-queue"));

const dispatchId = `p3p-hybrid-rehearsal-${new Date().toISOString().replace(/[:.]/g, "-")}`;

async function main() {
  const sb = createMaintenanceSupabase(root);
  const store = await queue.resolvePrincessHarvestStore(sb);
  const enqueued = await queue.enqueuePrincessHarvestRequest(store, {
    period_key: "p3p-hybrid-rehearsal",
    dispatch_id: dispatchId,
    dry_run: true
  });
  if (!enqueued.request?.id) {
    throw new Error("enqueue_failed");
  }
  const worker = spawnSync(process.execPath, [path.join(root, "scripts/princess-mac-source-worker.mjs"), "--once"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PRINCESS_SOURCE_WORKER_ID: "p3p-rehearsal-mac" }
  });
  const after = await store.getById(enqueued.request.id);
  const report = {
    ok: after?.status === "completed" && worker.status === 0,
    launcher: "rehearsal_enqueue",
    source_worker: "mac",
    harvest_request_id: enqueued.request.id,
    dispatch_id: dispatchId,
    duplicate: enqueued.duplicate === true,
    claimed_worker: after?.worker_id || null,
    harvest_status: after?.status || null,
    source_freeze: Boolean(after?.source_snapshot_hash || after?.source_freeze),
    eligible_count: after?.eligible_count ?? null,
    source_snapshot_hash: after?.source_snapshot_hash || null,
    writes: 0,
    worker_stdout: String(worker.stdout || "").slice(0, 800),
    worker_stderr: String(worker.stderr || "").slice(0, 400),
    worker_exit: worker.status
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message || String(error), writes: 0 }));
  process.exit(1);
});
