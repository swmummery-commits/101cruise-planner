#!/usr/bin/env node
/**
 * Princess P3P source-transport + scheduler architecture tests.
 *   node scripts/test-princess-p3p-source-transport.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import crypto from "crypto";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const diag = require(path.join(root, "netlify/functions/lib/princess-source-diagnostics"));
const source = require(path.join(root, "netlify/functions/lib/princess-discovery-source"));
const worker = require(path.join(root, "netlify/functions/lib/princess-source-worker-watch"));
const queue = require(path.join(root, "netlify/functions/lib/princess-harvest-queue"));
const tracking = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-tracking"));
const accounting = require(path.join(root, "netlify/functions/lib/weekly-maintenance-write-accounting"));
const cutoff = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const lanes = require(path.join(root, "netlify/functions/lib/princess-weekly-lanes"));

const applyWorkflow = fs.readFileSync(
  path.join(root, ".github/workflows/princess-weekly-maintenance-apply.yml"),
  "utf8"
);
const dryWorkflow = fs.readFileSync(
  path.join(root, ".github/workflows/princess-weekly-maintenance.yml"),
  "utf8"
);
const netlifyToml = fs.readFileSync(path.join(root, "netlify.toml"), "utf8");
const runnerSrc = fs.readFileSync(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-runner.js"),
  "utf8"
);

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

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

const DEFAULT_HASH = sha256(source.DEFAULT_CLIENT_ID);

await test("Mac effective-client fingerprint uses DEFAULT when env unset", async () => {
  const resolved = await source.resolvePclClientIdDetailed({
    PRINCESS_PCL_CLIENT_ID: "",
    PRINCESS_PCL_CLIENT_ID_REFRESH: ""
  });
  const fp = diag.fingerprintClientId(resolved.value);
  if (resolved.source !== "DEFAULT") throw new Error(resolved.source);
  if (fp.sha256 !== DEFAULT_HASH) throw new Error("default hash mismatch");
});

await test("Netlify effective-client fingerprint ENV vs DEFAULT classification", async () => {
  const envResolved = await source.resolvePclClientIdDetailed({
    PRINCESS_PCL_CLIENT_ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  });
  if (envResolved.source !== "ENV") throw new Error(envResolved.source);
  const fp = diag.fingerprintClientId(envResolved.value);
  if (fp.sha256 === DEFAULT_HASH) throw new Error("env hash must differ from default");
  const compared = diag.compareEffectiveClientConfig(
    { sha256: DEFAULT_HASH, source: "DEFAULT" },
    { sha256: fp.sha256, source: "ENV" }
  );
  if (compared.hash_match) throw new Error("hashes must differ");
  if (compared.source_match) throw new Error("sources must differ");
});

await test("sanitized source diagnostics never include raw secrets", () => {
  const payload = source.buildPrincessSourceDiagnosticsEnvelope({
    session: {
      ok: false,
      clientId: source.DEFAULT_CLIENT_ID,
      cookie: "session=supersecretcookievalue",
      client_id_source: "DEFAULT",
      diagnostics: {
        attempts: [
          {
            http_status: 403,
            body_excerpt: "Access Denied",
            response_headers: { server: "AkamaiGHost" },
            request: {
              user_agent: "101cruise-discovery/1.0",
              origin: "https://www.princess.com",
              referer: "https://www.princess.com/cruise-search/cruises/",
              pcl_client_id_present: true,
              cookie_present: true,
              productcompany: "PC",
              bookingcompany: "PC"
            }
          }
        ]
      }
    }
  });
  const leak = diag.assertNoSecretLeakage(payload);
  if (!leak.ok) throw new Error(leak.leaks.join(","));
  if (JSON.stringify(payload).includes(source.DEFAULT_CLIENT_ID)) throw new Error("raw client id leaked");
  if (/supersecretcookievalue/.test(JSON.stringify(payload))) throw new Error("raw cookie leaked");
  if (payload.effective_client_id.sha256 !== DEFAULT_HASH) throw new Error("fingerprint missing");
});

await test("bootstrap 403 Akamai classifies as AKAMAI_WAF_REJECTION", () => {
  const klass = diag.classifyPrincessSourceFailure({
    bootstrap: {
      attempts: [
        {
          http_status: 403,
          body_excerpt: "Access Denied Reference #18.abc",
          response_headers: { server: "AkamaiGHost" }
        }
      ]
    }
  });
  if (klass !== "AKAMAI_WAF_REJECTION") throw new Error(klass);
});

await test("bootstrap 4xx/5xx classification", () => {
  if (
    diag.classifyPrincessSourceFailure({ bootstrap: { attempts: [{ http_status: 401 }] } }) !==
    "UBE_BOOTSTRAP_4XX"
  ) {
    throw new Error("401");
  }
  if (
    diag.classifyPrincessSourceFailure({ bootstrap: { attempts: [{ http_status: 503 }] } }) !==
    "UBE_BOOTSTRAP_5XX"
  ) {
    throw new Error("503");
  }
});

await test("catalogue failure classification", () => {
  const cases = [
    [400, "CATALOGUE_400"],
    [401, "CATALOGUE_401"],
    [403, "CATALOGUE_403"],
    [429, "CATALOGUE_429"],
    [502, "CATALOGUE_5XX"]
  ];
  for (const [status, expected] of cases) {
    const klass = diag.classifyPrincessSourceFailure({
      catalogue: { attempts: [{ http_status: status, body_excerpt: "error" }] }
    });
    if (klass !== expected) throw new Error(`${status} => ${klass}`);
  }
});

await test("DNS/TLS/timeout classification", () => {
  if (
    diag.classifyPrincessSourceFailure({ transport: { dns: { ok: false }, error_code: "ENOTFOUND" } }) !==
    "DNS_FAILURE"
  ) {
    throw new Error("dns");
  }
  if (diag.classifyPrincessSourceFailure({ transport: { tls_ok: false, error_code: "CERT_HAS_EXPIRED" } }) !== "TLS_FAILURE") {
    throw new Error("tls");
  }
  if (diag.classifyPrincessSourceFailure({ transport: { timeout: true } }) !== "SOURCE_TIMEOUT") {
    throw new Error("timeout");
  }
});

await test("fetch_failed summary persists classified diagnostics", () => {
  if (!runnerSrc.includes("source_failure_class")) throw new Error("runner missing failure class");
  if (!runnerSrc.includes("source_diagnostics")) throw new Error("runner missing diagnostics");
  const stats = tracking.buildMaintenanceRunStats({
    run_id: "x",
    source_failure_class: "AKAMAI_WAF_REJECTION",
    source_diagnostics: { failure_class: "AKAMAI_WAF_REJECTION", effective_client_id: { sha256: DEFAULT_HASH } },
    inserts: 0,
    updates: 0
  });
  if (stats.source_failure_class !== "AKAMAI_WAF_REJECTION") throw new Error("stats class");
  const leak = diag.assertNoSecretLeakage(stats);
  if (!leak.ok) throw new Error(leak.leaks.join(","));
});

await test("request construction compare detects header differences one field at a time", () => {
  const mac = {
    user_agent: "101cruise-discovery/1.0",
    origin: "https://www.princess.com",
    referer: "https://www.princess.com/cruise-search/cruises/",
    pcl_client_id_present: true,
    cookie_present: false,
    productcompany: "PC",
    bookingcompany: "PA"
  };
  const same = diag.compareRequestConstruction(mac, { ...mac });
  if (!same.match) throw new Error("identical");
  const ua = diag.compareRequestConstruction(mac, { ...mac, user_agent: "other" });
  if (ua.match || ua.differences.join() !== "user_agent") throw new Error(String(ua.differences));
});

await test("Mac queue atomic claim is exclusive", async () => {
  const store = queue.createMemoryPrincessHarvestStore();
  await queue.enqueuePrincessHarvestRequest(store, {
    period_key: "2026-W40",
    dispatch_id: "d1",
    run_record_id: "run-1"
  });
  const first = await queue.claimPrincessHarvestRequest(store, { workerId: "mac-a" });
  const second = await queue.claimPrincessHarvestRequest(store, { workerId: "mac-b" });
  if (!first || first.worker_id !== "mac-a") throw new Error("first claim");
  if (second) throw new Error("second claim must be empty");
});

await test("duplicate harvest request prevention", async () => {
  const store = queue.createMemoryPrincessHarvestStore();
  const one = await queue.enqueuePrincessHarvestRequest(store, {
    period_key: "2026-W40",
    dispatch_id: "same"
  });
  const two = await queue.enqueuePrincessHarvestRequest(store, {
    period_key: "2026-W40",
    dispatch_id: "same"
  });
  if (!one.created) throw new Error("first");
  if (!two.duplicate || two.created) throw new Error("duplicate not detected");
});

await test("Mac worker restart can resume a claimed request via heartbeat", async () => {
  const store = queue.createMemoryPrincessHarvestStore();
  const enqueued = await queue.enqueuePrincessHarvestRequest(store, {
    period_key: "2026-W40",
    dispatch_id: "resume"
  });
  const claimed = await queue.claimPrincessHarvestRequest(store, { workerId: "mac-1" });
  await queue.startPrincessHarvestRequest(store, claimed.id);
  const beat = await queue.heartbeatPrincessHarvestRequest(store, claimed.id);
  if (beat.status !== "running") throw new Error(beat.status);
  await queue.completePrincessHarvestRequest(store, claimed.id, {
    source_snapshot_hash: "abc",
    eligible_count: 1941,
    source_freeze: { official_ids: ["A"] }
  });
  const done = await store.getById(enqueued.request.id);
  if (done.status !== "completed") throw new Error(done.status);
  if (done.eligible_count !== 1941) throw new Error("eligible");
});

await test("worker-not-started timeout", () => {
  const requested = Date.parse("2026-09-28T21:00:00Z");
  const late = queue.evaluateHarvestWait(
    { status: "queued", requested_at: "2026-09-28T21:00:00Z" },
    { expectedStartMs: requested, nowMs: requested + 21 * 60 * 1000, graceMs: 20 * 60 * 1000 }
  );
  if (late.status !== "SOURCE_WORKER_NOT_STARTED") throw new Error(late.status);
  const terminal = accounting.resolveWeeklyTerminalStatus({
    ok: false,
    reason: "SOURCE_WORKER_NOT_STARTED",
    summary: { inserts: 0, updates: 0 }
  });
  if (terminal !== "source_worker_not_started") throw new Error(terminal);
});

await test("stale worker timeout", () => {
  const started = Date.parse("2026-09-28T21:01:00Z");
  const stale = worker.evaluatePrincessSourceWorkerHealth({
    expectedStartMs: Date.parse("2026-09-28T21:00:00Z"),
    harvestStartedMs: started,
    lastHeartbeatMs: started,
    nowMs: started + 16 * 60 * 1000,
    staleMs: 15 * 60 * 1000
  });
  if (stale.status !== "STALE_SOURCE_WORKER") throw new Error(stale.status);
});

await test("zero-write orchestration rehearsal contract", async () => {
  const store = queue.createMemoryPrincessHarvestStore();
  const created = await queue.enqueuePrincessHarvestRequest(store, {
    period_key: "p3p-rehearsal",
    dispatch_id: "rehearsal-1",
    dry_run: true
  });
  const claimed = await queue.claimPrincessHarvestRequest(store, { workerId: "mac" });
  await queue.startPrincessHarvestRequest(store, claimed.id);
  await queue.completePrincessHarvestRequest(store, claimed.id, {
    source_snapshot_hash: "freeze",
    eligible_count: 1941,
    source_freeze: { official_ids: ["X"] }
  });
  const wait = queue.evaluateHarvestWait(await store.getById(created.request.id), {
    expectedStartMs: Date.now()
  });
  if (wait.status !== "completed") throw new Error(wait.status);
  if (claimed.dry_run !== true) throw new Error("must stay dry-run");
});

await test("single scheduler enforcement is Netlify-only after cutover", () => {
  const princessTomlBlock =
    netlifyToml.match(/\[functions\."princess-weekly-maintenance-cron"\][\s\S]*?(?=\n\[functions\.|$)/)?.[0] ||
    "";
  const netlifyHasCron = /^\s*schedule\s*=/m.test(princessTomlBlock);
  const githubHasCron = /schedule:[\s\S]*cron: "0 21 \* \* 0"/.test(applyWorkflow);
  const owners = queue.countSchedulerOwners({ githubHasCron, netlifyHasCron });
  if (owners.length !== 1) throw new Error(`owners=${owners.join(",")}`);
  if (owners[0] !== "netlify") throw new Error("cutover must leave Netlify as the only scheduler");
});

await test("GitHub workflow_dispatch retained", () => {
  if (!/workflow_dispatch:/.test(applyWorkflow)) throw new Error("apply workflow_dispatch missing");
  if (!/workflow_dispatch:/.test(dryWorkflow) && !fs.existsSync(path.join(root, ".github/workflows/princess-weekly-maintenance.yml"))) {
    throw new Error("manual path");
  }
});

await test("21-day cutoff, source-absence policy and write cap unchanged", () => {
  if (cutoff.PUBLIC_BOOKING_CUTOFF_DAYS !== 21) throw new Error("cutoff");
  if (lanes.PRINCESS_WEEKLY_WRITE_CAP !== 30) throw new Error("cap");
  if (!/source_absent_retained_active/.test(fs.readFileSync(
    path.join(root, "netlify/functions/lib/princess-weekly-maintenance-cli.js"),
    "utf8"
  ))) {
    throw new Error("source absence policy");
  }
});

await test("mocked harvest does not leak DEFAULT client id in diagnostics", async () => {
  source.__setPrincessTransportGetForTests(async (url) => {
    if (String(url).includes("/ube/")) {
      return {
        status: 403,
        headers: { "content-type": "text/html", server: "AkamaiGHost" },
        text: "Access Denied Reference #99",
        setCookie: []
      };
    }
    return { status: 403, headers: {}, text: "denied", setCookie: [] };
  });
  try {
    const result = await source.fetchAllPrincessRawSailings({ collectDiagnostics: true });
    if (!result.fetch_failed) throw new Error("expected failure");
    if (result.source_diagnostics.failure_class !== "AKAMAI_WAF_REJECTION") {
      throw new Error(result.source_diagnostics.failure_class);
    }
    const leak = diag.assertNoSecretLeakage(result);
    if (!leak.ok) throw new Error(leak.leaks.join(","));
    if (JSON.stringify(result).includes(source.DEFAULT_CLIENT_ID)) throw new Error("raw id in fetch_failed");
  } finally {
    source.__resetPrincessTransportGetForTests();
  }
});

console.log(`\n${passed} P3P tests passed`);
