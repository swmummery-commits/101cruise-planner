#!/usr/bin/env node
/**
 * Controlled Holland America first production batch.
 *
 *   node scripts/run-hal-first-production-batch.mjs --precheck
 *   node scripts/run-hal-first-production-batch.mjs --manifest
 *   node scripts/run-hal-first-production-batch.mjs --gate
 *   node scripts/run-hal-first-production-batch.mjs --apply-production
 *   node scripts/run-hal-first-production-batch.mjs --idempotency-check
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

const MANIFEST_PATH = path.join(root, "reports/hal-first-production-batch-manifest-2026-08-02.json");
const CURSOR_START = 0;
const MAX_PAGES = 3;
const MAX_WRITES = 40;
const RUN_ID = `hal-first-batch-2026-08-02T${new Date().toISOString().replace(/[:.]/g, "-").slice(11, 19)}Z`;

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
    applyProduction: false,
    idempotencyCheck: false
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--precheck") args.precheck = true;
    if (arg === "--manifest") args.manifest = true;
    if (arg === "--gate") args.gate = true;
    if (arg === "--apply-production") args.applyProduction = true;
    if (arg === "--idempotency-check") args.idempotencyCheck = true;
  }
  if (!Object.values(args).some(Boolean)) args.precheck = true;
  return args;
}

async function headCount(table) {
  const https = require("https");
  const { url, key } = getSupabaseConfig(root);
  return new Promise((resolve, reject) => {
    const u = new URL(`${url}/rest/v1/${table}?select=id`);
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

async function fetchCounts() {
  const tables = [
    "discovered_cruises",
    "cruise_discovery_review_items",
    "cruise_ship_aliases",
    "destinations",
    "destination_ports",
    "cruise_destination_aliases",
    "cruise_discovery_resolution_audit"
  ];
  const out = {};
  for (const table of tables) out[table] = await headCount(table);
  return out;
}

async function activeFutureCount(sb) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await sb.get(
    `discovered_cruises?status=eq.active&departure_date=gte.${today}&select=id`
  );
  return rows?.length || 0;
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
  return { status: response.status, body };
}

async function invokeProductionBatch(payload) {
  const secret = String(process.env.DISCOVERY_CRON_SECRET || "").trim();
  if (!secret) throw new Error("DISCOVERY_CRON_SECRET required");
  const response = await fetch(`${siteUrl}/.netlify/functions/hal-discovery-batch-background`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-discovery-cron-secret": secret },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { status: response.status, body };
}

async function runPrecheck(sb) {
  const counts = await fetchCounts();
  const activeFuture = await activeFutureCount(sb);
  const smoke = await runSmoke();
  const destRows = await sb.get("destinations?select=id,classification_enabled");
  const classificationEnabled = (destRows || []).filter((d) => d.classification_enabled === true).length;

  return {
    phase: "precheck",
    deployed_commit_check: "9151b16 or later required (verify via Netlify deploy)",
    hal_write_flag_local_process: HAL_DISCOVERY_WRITE_ENABLED,
    smoke,
    destination_count_classification_enabled: classificationEnabled,
    table_counts: counts,
    active_future_sailings: activeFuture,
    hal_existing_rows: (
      await sb.get(
        "discovered_cruises?select=id&ci_cruise_lines.slug=eq.holland-america-line&limit=1"
      ).catch(() => [])
    )?.length || 0
  };
}

async function runManifest(sb, ctx) {
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
    cruiseLine: ctx.line,
    ships: ctx.ships,
    destinations: ctx.destinations,
    supabase
  });

  const manifest = {
    ...result.manifest,
    run_id: RUN_ID,
    cursor_start: CURSOR_START,
    max_pages: MAX_PAGES,
    max_writes: MAX_WRITES,
    batch_stats: result.stats,
    cruise_metrics: result.cruise_metrics,
    destination_counts: result.destination_counts,
    page_log: result.page_log
  };

  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

  return {
    phase: "manifest",
    manifest_path: MANIFEST_PATH,
    acceptance_gate: manifest.acceptance_gate,
    product_count: manifest.products?.length || 0,
    proposed_writes: manifest.acceptance_gate?.proposed_write_count || 0
  };
}

function runGate() {
  if (!fs.existsSync(MANIFEST_PATH)) throw new Error(`Manifest missing: ${MANIFEST_PATH}`);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const gate = evaluateAcceptanceGate(manifest);
  return { phase: "gate", passed: gate.passed, gate, manifest_path: MANIFEST_PATH };
}

async function runApplyProduction() {
  const gate = runGate();
  if (!gate.passed) throw new Error(`Acceptance gate failed: ${JSON.stringify(gate.gate.failures)}`);

  const payload = {
    mode: "production_write",
    cursor_start: CURSOR_START,
    max_pages: MAX_PAGES,
    max_writes: MAX_WRITES,
    run_id: RUN_ID,
    perform_writes: true
  };

  const result = await invokeProductionBatch(payload);
  if (result.status !== 200 || !result.body?.success) {
    throw new Error(`Production batch failed: ${JSON.stringify(result)}`);
  }

  const rollbackPath = path.join(
    root,
    `reports/hal-first-production-batch-rollback-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const inserted = result.body.write_result?.stats?.write_details?.filter((d) => d.created) || [];

  fs.writeFileSync(
    rollbackPath,
    JSON.stringify(
      {
        created_at: new Date().toISOString(),
        run_id: RUN_ID,
        apply_timestamp: new Date().toISOString(),
        production_response: result.body,
        rollback_actions: manifest.products
          .filter((p) => ["insert_active", "update_existing"].includes(p.proposed_action))
          .map((p) => ({
            hal_product_identity: p.stable_product_identity_key,
            discovered_cruise_id: inserted.find((d) => d.hal_product_key === p.stable_product_identity_key)?.discovered_cruise_id || p.existing_discovered_cruise_id,
            proposed_action: p.proposed_action,
            rollback: p.rollback
          }))
      },
      null,
      2
    )
  );

  return {
    phase: "apply",
    run_id: RUN_ID,
    production_status: result.status,
    result: result.body,
    rollback_path: rollbackPath
  };
}

async function runIdempotencyCheck() {
  const payload = {
    mode: "production_write",
    cursor_start: CURSOR_START,
    max_pages: MAX_PAGES,
    max_writes: MAX_WRITES,
    run_id: `${RUN_ID}-idempotency`,
    perform_writes: true
  };
  const result = await invokeProductionBatch(payload);
  return {
    phase: "idempotency",
    status: result.status,
    body: result.body
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createSupabaseRest(root);
  const ctx = await loadHalContext(sb);

  let out;
  if (args.precheck) out = await runPrecheck(sb);
  else if (args.manifest) out = await runManifest(sb, ctx);
  else if (args.gate) out = runGate();
  else if (args.applyProduction) out = await runApplyProduction();
  else if (args.idempotencyCheck) out = await runIdempotencyCheck();
  else out = await runPrecheck(sb);

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
