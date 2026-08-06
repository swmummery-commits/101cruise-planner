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
const { simulateCelebrityInventory, catalogueDestinations, isEligibleCelebrityCruise } = require(path.join(
  root,
  "netlify/functions/lib/celebrity-discovery-adapter"
));
const { applyCelebrityBatchWrites, indexExistingCelebrityRecords } = require(path.join(
  root,
  "netlify/functions/lib/celebrity-discovery-writes"
));
const { withCelebrityRunRecord } = require(path.join(root, "scripts/lib/celebrity-run-tracking.cjs"));
const { CELEBRITY_AUTO_RUN_TYPE } = require(path.join(
  root,
  "netlify/functions/lib/celebrity-discovery-run-tracking"
));
const { supabase } = require(path.join(root, "netlify/functions/lib/cruise-discovery-ops"));

const SESSION = new Date().toISOString().replace(/[:.]/g, "-");
const SUMMARY_PATH = path.join(root, `reports/celebrity-automatic-continuation-${SESSION}.json`);
const BATCH_SIZE = 100;

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

  const today = new Date().toISOString().slice(0, 10);
  const simulation = await simulateCelebrityInventory({
    cruiseLine: ctx.line,
    ships: ctx.ships,
    destinations: ctx.destinations,
    today
  });

  const indexes = await indexExistingCelebrityRecords(supabase, ctx.line.id);
  const pending = simulation.products.filter((p) => {
    if (!p.complete_high_confidence || !isEligibleCelebrityCruise(p.product_type)) return false;
    const sid = p.official_product_key;
    return sid && !indexes.byProductKey.has(sid);
  });

  const batches = [];
  let offset = 0;
  let batchNum = 0;

  while (offset < pending.length && batchNum < 50) {
    batchNum += 1;
    const slice = pending.slice(offset, offset + BATCH_SIZE);
    if (!slice.length) break;
    const runId = `celebrity-auto-${SESSION}-batch-${batchNum}`;
    const tracked = await withCelebrityRunRecord({
      supabase,
      cruiseLineId: ctx.line.id,
      runId,
      runType: CELEBRITY_AUTO_RUN_TYPE,
      automatic: true,
      mode: "production_write",
      writesEnabled: true,
      execute: async () => {
        const writeResult = await applyCelebrityBatchWrites({
          products: simulation.products,
          cruiseLine: ctx.line,
          maxWrites: BATCH_SIZE,
          runId,
          supabase,
          controlledSelection: slice
        });
        return {
          stats: writeResult.stats,
          timing: writeResult.timing,
          proposed_writes: slice.length,
          run_stats: {
            proposed_writes: slice.length,
            duplicate_skips: writeResult.stats.duplicate_skips,
            incomplete_skips: writeResult.stats.incomplete_skips
          }
        };
      }
    });
    const writeResult = tracked.result;

    batches.push({
      run_id: runId,
      batch_num: batchNum,
      attempted: slice.length,
      inserted: writeResult.stats.inserted,
      updated: writeResult.stats.updated,
      duplicate_skips: writeResult.stats.duplicate_skips,
      failed: writeResult.stats.failed
    });

    if ((writeResult.stats.failed || 0) > 0) break;
    offset += slice.length;
    for (const row of slice) {
      const pk = row.official_product_key;
      if (pk) indexes.byProductKey.set(pk, { official_sailing_id: pk });
    }
  }

  const summary = {
    official_inventory_total: simulation.official_reported_total,
    eligible_pending_at_start: pending.length,
    batches,
    batch_count: batches.length,
    completed: offset >= pending.length
  };
  fs.mkdirSync(path.dirname(SUMMARY_PATH), { recursive: true });
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  return summary;
}

async function verify(ctx, sb) {
  const halLine = (await sb.get("ci_cruise_lines?slug=eq.holland-america-line&select=id&limit=1"))?.[0];
  const ocean = await sb.get(
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(ctx.line.id)}&status=eq.active&raw_extract->>celebrity_product_type=eq.ocean_cruise&select=id`
  );
  const river = await sb.get(
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(ctx.line.id)}&status=eq.active&raw_extract->>celebrity_product_type=eq.river_cruise&select=id`
  );
  return {
    celebrity_active: await headCount(
      "discovered_cruises",
      `cruise_line_id=eq.${encodeURIComponent(ctx.line.id)}&status=eq.active`
    ),
    celebrity_ocean_active: ocean?.length || 0,
    celebrity_river_active: river?.length || 0,
    hal_active: halLine
      ? await headCount(
          "discovered_cruises",
          `cruise_line_id=eq.${encodeURIComponent(halLine.id)}&status=eq.active`
        )
      : 0,
    discovered_cruise_destinations: await headCount("discovered_cruise_destinations"),
    destinations: await headCount("destinations"),
    destination_ports: await headCount("destination_ports")
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createSupabaseRest(root);
  const ctx = await loadCtx(sb);

  if (args.run) {
    console.log(JSON.stringify(await runBatches(ctx), null, 2));
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
