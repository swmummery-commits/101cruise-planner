#!/usr/bin/env node
/**
 * Guarded cleanup: delete ONE superseded Royal Caribbean logo Media Library row.
 *
 * Does NOT delete Storage objects.
 * Does NOT update ci_cruise_lines / ci_cruise_ships.
 *
 *   node scripts/cleanup-royal-caribbean-logo-duplicate.mjs \
 *     --target=production \
 *     --delete-media-row \
 *     --record-id=ba55f15e-eb84-4c4c-a489-d16663ad4917 \
 *     --confirm=DELETE-SUPERSEDED-RC-LOGO
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
  RC_LINE_ID,
  RC_LINE_NAME,
  RC_CANONICAL_MEDIA_ID,
  RC_SUPERSEDED_MEDIA_ID,
  RC_CANONICAL_LOGO_URL,
  RC_SUPERSEDED_STORAGE_PATH,
  RC_CONFIRM_TOKEN,
  ICON_OF_THE_SEAS_MEDIA_ID,
  assertRcLogoCleanupCliGate,
  assertRcLogoCleanupPreDelete,
  assertExactOneDeletedRow,
  assertRcLogoCleanupPostDelete,
  summariseRcLogoCleanupWrites,
  assertRcCleanupWriteBanner
} from "./lib/media-coverage-audit/royal-caribbean-logo-cleanup-gate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "tmp", "media-coverage-audit");

const MEDIA_SELECT =
  "id,title,media_type,cruise_line_id,ship_id,public_url,source_url,storage_bucket,storage_path,original_filename,import_source,content_hash,created_at,updated_at,mime_type,is_active,is_default";

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

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function supabaseRest(env, method, tablePath, { query = "", body, headers = {} } = {}) {
  const m = String(method || "").toUpperCase();
  if (m !== "GET" && m !== "DELETE" && m !== "HEAD") {
    throw Object.assign(
      new Error(`REFUSED: cleanup HTTP method ${m} not allowed`),
      { code: "rc_cleanup_http_forbidden" }
    );
  }
  if (m === "GET" || m === "HEAD") assertAuditHttpMethod(m);

  const response = await fetch(`${env.url}/rest/v1/${tablePath}${query}`, {
    method: m,
    headers: {
      apikey: env.key,
      Authorization: `Bearer ${env.key}`,
      "Content-Type": "application/json",
      Prefer: m === "DELETE" ? "return=representation" : "count=exact",
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

async function supabaseGet(env, table, query) {
  const { ok, status, body, text } = await supabaseRest(env, "GET", table, { query });
  if (!ok) throw new Error((body && body.message) || `Supabase HTTP ${status}: ${text}`);
  return body;
}

async function urlReachable(url) {
  if (!url) return false;
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

async function storageObjectExists(env, storagePath) {
  if (!storagePath) return false;
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
        headers: { apikey: env.key, Authorization: `Bearer ${env.key}` }
      }
    );
    if (info.ok) return true;
  } catch {
    /* continue */
  }
  assertAuditHttpMethod("HEAD");
  try {
    const head = await fetch(`${env.url}/storage/v1/object/${MEDIA_BUCKET}/${encoded}`, {
      method: "HEAD",
      headers: { apikey: env.key, Authorization: `Bearer ${env.key}` }
    });
    return head.ok;
  } catch {
    return false;
  }
}

