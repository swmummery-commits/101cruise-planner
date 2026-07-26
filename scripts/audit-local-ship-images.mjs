#!/usr/bin/env node
/**
 * Local Brand Imaging ship-image inventory + canonical matching audit.
 * READ-ONLY against Original project catalogue and local files.
 *
 * Never INSERT/UPDATE/DELETE. Never Storage writes. Never alters local images.
 * Never touches DEV.
 *
 *   node scripts/audit-local-ship-images.mjs --target=production
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
import { assertAuditHttpMethod } from "./lib/local-ship-image-audit/read-only.js";
import {
  DEFAULT_BRAND_IMAGING_ROOT,
  scanBrandImagingRoot
} from "./lib/local-ship-image-audit/scan.js";
import {
  analyseLocalShipImageCoverage,
  formatTerminalSummary,
  toCsv,
  COVERAGE_CSV_COLUMNS,
  FOLDER_MATCH_CSV_COLUMNS,
  HERO_CANDIDATE_CSV_COLUMNS,
  ANOMALY_CSV_COLUMNS
} from "./lib/local-ship-image-audit/analyze.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "tmp", "media-coverage-audit", "local-ship-images");

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

/** Read-only REST — GET only. */
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

async function main() {
  loadEnvFile();

  const target = parseTargetArg(process.argv);
  if (target !== "production") {
    console.error("REFUSED: require --target=production (DEV forbidden; read-only Original only)");
    process.exit(2);
  }

  let env;
  try {
    env = resolveMigrationTarget({
      target: "production",
      mode: "dry-run",
      env: process.env
    });
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  if (env.project_ref !== PRODUCTION_REF) {
    console.error("REFUSED: selected project is not the Original project");
    process.exit(2);
  }

  console.log("\n=== Local Brand Imaging ship-image audit ===");
  console.log(formatTargetBanner(env, "dry-run"));
  console.log("Mode: READ-ONLY inventory + canonical matching");
  console.log(`Local root: ${DEFAULT_BRAND_IMAGING_ROOT}`);
  console.log("Writes: no (DB / Storage / DEV / local files)");

  console.log("\nScanning local Brand Imaging (read-only)...");
  const scanStarted = Date.now();
  const scan = scanBrandImagingRoot(DEFAULT_BRAND_IMAGING_ROOT, {
    onProgress: (n) => {
      const elapsed = ((Date.now() - scanStarted) / 1000).toFixed(1);
      console.log(`  … ${n} images inspected (${elapsed}s)`);
    }
  });
  console.log(
    `Scanned ${scan.totals.images} images in ${((Date.now() - scanStarted) / 1000).toFixed(1)}s`
  );

  console.log("Loading Original catalogue (GET only)...");
  const [lines, ships, aliases] = await Promise.all([
    listAll(env, "ci_cruise_lines", "id,name,logo_url"),
    listAll(env, "ci_cruise_ships", "id,name,cruise_line_id,hero_image_url"),
    listAll(
      env,
      "cruise_ship_aliases",
      "id,ship_id,cruise_line_id,raw_alias,normalised_alias,active"
    )
  ]);
  console.log(
    `Catalogue: ${lines.length} lines, ${ships.length} ships, ${aliases.length} aliases`
  );

  const analysis = analyseLocalShipImageCoverage({
    scan,
    lines,
    ships,
    aliases
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const summaryPath = path.join(OUT_DIR, "local-ship-image-summary.json");
  const coveragePath = path.join(OUT_DIR, "canonical-ship-local-coverage.csv");
  const folderPath = path.join(OUT_DIR, "local-folder-canonical-matches.csv");
  const heroPath = path.join(OUT_DIR, "proposed-hero-candidates.csv");
  const anomalyPath = path.join(OUT_DIR, "local-ship-image-anomalies.csv");

  writeJson(summaryPath, {
    ...analysis.summary,
    line_folder_matches: analysis.lineFolderMatches,
    duplicate_groups: analysis.duplicateGroups,
    fleet_reuse_for_review: analysis.fleetReuseForReview,
    report_paths: {
      summary: summaryPath,
      coverage: coveragePath,
      folders: folderPath,
      heroes: heroPath,
      anomalies: anomalyPath
    }
  });
  writeText(coveragePath, toCsv(analysis.coverageRows, COVERAGE_CSV_COLUMNS));
  writeText(folderPath, toCsv(analysis.folderMatchRows, FOLDER_MATCH_CSV_COLUMNS));
  writeText(heroPath, toCsv(analysis.heroCandidateRows, HERO_CANDIDATE_CSV_COLUMNS));
  writeText(anomalyPath, toCsv(analysis.anomalies, ANOMALY_CSV_COLUMNS));

  console.log("\n" + formatTerminalSummary(analysis.summary));
  console.log("\nReports:");
  console.log(`  ${summaryPath}`);
  console.log(`  ${coveragePath}`);
  console.log(`  ${folderPath}`);
  console.log(`  ${heroPath}`);
  console.log(`  ${anomalyPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
