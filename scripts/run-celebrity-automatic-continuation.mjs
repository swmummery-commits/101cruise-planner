#!/usr/bin/env node
/**
 * Celebrity automatic inventory continuation (local Supabase writes).
 *
 *   node scripts/run-celebrity-automatic-continuation.mjs --run
 *   node scripts/run-celebrity-automatic-continuation.mjs --verify
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const { createSupabaseRest, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { runCelebrityDiscoveryBatch } = require(path.join(root, "netlify/functions/lib/celebrity-discovery-batch"));
const { catalogueDestinations } = require(path.join(root, "netlify/functions/lib/celebrity-discovery-adapter"));
const { loadCelebrityInventoryProgress } = require(path.join(
  root,
  "netlify/functions/lib/celebrity-discovery-run-tracking"
));
const { supabase } = require(path.join(root, "netlify/functions/lib/cruise-discovery-ops"));

const SESSION = new Date().toISOString().replace(/[:.]/g, "-");
const SUMMARY_PATH = path.join(root, `reports/celebrity-automatic-continuation-${SESSION}.json`);
const MAX_WRITES = 100;

function loadEnv() {
  try {
    require("dotenv").config({ path: path.join(root, ".env") });
  } catch {
    /* optional */
  }
}

loadEnv();

function parseArgs(argv) {
  return { run: argv.includes("--run"), verify: argv.includes("--verify") };
}

async function headCount(table, query = "") {
  const https = require("https");
  const { url, key } = getSupabaseConfig(root);
  return new Promise((resolve, reject) => {
    const u = new URL(`${url}/rest/v1/${table}?select=id${query ? `&${query}` : ""}`);
    https
      .request(
        u,
        { method: "HEAD", headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" } },
        (res) => {
          const range = res.headers["content-range"] || "";
          const m = range.match(/\/(\d+)/);
          resolve(m ? Number(m[1]) : 0);
        }
      )
      .on("error", reject)
      .end();
  });
}

async function loadCtx(sb) {
  const line = (await sb.get("ci_cruise_lines?slug=eq.celebrity-cruises&select=id,name&limit=1"))?.[0];
  if (!line) throw new Error("Celebrity line not found");
  const ships = await sb.get(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&active=eq.true&select=id,name,cruise_line_id,official_line_ship_id`
  );
  const destRows = await sb.get(
    "destinations?classification_enabled=eq.true&select=id,name,slug,status,classification_enabled"
  );
  return { line, ships: ships || [], destinations: catalogueDestinations(destRows || []) };
}

async function runBatches(ctx) {
  if (String(process.env.CELEBRITY_DISCOVERY_WRITE_ENABLED || "").toLowerCase() !== "true") {
    throw new Error("CELEBRITY_DISCOVERY_WRITE_ENABLED must be true");
  }

  const batches = [];
  let skipStart = 0;
  let completed = false;
  let batchNum = 0;
  let stagnantBatches = 0;

  while (!completed && batchNum < 80) {
    batchNum += 1;
    const runId = `celebrity-auto-${SESSION}-batch-${batchNum}`;
    const result = await runCelebrityDiscoveryBatch({
      mode: "production_write",
      runId,
      skipStart,
      maxPages: 12,
      maxWrites: MAX_WRITES,
      maxCandidates: 5000,
      performWrites: true,
      recordRun: true,
      automatic: true,
      cruiseLine: ctx.line,
      ships: ctx.ships,
      destinations: ctx.destinations,
      supabase
    });

    batches.push({
      run_id: runId,
      skip_start: skipStart,
      next_skip: result.cursor?.next_start ?? result.stats?.next_skip,
      inserted: result.stats?.inserted || 0,
      updated: result.stats?.updated || 0,
      failed: result.stats?.failed_writes || 0,
      batch_status: result.stats?.batch_status,
      ok: result.ok
    });

    if (!result.ok || (result.stats?.failed_writes || 0) > 0) break;

    skipStart = result.cursor?.next_start ?? result.stats?.next_skip ?? skipStart;
    completed = result.stats?.batch_status === "completed" || skipStart >= (result.stats?.num_found_official || 0);
    const wrote = (result.stats?.inserted || 0) + (result.stats?.updated || 0);
    stagnantBatches = wrote === 0 ? stagnantBatches + 1 : 0;
    if (stagnantBatches >= 3 && !completed) break;
  }

  const summary = { batches, batch_count: batches.length, completed };
  fs.mkdirSync(path.dirname(SUMMARY_PATH), { recursive: true });
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  return summary;
}

async function verify(ctx, sb) {
  const halLine = (await sb.get("ci_cruise_lines?slug=eq.holland-america-line&select=id&limit=1"))?.[0];
  const progress = await loadCelebrityInventoryProgress(supabase, ctx.line.id);
  return {
    celebrity_active: await headCount(
      "discovered_cruises",
      `cruise_line_id=eq.${encodeURIComponent(ctx.line.id)}&status=eq.active`
    ),
    hal_active: halLine
      ? await headCount(
          "discovered_cruises",
          `cruise_line_id=eq.${encodeURIComponent(halLine.id)}&status=eq.active`
        )
      : 0,
    progress
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createSupabaseRest(root);
  const ctx = await loadCtx(sb);

  if (args.run) {
    const summary = await runBatches(ctx);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (args.verify) {
    console.log(JSON.stringify(await verify(ctx, sb), null, 2));
    return;
  }

  console.error("Use --run or --verify");
  process.exit(1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
