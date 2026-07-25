#!/usr/bin/env node
/**
 * Cruise Media Coverage Audit — Original project, READ-ONLY.
 *
 * Never INSERT / UPDATE / DELETE. Never writes Storage. Never touches DEV.
 *
 *   node scripts/audit-cruise-media-coverage.mjs --target=production
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseTargetArg,
  resolveMigrationTarget,
  formatTargetBanner,
  PRODUCTION_REF
} from "./lib/squarespace-ci-media/target.js";
import { MEDIA_BUCKET } from "./lib/squarespace-ci-media/media-utils.js";
import { assertAuditHttpMethod } from "./lib/media-coverage-audit/read-only.js";
import {
  analyseCruiseLine,
  analyseShip,
  indexContentHashes,
  sharedBinaryGroups,
  collectCatalogueAnomalies,
  summariseCoverage,
  toCsv,
  LINE_CSV_COLUMNS,
  SHIP_CSV_COLUMNS,
  ANOMALY_CSV_COLUMNS
} from "./lib/media-coverage-audit/analyze.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "tmp", "media-coverage-audit");

const REACHABILITY_CONCURRENCY = 12;

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

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

/**
 * Read-only REST helper — GET only.
 */
async function supabaseGet(env, tablePath, query = "") {
  assertAuditHttpMethod("GET");
  const response = await fetch(`${env.url}/rest/v1/${tablePath}${query}`, {
    method: "GET",
    headers: {
      apikey: env.key,
      Authorization: `Bearer ${env.key}`,
      "Content-Type": "application/json",
      Prefer: "count=exact"
    }
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    throw new Error((data && data.message) || `Supabase HTTP ${response.status}: ${text}`);
  }
  return data;
}

async function listAll(env, table, select) {
  const pageSize = 500;
  let offset = 0;
  const all = [];
  while (offset < 50000) {
    const rows = await supabaseGet(
      env,
      table,
      `?select=${encodeURIComponent(select)}&order=id.asc&limit=${pageSize}&offset=${offset}`
    );
    const list = Array.isArray(rows) ? rows : [];
    all.push(...list);
    if (list.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

async function urlReachable(url) {
  if (!url || !String(url).trim()) return null;
  assertAuditHttpMethod("HEAD");
  try {
    const head = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (head.ok) return true;
    assertAuditHttpMethod("GET");
    const get = await fetch(url, { method: "GET", redirect: "follow" });
    return get.ok;
  } catch {
    return false;
  }
}

/** Read-only Storage object probe (HEAD / info). */
async function storageObjectExists(env, storagePath) {
  if (!storagePath) return null;
  const encoded = String(storagePath)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  assertAuditHttpMethod("GET");
  try {
    const info = await fetch(
      `${env.url}/storage/v1/object/info/public/${MEDIA_BUCKET}/${encoded}`,
      {
        method: "GET",
        headers: {
          apikey: env.key,
          Authorization: `Bearer ${env.key}`
        }
      }
    );
    if (info.ok) return true;
  } catch {
    /* fall through */
  }
  assertAuditHttpMethod("HEAD");
  try {
    const head = await fetch(`${env.url}/storage/v1/object/${MEDIA_BUCKET}/${encoded}`, {
      method: "HEAD",
      headers: {
        apikey: env.key,
        Authorization: `Bearer ${env.key}`
      }
    });
    return head.ok;
  } catch {
    return false;
  }
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(concurrency, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

async function main() {
  // Abort before network / env load when target is wrong.
  const target = parseTargetArg(process.argv);
  if (target == null) {
    console.error("REFUSED: require --target=production");
    process.exit(2);
  }
  if (target !== "production") {
    console.error("REFUSED: media coverage audit requires --target=production (DEV forbidden)");
    process.exit(2);
  }

  loadEnvFile();

  let env;
  try {
    env = resolveMigrationTarget({
      target: "production",
      mode: "dry-run",
      env: process.env
    });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  if (env.project_ref !== PRODUCTION_REF || env.target !== "production") {
    console.error("REFUSED: audit may only use the Original project.");
    process.exit(2);
  }

  console.log("\n=== Cruise Media Coverage Audit (READ-ONLY) ===");
  console.log(formatTargetBanner(env, "dry-run"));
  console.log("Operations: GET/HEAD only — zero writes\n");

  const lines = await listAll(
    env,
    "ci_cruise_lines",
    "id,name,logo_url,active"
  );
  const ships = await listAll(
    env,
    "ci_cruise_ships",
    "id,name,cruise_line_id,hero_image_url,active"
  );
  const mediaRows = await listAll(
    env,
    "media_library",
    "id,media_type,public_url,storage_bucket,storage_path,cruise_line_id,ship_id,content_hash,import_source,source_url"
  );

  console.log(
    `Loaded: ${lines.length} lines, ${ships.length} ships, ${mediaRows.length} media_library rows`
  );
  console.log("Checking URL reachability…");

  const lineUrls = lines.map((l) => l.logo_url || null);
  const shipUrls = ships.map((s) => s.hero_image_url || null);
  const lineReach = await mapPool(lineUrls, REACHABILITY_CONCURRENCY, (u) =>
    urlReachable(u)
  );
  const shipReach = await mapPool(shipUrls, REACHABILITY_CONCURRENCY, (u) =>
    urlReachable(u)
  );

  const linesById = new Map(lines.map((l) => [String(l.id), l]));

  const lineRows = lines.map((line, i) =>
    analyseCruiseLine({
      line,
      mediaRows,
      reachable: lineReach[i]
    })
  );
  const shipRows = ships.map((ship, i) =>
    analyseShip({
      ship,
      lineName: linesById.get(String(ship.cruise_line_id))?.name || "",
      mediaRows,
      reachable: shipReach[i]
    })
  );

  console.log("Probing Media Library storage_path references (read-only)…");
  const withPath = mediaRows.filter((m) => m.storage_path);
  const pathExists = await mapPool(withPath, REACHABILITY_CONCURRENCY, (m) =>
    storageObjectExists(env, m.storage_path)
  );
  const storageOrphans = [];
  withPath.forEach((m, i) => {
    if (pathExists[i] === false) {
      storageOrphans.push({
        media_library_id: m.id,
        detail: `storage_path not found in ${MEDIA_BUCKET}: ${m.storage_path}`
      });
    }
  });

  const byHash = indexContentHashes(mediaRows);
  const sharedBinaries = sharedBinaryGroups(byHash);
  const anomalies = collectCatalogueAnomalies({
    lines,
    ships,
    mediaRows,
    lineRows,
    shipRows,
    sharedBinaries,
    storageOrphans
  });

  const summary = {
    mode: "read-only-audit",
    target: "production",
    project_ref: env.project_ref,
    generated_at: new Date().toISOString(),
    ...summariseCoverage({ lineRows, shipRows, anomalies, sharedBinaries }),
    shared_binaries_for_review: sharedBinaries,
    lines_with_no_logo: lineRows
      .filter((r) => r.logo_status === "missing")
      .map((r) => ({ id: r.uuid, name: r.canonical_name })),
    ships_with_no_hero: shipRows
      .filter((r) => r.hero_status === "missing")
      .map((r) => ({
        id: r.uuid,
        name: r.canonical_ship_name,
        cruise_line_id: r.cruise_line_uuid,
        cruise_line_name: r.cruise_line_name
      })),
    report_paths: {
      summary: path.join(OUT_DIR, "media-coverage-summary.json"),
      lines: path.join(OUT_DIR, "cruise-line-media-coverage.csv"),
      ships: path.join(OUT_DIR, "ship-media-coverage.csv"),
      anomalies: path.join(OUT_DIR, "media-anomalies.csv")
    }
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  writeJson(summary.report_paths.summary, summary);
  writeText(
    summary.report_paths.lines,
    toCsv(lineRows, LINE_CSV_COLUMNS)
  );
  writeText(
    summary.report_paths.ships,
    toCsv(shipRows, SHIP_CSV_COLUMNS)
  );
  writeText(
    summary.report_paths.anomalies,
    toCsv(anomalies, ANOMALY_CSV_COLUMNS)
  );

  console.log("\n--- Coverage summary ---");
  console.log(`Total cruise lines:              ${summary.total_cruise_lines}`);
  console.log(`Lines with Supabase logos:       ${summary.lines_with_supabase_logos}`);
  console.log(`Lines with other external logos: ${summary.lines_with_other_external_logos}`);
  console.log(`Lines with missing logos:        ${summary.lines_with_missing_logos}`);
  console.log(`Total ships:                     ${summary.total_ships}`);
  console.log(`Ships with Supabase hero images: ${summary.ships_with_supabase_heroes}`);
  console.log(`Ships with other external heroes: ${summary.ships_with_other_external_heroes}`);
  console.log(`Ships with missing hero images:  ${summary.ships_with_missing_heroes}`);
  console.log(`Remaining Squarespace URLs:      ${summary.remaining_squarespace_urls}`);
  console.log(`Broken URLs:                     ${summary.broken_urls}`);
  console.log(`Relationship errors:             ${summary.relationship_errors}`);
  console.log(`Duplicate-record warnings:       ${summary.duplicate_record_warnings}`);
  console.log(`Orphan warnings:                 ${summary.orphan_warnings}`);
  console.log(`Shared binaries (review):        ${summary.shared_binary_review_count}`);
  console.log(`Total anomalies:                 ${summary.total_anomalies}`);
  console.log(`Writes (insert/update/delete):   0 / 0 / 0`);
  console.log(`Storage writes / DEV writes:     0 / 0`);
  console.log("\nReports:");
  console.log(`  ${summary.report_paths.summary}`);
  console.log(`  ${summary.report_paths.lines}`);
  console.log(`  ${summary.report_paths.ships}`);
  console.log(`  ${summary.report_paths.anomalies}`);
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
