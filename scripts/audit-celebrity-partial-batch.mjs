#!/usr/bin/env node
/**
 * Audit the partial Celebrity controlled batch against production records.
 *   node scripts/audit-celebrity-partial-batch.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const { createSupabaseRest, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const RUN_ID = "celebrity-first-batch-2026-08-06T05-25-49Z";
const MANIFEST_PATH = path.join(root, "reports/celebrity-first-production-batch-manifest-2026-08-06.json");
const ROLLBACK_PATH = path.join(
  root,
  "reports/celebrity-first-production-batch-rollback-2026-08-06T05-26-12-313Z.json"
);
const OUTPUT = path.join(root, "reports/celebrity-partial-batch-audit-2026-08-06.json");

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

async function main() {
  const sb = createSupabaseRest(root);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const rollback = JSON.parse(fs.readFileSync(ROLLBACK_PATH, "utf8"));
  const writeDetails = rollback.write_result?.stats?.write_details || [];

  const line = (await sb.get("ci_cruise_lines?slug=eq.celebrity-cruises&select=id&limit=1"))?.[0];
  if (!line) throw new Error("Celebrity line not found");

  const sailingIds = manifest.products.map((p) => p.official_celebrity_sailing_id).filter(Boolean);
  const or = sailingIds.map((id) => `official_sailing_id.eq.${encodeURIComponent(id)}`).join(",");
  const dbRows = await sb.get(
    `discovered_cruises?or=(${or})&select=id,status,official_sailing_id,official_url,departure_date,return_date,nights,departure_port,destination_id,ship_id,last_changed_at,raw_extract,cruise_line_id`
  );

  const batchMarked = await sb.get(
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(line.id)}&raw_extract->>celebrity_batch_write=eq.true&select=id,status,official_sailing_id,official_url,departure_date,raw_extract,last_changed_at`
  );

  const destLinks = [];
  for (const chunk of chunkIds((batchMarked || []).map((r) => r.id))) {
    const rows = await sb.get(
      `discovered_cruise_destinations?cruise_id=in.(${chunk.join(",")})&select=cruise_id,destination_id,created_at`
    );
    destLinks.push(...(rows || []));
  }

  const bySailingId = new Map((dbRows || []).map((r) => [r.official_sailing_id, r]));
  const writeBySailing = new Map(writeDetails.filter((d) => d.celebrity_sailing_id).map((d) => [d.celebrity_sailing_id, d]));

  const urlGroups = new Map();
  for (const p of manifest.products) {
    const url = p.source_url || p.official_url;
    if (!url) continue;
    if (!urlGroups.has(url)) urlGroups.set(url, []);
    urlGroups.get(url).push(p.official_celebrity_sailing_id);
  }

  const products = manifest.products.map((p) => {
    const sid = p.official_celebrity_sailing_id;
    const write = writeBySailing.get(sid);
    const db = bySailingId.get(sid);
    const sharedUrl = (urlGroups.get(p.source_url || p.official_url) || []).length > 1;
    let actualAction = "none";
    if (write?.error) actualAction = "failed";
    else if (write?.created === true) actualAction = "insert_active";
    else if (write?.created === false && write?.discovered_cruise_id) actualAction = "incorrect_update_or_duplicate";
    else if (db) actualAction = "found_in_db";
    return {
      official_sailing_id: sid,
      official_group_id: p.official_celebrity_group_id,
      official_url: p.source_url || p.official_url,
      shared_official_url: sharedUrl,
      intended_action: p.proposed_action,
      script_action: write?.action || null,
      actual_database_action: actualAction,
      discovered_cruise_id: db?.id || write?.discovered_cruise_id || null,
      script_discovered_cruise_id: write?.discovered_cruise_id || null,
      current_status: db?.status || null,
      official_sailing_id_in_db: db?.official_sailing_id || db?.raw_extract?.celebrity_sailing_id || null,
      departure_date_in_db: db?.departure_date || null,
      expected_departure_date: p.departure_date,
      rollback_required: Boolean(
        write?.created === true ||
          write?.created === false ||
          write?.error ||
          (db && db.raw_extract?.celebrity_batch_write)
      ),
      write_error: write?.error || null
    };
  });

  const counts = {
    discovered_cruises: await headCount("discovered_cruises"),
    celebrity_active: await headCount(
      "discovered_cruises",
      `cruise_line_id=eq.${encodeURIComponent(line.id)}&status=eq.active`
    ),
    celebrity_batch_marked: (batchMarked || []).length,
    discovered_cruise_destinations: await headCount("discovered_cruise_destinations"),
    pending_review: await headCount("cruise_discovery_review_items", "status=eq.pending")
  };

  const wrongUpdates = products.filter((p) => p.actual_database_action === "incorrect_update_or_duplicate");

  const report = {
    generated_at: new Date().toISOString(),
    run_id: RUN_ID,
    counts,
    inserted_script_count: writeDetails.filter((d) => d.created === true).length,
    wrong_update_count: wrongUpdates.length,
    failed_count: writeDetails.filter((d) => d.error).length,
    wrong_updates: wrongUpdates,
    destination_link_rows: destLinks,
    batch_marked_rows: batchMarked,
    products
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output: OUTPUT, ...counts, wrong_update_count: wrongUpdates.length }, null, 2));
}

function chunkIds(ids, size = 40) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
