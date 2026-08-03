#!/usr/bin/env node
/**
 * Controlled Holland America third (final manual) production batch (cursor 72).
 *
 *   node scripts/run-hal-third-production-batch.mjs --precheck
 *   node scripts/run-hal-third-production-batch.mjs --manifest
 *   node scripts/run-hal-third-production-batch.mjs --gate
 *   node scripts/run-hal-third-production-batch.mjs --apply-local
 *   node scripts/run-hal-third-production-batch.mjs --idempotency-local
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const { createSupabaseRest, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { runHalDiscoveryBatch } = require(path.join(root, "netlify/functions/lib/holland-america-discovery-batch"));
const { catalogueDestinations } = require(path.join(root, "netlify/functions/lib/holland-america-discovery-adapter"));
const { evaluateAcceptanceGate } = require(path.join(root, "netlify/functions/lib/holland-america-discovery-writes"));
const { HAL_DISCOVERY_WRITE_ENABLED } = require(path.join(root, "netlify/functions/lib/holland-america-discovery-mode"));
const { isHalAutomaticContinuationEnabled } = require(path.join(root, "netlify/functions/lib/holland-america-discovery-automation"));

const MANIFEST_PATH = path.join(root, "reports/hal-third-production-batch-manifest-2026-08-03.json");
const CURSOR_START = 72;
const MAX_PAGES = 3;
const MAX_WRITES = 40;
const BATCH_LABEL = "hal-third-batch";
const RUN_ID = `${BATCH_LABEL}-2026-08-03T${new Date().toISOString().replace(/[:.]/g, "-").slice(11, 19)}Z`;

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
  const args = {
    precheck: false,
    manifest: false,
    gate: false,
    applyLocal: false,
    idempotencyLocal: false
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--precheck") args.precheck = true;
    if (arg === "--manifest") args.manifest = true;
    if (arg === "--gate") args.gate = true;
    if (arg === "--apply-local") args.applyLocal = true;
    if (arg === "--idempotency-local") args.idempotencyLocal = true;
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

async function fetchDetailedCounts(sb, halLineId) {
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

  return {
    table_counts,
    discovered_cruises_all: table_counts.discovered_cruises,
    discovered_cruises_active: await headCount("discovered_cruises", "status=eq.active"),
    discovered_cruises_active_future: await headCount(
      "discovered_cruises",
      `status=eq.active&departure_date=gte.${today}`
    ),
    holland_america_discovered_cruises: halLineId
      ? await headCount("discovered_cruises", `cruise_line_id=eq.${encodeURIComponent(halLineId)}`)
      : 0,
    holland_america_active: halLineId
      ? await headCount("discovered_cruises", `cruise_line_id=eq.${encodeURIComponent(halLineId)}&status=eq.active`)
      : 0,
    hal_controlled_runs: await headCount("cruise_discovery_runs", "scope=eq.cruise_line")
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

async function runPrecheck(sb, ctx) {
  const counts = await fetchDetailedCounts(sb, ctx.line.id);
  const smoke = await runSmoke();
  const destRows = await sb.get("destinations?select=id,classification_enabled");
  const classificationEnabled = (destRows || []).filter((d) => d.classification_enabled === true).length;

  return {
    phase: "precheck",
    batch: 3,
    approved_cursor_start: CURSOR_START,
    prior_batches_completed_through: CURSOR_START - 1,
    hal_write_flag_local: HAL_DISCOVERY_WRITE_ENABLED,
    hal_write_flag_expected: false,
    hal_automatic_continuation_enabled: isHalAutomaticContinuationEnabled(),
    smoke,
    destination_count_classification_enabled: classificationEnabled,
    counts
  };
}

async function runManifest(ctx) {
  const { supabase } = require(path.join(root, "netlify/functions/lib/cruise-discovery-ops"));
  const result = await runHalDiscoveryBatch({
    mode: "production_read_only",
    runId: RUN_ID,
    cursorStart: CURSOR_START,
    maxPages: MAX_PAGES,
    maxCandidates: MAX_WRITES,
    maxWrites: MAX_WRITES,
    buildManifest: true,
    performWrites: false,
    recordRun: false,
    cruiseLine: ctx.line,
    ships: ctx.ships,
    destinations: ctx.destinations,
    supabase
  });

  const manifest = {
    ...result.manifest,
    batch: 3,
    run_id: RUN_ID,
    cursor_start: CURSOR_START,
    max_pages: MAX_PAGES,
    max_writes: MAX_WRITES,
    batch_stats: result.stats,
    cruise_metrics: result.cruise_metrics,
    destination_counts: result.destination_counts,
    page_log: result.page_log,
    timing: result.timing
  };

  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

  return {
    phase: "manifest",
    manifest_path: MANIFEST_PATH,
    acceptance_gate: manifest.acceptance_gate,
    product_count: manifest.products?.length || 0,
    proposed_writes: manifest.acceptance_gate?.proposed_write_count || 0,
    next_cursor: result.cursor?.next_start,
    timing: result.timing
  };
}

function runGate() {
  if (!fs.existsSync(MANIFEST_PATH)) throw new Error(`Manifest missing: ${MANIFEST_PATH}`);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const gate = evaluateAcceptanceGate(manifest, { minComplete: 25 });
  if (gate.proposed_write_count > MAX_WRITES) {
    gate.passed = false;
    gate.failures.push(`proposed_writes_exceed_cap:${gate.proposed_write_count}>${MAX_WRITES}`);
  }
  return { phase: "gate", passed: gate.passed, gate, manifest_path: MANIFEST_PATH };
}

async function runApplyLocal(ctx) {
  const gate = runGate();
  if (!gate.passed) throw new Error(`Acceptance gate failed: ${JSON.stringify(gate.gate.failures)}`);
  if (String(process.env.HAL_DISCOVERY_WRITE_ENABLED || "").toLowerCase() !== "true") {
    throw new Error("HAL_DISCOVERY_WRITE_ENABLED must be true for apply");
  }

  const { supabase } = require(path.join(root, "netlify/functions/lib/cruise-discovery-ops"));
  const sb = createSupabaseRest(root);
  const countsBefore = await fetchDetailedCounts(sb, ctx.line.id);
  const started = Date.now();

  const result = await runHalDiscoveryBatch({
    mode: "production_write",
    runId: RUN_ID,
    cursorStart: CURSOR_START,
    maxPages: MAX_PAGES,
    maxCandidates: MAX_WRITES,
    maxWrites: MAX_WRITES,
    performWrites: true,
    buildManifest: false,
    recordRun: true,
    cruiseLine: ctx.line,
    ships: ctx.ships,
    destinations: ctx.destinations,
    supabase
  });

  const countsAfter = await fetchDetailedCounts(sb, ctx.line.id);
  const rollbackPath = path.join(
    root,
    `reports/hal-third-production-batch-rollback-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  const writeDetails = result.write_result?.stats?.write_details || [];

  fs.writeFileSync(
    rollbackPath,
    JSON.stringify(
      {
        created_at: new Date().toISOString(),
        batch: 3,
        run_id: RUN_ID,
        run_record_id: result.run_record_id,
        cursor_start: CURSOR_START,
        apply_timestamp: new Date().toISOString(),
        write_result: result.write_result,
        timing: result.timing,
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

  return {
    phase: "apply_local",
    batch: 3,
    run_id: RUN_ID,
    run_record_id: result.run_record_id,
    elapsed_ms: Date.now() - started,
    cursor_start: CURSOR_START,
    next_cursor: result.cursor?.next_start,
    stats: result.stats,
    write_result: result.write_result,
    destination_counts: result.destination_counts,
    timing: result.timing,
    rollback_path: rollbackPath,
    counts_before: countsBefore,
    counts_after: countsAfter
  };
}

async function runIdempotencyLocal(ctx) {
  if (String(process.env.HAL_DISCOVERY_WRITE_ENABLED || "").toLowerCase() !== "true") {
    throw new Error("HAL_DISCOVERY_WRITE_ENABLED must be true for idempotency check");
  }
  const { supabase } = require(path.join(root, "netlify/functions/lib/cruise-discovery-ops"));
  const sb = createSupabaseRest(root);
  const countsBefore = await fetchDetailedCounts(sb, ctx.line.id);
  const result = await runHalDiscoveryBatch({
    mode: "production_write",
    runId: `${RUN_ID}-idempotency`,
    cursorStart: CURSOR_START,
    maxPages: MAX_PAGES,
    maxCandidates: MAX_WRITES,
    maxWrites: MAX_WRITES,
    performWrites: true,
    recordRun: false,
    cruiseLine: ctx.line,
    ships: ctx.ships,
    destinations: ctx.destinations,
    supabase
  });
  const countsAfter = await fetchDetailedCounts(sb, ctx.line.id);
  return {
    phase: "idempotency_local",
    batch: 3,
    inserted: result.write_result?.stats?.inserted || 0,
    updated: result.write_result?.stats?.updated || 0,
    duplicate_skips: result.write_result?.stats?.duplicate_skips || 0,
    incomplete_skips: result.write_result?.stats?.incomplete_skips || 0,
    failed: result.write_result?.stats?.failed || 0,
    timing: result.timing,
    counts_before: countsBefore,
    counts_after: countsAfter
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createSupabaseRest(root);
  const ctx = await loadHalContext(sb);

  let out;
  if (args.precheck) out = await runPrecheck(sb, ctx);
  else if (args.manifest) out = await runManifest(ctx);
  else if (args.gate) out = runGate();
  else if (args.applyLocal) out = await runApplyLocal(ctx);
  else if (args.idempotencyLocal) out = await runIdempotencyLocal(ctx);
  else out = await runPrecheck(sb, ctx);

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
