#!/usr/bin/env node
/**
 * Batch 2 — upload Steve-approved ship heroes from steve-hero-selections.json.
 *
 * Dry run:
 *   node scripts/upload-external-ship-heroes-batch-2.mjs \
 *     --dry-run --target=production \
 *     --confirm=UPLOAD-EXTERNAL-SHIP-HEROES-BATCH-2
 *
 * Apply:
 *   node scripts/upload-external-ship-heroes-batch-2.mjs \
 *     --apply --target=production \
 *     --confirm=UPLOAD-EXTERNAL-SHIP-HEROES-BATCH-2
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
import { verifiedCiFieldWrite } from "./lib/squarespace-ci-media/verified-ci-patch.js";
import {
  CONFIRM_TOKEN_BATCH_2,
  IMPORT_SOURCE_BATCH_2,
  inspectLocalShipHero,
  readLocalImageBuffer,
  toCsv
} from "./lib/local-ship-image-audit/hero-batch-upload.js";
import { validateSteveHeroSelections } from "./lib/local-ship-image-audit/steve-selection-validate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const AUDIT_DIR = path.join(ROOT, "tmp", "ship-image-audit-external");
const SELECTIONS_PATH = path.join(AUDIT_DIR, "steve-hero-selections.json");

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

function hasHeroUrl(url) {
  return Boolean(url && String(url).trim());
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
    const response = await fetch(
      `${env.url}/storage/v1/object/info/${MEDIA_BUCKET}/${encoded}`,
      {
        method: "GET",
        headers: {
          apikey: env.key,
          Authorization: `Bearer ${env.key}`
        }
      }
    );
    if (response.ok) return true;
  } catch {
    /* fall through */
  }
  try {
    const pub = `${env.url}/storage/v1/object/public/${MEDIA_BUCKET}/${encoded}`;
    const head = await fetch(pub, { method: "HEAD", redirect: "follow" });
    if (head.ok) return true;
    const get = await fetch(pub, { method: "GET", redirect: "follow" });
    return get.ok;
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
  if (confirm !== CONFIRM_TOKEN_BATCH_2) {
    console.error(`REFUSED: require --confirm=${CONFIRM_TOKEN_BATCH_2}`);
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

  if (!fs.existsSync(SELECTIONS_PATH)) {
    console.error(`REFUSED: missing ${SELECTIONS_PATH}`);
    process.exit(2);
  }

  const exportPayload = JSON.parse(fs.readFileSync(SELECTIONS_PATH, "utf8"));
  const validation = validateSteveHeroSelections(exportPayload);

  console.log("\n=== Batch 2 — Steve approved ship heroes ===");
  console.log(formatTargetBanner(env, mode));
  console.log(`Import source: ${IMPORT_SOURCE_BATCH_2}`);
  console.log(`Ships in export: ${validation.ship_count}`);
  console.log(`Approved: ${validation.approved.length}`);
  console.log(`No suitable image: ${validation.no_suitable_image.length}`);
  console.log(`Investigate: ${validation.investigate.length}`);
  console.log(`Invalid/incomplete: ${validation.invalid_or_incomplete.length}`);
  console.log(`Eligible after file validation: ${validation.eligible_approved.length}`);

  writeJson(path.join(AUDIT_DIR, "hero-upload-batch-2-validation.json"), {
    generated_at: new Date().toISOString(),
    ...validation,
    eligible_approved: validation.eligible_approved.map((s) => ({
      ship_id: s.ship_id,
      ship_name: s.ship_name,
      cruise_line: s.cruise_line,
      selected_filename: s.selected_filename,
      selected_source_pathname: s.selected_source_pathname,
      live_width: s.live_width,
      live_height: s.live_height,
      live_file_size_bytes: s.live_file_size_bytes,
      live_content_hash: s.live_content_hash
    }))
  });

  if (validation.blocked) {
    console.error("\nREFUSED: validation blocked production writes");
    for (const r of validation.block_reasons) console.error(`  - ${r}`);
    process.exit(2);
  }

  const dryRows = [];
  const skipRows = [];

  for (const ship of validation.eligible_approved) {
    const item = {
      ship_id: ship.ship_id,
      ship_name: ship.ship_name,
      cruise_line_id: ship.cruise_line_id,
      cruise_line_name: ship.cruise_line,
      absolute_path: ship.selected_source_pathname
    };
    const rowBase = {
      ship_id: ship.ship_id,
      ship_name: ship.ship_name,
      cruise_line_id: ship.cruise_line_id,
      cruise_line_name: ship.cruise_line,
      source_pathname: ship.selected_source_pathname,
      filename: ship.selected_filename
    };

    const { ok, body } = await supabaseRest(env, "GET", "ci_cruise_ships", {
      query: `?id=eq.${encodeURIComponent(ship.ship_id)}&select=id,name,cruise_line_id,hero_image_url&limit=1`
    });
    const live = ok && Array.isArray(body) ? body[0] : null;
    if (!live) {
      skipRows.push({ ...rowBase, status: "skipped", reason: "ship_missing_in_catalogue" });
      continue;
    }
    if (String(live.name) !== String(ship.ship_name)) {
      skipRows.push({
        ...rowBase,
        status: "skipped",
        reason: `ship_name_mismatch_live=${live.name}`
      });
      continue;
    }
    if (hasHeroUrl(live.hero_image_url)) {
      skipRows.push({
        ...rowBase,
        status: "skipped",
        reason: "ship_now_has_canonical_hero",
        existing_hero: live.hero_image_url
      });
      continue;
    }

    let buffer;
    let inspected;
    try {
      buffer = readLocalImageBuffer(ship.selected_source_pathname);
      inspected = inspectLocalShipHero(item, buffer, { supabaseUrl: env.url });
      inspected.media_library_values.import_source = IMPORT_SOURCE_BATCH_2;
      inspected.media_library_values.tags = [
        "ship_hero",
        "external_brand_imaging",
        "batch_2",
        "steve_selected"
      ];
    } catch (error) {
      skipRows.push({
        ...rowBase,
        status: "skipped",
        reason: error.code || error.message
      });
      continue;
    }

    const { body: hashRows } = await supabaseRest(env, "GET", "media_library", {
      query: `?content_hash=eq.${encodeURIComponent(inspected.content_hash)}&select=id,ship_id,import_source&limit=5`
    });
    if (Array.isArray(hashRows) && hashRows.length) {
      skipRows.push({
        ...rowBase,
        status: "skipped",
        reason: "media_library_content_hash_exists",
        media_library_id: hashRows[0].id
      });
      continue;
    }
    if (await storageObjectExists(env, inspected.storage_path)) {
      skipRows.push({
        ...rowBase,
        status: "skipped",
        reason: "storage_object_already_exists",
        storage_path: inspected.storage_path
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
      existing_hero_state: "none",
      proposed_storage_path: inspected.storage_path,
      proposed_public_url: inspected.proposed_public_url,
      proposed_media_library: {
        media_type: "ship",
        is_default: true,
        import_source: IMPORT_SOURCE_BATCH_2,
        ship_id: ship.ship_id
      },
      would_set_ship_hero: true,
      _buffer: buffer,
      _inspected: inspected,
      _previous_hero: live.hero_image_url || null
    });
  }

  // Also record non-upload decisions as skips for results completeness
  for (const s of validation.no_suitable_image) {
    skipRows.push({
      ship_id: s.ship_id,
      ship_name: s.ship_name,
      cruise_line_name: s.cruise_line,
      status: "skipped",
      reason: "decision_no_suitable_image"
    });
  }
  for (const s of validation.investigate) {
    skipRows.push({
      ship_id: s.ship_id,
      ship_name: s.ship_name,
      cruise_line_name: s.cruise_line,
      status: "skipped",
      reason: "decision_investigate"
    });
  }

  console.log(`\nDry-run eligible: ${dryRows.length}`);
  console.log(`Dry-run skipped: ${skipRows.length}`);
  for (const r of dryRows) {
    console.log(
      `  PROPOSE ${r.cruise_line_name} | ${r.ship_name} | ${r.dimensions} | ${r.file_size_bytes}B | ${r.proposed_storage_path}`
    );
  }
  for (const r of skipRows) {
    if (!String(r.reason).startsWith("decision_")) {
      console.log(`  SKIP ${r.ship_name}: ${r.reason}`);
    }
  }

  writeJson(path.join(AUDIT_DIR, "hero-upload-batch-2-dry-run.json"), {
    generated_at: new Date().toISOString(),
    eligible_count: dryRows.length,
    eligible: dryRows.map(({ _buffer, _inspected, ...r }) => r),
    skipped: skipRows
  });

  if (mode === "dry-run") {
    console.log("\nDry run complete. No writes performed.");
    return;
  }

  console.log("\n=== APPLY batch 2 ===");
  const results = [];
  const rollback = [];
  let success = 0;
  let failed = 0;
  let uploadedBytes = 0;

  for (const row of dryRows) {
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
      status: "failed",
      reason: null,
      storage_created: false,
      media_library_id: null,
      ship_hero_updated: false,
      previous_hero_value: row._previous_hero,
      new_hero_value: null,
      storage_path: inspected.storage_path,
      public_url: inspected.proposed_public_url,
      rollback_action: null
    };

    try {
      const { ok, body } = await supabaseRest(env, "GET", "ci_cruise_ships", {
        query: `?id=eq.${encodeURIComponent(row.ship_id)}&select=id,name,hero_image_url&limit=1`
      });
      const live = ok && Array.isArray(body) ? body[0] : null;
      if (!live) {
        entry.reason = "precheck_ship_missing";
        results.push(entry);
        failed += 1;
        continue;
      }
      if (hasHeroUrl(live.hero_image_url)) {
        entry.status = "skipped";
        entry.reason = "precheck_ship_now_has_hero";
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
        query: `?content_hash=eq.${encodeURIComponent(inspected.content_hash)}&select=id&limit=5`
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

      if (!(await verifyPublicUrl(inspected.proposed_public_url))) {
        await deleteStorageObject(env, inspected.storage_path);
        entry.rollback_action = "deleted_storage_after_verify_fail";
        entry.storage_created = false;
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
        entry.reason = `media_insert_failed:${insert.status}`;
        results.push(entry);
        failed += 1;
        continue;
      }
      const mediaId = insert.body[0].id;
      entry.media_library_id = mediaId;

      try {
        await verifiedCiFieldWrite({
          table: "ci_cruise_ships",
          id: row.ship_id,
          field: "hero_image_url",
          value: inspected.proposed_public_url,
          patchRow: async ({ table, id, field, value }) => {
            const res = await supabaseRest(env, "PATCH", table, {
              query: `?id=eq.${encodeURIComponent(id)}`,
              body: { [field]: value }
            });
            return { status: res.status, body: res.body };
          },
          readRow: async ({ table, id, field }) => {
            const res = await supabaseRest(env, "GET", table, {
              query: `?id=eq.${encodeURIComponent(id)}&select=id,${field}&limit=1`
            });
            return Array.isArray(res.body) ? res.body[0] || null : null;
          }
        });
      } catch (patchError) {
        await supabaseRest(env, "DELETE", "media_library", {
          query: `?id=eq.${encodeURIComponent(mediaId)}`
        });
        await deleteStorageObject(env, inspected.storage_path);
        entry.rollback_action = "deleted_media_and_storage_after_ship_patch_fail";
        entry.storage_created = false;
        entry.media_library_id = null;
        entry.reason = `ship_patch_failed:${patchError.message}`;
        results.push(entry);
        failed += 1;
        continue;
      }

      entry.status = "success";
      entry.ship_hero_updated = true;
      entry.new_hero_value = inspected.proposed_public_url;
      success += 1;
      uploadedBytes += inspected.bytes;
      rollback.push({
        ship_id: row.ship_id,
        ship_name: row.ship_name,
        cruise_line: row.cruise_line_name,
        storage_bucket: MEDIA_BUCKET,
        storage_path: inspected.storage_path,
        media_library_id: mediaId,
        previous_hero_value: row._previous_hero,
        new_hero_value: inspected.proposed_public_url,
        upload_timestamp: new Date().toISOString(),
        source_pathname: row.source_pathname,
        content_hash: inspected.content_hash
      });
      console.log(`  OK ${row.ship_name}`);
      results.push(entry);
    } catch (error) {
      entry.reason = error.message || String(error);
      if (entry.storage_created && !entry.media_library_id) {
        try {
          await deleteStorageObject(env, inspected.storage_path);
          entry.rollback_action = "deleted_storage_after_unexpected_error";
          entry.storage_created = false;
        } catch {
          entry.rollback_action = "storage_cleanup_failed_manual_review";
        }
      }
      results.push(entry);
      failed += 1;
      console.log(`  FAIL ${row.ship_name}: ${entry.reason}`);
    }
  }

  const resultsPath = path.join(AUDIT_DIR, "hero-upload-batch-2-results.json");
  const resultsCsv = path.join(AUDIT_DIR, "hero-upload-batch-2-results.csv");
  const rollbackPath = path.join(AUDIT_DIR, "hero-upload-batch-2-rollback.json");

  writeJson(resultsPath, {
    generated_at: new Date().toISOString(),
    mode: "apply",
    approved_count: validation.approved.length,
    no_suitable_count: validation.no_suitable_image.length,
    investigate_count: validation.investigate.length,
    invalid_count: validation.invalid_or_incomplete.length,
    eligible_count: dryRows.length,
    success_count: success,
    failed_count: failed,
    uploaded_bytes: uploadedBytes,
    results,
    skipped: skipRows
  });
  writeText(
    resultsCsv,
    toCsv(
      [...results, ...skipRows],
      [
        "status",
        "ship_id",
        "ship_name",
        "cruise_line_name",
        "filename",
        "dimensions",
        "file_size_bytes",
        "content_hash",
        "storage_path",
        "media_library_id",
        "ship_hero_updated",
        "previous_hero_value",
        "new_hero_value",
        "reason",
        "rollback_action",
        "source_pathname"
      ]
    )
  );
  writeJson(rollbackPath, {
    generated_at: new Date().toISOString(),
    import_source: IMPORT_SOURCE_BATCH_2,
    successful_uploads: rollback
  });

  console.log("\n=== Apply summary ===");
  console.log(`Success: ${success}`);
  console.log(`Failed/skipped during apply: ${failed}`);
  console.log(`Uploaded bytes: ${uploadedBytes}`);
  console.log(`Results: ${resultsPath}`);
  console.log(`Rollback: ${rollbackPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
