#!/usr/bin/env node
/**
 * Persistent Mac Princess source worker.
 * Polls princess_harvest_requests, claims one job, harvests, persists freeze.
 *
 *   node scripts/princess-mac-source-worker.mjs --once
 *   node scripts/princess-mac-source-worker.mjs --loop
 */

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const { createMaintenanceSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const queue = require(path.join(root, "netlify/functions/lib/princess-harvest-queue"));
const { runPrincessWeeklyMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-runner"
));
const { assertNoSecretLeakage, redactSecretsFromDiagnostics } = require(path.join(
  root,
  "netlify/functions/lib/princess-source-diagnostics"
));

const POLL_MS = Number(process.env.PRINCESS_SOURCE_WORKER_POLL_MS || 45000);
const HEARTBEAT_PATH =
  process.env.PRINCESS_SOURCE_WORKER_HEARTBEAT_PATH ||
  path.join(os.homedir(), "Library/Logs/101cruise-princess-source-worker-heartbeat.json");

function parseArgs(argv) {
  return {
    once: argv.includes("--once"),
    loop: argv.includes("--loop") || !argv.includes("--once")
  };
}

function workerId() {
  return String(process.env.PRINCESS_SOURCE_WORKER_ID || `mac-${os.hostname()}`).slice(0, 80);
}

function hostnameClass() {
  return "mac";
}

function writeLocalHeartbeat(status) {
  const payload = {
    worker_id: workerId(),
    hostname_class: hostnameClass(),
    pid: process.pid,
    status,
    last_seen_at: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(HEARTBEAT_PATH), { recursive: true });
  fs.writeFileSync(HEARTBEAT_PATH, JSON.stringify(payload, null, 2));
  return payload;
}

async function persistRemoteHeartbeat(sb, payload) {
  await sb("princess_source_worker_heartbeats?worker_id=eq." + encodeURIComponent(payload.worker_id), {
    method: "PATCH",
    body: payload
  }).catch(async () => {
    await sb("princess_source_worker_heartbeats", {
      method: "POST",
      body: payload
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeClaimedRequest(sb, store, request) {
  await queue.startPrincessHarvestRequest(store, request.id);
  const result = await runPrincessWeeklyMaintenance({
    supabase: sb,
    dryRun: request.dry_run !== false,
    performWrites: request.dry_run === false,
    writeMode: "weekly_maintenance",
    triggerType: "orchestrated_mac_harvest",
    runId: request.dispatch_id,
    runRecordId: request.run_record_id,
    collectSourceDiagnostics: true,
    macHarvestWorker: true
  });
  const summary = result.summary || {};
  const freeze = {
    official_ids: summary.frozen_source?.official_ids || [],
    snapshot_id: summary.snapshot_id || summary.source_snapshot_id || null,
    eligible_total: summary.eligible_total ?? null,
    official_source_total: summary.official_source_total ?? null,
    source_diagnostics: redactSecretsFromDiagnostics(summary.source_diagnostics || null),
    terminal_status: result.terminal_status || summary.terminal_status || null,
    inserts: summary.inserts ?? 0,
    updates: summary.updates ?? 0,
    inventory_changed: summary.inventory_changed === true
  };
  const leak = assertNoSecretLeakage(freeze);
  if (!leak.ok) {
    await queue.failPrincessHarvestRequest(store, request.id, {
      errorCode: "SECRET_LEAKAGE_BLOCKED",
      errorDetail: leak.leaks.join(",")
    });
    return { ok: false, request_id: request.id, error: "secret_leakage_blocked" };
  }
  if (result.ok === false && result.reason === "official_source_unreachable") {
    await queue.failPrincessHarvestRequest(store, request.id, {
      errorCode: summary.source_failure_class || "OFFICIAL_SOURCE_UNREACHABLE",
      errorDetail: result.reason
    });
    return { ok: false, request_id: request.id, error: result.reason };
  }
  await queue.completePrincessHarvestRequest(store, request.id, {
    source_snapshot_hash: freeze.snapshot_id,
    eligible_count: freeze.eligible_total,
    source_freeze: freeze
  });
  return {
    ok: true,
    request_id: request.id,
    eligible_count: freeze.eligible_total,
    writes: 0
  };
}

async function tick(sb, store) {
  const heartbeat = writeLocalHeartbeat("idle");
  await persistRemoteHeartbeat(sb, heartbeat).catch(() => null);
  const claimed = await queue.claimPrincessHarvestRequest(store, { workerId: workerId() });
  if (!claimed) return { claimed: false };
  writeLocalHeartbeat("running");
  try {
    const outcome = await executeClaimedRequest(sb, store, claimed);
    writeLocalHeartbeat("idle");
    return { claimed: true, ...outcome };
  } catch (error) {
    await queue.failPrincessHarvestRequest(store, claimed.id, {
      errorCode: "WORKER_EXCEPTION",
      errorDetail: error.message || "worker_exception"
    });
    writeLocalHeartbeat("idle");
    return { claimed: true, ok: false, error: error.message || "worker_exception" };
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createMaintenanceSupabase(root);
  const store = await queue.resolvePrincessHarvestStore(sb);
  if (args.once) {
    const result = await tick(sb, store);
    console.log(JSON.stringify({ worker_id: workerId(), ...result, writes: 0 }));
    return;
  }
  writeLocalHeartbeat("starting");
  while (true) {
    try {
      await tick(sb, store);
    } catch (error) {
      writeLocalHeartbeat("error");
      console.error(JSON.stringify({ ok: false, error: error.message || String(error) }));
    }
    await sleep(POLL_MS);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message || String(error) }));
  process.exit(1);
});
