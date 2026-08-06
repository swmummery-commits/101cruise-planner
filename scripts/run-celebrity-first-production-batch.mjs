#!/usr/bin/env node
/**
 * Controlled Celebrity first production batch.
 *
 *   node scripts/run-celebrity-first-production-batch.mjs --precheck
 *   node scripts/run-celebrity-first-production-batch.mjs --manifest
 *   node scripts/run-celebrity-first-production-batch.mjs --gate
 *   node scripts/run-celebrity-first-production-batch.mjs --apply-production
 *   node scripts/run-celebrity-first-production-batch.mjs --idempotency-check
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const { createSupabaseRest, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { simulateCelebrityInventory, catalogueDestinations } = require(path.join(
  root,
  "netlify/functions/lib/celebrity-discovery-adapter"
));
const {
  buildCelebrityBatchManifest,
  selectControlledBatchProducts,
  evaluateAcceptanceGate
} = require(path.join(root, "netlify/functions/lib/celebrity-discovery-writes"));
const { applyCelebrityBatchWrites } = require(path.join(root, "netlify/functions/lib/celebrity-discovery-writes"));
const { CELEBRITY_DISCOVERY_WRITE_ENABLED } = require(path.join(
  root,
  "netlify/functions/lib/celebrity-discovery-mode"
));
const { fetchRowsBySailingIds, summariseActivationAudit } = require(path.join(
  root,
  "scripts/lib/celebrity-batch-audit.cjs"
));

const MANIFEST_PATH = path.join(root, "reports/celebrity-first-production-batch-manifest-2026-08-06.json");
const RUN_ID = `celebrity-first-batch-2026-08-06T${new Date().toISOString().replace(/[:.]/g, "-").slice(11, 19)}Z`;
const MAX_WRITES = 40;

function loadEnv() {
  try {
    require("dotenv").config({ path: path.join(root, ".env") });
    require("dotenv").config({ path: path.join(root, ".env.local") });
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
    applyLocal: false,
    idempotencyCheck: false,
    idempotencyLocal: false
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--precheck") args.precheck = true;
    if (arg === "--manifest") args.manifest = true;
    if (arg === "--gate") args.gate = true;
    if (arg === "--apply-production") args.applyProduction = true;
    if (arg === "--apply-local") args.applyLocal = true;
    if (arg === "--idempotency-check") args.idempotencyCheck = true;
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

async function fetchBaselineCounts(celebrityLineId, halLineId) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    discovered_cruises: await headCount("discovered_cruises"),
    active_discovered_cruises: await headCount("discovered_cruises", "status=eq.active"),
    active_future_cruises: await headCount(
      "discovered_cruises",
      `status=eq.active&departure_date=gte.${today}`
    ),
    celebrity_discovered: celebrityLineId
      ? await headCount("discovered_cruises", `cruise_line_id=eq.${encodeURIComponent(celebrityLineId)}`)
      : 0,
    celebrity_active: celebrityLineId
      ? await headCount(
          "discovered_cruises",
          `cruise_line_id=eq.${encodeURIComponent(celebrityLineId)}&status=eq.active`
        )
      : 0,
    hal_active: halLineId
      ? await headCount(
          "discovered_cruises",
          `cruise_line_id=eq.${encodeURIComponent(halLineId)}&status=eq.active`
        )
      : 0,
    pending_review_items: await headCount("cruise_discovery_review_items", "status=eq.pending"),
    total_review_items: await headCount("cruise_discovery_review_items"),
    cruise_ship_aliases: await headCount("cruise_ship_aliases"),
    cruise_destination_aliases: await headCount("cruise_destination_aliases"),
    destinations: await headCount("destinations"),
    destination_ports: await headCount("destination_ports"),
    cruise_discovery_resolution_audit: await headCount("cruise_discovery_resolution_audit"),
    cruise_discovery_runs: await headCount("cruise_discovery_runs")
  };
}

async function loadCelebrityContext(sb) {
  const lines = await sb.get(
    "ci_cruise_lines?slug=eq.celebrity-cruises&select=id,name,slug,website_url,cruise_search_url&limit=1"
  );
  const line = lines?.[0];
  if (!line) throw new Error("Celebrity Cruises line not found");
  const halLine = (await sb.get("ci_cruise_lines?slug=eq.holland-america-line&select=id&limit=1"))?.[0];
  const ships = await sb.get(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&active=eq.true&select=id,name,cruise_line_id,official_line_ship_id,ship_class,status`
  );
  const destRows = await sb.get(
    "destinations?classification_enabled=eq.true&select=id,name,slug,status,classification_enabled"
  );
  return {
    line,
    halLine,
    ships: ships || [],
    destinations: catalogueDestinations(destRows || [])
  };
}

async function runSmoke() {
  const secret = String(process.env.DISCOVERY_CRON_SECRET || "").trim();
  if (!secret) throw new Error("DISCOVERY_CRON_SECRET required");
  const response = await fetch(`${siteUrl}/.netlify/functions/celebrity-discovery-smoke`, {
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
  const response = await fetch(`${siteUrl}/.netlify/functions/celebrity-discovery-batch-background`, {
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

async function runPrecheck(sb, ctx) {
  const counts = await fetchBaselineCounts(ctx.line.id, ctx.halLine?.id);
  const smoke = await runSmoke();
  const inactive = await sb.get(
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(ctx.line.id)}&status=in.(hidden,match_required,validation_failed)&select=id,status&limit=20`
  );
  const statusBreakdown = {};
  for (const row of inactive || []) {
    statusBreakdown[row.status] = (statusBreakdown[row.status] || 0) + 1;
  }

  return {
    phase: "precheck",
    required_commits: ["e3e7d37", "089a45a", "ac5fe2d"],
    celebrity_write_flag_local: CELEBRITY_DISCOVERY_WRITE_ENABLED,
    smoke,
    baseline_counts: counts,
    inactive_celebrity_records: inactive?.length || 0,
    inactive_status_breakdown: statusBreakdown,
    river_ships: (ctx.ships || []).filter((s) => s.ship_class === "River").map((s) => s.name)
  };
}

async function runManifest(sb, ctx) {
  const { supabase } = require(path.join(root, "netlify/functions/lib/cruise-discovery-ops"));
  const today = new Date().toISOString().slice(0, 10);
  const simulation = await simulateCelebrityInventory({
    cruiseLine: ctx.line,
    ships: ctx.ships,
    destinations: ctx.destinations,
    today
  });

  const controlledSelection = selectControlledBatchProducts(simulation.products, {
    oceanTarget: 20,
    riverTarget: 20,
    maxWrites: MAX_WRITES
  });

  const manifest = await buildCelebrityBatchManifest({
    products: simulation.products,
    cruiseLine: ctx.line,
    destinations: ctx.destinations,
    supabase,
    runId: RUN_ID,
    controlledBatch: true,
    controlledSelection
  });

  manifest.run_id = RUN_ID;
  manifest.simulation_summary = {
    official_reported_total: simulation.official_reported_total,
    sailing_products_fetched: simulation.sailing_products_fetched,
    cruise_metrics: simulation.cruise_metrics,
    controlled_ocean: controlledSelection.filter((p) => p.product_type === "ocean_cruise").length,
    controlled_river: controlledSelection.filter((p) => p.product_type === "river_cruise").length
  };
  manifest.controlled_sailing_ids = controlledSelection.map((p) => p.official_product_key);

  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

  return {
    phase: "manifest",
    manifest_path: MANIFEST_PATH,
    acceptance_gate: manifest.acceptance_gate,
    controlled_ocean: manifest.simulation_summary.controlled_ocean,
    controlled_river: manifest.simulation_summary.controlled_river,
    proposed_writes: manifest.acceptance_gate?.proposed_write_count || 0
  };
}

function runGate() {
  if (!fs.existsSync(MANIFEST_PATH)) throw new Error(`Manifest missing: ${MANIFEST_PATH}`);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const gate = evaluateAcceptanceGate(manifest, { minOcean: 1, minRiver: 1, maxWrites: MAX_WRITES });
  return { phase: "gate", passed: gate.passed, gate, manifest_path: MANIFEST_PATH };
}

function loadControlledSelectionFromManifest(simulationProducts, manifest) {
  const ids = new Set((manifest.controlled_sailing_ids || manifest.products.map((p) => p.official_celebrity_sailing_id)).filter(Boolean));
  return simulationProducts.filter((p) => ids.has(p.official_product_key));
}

async function runApplyLocal(ctx) {
  const gate = runGate();
  if (!gate.passed) throw new Error(`Acceptance gate failed: ${JSON.stringify(gate.gate.failures)}`);
  if (String(process.env.CELEBRITY_DISCOVERY_WRITE_ENABLED || "").toLowerCase() !== "true") {
    throw new Error("CELEBRITY_DISCOVERY_WRITE_ENABLED must be true for local apply");
  }

  const { supabase } = require(path.join(root, "netlify/functions/lib/cruise-discovery-ops"));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const today = new Date().toISOString().slice(0, 10);
  const simulation = await simulateCelebrityInventory({
    cruiseLine: ctx.line,
    ships: ctx.ships,
    destinations: ctx.destinations,
    today
  });
  const controlledSelection = loadControlledSelectionFromManifest(simulation.products, manifest);
  const countsBefore = await fetchBaselineCounts(ctx.line.id, ctx.halLine?.id);
  const started = Date.now();

  const writeResult = await applyCelebrityBatchWrites({
    products: simulation.products,
    cruiseLine: ctx.line,
    maxWrites: MAX_WRITES,
    runId: RUN_ID,
    supabase,
    controlledSelection
  });

  const countsAfter = await fetchBaselineCounts(ctx.line.id, ctx.halLine?.id);
  const rollbackPath = path.join(
    root,
    `reports/celebrity-first-production-batch-rollback-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );

  fs.writeFileSync(
    rollbackPath,
    JSON.stringify(
      {
        created_at: new Date().toISOString(),
        run_id: RUN_ID,
        apply_timestamp: new Date().toISOString(),
        apply_mode: "local_production_write",
        write_result: writeResult,
        rollback_actions: (writeResult.stats.write_details || []).map((d) => ({
          celebrity_sailing_id: d.celebrity_sailing_id,
          discovered_cruise_id: d.discovered_cruise_id,
          product_type: d.product_type,
          rollback: { delete_on_rollback: d.created === true }
        }))
      },
      null,
      2
    )
  );

  const auditRows = await fetchRowsBySailingIds(
    root,
    controlledSelection.map((p) => p.official_product_key)
  );

  return {
    phase: "apply_local",
    run_id: RUN_ID,
    elapsed_ms: Date.now() - started,
    write_result: writeResult.stats,
    activation_audit: summariseActivationAudit(auditRows),
    rollback_path: rollbackPath,
    table_counts_before: countsBefore,
    table_counts_after: countsAfter
  };
}

async function runApplyProduction() {
  const gate = runGate();
  if (!gate.passed) throw new Error(`Acceptance gate failed: ${JSON.stringify(gate.gate.failures)}`);

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const payload = {
    mode: "production_write",
    skip_start: 0,
    max_pages: 20,
    max_writes: MAX_WRITES,
    run_id: RUN_ID,
    perform_writes: true,
    controlled_batch: true,
    controlled_sailing_ids: manifest.controlled_sailing_ids || manifest.products.map((p) => p.official_celebrity_sailing_id),
    build_manifest: true,
    record_run: true
  };

  const result = await invokeProductionBatch(payload);
  if (result.status !== 200 || !result.body?.success) {
    throw new Error(`Production batch failed: ${JSON.stringify(result)}`);
  }

  const rollbackPath = path.join(
    root,
    `reports/celebrity-first-production-batch-rollback-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );

  fs.writeFileSync(
    rollbackPath,
    JSON.stringify(
      {
        created_at: new Date().toISOString(),
        run_id: RUN_ID,
        apply_timestamp: new Date().toISOString(),
        production_response: result.body,
        rollback_actions: (manifest.products || [])
          .filter((p) => ["insert_active", "update_exact_legacy_match"].includes(p.proposed_action))
          .map((p) => ({
            celebrity_sailing_id: p.official_celebrity_sailing_id,
            product_type: p.product_type,
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
    skip_start: 0,
    max_pages: 20,
    max_writes: MAX_WRITES,
    run_id: `${RUN_ID}-idempotency`,
    perform_writes: true,
    controlled_batch: true,
    record_run: true
  };
  const result = await invokeProductionBatch(payload);
  return { phase: "idempotency", status: result.status, body: result.body };
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createSupabaseRest(root);
  const ctx = await loadCelebrityContext(sb);

  let out;
  if (args.precheck) out = await runPrecheck(sb, ctx);
  else if (args.manifest) out = await runManifest(sb, ctx);
  else if (args.gate) out = runGate();
  else if (args.applyProduction) out = await runApplyProduction();
  else if (args.applyLocal) out = await runApplyLocal(ctx);
  else if (args.idempotencyCheck) out = await runIdempotencyCheck();
  else out = await runPrecheck(sb, ctx);

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
