#!/usr/bin/env node
/**
 * Controlled production upload — external Brand Imaging ship heroes batch 1.
 *
 * Dry run:
 *   node scripts/upload-external-ship-heroes-batch-1.mjs \
 *     --dry-run --target=production \
 *     --confirm=UPLOAD-EXTERNAL-SHIP-HEROES-BATCH-1
 *
 * Apply:
 *   node scripts/upload-external-ship-heroes-batch-1.mjs \
 *     --apply --target=production \
 *     --confirm=UPLOAD-EXTERNAL-SHIP-HEROES-BATCH-1
 *
 * Never uploads galleries, line Hero Images, or room images.
 * Never overwrites an existing canonical hero.
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
  CONFIRM_TOKEN,
  IMPORT_SOURCE,
  buildStrictHeroBatch,
  inspectLocalShipHero,
  readLocalImageBuffer,
  toCsv
} from "./lib/local-ship-image-audit/hero-batch-upload.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const AUDIT_DIR = path.join(ROOT, "tmp", "ship-image-audit-external");
const PLAN_PATH = path.join(AUDIT_DIR, "proposed-upload-plan.json");

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
    const { ok, body, text, status } = await supabaseRest(
      env,
      "GET",
      table,
      {
        query: `?select=${encodeURIComponent(select)}&order=id.asc&limit=${pageSize}&offset=${offset}`
      }
    );
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
  const response = await fetch(
    `${env.url}/storage/v1/object/${MEDIA_BUCKET}`,
    {
      method: "DELETE",
      headers: {
        apikey: env.key,
        Authorization: `Bearer ${env.key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ prefixes: [storagePath] })
    }
  );
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

function hasHeroUrl(url) {
  return Boolean(url && String(url).trim());
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
  if (confirm !== CONFIRM_TOKEN) {
    console.error(`REFUSED: require --confirm=${CONFIRM_TOKEN}`);
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

  if (!fs.existsSync(PLAN_PATH)) {
    console.error(`REFUSED: missing audit plan ${PLAN_PATH}`);
    process.exit(2);
  }

  const plan = JSON.parse(fs.readFileSync(PLAN_PATH, "utf8"));
  const batch = buildStrictHeroBatch(plan.new_ship_heroes?.items || []);

  console.log("\n=== External ship hero upload — batch 1 ===");
  console.log(formatTargetBanner(env, mode));
  console.log(`Import source: ${IMPORT_SOURCE}`);
  console.log(`STRICT BATCH COUNT (before writes): ${batch.count}`);
  console.log(`Excluded from plan: ${batch.excluded.length}`);
  console.log("Scope: ship heroes only (no galleries / line heroes / rooms)");

  writeJson(path.join(AUDIT_DIR, "hero-upload-batch-1-proposed.json"), {
    generated_at: new Date().toISOString(),
    count: batch.count,
    items: batch.approved,
    excluded: batch.excluded.map((e) => ({
      ship_name: e.ship_name,
      cruise_line_name: e.cruise_line_name,
      reason: e.exclude_reason,
      absolute_path: e.absolute_path
    }))
  });

  console.log("\nLoading live catalogue + media_library (GET)...");
  const [ships, media] = await Promise.all([
    listAll(env, "ci_cruise_ships", "id,name,cruise_line_id,hero_image_url"),
    listAll(
      env,
      "media_library",
      "id,title,file_name,original_filename,media_type,width,height,file_size_bytes,ship_id,cruise_line_id,is_default,is_active,storage_path,public_url,content_hash"
    )
  ]);
  const shipsById = new Map(ships.map((s) => [s.id, s]));
  const mediaByShipHash = new Map();
  const mediaByHash = new Map();
  for (const m of media) {
    if (m.content_hash) {
      mediaByHash.set(m.content_hash, m);
      if (m.ship_id) mediaByShipHash.set(`${m.ship_id}::${m.content_hash}`, m);
    }
  }

  const dryRows = [];
  const skipRows = [];

  for (const item of batch.approved) {
    const live = shipsById.get(item.ship_id);
    const rowBase = {
      ship_id: item.ship_id,
      ship_name: item.ship_name,
      cruise_line_id: item.cruise_line_id,
      cruise_line_name: item.cruise_line_name,
      source_pathname: item.absolute_path,
      filename: path.basename(item.absolute_path)
    };

    if (!live) {
      skipRows.push({ ...rowBase, status: "skipped", reason: "ship_missing_in_catalogue" });
      continue;
    }
    if (String(live.name) !== String(item.ship_name)) {
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
    if (!fs.existsSync(item.absolute_path)) {
      skipRows.push({ ...rowBase, status: "skipped", reason: "source_file_missing" });
      continue;
    }

    let buffer;
    let inspected;
    try {
      buffer = readLocalImageBuffer(item.absolute_path);
      inspected = inspectLocalShipHero(item, buffer, { supabaseUrl: env.url });
    } catch (error) {
      skipRows.push({
        ...rowBase,
        status: "skipped",
        reason: error.code || error.message
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
        media_library_id: hashHit.id
      });
      continue;
    }

    const storageExists = await storageObjectExists(env, inspected.storage_path);
    if (storageExists) {
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
      proposed_media_library_association: {
        media_type: "ship",
        ship_id: item.ship_id,
        cruise_line_id: item.cruise_line_id,
        is_default: true
      },
      would_set_ship_hero: true,
      _buffer: buffer,
      _inspected: inspected,
      _previous_hero: live.hero_image_url || null
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
    console.log(`  SKIP ${r.ship_name}: ${r.reason}`);
  }

  writeJson(path.join(AUDIT_DIR, "hero-upload-batch-1-dry-run.json"), {
    generated_at: new Date().toISOString(),
    strict_batch_count: batch.count,
    eligible: dryRows.map(({ _buffer, _inspected, ...r }) => r),
    skipped: skipRows
  });

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
      partial_objects: [],
      rollback_action: null
    };

    try {
      // Immediate pre-upload revalidation
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
      entry.media_library_id = mediaId;
      entry.partial_objects.push(`media_library:${mediaId}`);

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
        // rollback media + storage; do not leave orphan default hero media without ship field
        await supabaseRest(env, "DELETE", "media_library", {
          query: `?id=eq.${encodeURIComponent(mediaId)}`
        });
        await deleteStorageObject(env, inspected.storage_path);
        entry.rollback_action = "deleted_media_and_storage_after_ship_patch_fail";
        entry.storage_created = false;
        entry.media_library_id = null;
        entry.partial_objects = [];
        entry.reason = `ship_patch_failed:${patchError.message}`;
        results.push(entry);
        failed += 1;
        continue;
      }

      entry.status = "success";
      entry.ship_hero_updated = true;
      entry.new_hero_value = inspected.proposed_public_url;
      entry.reason = null;
      entry.partial_objects = [];
      entry.rollback_action = null;
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
      }
      results.push(entry);
      failed += 1;
      console.log(`  FAIL ${row.ship_name}: ${entry.reason}`);
      continue;
    }

    results.push(entry);
  }

  const resultsPath = path.join(AUDIT_DIR, "hero-upload-batch-1-results.json");
  const resultsCsv = path.join(AUDIT_DIR, "hero-upload-batch-1-results.csv");
  const rollbackPath = path.join(AUDIT_DIR, "hero-upload-batch-1-rollback.json");

  writeJson(resultsPath, {
    generated_at: new Date().toISOString(),
    mode: "apply",
    strict_batch_count: batch.count,
    eligible_count: dryRows.length,
    success_count: success,
    failed_or_skipped_count: failed + skipRows.length,
    uploaded_bytes: uploadedBytes,
    results,
    pre_upload_skips: skipRows
  });
  writeText(
    resultsCsv,
    toCsv(
      [...results, ...skipRows.map((s) => ({ ...s, status: s.status || "skipped" }))],
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
    import_source: IMPORT_SOURCE,
    successful_uploads: rollback
  });

  console.log("\n=== Apply summary ===");
  console.log(`Success: ${success}`);
  console.log(`Failed/skipped during apply: ${failed}`);
  console.log(`Pre-upload skips: ${skipRows.length}`);
  console.log(`Uploaded bytes: ${uploadedBytes}`);
  console.log(`Results: ${resultsPath}`);
  console.log(`Rollback: ${rollbackPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
