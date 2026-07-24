#!/usr/bin/env node
/**
 * Read-only inventory of CI / Media Library image URLs (Sprint 16E Phase 1).
 * Never writes. Safe to run against production for audit counts only.
 *
 *   node scripts/inventory-ci-image-urls.mjs
 *   node scripts/inventory-ci-image-urls.mjs --json > tmp/image-url-inventory.json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function loadEnvFile() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile();

function classifyHost(url) {
  if (!url || !String(url).trim()) return "blank";
  let host = "";
  try {
    host = new URL(String(url).trim()).hostname.toLowerCase();
  } catch {
    return "invalid_url";
  }
  if (host.includes("squarespace")) return "squarespace";
  if (host.includes("supabase.co") || host.includes("supabase.in")) return "supabase";
  if (host.endsWith("101cruise.com.au")) return "101cruise";
  return "other";
}

async function listAll(url, key, table, select) {
  const pageSize = 500;
  let offset = 0;
  const all = [];
  while (offset < 20000) {
    const response = await fetch(
      `${url}/rest/v1/${table}?select=${encodeURIComponent(select)}&order=id.asc&limit=${pageSize}&offset=${offset}`,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          Prefer: "count=exact"
        }
      }
    );
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : [];
    } catch {
      throw new Error(`${table}: ${text}`);
    }
    if (!response.ok) throw new Error(`${table}: ${data?.message || response.status}`);
    const list = Array.isArray(data) ? data : [];
    all.push(...list);
    if (list.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

function summariseField(rows, field, entityType, table) {
  const urls = rows.map((r) => r[field]);
  const populated = urls.filter((u) => u && String(u).trim());
  const blank = urls.length - populated.length;
  const byHost = { squarespace: 0, supabase: 0, "101cruise": 0, other: 0, invalid_url: 0 };
  const hostnames = new Map();
  const urlCounts = new Map();
  for (const u of populated) {
    const kind = classifyHost(u);
    byHost[kind] = (byHost[kind] || 0) + 1;
    try {
      const h = new URL(String(u).trim()).hostname.toLowerCase();
      hostnames.set(h, (hostnames.get(h) || 0) + 1);
    } catch {
      /* ignore */
    }
    const key = String(u).trim();
    urlCounts.set(key, (urlCounts.get(key) || 0) + 1);
  }
  let duplicateUrlRows = 0;
  for (const c of urlCounts.values()) {
    if (c > 1) duplicateUrlRows += c;
  }
  return {
    table,
    field,
    entity_type: entityType,
    total_rows: rows.length,
    populated: populated.length,
    blank,
    squarespace: byHost.squarespace,
    supabase: byHost.supabase,
    host_101cruise: byHost["101cruise"],
    other_host: byHost.other,
    invalid_url: byHost.invalid_url,
    duplicate_url_rows: duplicateUrlRows,
    distinct_urls: urlCounts.size,
    top_hostnames: [...hostnames.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([host, count]) => ({ host, count })),
    inaccessible_url_count: null,
    note: "inaccessible_url_count requires network HEAD/GET — run migrate --dry-run"
  };
}

async function main() {
  const url = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !key) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const asJson = process.argv.includes("--json");

  const [lines, ships, media] = await Promise.all([
    listAll(url, key, "ci_cruise_lines", "id,name,logo_url,hero_image_url"),
    listAll(url, key, "ci_cruise_ships", "id,name,cruise_line_id,hero_image_url,image_gallery"),
    listAll(
      url,
      key,
      "media_library",
      "id,media_type,public_url,storage_bucket,storage_path,cruise_line_id,ship_id,content_hash,import_source"
    ).catch((e) => {
      console.error("media_library list warning:", e.message);
      return [];
    })
  ]);

  const galleryPopulated = ships.filter(
    (s) => s.image_gallery != null && String(s.image_gallery) !== "" && String(s.image_gallery) !== "null"
  ).length;

  const fields = [
    summariseField(lines, "logo_url", "cruise_line", "ci_cruise_lines"),
    summariseField(lines, "hero_image_url", "cruise_line", "ci_cruise_lines"),
    summariseField(ships, "hero_image_url", "ship", "ci_cruise_ships"),
    summariseField(media, "public_url", "media_library", "media_library")
  ];

  const report = {
    generated_at: new Date().toISOString(),
    supabase_host: new URL(url).host,
    read_only: true,
    has_supabase_dev: Boolean(process.env.SUPABASE_DEV_URL),
    fields,
    notes: [
      "ci_cruise_ships.image_gallery jsonb populated rows: " + galleryPopulated,
      "No other CI ship image URL columns found in schema beyond hero_image_url.",
      "Existing URL-copy script: scripts/migrate-ci-media.mjs (copies legacy URLs into CI fields; does not download binaries).",
      "Sprint 16E binary migration extends that ownership via scripts/migrate-squarespace-ci-media.mjs.",
      "Additive schema for source_url + cruise_line media_type: 20260738_media_library_squarespace_migration.sql (unapplied)."
    ]
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("Image URL inventory (read-only)");
    console.log("Host:", report.supabase_host);
    console.log("SUPABASE_DEV_URL set:", report.has_supabase_dev);
    console.log("");
    for (const f of fields) {
      console.log(
        `${f.table}.${f.field}  rows=${f.total_rows} populated=${f.populated} blank=${f.blank} sqsp=${f.squarespace} supabase=${f.supabase} other=${f.other_host + f.host_101cruise} dupRows=${f.duplicate_url_rows}`
      );
      if (f.top_hostnames.length) {
        console.log(
          "  hosts:",
          f.top_hostnames.map((h) => `${h.host}(${h.count})`).join(", ")
        );
      }
    }
    console.log("\nimage_gallery non-empty:", galleryPopulated);
  }

  const outDir = path.join(ROOT, "tmp");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "image-url-inventory.json"), JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