async function main() {
  // Abort before network / env if CLI args wrong.
  const target = parseTargetArg(process.argv);
  const deleteMediaRow = hasFlag("--delete-media-row");
  const recordId = parseArg("record-id");
  const confirmToken = parseArg("confirm");

  try {
    assertRcLogoCleanupCliGate({
      target,
      deleteMediaRow,
      recordId,
      confirmToken
    });
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  loadEnvFile();

  let env;
  try {
    env = resolveMigrationTarget({
      target: "production",
      mode: "delete-media-row",
      env: process.env
    });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  if (env.project_ref !== PRODUCTION_REF || env.target !== "production") {
    console.error("REFUSED: cleanup may only use the Original project.");
    process.exit(2);
  }

  console.log("\n=== Royal Caribbean superseded logo cleanup ===");
  const banner = formatTargetBanner(env, "delete-media-row");
  assertRcCleanupWriteBanner(banner);
  console.log(banner);
  console.log(`Confirm: ${RC_CONFIRM_TOKEN}`);
  console.log(`Delete Media Library row ONLY: ${RC_SUPERSEDED_MEDIA_ID}`);
  console.log("Storage objects: NOT deleted\n");

  const lines = await supabaseGet(
    env,
    "ci_cruise_lines",
    `?id=eq.${encodeURIComponent(RC_LINE_ID)}&select=id,name,logo_url,active`
  );
  const line = Array.isArray(lines) ? lines[0] : null;

  const canonicalRows = await supabaseGet(
    env,
    "media_library",
    `?id=eq.${encodeURIComponent(RC_CANONICAL_MEDIA_ID)}&select=${MEDIA_SELECT}`
  );
  const canonicalMedia = Array.isArray(canonicalRows) ? canonicalRows[0] : null;

  const supersededRows = await supabaseGet(
    env,
    "media_library",
    `?id=eq.${encodeURIComponent(RC_SUPERSEDED_MEDIA_ID)}&select=${MEDIA_SELECT}`
  );
  const supersededMedia = Array.isArray(supersededRows) ? supersededRows[0] : null;

  const sharing = await supabaseGet(
    env,
    "media_library",
    `?storage_path=eq.${encodeURIComponent(RC_SUPERSEDED_STORAGE_PATH)}&select=${MEDIA_SELECT}`
  );

  const supersededUrl = supersededMedia?.public_url || "";
  const linesRef = supersededUrl
    ? await supabaseGet(
        env,
        "ci_cruise_lines",
        `?logo_url=eq.${encodeURIComponent(supersededUrl)}&select=id,name,logo_url`
      )
    : [];
  const shipsRef = supersededUrl
    ? await supabaseGet(
        env,
        "ci_cruise_ships",
        `?hero_image_url=eq.${encodeURIComponent(supersededUrl)}&select=id,name,cruise_line_id,hero_image_url`
      )
    : [];

  const iconRows = await supabaseGet(
    env,
    "media_library",
    `?id=eq.${encodeURIComponent(ICON_OF_THE_SEAS_MEDIA_ID)}&select=${MEDIA_SELECT}`
  );
  const iconMedia = Array.isArray(iconRows) ? iconRows[0] : null;

  const canonicalReachable = await urlReachable(RC_CANONICAL_LOGO_URL);

  try {
    assertRcLogoCleanupPreDelete({
      line,
      canonicalMedia,
      supersededMedia,
      otherRowsSharingStoragePath: sharing || [],
      linesReferencingSupersededUrl: linesRef || [],
      shipsReferencingSupersededUrl: shipsRef || [],
      iconMedia,
      canonicalUrlReachable: canonicalReachable
    });
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  if (String(line.name).trim() !== RC_LINE_NAME) {
    console.error(`REFUSED: unexpected line name ${line.name}`);
    process.exit(2);
  }

  const stamp = Date.now();
  const rollbackPath = path.join(
    OUT_DIR,
    `royal-caribbean-superseded-logo-rollback-${stamp}.json`
  );
  writeJson(rollbackPath, {
    purpose: "manual reinsert only — not auto-applied",
    created_at: new Date().toISOString(),
    project_ref: env.project_ref,
    cruise_line_id: RC_LINE_ID,
    cruise_line_name: RC_LINE_NAME,
    keep_media_library_id: RC_CANONICAL_MEDIA_ID,
    delete_media_library_id: RC_SUPERSEDED_MEDIA_ID,
    canonical_logo_url: RC_CANONICAL_LOGO_URL,
    superseded_storage_path: RC_SUPERSEDED_STORAGE_PATH,
    storage_delete: false,
    full_superseded_media_library_row: supersededMedia
  });
  console.log(`Rollback record written (before DELETE):\n  ${rollbackPath}`);

  const del = await supabaseRest(env, "DELETE", "media_library", {
    query: `?id=eq.${encodeURIComponent(RC_SUPERSEDED_MEDIA_ID)}`,
    headers: { Prefer: "return=representation" }
  });
  if (!del.ok) {
    console.error(`REFUSED: DELETE HTTP ${del.status}: ${del.text}`);
    process.exit(1);
  }

  let deleted;
  try {
    deleted = assertExactOneDeletedRow(del.body, RC_SUPERSEDED_MEDIA_ID);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const afterSuperseded = await supabaseGet(
    env,
    "media_library",
    `?id=eq.${encodeURIComponent(RC_SUPERSEDED_MEDIA_ID)}&select=id`
  );
  const afterCanonical = await supabaseGet(
    env,
    "media_library",
    `?id=eq.${encodeURIComponent(RC_CANONICAL_MEDIA_ID)}&select=${MEDIA_SELECT}`
  );
  const afterLine = await supabaseGet(
    env,
    "ci_cruise_lines",
    `?id=eq.${encodeURIComponent(RC_LINE_ID)}&select=id,name,logo_url`
  );
  const afterIcon = await supabaseGet(
    env,
    "media_library",
    `?id=eq.${encodeURIComponent(ICON_OF_THE_SEAS_MEDIA_ID)}&select=id,ship_id,public_url`
  );

  const storageStill = await storageObjectExists(env, RC_SUPERSEDED_STORAGE_PATH);
  const reachableAfter = await urlReachable(RC_CANONICAL_LOGO_URL);

  try {
    assertRcLogoCleanupPostDelete({
      supersededAfter: Array.isArray(afterSuperseded) && afterSuperseded[0] ? afterSuperseded[0] : null,
      canonicalAfter: Array.isArray(afterCanonical) ? afterCanonical[0] : null,
      lineAfter: Array.isArray(afterLine) ? afterLine[0] : null,
      supersededStorageExists: storageStill,
      canonicalUrlReachable: reachableAfter,
      iconMediaAfter: Array.isArray(afterIcon) ? afterIcon[0] : null
    });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const writes = summariseRcLogoCleanupWrites({ mediaLibraryDeletes: 1 });
  const reportPath = path.join(
    OUT_DIR,
    `royal-caribbean-superseded-logo-cleanup-${stamp}.json`
  );
  writeJson(reportPath, {
    mode: "delete-media-row",
    target: "production",
    project_ref: env.project_ref,
    finished_at: new Date().toISOString(),
    deleted_media_library_id: deleted.deleted_id,
    deleted_row: deleted.deleted_row,
    kept_media_library_id: RC_CANONICAL_MEDIA_ID,
    logo_url_unchanged: RC_CANONICAL_LOGO_URL,
    storage_deleted: false,
    superseded_storage_still_exists: storageStill,
    icon_of_the_seas_untouched: true,
    icon_media_id: ICON_OF_THE_SEAS_MEDIA_ID,
    rollback_path: rollbackPath,
    writes,
    write_banner: "gated Original-project Media Library delete only"
  });

  console.log("\nCleanup complete (Media Library row only).");
  console.log(`Deleted: ${deleted.deleted_id}`);
  console.log(`Canonical Media Library kept: ${RC_CANONICAL_MEDIA_ID}`);
  console.log(`logo_url unchanged: ${RC_CANONICAL_LOGO_URL}`);
  console.log(`Superseded Storage still exists: ${storageStill}`);
  console.log(`Icon of the Seas untouched: ${ICON_OF_THE_SEAS_MEDIA_ID}`);
  console.log(`media_library deletes: ${writes.media_library_deletes}`);
  console.log(`database inserts: ${writes.database_inserts}`);
  console.log(`database updates: ${writes.database_updates}`);
  console.log(`Storage deletes: ${writes.storage_deletes}`);
  console.log(`Storage writes: ${writes.storage_writes}`);
  console.log(`DEV writes: ${writes.dev_writes}`);
  console.log(`Report: ${reportPath}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
