#!/usr/bin/env node
/**
 * Roll back the partial Celebrity controlled batch.
 *   node scripts/rollback-celebrity-partial-batch.mjs --backup
 *   node scripts/rollback-celebrity-partial-batch.mjs --apply
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const { createSupabaseRest, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const RUN_ID = "celebrity-first-batch-2026-08-06T05-25-49Z";
const ROLLBACK_PATH = path.join(
  root,
  "reports/celebrity-first-production-batch-rollback-2026-08-06T05-26-12-313Z.json"
);
const BACKUP_PATH = path.join(root, "reports/celebrity-partial-batch-pre-rollback-backup-2026-08-06.json");

function parseArgs(argv) {
  return { backup: argv.includes("--backup"), apply: argv.includes("--apply") };
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

async function fetchCounts(lineId, halLineId) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    discovered_cruises: await headCount("discovered_cruises"),
    active_discovered: await headCount("discovered_cruises", "status=eq.active"),
    active_future: await headCount(
      "discovered_cruises",
      `status=eq.active&departure_date=gte.${today}`
    ),
    celebrity_total: lineId
      ? await headCount("discovered_cruises", `cruise_line_id=eq.${encodeURIComponent(lineId)}`)
      : 0,
    celebrity_active: lineId
      ? await headCount(
          "discovered_cruises",
          `cruise_line_id=eq.${encodeURIComponent(lineId)}&status=eq.active`
        )
      : 0,
    hal_active: halLineId
      ? await headCount(
          "discovered_cruises",
          `cruise_line_id=eq.${encodeURIComponent(halLineId)}&status=eq.active`
        )
      : 0,
    pending_review: await headCount("cruise_discovery_review_items", "status=eq.pending"),
    total_review: await headCount("cruise_discovery_review_items"),
    ship_aliases: await headCount("cruise_ship_aliases"),
    destination_aliases: await headCount("cruise_destination_aliases"),
    destinations: await headCount("destinations"),
    destination_ports: await headCount("destination_ports"),
    discovered_cruise_destinations: await headCount("discovered_cruise_destinations"),
    discovery_runs: await headCount("cruise_discovery_runs")
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.backup && !args.apply) {
    console.error("Use --backup or --apply");
    process.exit(1);
  }

  const sb = createSupabaseRest(root);
  const rollback = JSON.parse(fs.readFileSync(ROLLBACK_PATH, "utf8"));
  const writeDetails = rollback.write_result?.stats?.write_details || [];

  const line = (await sb.get("ci_cruise_lines?slug=eq.celebrity-cruises&select=id&limit=1"))?.[0];
  const halLine = (await sb.get("ci_cruise_lines?slug=eq.holland-america-line&select=id&limit=1"))?.[0];
  if (!line) throw new Error("Celebrity line not found");

  const insertIds = [
    ...new Set(
      writeDetails.filter((d) => d.created === true && d.discovered_cruise_id).map((d) => d.discovered_cruise_id)
    )
  ];

  const batchRows = await sb.get(
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(line.id)}&raw_extract->>celebrity_batch_write=eq.true&select=*`
  );

  const deleteIds = [...new Set([...insertIds, ...(batchRows || []).map((r) => r.id)])];

  const destLinks = [];
  for (const chunk of chunkIds(deleteIds)) {
    const rows = await sb.get(`discovered_cruise_destinations?cruise_id=in.(${chunk.join(",")})&select=*`);
    destLinks.push(...(rows || []));
  }

  const rowsToDelete = [];
  for (const id of deleteIds) {
    const row = (batchRows || []).find((r) => r.id === id) || (await sb.get(`discovered_cruises?id=eq.${id}&select=*&limit=1`))?.[0];
    if (!row) continue;
    if (row.cruise_line_id !== line.id) {
      throw new Error(`Refusing rollback for non-Celebrity row ${id}`);
    }
    if (row.raw_extract?.celebrity_batch_write !== true && !insertIds.includes(id)) {
      throw new Error(`Refusing rollback for row without batch marker ${id}`);
    }
    rowsToDelete.push(row);
  }

  const backup = {
    generated_at: new Date().toISOString(),
    run_id: RUN_ID,
    counts_before: await fetchCounts(line.id, halLine?.id),
    delete_ids: deleteIds,
    rows_to_delete: rowsToDelete,
    destination_links: destLinks,
    rollback_source: ROLLBACK_PATH
  };

  if (args.backup) {
    fs.mkdirSync(path.dirname(BACKUP_PATH), { recursive: true });
    fs.writeFileSync(BACKUP_PATH, JSON.stringify(backup, null, 2));
    console.log(JSON.stringify({ phase: "backup", backup_path: BACKUP_PATH, delete_count: deleteIds.length }, null, 2));
    return;
  }

  let deleted = 0;
  let destDeleted = 0;
  let failed = 0;
  for (const id of deleteIds) {
    try {
      await sb.request(`discovered_cruise_destinations?cruise_id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
      destDeleted += 1;
      await sb.request(`discovered_cruises?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
      deleted += 1;
    } catch (err) {
      failed += 1;
      console.error(`delete failed ${id}: ${err.message}`);
    }
  }

  const countsAfter = await fetchCounts(line.id, halLine?.id);
  const result = {
    phase: "apply",
    run_id: RUN_ID,
    deleted,
    destination_link_cleanups: destDeleted,
    failed,
    counts_after: countsAfter
  };
  fs.writeFileSync(
    path.join(root, "reports/celebrity-partial-batch-rollback-result-2026-08-06.json"),
    JSON.stringify(result, null, 2)
  );
  console.log(JSON.stringify(result, null, 2));
  if (countsAfter.celebrity_active !== 0) process.exit(1);
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
