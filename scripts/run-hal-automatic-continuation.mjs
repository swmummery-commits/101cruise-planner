#!/usr/bin/env node
/**
 * Holland America automatic inventory continuation (production).
 *
 *   node scripts/run-hal-automatic-continuation.mjs --precheck
 *   node scripts/run-hal-automatic-continuation.mjs --run
 *   node scripts/run-hal-automatic-continuation.mjs --verify
 *   node scripts/run-hal-automatic-continuation.mjs --disable-flags
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const { createSupabaseRest, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const {
  runHalDiscoveryBatch,
  acquireRunLock,
  releaseRunLock
} = require(path.join(root, "netlify/functions/lib/holland-america-discovery-batch"));
const { catalogueDestinations } = require(path.join(root, "netlify/functions/lib/holland-america-discovery-adapter"));
const {
  loadHalInventoryProgress,
  findRunningHalBatch
} = require(path.join(root, "netlify/functions/lib/holland-america-discovery-run-tracking"));
const {
  halAutomaticLimits,
  isHalAutomaticContinuationEnabled
} = require(path.join(root, "netlify/functions/lib/holland-america-discovery-automation"));
const { HAL_DISCOVERY_WRITE_ENABLED } = require(path.join(root, "netlify/functions/lib/holland-america-discovery-mode"));
const { activationGateIssues } = require(path.join(root, "scripts/lib/hal-batch-audit.cjs"));

const GLOBAL_LOCK = "hal-automatic-inventory";
const SESSION_ID = new Date().toISOString().replace(/[:.]/g, "-");
const SUMMARY_PATH = path.join(root, `reports/hal-automatic-continuation-${SESSION_ID}.json`);

function loadEnv() {
  try {
    require("dotenv").config({ path: path.join(root, ".env") });
  } catch {
    /* optional */
  }
}

loadEnv();

const siteUrl = String(
  process.env.NETLIFY_SITE_URL || process.env.URL || "https://admirable-tiramisu-d4da8a.netlify.app"
).replace(/\/$/, "");

function parseArgs(argv) {
  const args = { precheck: false, run: false, verify: false, disableFlags: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--precheck") args.precheck = true;
    if (arg === "--run") args.run = true;
    if (arg === "--verify") args.verify = true;
    if (arg === "--disable-flags") args.disableFlags = true;
  }
  if (!Object.values(args).some(Boolean)) args.precheck = true;
  return args;
}

