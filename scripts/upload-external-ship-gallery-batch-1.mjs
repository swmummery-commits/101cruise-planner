#!/usr/bin/env node
/**
 * Controlled production upload — external Brand Imaging ship galleries batch 1.
 *
 * Dry run:
 *   node scripts/upload-external-ship-gallery-batch-1.mjs \
 *     --dry-run --target=production \
 *     --confirm=UPLOAD-EXTERNAL-SHIP-GALLERY-BATCH-1
 *
 * Apply:
 *   node scripts/upload-external-ship-gallery-batch-1.mjs \
 *     --apply --target=production \
 *     --confirm=UPLOAD-EXTERNAL-SHIP-GALLERY-BATCH-1
 *
 * Never uploads rooms or cruise-line loose Hero Images.
 * Never changes hero_image_url or default hero media rows.
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
import {
  CONFIRM_TOKEN_GALLERY_BATCH_1,
  IMPORT_SOURCE_GALLERY_BATCH_1,
  buildStrictGalleryBatch,
  inspectLocalShipGallery,
  isNearDuplicatePair,
  loadHeroShipsFromResults,
  readLocalImageBuffer,
  toCsv
} from "./lib/local-ship-image-audit/gallery-batch-upload.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const AUDIT_DIR = path.join(ROOT, "tmp", "ship-image-audit-external");

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

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function parseArg(name) {
  for (let i = 0; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === `--${name}`) {
      const next = process.argv[i + 1];
      if (!next || next.startsWith("-")) return null;
      return String(next);
    }
    if (arg.startsWith(`--${name}=`)) return arg.slice(`--${name}=`.length);
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

async function supabaseRest(env, method, tablePath, { query = "", body, headers = {} } = {}) {
  const m = String(method || "").toUpperCase();
  const response = await fetch(`${env.url}/rest/v1/${tablePath}${query}`, {
    method: m,
    headers: {
      apikey: env.key,
      Authorization: `Bearer ${env.key}`,
      "Content-Type": "application/json",
      Prefer:
        m === "POST" || m === "PATCH"
          ? "return=representation"
          : "count=exact",
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, ok: response.ok, body: data, text };
}

async function listAll(env, table, select) {
  const pageSize = 500;
  let offset = 0;
  const all = [];
  while (offset < 100000) {
    const { ok, body, text, status } = await supabaseRest(env, "GET", table, {
      query: `?select=${encodeURIComponent(select)}&order=id.asc&limit=${pageSize}&offset=${offset}`
    });
    if (!ok) throw new Error(`GET ${table} failed HTTP ${status}: ${text}`);
    const list = Array.isArray(body) ? body : [];
    all.push(...list);
    if (list.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

async function uploadObject(env, { path: storagePath, buffer, contentType }) {
  const response = await fetch(
    `${env.url}/storage/v1/object/${MEDIA_BUCKET}/${storagePath
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
    {
      method: "POST",
      headers: {
        apikey: env.key,
        Authorization: `Bearer ${env.key}`,
        "Content-Type": contentType || "application/octet-stream",
        "x-upsert": "false"
      },
      body: buffer
    }
  );
  if (!response.ok) {
    const text = await response.text();
    if (response.status === 400 || response.status === 409) {
      if (/already exists|Duplicate|resource already/i.test(text)) {
        return { skipped_existing: true };
      }
    }
    throw new Error(`Storage upload failed: ${text || response.status}`);
  }
  return { skipped_existing: false };
}

async function deleteStorageObject(env, storagePath) {
  const response = await fetch(`${env.url}/storage/v1/object/${MEDIA_BUCKET}`, {
    method: "DELETE",
    headers: {
      apikey: env.key,
      Authorization: `Bearer ${env.key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ prefixes: [storagePath] })
  });
  return response.ok;
}

async function storageObjectExists(env, storagePath) {
  if (!storagePath) return false;
  const encoded = String(storagePath)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  try {
    const pub = `${env.url}/storage/v1/object/public/${MEDIA_BUCKET}/${encoded}`;
    const head = await fetch(pub, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(12000)
    });
    return head.ok;
  } catch {
    return false;
  }
}

async function verifyPublicUrl(url) {
  try {
    const response = await fetch(url, { method: "GET", redirect: "follow" });
    if (!response.ok) return false;
    const ab = await response.arrayBuffer();
    return ab.byteLength > 0;
  } catch {
    return false;
  }
}

function hasHeroUrl(url) {
  return Boolean(url && String(url).trim());
}

function filenameMatch(a, b) {
  const na = String(a || "")
    .trim()
    .toLowerCase();
  const nb = String(b || "")
    .trim()
    .toLowerCase();
  return Boolean(na && nb && na === nb);
}

async function main() {
  loadEnvFile();

  const dry = hasFlag("--dry-run");
  const apply = hasFlag("--apply");
  if (dry === apply) {
    console.error("REFUSED: use exactly one of --dry-run or --apply");
    process.exit(2);
  }
  const mode = dry ? "dry-run" : "apply";
  const target = parseTargetArg(process.argv);
  const confirm = parseArg("confirm");

  if (target !== "production") {
    console.error("REFUSED: require --target=production");
    process.exit(2);
  }
  if (confirm !== CONFIRM_TOKEN_GALLERY_BATCH_1) {
    console.error(`REFUSED: require --confirm=${CONFIRM_TOKEN_GALLERY_BATCH_1}`);
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
    console.error("REFUSED: not Original project");
    process.exit(2);
  }

  const required = [
    "ship-gallery-candidates.json",
    "ship-hero-candidates.json",
    "hero-upload-batch-1-results.json",
    "hero-upload-batch-2-results.json"
  ];
  for (const name of required) {
    const p = path.join(AUDIT_DIR, name);
    if (!fs.existsSync(p)) {
      console.error(`REFUSED: missing ${p}`);
      process.exit(2);
    }
  }

  const galleryCandidates = readJson(path.join(AUDIT_DIR, "ship-gallery-candidates.json"));
  const heroCandidates = readJson(path.join(AUDIT_DIR, "ship-hero-candidates.json"));
  const batch1 = readJson(path.join(AUDIT_DIR, "hero-upload-batch-1-results.json"));
  const batch2 = readJson(path.join(AUDIT_DIR, "hero-upload-batch-2-results.json"));
  const heroShips = loadHeroShipsFromResults(batch1, batch2);

  const batch = buildStrictGalleryBatch({
    galleryCandidates,
    heroCandidates,
    heroShips
  });

  console.log("\n=== External ship gallery upload — batch 1 ===");
  console.log(formatTargetBanner(env, mode));
  console.log(`Import source: ${IMPORT_SOURCE_GALLERY_BATCH_1}`);
  console.log(`STRICT SHIPS (before writes): ${batch.ship_count}`);
  console.log(`STRICT IMAGES (before writes): ${batch.image_count}`);
  console.log(`Excluded: ${batch.excluded.length}`);
  console.log(`Held for later: ${batch.held_for_later.length}`);
  console.log("Scope: secondary galleries only (no hero changes / rooms / line heroes)");

  writeJson(path.join(AUDIT_DIR, "gallery-upload-batch-1-proposed.json"), {
    generated_at: new Date().toISOString(),
    ship_count: batch.ship_count,
    image_count: batch.image_count,
    per_ship: batch.per_ship,
    items: batch.approved,
    excluded: batch.excluded.map((e) => ({
      ship_name: e.ship_name,
      cruise_line_name: e.cruise_line_name,
      reason: e.exclude_reason,
      absolute_path: e.absolute_path
    })),
    held_for_later: batch.held_for_later.map((h) => ({
      ship_name: h.ship_name,
      reason: h.hold_reason,
      absolute_path: h.absolute_path
    }))
  });

  console.log("\nLoading live catalogue + media_library (GET)...");
  const [ships, media] = await Promise.all([
    listAll(env, "ci_cruise_ships", "id,name,cruise_line_id,hero_image_url"),
    listAll(
      env,
      "media_library",
      "id,title,file_name,original_filename,media_type,width,height,file_size_bytes,ship_id,cruise_line_id,is_default,is_active,storage_path,public_url,content_hash,import_source"
    )
  ]);
  console.log(`Loaded ${ships.length} ships, ${media.length} media_library rows`);
  const shipsById = new Map(ships.map((s) => [s.id, s]));
  const mediaByShipHash = new Map();
  const mediaByHash = new Map();
  const mediaByShip = new Map();
  for (const m of media) {
    if (m.content_hash) {
      mediaByHash.set(m.content_hash, m);
      if (m.ship_id) mediaByShipHash.set(`${m.ship_id}::${m.content_hash}`, m);
    }
    if (m.ship_id && m.media_type === "ship") {
      if (!mediaByShip.has(m.ship_id)) mediaByShip.set(m.ship_id, []);
      mediaByShip.get(m.ship_id).push(m);
    }
  }

  // Group approved by ship for one-ship-at-a-time processing later
  const byShip = new Map();
  for (const item of batch.approved) {
    if (!byShip.has(item.ship_id)) byShip.set(item.ship_id, []);
    byShip.get(item.ship_id).push(item);
  }

  const dryRows = [];
  const skipRows = [];
  let systemicError = null;
  let inspectedCount = 0;
  const totalToInspect = batch.approved.length;

  for (const [shipId, items] of byShip) {
    const live = shipsById.get(shipId);
    const heroMeta = heroShips.get(shipId);
    const existing = mediaByShip.get(shipId) || [];
    const existingGallery = existing.filter((m) => m.is_default !== true);
    const existingHeroMedia = existing.filter((m) => m.is_default === true);

    for (const item of items) {
      const rowBase = {
        ship_id: item.ship_id,
        ship_name: item.ship_name,
        cruise_line_id: item.cruise_line_id,
        cruise_line_name: item.cruise_line_name,
        source_pathname: item.absolute_path,
        filename: path.basename(item.absolute_path),
        audit_classification: item.quality_class || item.source_kind,
        intended_gallery_role: item.intended_gallery_role,
        display_order: item.display_order,
        match_class: item.match_class
      };

      if (!live) {
        skipRows.push({ ...rowBase, status: "skipped", reason: "ship_missing_in_catalogue" });
        systemicError = systemicError || "ship_missing_in_catalogue";
        continue;
      }
      if (String(live.name) !== String(item.ship_name)) {
        skipRows.push({
          ...rowBase,
          status: "skipped",
          reason: `ship_name_mismatch_live=${live.name}`
        });
        systemicError = systemicError || "ship_name_mismatch";
        continue;
      }
      if (!hasHeroUrl(live.hero_image_url)) {
        skipRows.push({
          ...rowBase,
          status: "skipped",
          reason: "ship_missing_canonical_hero"
        });
        continue;
      }
      // Hero must remain the batch hero (or any existing) — never change it.
      if (
        heroMeta?.hero_public_url &&
        String(live.hero_image_url).trim() !== String(heroMeta.hero_public_url).trim()
      ) {
        // Still OK if live hero differs from batch record but exists — do not mutate.
        // Only skip if we somehow planned to replace; we never patch hero.
      }

      if (!fs.existsSync(item.absolute_path)) {
        skipRows.push({ ...rowBase, status: "skipped", reason: "source_file_missing" });
        continue;
      }

      let buffer;
      let inspected;
      try {
        inspectedCount += 1;
        if (inspectedCount === 1 || inspectedCount % 10 === 0) {
          console.log(`  Inspecting local files ${inspectedCount}/${totalToInspect}...`);
        }
        buffer = readLocalImageBuffer(item.absolute_path);
        inspected = inspectLocalShipGallery(item, buffer, { supabaseUrl: env.url });
      } catch (error) {
        skipRows.push({
          ...rowBase,
          status: "skipped",
          reason: error.code || error.message
        });
        continue;
      }

      if (inspected.media_library_values.is_default !== false) {
        systemicError = "gallery_row_would_be_default";
        skipRows.push({
          ...rowBase,
          status: "skipped",
          reason: "schema_guard_is_default_must_be_false"
        });
        continue;
      }

      const hashHit =
        mediaByShipHash.get(`${item.ship_id}::${inspected.content_hash}`) ||
        mediaByHash.get(inspected.content_hash);
      if (hashHit) {
        skipRows.push({
          ...rowBase,
          status: "skipped",
          reason: "media_library_content_hash_exists",
          media_library_id: hashHit.id,
          duplicate_check_result: "exact_hash_duplicate"
        });
        continue;
      }

      // Filename + dims + size similarity vs existing ship media
      let visualDup = null;
      for (const m of existing) {
        const proxy = {
          content_hash: m.content_hash,
          filename: m.original_filename || m.file_name,
          width: m.width,
          height: m.height,
          file_size_bytes: m.file_size_bytes,
          absolute_path: m.original_filename || m.file_name
        };
        const candidateProxy = {
          content_hash: inspected.content_hash,
          filename: inspected.filename,
          width: inspected.width,
          height: inspected.height,
          file_size_bytes: inspected.bytes,
          absolute_path: inspected.filename
        };
        if (isNearDuplicatePair(candidateProxy, proxy)) {
          visualDup = m;
          break;
        }
        if (
          filenameMatch(m.original_filename, inspected.filename) ||
          filenameMatch(m.file_name, inspected.filename)
        ) {
          if (
            m.width === inspected.width &&
            m.height === inspected.height &&
            Number(m.file_size_bytes) === inspected.bytes
          ) {
            visualDup = m;
            break;
          }
          // Uncertain filename collision with different size — skip
          skipRows.push({
            ...rowBase,
            status: "skipped",
            reason: "uncertain_filename_collision_with_existing_media",
            media_library_id: m.id,
            duplicate_check_result: "uncertain_skip"
          });
          visualDup = "uncertain";
          break;
        }
      }
      if (visualDup === "uncertain") continue;
      if (visualDup) {
        skipRows.push({
          ...rowBase,
          status: "skipped",
          reason: "visually_equivalent_existing_media",
          media_library_id: visualDup.id,
          duplicate_check_result: "near_duplicate_existing"
        });
        continue;
      }

      // Same as current hero URL / default hero media
      if (
        existingHeroMedia.some(
          (m) =>
            m.content_hash === inspected.content_hash ||
            m.public_url === live.hero_image_url
        ) &&
        (heroMeta?.hero_content_hash === inspected.content_hash ||
          existingHeroMedia.some((m) => m.content_hash === inspected.content_hash))
      ) {
        skipRows.push({
          ...rowBase,
          status: "skipped",
          reason: "matches_current_hero_media",
          duplicate_check_result: "hero_duplicate"
        });
        continue;
      }
      if (heroMeta?.hero_content_hash === inspected.content_hash) {
        skipRows.push({
          ...rowBase,
          status: "skipped",
          reason: "content_hash_matches_batch_hero",
          duplicate_check_result: "hero_duplicate"
        });
        continue;
      }

      const storageExists = await storageObjectExists(env, inspected.storage_path);
      if (storageExists) {
        skipRows.push({
          ...rowBase,
          status: "skipped",
          reason: "storage_object_already_exists",
          storage_path: inspected.storage_path,
          duplicate_check_result: "storage_exists"
        });
        continue;
      }

      dryRows.push({
        ...rowBase,
        status: "proposed_upload",
        dimensions: `${inspected.width}x${inspected.height}`,
        width: inspected.width,
        height: inspected.height,
        file_size_bytes: inspected.bytes,
        content_hash: inspected.content_hash,
        current_hero_url: live.hero_image_url,
        existing_gallery_count: existingGallery.length,
        proposed_storage_path: inspected.storage_path,
        proposed_public_url: inspected.proposed_public_url,
        proposed_media_library_association: {
          media_type: "ship",
          ship_id: item.ship_id,
          cruise_line_id: item.cruise_line_id,
          is_default: false,
          import_source: IMPORT_SOURCE_GALLERY_BATCH_1,
          title: inspected.media_library_values.title
        },
        proposed_display_order: inspected.display_order,
        duplicate_check_result: "clear",
        would_set_ship_hero: false,
        _buffer: buffer,
        _inspected: inspected,
        _live_hero: live.hero_image_url
      });
    }
  }

  const estBytes = dryRows.reduce((a, r) => a + (r.file_size_bytes || 0), 0);
  const eligibleShips = new Set(dryRows.map((r) => r.ship_id)).size;

  console.log(`\nDry-run eligible ships: ${eligibleShips}`);
  console.log(`Dry-run eligible images: ${dryRows.length}`);
  console.log(`Dry-run skipped: ${skipRows.length}`);
  console.log(`Estimated upload size: ${estBytes} bytes (${(estBytes / 1024 / 1024).toFixed(2)} MB)`);
  if (systemicError) {
    console.error(`\nSYSTEMIC GUARD: ${systemicError} — refusing writes`);
  }

  for (const r of dryRows) {
    console.log(
      `  PROPOSE ${r.cruise_line_name} | ${r.ship_name} | #${r.display_order} ${r.intended_gallery_role} | ${r.dimensions} | ${r.file_size_bytes}B`
    );
  }
  for (const r of skipRows) {
    console.log(`  SKIP ${r.ship_name}: ${r.reason}`);
  }

  const dryPayload = {
    generated_at: new Date().toISOString(),
    strict_ship_count: batch.ship_count,
    strict_image_count: batch.image_count,
    eligible_ships: eligibleShips,
    eligible_images: dryRows.length,
    skipped_images: skipRows.length,
    estimated_upload_bytes: estBytes,
    systemic_error: systemicError,
    eligible: dryRows.map(({ _buffer, _inspected, _live_hero, ...r }) => r),
    skipped: skipRows,
    per_ship: batch.per_ship,
    excluded_selection: batch.excluded.map((e) => ({
      ship_name: e.ship_name,
      reason: e.exclude_reason,
      absolute_path: e.absolute_path
    })),
    held_for_later_count: batch.held_for_later.length
  };
  writeJson(path.join(AUDIT_DIR, "gallery-upload-batch-1-dry-run.json"), dryPayload);

  if (systemicError) {
    console.error("Dry run recorded systemic error. No apply.");
    process.exit(1);
  }

  if (mode === "dry-run") {
    console.log("\nDry run complete. No writes performed.");
    return;
  }

  console.log("\n=== APPLY: uploading one ship at a time ===");
  const results = [];
  const rollback = [];
  let success = 0;
  let failed = 0;
  let uploadedBytes = 0;

  // Preserve ship order from dry rows
  const shipOrder = [];
  const seenShip = new Set();
  for (const row of dryRows) {
    if (!seenShip.has(row.ship_id)) {
      seenShip.add(row.ship_id);
      shipOrder.push(row.ship_id);
    }
  }

  for (const shipId of shipOrder) {
    const shipRows = dryRows.filter((r) => r.ship_id === shipId);
    const shipName = shipRows[0]?.ship_name;

    // Snapshot hero before any writes for this ship
    const { ok: shipOk, body: shipBody } = await supabaseRest(env, "GET", "ci_cruise_ships", {
      query: `?id=eq.${encodeURIComponent(shipId)}&select=id,name,hero_image_url&limit=1`
    });
    const liveShip = shipOk && Array.isArray(shipBody) ? shipBody[0] : null;
    const heroBefore = liveShip?.hero_image_url || null;

    for (const row of shipRows) {
      const inspected = row._inspected;
      const buffer = row._buffer;
      const entry = {
        ship_id: row.ship_id,
        ship_name: row.ship_name,
        cruise_line_id: row.cruise_line_id,
        cruise_line_name: row.cruise_line_name,
        source_pathname: row.source_pathname,
        filename: row.filename,
        dimensions: row.dimensions,
        file_size_bytes: row.file_size_bytes,
        content_hash: row.content_hash,
        display_order: row.display_order,
        intended_gallery_role: row.intended_gallery_role,
        status: "failed",
        reason: null,
        storage_created: false,
        media_library_id: null,
        is_default: false,
        hero_image_url_unchanged: true,
        unchanged_hero_url: heroBefore,
        storage_bucket: MEDIA_BUCKET,
        storage_path: inspected.storage_path,
        public_url: inspected.proposed_public_url,
        upload_timestamp: null,
        partial_objects: [],
        rollback_action: null
      };

      try {
        if (!liveShip) {
          entry.reason = "precheck_ship_missing";
          results.push(entry);
          failed += 1;
          continue;
        }
        if (!hasHeroUrl(liveShip.hero_image_url)) {
          entry.status = "skipped";
          entry.reason = "precheck_ship_missing_hero";
          results.push(entry);
          failed += 1;
          continue;
        }
        if (await storageObjectExists(env, inspected.storage_path)) {
          entry.status = "skipped";
          entry.reason = "precheck_storage_exists";
          results.push(entry);
          failed += 1;
          continue;
        }
        const { body: hashRows } = await supabaseRest(env, "GET", "media_library", {
          query: `?content_hash=eq.${encodeURIComponent(inspected.content_hash)}&select=id,ship_id&limit=5`
        });
        if (Array.isArray(hashRows) && hashRows.length) {
          entry.status = "skipped";
          entry.reason = "precheck_media_hash_exists";
          entry.media_library_id = hashRows[0].id;
          results.push(entry);
          failed += 1;
          continue;
        }

        await uploadObject(env, {
          path: inspected.storage_path,
          buffer,
          contentType: inspected.mime_type
        });
        entry.storage_created = true;
        entry.partial_objects.push(`storage:${inspected.storage_path}`);

        const urlOk = await verifyPublicUrl(inspected.proposed_public_url);
        if (!urlOk) {
          await deleteStorageObject(env, inspected.storage_path);
          entry.rollback_action = "deleted_storage_after_verify_fail";
          entry.storage_created = false;
          entry.partial_objects = [];
          entry.reason = "public_url_verify_failed";
          results.push(entry);
          failed += 1;
          continue;
        }

        const insert = await supabaseRest(env, "POST", "media_library", {
          body: inspected.media_library_values
        });
        if (!insert.ok || !Array.isArray(insert.body) || !insert.body[0]?.id) {
          await deleteStorageObject(env, inspected.storage_path);
          entry.rollback_action = "deleted_storage_after_media_insert_fail";
          entry.storage_created = false;
          entry.partial_objects = [];
          entry.reason = `media_insert_failed:${insert.status}:${insert.text?.slice?.(0, 200) || ""}`;
          results.push(entry);
          failed += 1;
          continue;
        }
        const mediaId = insert.body[0].id;
        const mediaRow = insert.body[0];
        entry.media_library_id = mediaId;
        entry.partial_objects.push(`media_library:${mediaId}`);

        if (mediaRow.is_default === true) {
          // Should never happen — rollback batch-created row only
          await supabaseRest(env, "DELETE", "media_library", {
            query: `?id=eq.${encodeURIComponent(mediaId)}`
          });
          await deleteStorageObject(env, inspected.storage_path);
          entry.rollback_action = "deleted_media_and_storage_after_default_true";
          entry.storage_created = false;
          entry.media_library_id = null;
          entry.partial_objects = [];
          entry.reason = "inserted_row_was_default_rolled_back";
          results.push(entry);
          failed += 1;
          continue;
        }

        // Read-back verification
        const { body: readMedia } = await supabaseRest(env, "GET", "media_library", {
          query: `?id=eq.${encodeURIComponent(mediaId)}&select=id,ship_id,is_default,import_source,public_url,content_hash,storage_path&limit=1`
        });
        const verified = Array.isArray(readMedia) ? readMedia[0] : null;
        if (
          !verified ||
          verified.ship_id !== shipId ||
          verified.is_default !== false ||
          verified.import_source !== IMPORT_SOURCE_GALLERY_BATCH_1
        ) {
          await supabaseRest(env, "DELETE", "media_library", {
            query: `?id=eq.${encodeURIComponent(mediaId)}`
          });
          await deleteStorageObject(env, inspected.storage_path);
          entry.rollback_action = "deleted_media_and_storage_after_readback_fail";
          entry.storage_created = false;
          entry.media_library_id = null;
          entry.partial_objects = [];
          entry.reason = "media_readback_failed";
          results.push(entry);
          failed += 1;
          continue;
        }

        if (!(await storageObjectExists(env, inspected.storage_path))) {
          await supabaseRest(env, "DELETE", "media_library", {
            query: `?id=eq.${encodeURIComponent(mediaId)}`
          });
          entry.rollback_action = "deleted_media_after_storage_missing";
          entry.storage_created = false;
          entry.media_library_id = null;
          entry.partial_objects = [];
          entry.reason = "storage_readback_failed";
          results.push(entry);
          failed += 1;
          continue;
        }

        // Confirm hero unchanged
        const { body: heroCheck } = await supabaseRest(env, "GET", "ci_cruise_ships", {
          query: `?id=eq.${encodeURIComponent(shipId)}&select=id,hero_image_url&limit=1`
        });
        const afterHero = Array.isArray(heroCheck) ? heroCheck[0]?.hero_image_url : null;
        if (String(afterHero || "") !== String(heroBefore || "")) {
          // Unexpected hero change — do not mutate further; record failure but leave
          // gallery row (it is valid non-default). Do not "fix" hero here.
          entry.hero_image_url_unchanged = false;
          entry.reason = "hero_url_changed_unexpectedly_manual_review";
          entry.status = "failed";
          results.push(entry);
          failed += 1;
          console.log(`  FAIL ${shipName}: hero unexpectedly changed`);
          continue;
        }

        entry.status = "success";
        entry.reason = null;
        entry.partial_objects = [];
        entry.rollback_action = null;
        entry.upload_timestamp = new Date().toISOString();
        entry.is_default = false;
        entry.unchanged_hero_url = afterHero;
        success += 1;
        uploadedBytes += inspected.bytes;
        rollback.push({
          ship_id: row.ship_id,
          ship_name: row.ship_name,
          cruise_line: row.cruise_line_name,
          storage_bucket: MEDIA_BUCKET,
          storage_path: inspected.storage_path,
          media_library_id: mediaId,
          content_hash: inspected.content_hash,
          display_order: row.display_order,
          upload_timestamp: entry.upload_timestamp,
          unchanged_hero_url: afterHero,
          source_pathname: row.source_pathname,
          note: "Delete only these batch-created objects to roll back this gallery image"
        });
        console.log(`  OK ${shipName} #${row.display_order}`);
      } catch (error) {
        entry.reason = error.message || String(error);
        if (entry.storage_created && !entry.media_library_id) {
          try {
            await deleteStorageObject(env, inspected.storage_path);
            entry.rollback_action = "deleted_storage_after_unexpected_error";
            entry.storage_created = false;
            entry.partial_objects = [];
          } catch {
            entry.rollback_action = "storage_cleanup_failed_manual_review";
          }
        } else if (entry.media_library_id && entry.storage_created) {
          try {
            await supabaseRest(env, "DELETE", "media_library", {
              query: `?id=eq.${encodeURIComponent(entry.media_library_id)}`
            });
            await deleteStorageObject(env, inspected.storage_path);
            entry.rollback_action = "deleted_media_and_storage_after_unexpected_error";
            entry.storage_created = false;
            entry.media_library_id = null;
            entry.partial_objects = [];
          } catch {
            entry.rollback_action = "partial_cleanup_failed_manual_review";
          }
        }
        results.push(entry);
        failed += 1;
        console.log(`  FAIL ${shipName}: ${entry.reason}`);
        continue;
      }

      results.push(entry);
    }
  }

  const resultsPath = path.join(AUDIT_DIR, "gallery-upload-batch-1-results.json");
  const resultsCsv = path.join(AUDIT_DIR, "gallery-upload-batch-1-results.csv");
  const rollbackPath = path.join(AUDIT_DIR, "gallery-upload-batch-1-rollback.json");

  const successRows = results.filter((r) => r.status === "success");
  writeJson(resultsPath, {
    generated_at: new Date().toISOString(),
    mode: "apply",
    strict_ship_count: batch.ship_count,
    strict_image_count: batch.image_count,
    success_count: success,
    failed_or_skipped_count: failed,
    uploaded_bytes: uploadedBytes,
    storage_objects_created: successRows.length,
    media_library_rows_created: successRows.length,
    all_gallery_rows_non_default: successRows.every((r) => r.is_default === false),
    all_heroes_unchanged: successRows.every((r) => r.hero_image_url_unchanged === true),
    results,
    skipped_dry_run: skipRows
  });

  writeText(
    resultsCsv,
    toCsv(results, [
      "ship_id",
      "ship_name",
      "cruise_line_name",
      "source_pathname",
      "storage_bucket",
      "storage_path",
      "media_library_id",
      "content_hash",
      "display_order",
      "upload_timestamp",
      "unchanged_hero_url",
      "status",
      "reason",
      "is_default",
      "file_size_bytes"
    ])
  );

  writeJson(rollbackPath, {
    generated_at: new Date().toISOString(),
    import_source: IMPORT_SOURCE_GALLERY_BATCH_1,
    note: "Roll back by deleting only listed media_library ids and storage paths. Do not touch heroes.",
    items: rollback
  });

  console.log(`\nSuccess: ${success}`);
  console.log(`Failed/skipped during apply: ${failed}`);
  console.log(`Uploaded bytes: ${uploadedBytes}`);
  console.log(`Results: ${resultsPath}`);
  console.log(`Rollback: ${rollbackPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
