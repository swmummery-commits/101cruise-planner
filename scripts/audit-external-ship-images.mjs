#!/usr/bin/env node
/**
 * Sprint 16 — external-drive Brand Imaging ship-image audit.
 * READ-ONLY: no uploads, no Supabase/Storage writes, no local image changes.
 *
 *   node scripts/audit-external-ship-images.mjs \
 *     --target=production \
 *     --root="/Volumes/4T My Music for Mac 4TB/BRAND IMAGING"
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
import { scanBrandImagingRoot } from "./lib/local-ship-image-audit/scan.js";
import {
  buildExternalShipImageAudit,
  toCsv,
  AUDIT_CSV_COLUMNS,
  ROOM_CSV_COLUMNS
} from "./lib/local-ship-image-audit/external-manifests.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "tmp", "ship-image-audit-external");

const DEFAULT_EXTERNAL_ROOT =
  "/Volumes/4T My Music for Mac 4TB/BRAND IMAGING";

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

function parseRootArg(argv = process.argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) return null;
      return next;
    }
    if (arg.startsWith("--root=")) return arg.slice("--root=".length);
  }
  return null;
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

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
  while (offset < 100000) {
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
    console.error("REFUSED: require --target=production (read-only Original only)");
    process.exit(2);
  }

  const rootDir = parseRootArg(process.argv) || DEFAULT_EXTERNAL_ROOT;
  if (!fs.existsSync(rootDir)) {
    console.error(`REFUSED: external root not accessible: ${rootDir}`);
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

  console.log("\n=== Sprint 16 external Brand Imaging audit ===");
  console.log(formatTargetBanner(env, "dry-run"));
  console.log("Mode: READ-ONLY inventory + matching + manifests");
  console.log(`External root: ${rootDir}`);
  console.log("Writes: tmp manifests only (no DB / Storage / drive changes)");

  console.log("\nScanning external Brand Imaging (read-only)...");
  const scanStarted = Date.now();
  const scan = scanBrandImagingRoot(rootDir, {
    onProgress: (n) => {
      const elapsed = ((Date.now() - scanStarted) / 1000).toFixed(1);
      console.log(`  … ${n} images inspected (${elapsed}s)`);
    }
  });
  console.log(
    `Scanned ${scan.totals.images} images / ${scan.totals.ship_folders} ship folders / ${scan.totals.hero_image_folders} Hero Images folders in ${((Date.now() - scanStarted) / 1000).toFixed(1)}s`
  );

  console.log("Loading Original catalogue + media_library (GET only)...");
  const [lines, ships, aliases, mediaLibrary] = await Promise.all([
    listAll(env, "ci_cruise_lines", "id,name,logo_url"),
    listAll(env, "ci_cruise_ships", "id,name,cruise_line_id,hero_image_url"),
    listAll(
      env,
      "cruise_ship_aliases",
      "id,ship_id,cruise_line_id,raw_alias,normalised_alias,active"
    ),
    listAll(
      env,
      "media_library",
      "id,title,file_name,media_type,width,height,file_size_bytes,ship_id,cruise_line_id,is_default,is_active,storage_path,public_url"
    )
  ]);
  console.log(
    `Catalogue: ${lines.length} lines, ${ships.length} ships, ${aliases.length} aliases, ${mediaLibrary.length} media rows`
  );

  const built = buildExternalShipImageAudit({
    scan,
    lines,
    ships,
    aliases,
    mediaLibrary
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const paths = {
    auditJson: path.join(OUT_DIR, "ship-image-audit-external.json"),
    auditCsv: path.join(OUT_DIR, "ship-image-audit-external.csv"),
    heroJson: path.join(OUT_DIR, "ship-hero-candidates.json"),
    galleryJson: path.join(OUT_DIR, "ship-gallery-candidates.json"),
    roomJson: path.join(OUT_DIR, "room-image-inventory.json"),
    roomCsv: path.join(OUT_DIR, "room-image-inventory.csv"),
    unmatchedJson: path.join(OUT_DIR, "unmatched-folders.json"),
    corruptJson: path.join(OUT_DIR, "corrupt-images.json"),
    planJson: path.join(OUT_DIR, "proposed-upload-plan.json"),
    summaryJson: path.join(OUT_DIR, "summary.json")
  };

  writeJson(paths.auditJson, {
    generated_at: new Date().toISOString(),
    summary: built.summary,
    line_folder_matches: built.lineFolderMatches,
    ship_folders: built.auditRows,
    loose_hero_images: built.looseHeroes,
    ships_with_no_suitable_hero: built.shipsNoSuitableHero
  });
  writeText(
    paths.auditCsv,
    toCsv(
      built.auditRows.map(({ images, ...row }) => row),
      AUDIT_CSV_COLUMNS
    )
  );
  writeJson(paths.heroJson, built.heroCandidates);
  writeJson(paths.galleryJson, built.galleryCandidates);
  writeJson(paths.roomJson, {
    by_category: built.summary.room_images_by_category,
    images: built.roomImages
  });
  writeText(paths.roomCsv, toCsv(built.roomImages, ROOM_CSV_COLUMNS));
  writeJson(paths.unmatchedJson, built.unmatchedFolders);
  writeJson(paths.corruptJson, built.corrupt);
  writeJson(paths.planJson, built.proposedUploadPlan);
  writeJson(paths.summaryJson, { ...built.summary, report_paths: paths });

  const s = built.summary;
  console.log("\n=== Summary ===");
  console.log(`Accessible: yes`);
  console.log(`Cruise-line folders: ${s.cruise_line_folders}`);
  console.log(`Ship folders: ${s.ship_folders}`);
  console.log(`Exact ship matches: ${s.exact_ship_matches}`);
  console.log(`Safe normalised matches: ${s.safe_normalised_ship_matches}`);
  console.log(`Ambiguous ship folders: ${s.ambiguous_ship_folders}`);
  console.log(`Unmatched ship folders: ${s.unmatched_ship_folders}`);
  console.log(`Images inspected: ${s.images_inspected}`);
  console.log(`Excellent hero candidates: ${s.excellent_hero_candidates}`);
  console.log(`Secondary gallery candidates: ${s.secondary_gallery_candidates}`);
  console.log(`Ships with no suitable hero: ${s.ships_with_no_suitable_hero}`);
  console.log(`Exact Media Library duplicates: ${s.exact_media_library_duplicates}`);
  console.log(`Room images: ${s.room_images_total}`, s.room_images_by_category);
  console.log(`Room reliable mapping: ${s.room_images_reliable_mapping}`);
  console.log(`Room held uncertain: ${s.room_images_held_uncertain}`);
  console.log(`Corrupt/unreadable: ${s.corrupt_or_unreadable}`);
  console.log(
    `Est. proposed upload: heroes ${s.estimated_new_hero_upload_bytes} B + gallery ${s.estimated_gallery_upload_bytes} B + line ${built.proposedUploadPlan.cruise_line_level_images.estimated_bytes} B`
  );
  console.log("\nManifests:");
  for (const p of Object.values(paths)) console.log(`  ${p}`);
  console.log("\nConfirmation: no upload; no Supabase/Storage/drive mutation.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