async function headCount(table, query = "") {
  const https = require("https");
  const { url, key } = getSupabaseConfig(root);
  return new Promise((resolve, reject) => {
    const u = new URL(`${url}/rest/v1/${table}?select=id${query ? `&${query}` : ""}`);
    const req = https.request(
      u,
      { method: "HEAD", headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" } },
      (res) => {
        const range = res.headers["content-range"] || "";
        const m = range.match(/\/(\d+)/);
        resolve(m ? Number(m[1]) : 0);
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function fetchDetailedCounts(halLineId) {
  const today = new Date().toISOString().slice(0, 10);
  const tables = [
    "discovered_cruises",
    "cruise_discovery_review_items",
    "cruise_ship_aliases",
    "destinations",
    "destination_ports",
    "cruise_destination_aliases",
    "cruise_discovery_resolution_audit",
    "cruise_discovery_runs"
  ];
  const table_counts = {};
  for (const table of tables) table_counts[table] = await headCount(table);

  const sb = createSupabaseRest(root);
  const pendingReviews = await sb.get(
    "cruise_discovery_review_items?status=eq.pending&select=id,item_type,status&limit=5000"
  );

  return {
    table_counts,
    discovered_cruises_all: table_counts.discovered_cruises,
    discovered_cruises_active: await headCount("discovered_cruises", "status=eq.active"),
    discovered_cruises_active_future: await headCount(
      "discovered_cruises",
      `status=eq.active&departure_date=gte.${today}`
    ),
    holland_america_active: halLineId
      ? await headCount("discovered_cruises", `cruise_line_id=eq.${encodeURIComponent(halLineId)}&status=eq.active`)
      : 0,
    pending_review_items: (pendingReviews || []).length,
    total_review_items: table_counts.cruise_discovery_review_items,
    ship_aliases: table_counts.cruise_ship_aliases,
    destinations: table_counts.destinations,
    destination_ports: table_counts.destination_ports,
    destination_aliases: table_counts.cruise_destination_aliases,
    resolution_audit: table_counts.cruise_discovery_resolution_audit,
    discovery_runs: table_counts.cruise_discovery_runs
  };
}

async function loadHalContext(sb) {
  const lines = await sb.get(
    "ci_cruise_lines?slug=eq.holland-america-line&select=id,name,slug,website_url,cruise_search_url&limit=1"
  );
  const line = lines?.[0];
  if (!line) throw new Error("Holland America Line not found");
  const ships = await sb.get(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&active=eq.true&select=id,name,cruise_line_id`
  );
  const destRows = await sb.get(
    "destinations?classification_enabled=eq.true&select=id,name,slug,status,classification_enabled"
  );
  return {
    line,
    ships: ships || [],
    destinations: catalogueDestinations(destRows || [])
  };
}

async function runSmoke() {
  const secret = String(process.env.DISCOVERY_CRON_SECRET || "").trim();
  if (!secret) throw new Error("DISCOVERY_CRON_SECRET required");
  const response = await fetch(`${siteUrl}/.netlify/functions/hal-discovery-smoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-discovery-cron-secret": secret },
    body: JSON.stringify({ mode: "production_read_only" })
  });
  const body = await response.json();
  return { status: response.status, ok: response.status === 200 && body.ok === true, body };
}

async function checkDeployCommit() {
  try {
    const out = execSync("npx netlify api listSiteDeploys --data '{\"site_id\":\"admirable-tiramisu-d4da8a\",\"page\":1,\"per_page\":1}' 2>/dev/null || npx netlify status 2>/dev/null", {
      cwd: root,
      encoding: "utf8",
      timeout: 30000
    });
    return { raw: out.slice(0, 500), commit_local: "7e8cd63" };
  } catch {
    return { commit_local: "7e8cd63", deploy_check: "manual_verify_required" };
  }
}

function assertFlagsEnabledForRun() {
  if (String(process.env.HAL_DISCOVERY_WRITE_ENABLED || "").toLowerCase() !== "true") {
    throw new Error("HAL_DISCOVERY_WRITE_ENABLED must be true");
  }
  if (!isHalAutomaticContinuationEnabled()) {
    throw new Error("HAL_AUTOMATIC_CONTINUATION_ENABLED must be true");
  }
}

function setLocalFlags(enabled) {
  process.env.HAL_DISCOVERY_WRITE_ENABLED = enabled ? "true" : "false";
  process.env.HAL_AUTOMATIC_CONTINUATION_ENABLED = enabled ? "true" : "false";
}

function netlifySetFlag(name, value) {
  try {
    execSync(`npx netlify env:set ${name} ${value} --context production`, {
      cwd: root,
      stdio: "pipe",
      timeout: 60000
    });
    return { name, value, ok: true };
  } catch (err) {
    return { name, value, ok: false, error: String(err.message || err).slice(0, 200) };
  }
}

async function runPrecheck(sb, ctx) {
  const { supabase } = require(path.join(root, "netlify/functions/lib/cruise-discovery-ops"));
  const counts = await fetchDetailedCounts(ctx.line.id);
  const progress = await loadHalInventoryProgress(supabase, ctx.line.id);
  const running = await findRunningHalBatch(supabase, ctx.line.id);
  const smoke = await runSmoke();
  const destRows = await sb.get("destinations?select=id,classification_enabled,status");
  const classificationEnabled = (destRows || []).filter((d) => d.classification_enabled === true).length;
  const pno = await sb.get("ci_cruise_lines?slug=eq.p-o-cruises-australia&select=id&limit=1");
  const limits = halAutomaticLimits();

  return {
    phase: "precheck",
    deploy: await checkDeployCommit(),
    smoke,
    progress,
    running_batches: running.length,
    stale_overlap_lock: running.length > 0,
    hal_write_flag_local: HAL_DISCOVERY_WRITE_ENABLED,
    hal_automatic_continuation_enabled: isHalAutomaticContinuationEnabled(),
    destination_count_classification_enabled: classificationEnabled,
    pno_cruises_australia_present: Boolean(pno?.[0]?.id),
    automatic_limits: limits,
    counts
  };
}

function saveRollback(batchIndex, runId, result) {
  const rollbackPath = path.join(
    root,
    `reports/hal-automatic-batch-rollback-${SESSION_ID}-batch${batchIndex}.json`
  );
  const writeDetails = result.write_result?.stats?.write_details || [];
  fs.mkdirSync(path.dirname(rollbackPath), { recursive: true });
  fs.writeFileSync(
    rollbackPath,
    JSON.stringify(
      {
        created_at: new Date().toISOString(),
        session_id: SESSION_ID,
        batch_index: batchIndex,
        run_id: runId,
        run_record_id: result.run_record_id,
        cursor_start: result.cursor?.start,
        cursor_end: result.cursor?.next_start,
        write_result: result.write_result,
        timing: result.timing,
        automatic_gate: result.automatic_gate || null,
        rollback_actions: writeDetails.map((d) => ({
          hal_product_identity: d.hal_product_key,
          discovered_cruise_id: d.discovered_cruise_id,
          created: d.created,
          rollback: { delete_on_rollback: d.created === true }
        }))
      },
      null,
      2
    )
  );
  return rollbackPath;
}

async function runOneBatch(ctx, { batchIndex, cursorStart, limits }) {
  const { supabase } = require(path.join(root, "netlify/functions/lib/cruise-discovery-ops"));
  const runId = `hal-auto-batch-${batchIndex}-${SESSION_ID}`;
  const started = Date.now();

  const result = await runHalDiscoveryBatch({
    mode: "production_write",
    runId,
    cursorStart,
    maxPages: limits.max_pages,
    maxCandidates: limits.max_writes,
    maxWrites: limits.max_writes,
    performWrites: true,
    buildManifest: true,
    recordRun: true,
    automatic: true,
    writeConcurrency: limits.write_concurrency,
    useCache: false,
    cruiseLine: ctx.line,
    ships: ctx.ships,
    destinations: ctx.destinations,
    supabase
  });

  const rollbackPath = saveRollback(batchIndex, runId, result);

  return {
    batch_index: batchIndex,
    run_id: runId,
    run_record_id: result.run_record_id,
    elapsed_ms: Date.now() - started,
    ok: result.ok && !result.blocked,
    blocked: result.blocked,
    automatic_gate: result.automatic_gate || null,
    cursor: result.cursor,
    stats: result.stats,
    write_result: result.write_result
      ? {
          inserted: result.write_result.stats?.inserted,
          updated: result.write_result.stats?.updated,
          duplicate_skips: result.write_result.stats?.duplicate_skips,
          incomplete_skips: result.write_result.stats?.incomplete_skips,
          cruisetour_skips: result.write_result.stats?.cruisetour_skips,
          failed: result.write_result.stats?.failed
        }
      : null,
    cruise_metrics: result.cruise_metrics,
    destination_counts: result.destination_counts,
    timing: result.timing,
    rollback_path: rollbackPath
  };
}

async function runContinuation(sb, ctx) {
  assertFlagsEnabledForRun();

  const lock = acquireRunLock(GLOBAL_LOCK);
  if (!lock.acquired) {
    throw new Error(`Global HAL lock blocked: ${lock.reason}`);
  }

  const { supabase } = require(path.join(root, "netlify/functions/lib/cruise-discovery-ops"));
  const limits = halAutomaticLimits();
  const countsBefore = await fetchDetailedCounts(ctx.line.id);
  const sessionStarted = Date.now();
  const batches = [];
  let stopReason = null;

  try {
    let progress = await loadHalInventoryProgress(supabase, ctx.line.id);
    let cursor = progress.next_eligible_cursor ?? 108;
    let numFound = progress.total_hal_api_results ?? null;
    let batchIndex = 0;
    const maxBatches = 200;

    while (batchIndex < maxBatches) {
      const running = await findRunningHalBatch(supabase, ctx.line.id);
      if (running.length) {
        stopReason = "stale_running_batch_detected";
        break;
      }

      batchIndex += 1;
      const batch = await runOneBatch(ctx, { batchIndex, cursorStart: cursor, limits });
      batches.push(batch);

      if (!batch.ok || batch.automatic_gate?.passed === false) {
        stopReason = batch.automatic_gate?.failures?.join("; ") || "batch_failed";
        break;
      }

      cursor = batch.cursor?.next_start ?? cursor;
      numFound = batch.cursor?.num_found ?? numFound;

      if (numFound != null && cursor >= numFound) {
        stopReason = "inventory_complete";
        break;
      }

      if ((batch.stats?.products_normalised || 0) === 0 && cursor >= (numFound || Infinity)) {
        stopReason = "inventory_complete";
        break;
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    if (batchIndex >= maxBatches && stopReason !== "inventory_complete") {
      stopReason = "max_batches_reached";
    }
  } finally {
    releaseRunLock(GLOBAL_LOCK);
  }

  const countsAfter = await fetchDetailedCounts(ctx.line.id);
  const progress = await loadHalInventoryProgress(supabase, ctx.line.id);

  const summary = {
    phase: "run",
    session_id: SESSION_ID,
    stop_reason: stopReason,
    inventory_complete: stopReason === "inventory_complete",
    start_cursor: batches[0]?.cursor?.start ?? null,
    final_cursor: batches[batches.length - 1]?.cursor?.next_start ?? null,
    official_api_total: batches[batches.length - 1]?.cursor?.num_found ?? null,
    batches_completed: batches.length,
    batches,
    total_duration_ms: Date.now() - sessionStarted,
    counts_before: countsBefore,
    counts_after: countsAfter,
    progress
  };

  fs.mkdirSync(path.dirname(SUMMARY_PATH), { recursive: true });
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));

  if (stopReason !== "inventory_complete") {
    setLocalFlags(false);
    netlifySetFlag("HAL_DISCOVERY_WRITE_ENABLED", "false");
    netlifySetFlag("HAL_AUTOMATIC_CONTINUATION_ENABLED", "false");
  }

  return summary;
}

async function runVerify(sb, ctx) {
  const { supabase } = require(path.join(root, "netlify/functions/lib/cruise-discovery-ops"));
  const counts = await fetchDetailedCounts(ctx.line.id);
  const progress = await loadHalInventoryProgress(supabase, ctx.line.id);

  const halRows = await sb.get(
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(ctx.line.id)}&status=eq.active&select=id,official_sailing_id,ship_id,departure_date,return_date,nights,departure_port,destination_id,official_url,source_url,raw_extract&limit=5000`
  );

  const shipIds = [...new Set((halRows || []).map((r) => r.ship_id).filter(Boolean))];
  const ships = shipIds.length
    ? await sb.get(`ci_cruise_ships?id=in.(${shipIds.join(",")})&select=id,name`)
    : [];
  const shipById = Object.fromEntries((ships || []).map((s) => [s.id, s.name]));

  const audited = (halRows || []).map((row) => ({
    id: row.id,
    issues: activationGateIssues({
      hal_product_key: row.raw_extract?.hal_product_key || row.official_sailing_id,
      official_sailing_id: row.official_sailing_id,
      ship: shipById[row.ship_id] || null,
      departure_date: row.departure_date,
      return_date: row.return_date,
      nights: row.nights,
      departure_port: row.departure_port,
      destination: row.destination_id,
      source_url: row.official_url || row.source_url,
      status: row.status
    })
  }));

  const gateBreaches = audited.filter((a) => a.issues?.length);
  const identitySet = new Set();
  const duplicateIdentities = [];
  for (const row of halRows || []) {
    const key = row.official_sailing_id || row.raw_extract?.hal_product_key;
    if (!key) continue;
    if (identitySet.has(key)) duplicateIdentities.push(key);
    identitySet.add(key);
  }

  const destCounts = {};
  for (const row of halRows || []) {
    const d = row.destination_id || "unknown";
    destCounts[d] = (destCounts[d] || 0) + 1;
  }

  const shipCounts = {};
  for (const row of halRows || []) {
    const s = shipById[row.ship_id] || "unknown";
    shipCounts[s] = (shipCounts[s] || 0) + 1;
  }

  const autoRuns = await sb.get(
    `cruise_discovery_runs?cruise_line_id=eq.${encodeURIComponent(ctx.line.id)}&scope=eq.cruise_line&select=id,status,stats&order=created_at.desc&limit=100`
  );
  const halAutoBatches = (autoRuns || []).filter((r) => r.stats?.run_type === "hal_automatic_batch");

  return {
    phase: "verify",
    progress,
    counts,
    hal_active_cruises: (halRows || []).length,
    activation_gate_breaches: gateBreaches.length,
    duplicate_official_identities: duplicateIdentities.length,
    destination_distribution: destCounts,
    ship_distribution: shipCounts,
    automatic_batches_recorded: halAutoBatches.length,
    hal_write_flag_local: HAL_DISCOVERY_WRITE_ENABLED,
    hal_automatic_continuation_enabled: isHalAutomaticContinuationEnabled()
  };
}

async function disableFlags() {
  setLocalFlags(false);
  const results = [
    netlifySetFlag("HAL_DISCOVERY_WRITE_ENABLED", "false"),
    netlifySetFlag("HAL_AUTOMATIC_CONTINUATION_ENABLED", "false")
  ];
  return { phase: "disable_flags", results };
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createSupabaseRest(root);
  const ctx = await loadHalContext(sb);

  let out;
  if (args.precheck) out = await runPrecheck(sb, ctx);
  else if (args.run) out = await runContinuation(sb, ctx);
  else if (args.verify) out = await runVerify(sb, ctx);
  else if (args.disableFlags) out = await disableFlags();
  else out = await runPrecheck(sb, ctx);

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
