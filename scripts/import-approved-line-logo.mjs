#!/usr/bin/env node
/**
 * Guarded importer for Steve-approved local cruise-line logos.
 *
 * Verified sequential import with rollback evidence (not a DB transaction).
 * Original project only. DEV untouched.
 *
 * Dry run:
 *   node scripts/import-approved-line-logo.mjs \
 *     --dry-run \
 *     --target=production \
 *     --logo=hurtigruten \
 *     --confirm=IMPORT-HURTIGRUTEN-LOGO
 *
 * Apply:
 *   node scripts/import-approved-line-logo.mjs \
 *     --apply \
 *     --target=production \
 *     --logo=hurtigruten \
 *     --confirm=IMPORT-HURTIGRUTEN-LOGO
 *
 * Do not accept arbitrary file path, line UUID, or free-form confirmation.
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
  HURTIGRUTEN_CONFIRM_TOKEN,
  HURTIGRUTEN_LINE_ID,
  assertHurtigrutenCliGate
} from "./lib/approved-line-logo-import/hurtigruten.js";
import {
  getApprovedLogoConfig,
  runApprovedLineLogoImport,
  emptyWriteCounts
} from "./lib/approved-line-logo-import/import-runner.js";

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

function resolveMode() {
  const dry = hasFlag("--dry-run");
  const apply = hasFlag("--apply");
  if (dry && apply) {
    throw Object.assign(new Error("REFUSED: use either --dry-run or --apply, not both"), {
      code: "approved_logo_mode_invalid"
    });
  }
  if (dry) return "dry-run";
  if (apply) return "apply";
  return null;
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
    // Idempotent retry: object already present is acceptable when path matches.
    if (response.status === 400 || response.status === 409) {
      if (/already exists|Duplicate|resource already/i.test(text)) {
        return { skipped_existing: true };
      }
    }
    throw new Error(`Storage upload failed: ${text || response.status}`);
  }
  return { skipped_existing: false };
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

  const mode = resolveMode();
  const target = parseTargetArg(process.argv);
  const logoKey = parseArg("logo");
  const confirmToken = parseArg("confirm");

  // Abort before network / credentials if CLI gate fails.
  try {
    assertHurtigrutenCliGate({
      target,
      mode,
      logoKey,
      confirmToken,
      argv: process.argv
    });
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  let env;
  try {
    env = resolveMigrationTarget({
      target,
      mode: "import-approved-line-logo",
      env: process.env
    });
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  if (env.project_ref !== PRODUCTION_REF || env.target !== "production") {
    console.error("REFUSED: selected project is not the Original project");
    process.exit(2);
  }

  console.log("\n=== Approved local cruise-line logo import ===");
  console.log(formatTargetBanner(env, "import-approved-line-logo"));
  console.log(`Logo key: ${logoKey}`);
  console.log(`Strategy: verified sequential import with rollback evidence`);
  console.log(`Mode: ${mode}`);

  const config = getApprovedLogoConfig(logoKey);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(
    OUT_DIR,
    `approved-line-logo-${logoKey}-${mode}-${stamp}.json`
  );

  let uploadCount = 0;

  try {
    const result = await runApprovedLineLogoImport({
      cli: {
        target,
        mode,
        logoKey,
        confirmToken,
        argv: process.argv
      },
      mode,
      projectRef: env.project_ref,
      supabaseUrl: env.url,
      readLocalFile: async (filePath) => {
        if (!fs.existsSync(filePath)) {
          throw Object.assign(new Error(`REFUSED: approved local file missing: ${filePath}`), {
            code: "approved_logo_file_missing"
          });
        }
        return fs.readFileSync(filePath);
      },
      loadLine: async (id) => {
        const { ok, status, body, text } = await supabaseRest(env, "GET", "ci_cruise_lines", {
          query: `?id=eq.${encodeURIComponent(id)}&select=id,name,logo_url&limit=1`
        });
        if (!ok) throw new Error((body && body.message) || `Supabase HTTP ${status}: ${text}`);
        return Array.isArray(body) ? body[0] || null : null;
      },
      loadLineMedia: async (lineId) => {
        const { ok, status, body, text } = await supabaseRest(env, "GET", "media_library", {
          query: `?cruise_line_id=eq.${encodeURIComponent(lineId)}&media_type=eq.cruise_line&select=${encodeURIComponent(MEDIA_SELECT)}`
        });
        if (!ok) throw new Error((body && body.message) || `Supabase HTTP ${status}: ${text}`);
        return Array.isArray(body) ? body : [];
      },
      loadMediaByLineHash: async (lineId, hash) => {
        const { ok, status, body, text } = await supabaseRest(env, "GET", "media_library", {
          query: `?cruise_line_id=eq.${encodeURIComponent(lineId)}&content_hash=eq.${encodeURIComponent(hash)}&select=${encodeURIComponent(MEDIA_SELECT)}`
        });
        if (!ok) throw new Error((body && body.message) || `Supabase HTTP ${status}: ${text}`);
        return Array.isArray(body) ? body : [];
      },
      loadHxLines: async () => {
        const { ok, status, body, text } = await supabaseRest(env, "GET", "ci_cruise_lines", {
          query:
            "?or=(name.ilike.*HX*,name.ilike.*Hurtigruten%20Expedition*)&select=id,name,logo_url&limit=20"
        });
        if (!ok) throw new Error((body && body.message) || `Supabase HTTP ${status}: ${text}`);
        return Array.isArray(body) ? body : [];
      },
      storageExists: (storagePath) => storageObjectExists(env, storagePath),
      verifyPublicUrl,
      writeRollbackManifest: async (manifest) => {
        const p = path.join(
          OUT_DIR,
          `approved-line-logo-rollback-${logoKey}-${stamp}.json`
        );
        writeJson(p, manifest);
        return p;
      },
      uploadObject: async (args) => {
        if (uploadCount >= 1) {
          throw Object.assign(new Error("REFUSED: apply uploads at most one object"), {
            code: "approved_logo_upload_limit"
          });
        }
        const out = await uploadObject(env, args);
        if (!out.skipped_existing) uploadCount += 1;
        return out;
      },
      insertMedia: async (row) => {
        const { ok, status, body, text } = await supabaseRest(env, "POST", "media_library", {
          body: row,
          headers: { Prefer: "return=representation" }
        });
        if (!ok) {
          throw new Error((body && body.message) || `media_library INSERT HTTP ${status}: ${text}`);
        }
        return Array.isArray(body) ? body : [body];
      },
      readMediaById: async (id) => {
        const { ok, status, body, text } = await supabaseRest(env, "GET", "media_library", {
          query: `?id=eq.${encodeURIComponent(id)}&select=${encodeURIComponent(MEDIA_SELECT)}&limit=1`
        });
        if (!ok) throw new Error((body && body.message) || `Supabase HTTP ${status}: ${text}`);
        return Array.isArray(body) ? body[0] || null : null;
      },
      patchLineLogo: async ({ table, id, field, value }) => {
        if (table !== "ci_cruise_lines" || field !== "logo_url") {
          throw Object.assign(
            new Error("REFUSED: only ci_cruise_lines.logo_url may be updated"),
            { code: "approved_logo_patch_field_forbidden" }
          );
        }
        if (String(id) !== HURTIGRUTEN_LINE_ID) {
          throw Object.assign(new Error("REFUSED: only Hurtigruten logo_url may be updated"), {
            code: "approved_logo_patch_line_forbidden"
          });
        }
        const { status, body, text, ok } = await supabaseRest(env, "PATCH", table, {
          query: `?id=eq.${encodeURIComponent(id)}`,
          body: { [field]: value },
          headers: { Prefer: "return=representation" }
        });
        if (!ok) {
          throw new Error((body && body.message) || `PATCH HTTP ${status}: ${text}`);
        }
        return { status, body };
      },
      readLineField: async ({ table, id, field }) => {
        const { ok, status, body, text } = await supabaseRest(env, "GET", table, {
          query: `?id=eq.${encodeURIComponent(id)}&select=id,${encodeURIComponent(field)}&limit=1`
        });
        if (!ok) throw new Error((body && body.message) || `Supabase HTTP ${status}: ${text}`);
        return Array.isArray(body) ? body[0] || null : null;
      },
      countOtherLineChanges: async () => 0
    });

    const writes = result.writes || emptyWriteCounts();

    console.log("\n--- Result ---");
    console.log(`Status: ${result.status}`);
    console.log(`Canonical UUID: ${result.canonical_uuid}`);
    console.log(`Canonical name: ${result.canonical_name}`);
    console.log(`Source file: ${result.source_file}`);
    console.log(`Dimensions: ${result.dimensions}`);
    console.log(`File size: ${result.file_size_bytes} bytes`);
    console.log(`SHA-256: ${result.content_hash_sha256}`);
    console.log(`Proposed Storage path: ${result.proposed_storage_path}`);
    console.log(`Proposed Media Library values:`, JSON.stringify(result.proposed_media_library_values, null, 2));
    console.log(`Proposed canonical logo_url: ${result.proposed_canonical_logo_url}`);
    console.log(`Database writes: ${result.database_writes ?? 0}`);
    console.log(`Storage writes: ${result.storage_writes ?? writes.storage_uploads}`);
    console.log(`DEV writes: ${result.dev_writes ?? 0}`);
    console.log(`Storage uploads: ${writes.storage_uploads}`);
    console.log(`Media Library inserts: ${writes.media_library_inserts}`);
    console.log(`Cruise-line updates: ${writes.cruise_line_updates}`);
    console.log(`Database inserts: ${writes.database_inserts}`);
    console.log(`Database updates: ${writes.database_updates}`);
    console.log(`Database deletes: ${writes.database_deletes}`);
    console.log(`Storage deletes: ${writes.storage_deletes}`);
    if (result.rollback_manifest_path) {
      console.log(`Rollback evidence: ${result.rollback_manifest_path}`);
    }
    if (result.media_library_id) {
      console.log(`Media Library id: ${result.media_library_id}`);
    }

    writeJson(reportPath, {
      ...result,
      confirm_token_used: HURTIGRUTEN_CONFIRM_TOKEN,
      config_snapshot: {
        cruise_line_id: config.cruise_line_id,
        cruise_line_name: config.cruise_line_name,
        local_path: config.local_path,
        brand_note: config.brand_note
      },
      mutations: {
        importer_ran_live: mode === "apply",
        ...writes
      }
    });
    console.log(`\nReport: ${reportPath}`);
  } catch (error) {
    console.error("\nIMPORT FAILED:", error.message);
    if (error.retained_storage_path) {
      console.error(`Retained Storage object: ${error.retained_storage_path}`);
    }
    if (error.rollback_manifest_path) {
      console.error(`Rollback evidence: ${error.rollback_manifest_path}`);
    }
    writeJson(reportPath, {
      status: "failed",
      error: error.message,
      code: error.code || null,
      retained_storage_path: error.retained_storage_path || null,
      rollback_manifest_path: error.rollback_manifest_path || null,
      writes: error.writes || emptyWriteCounts()
    });
    console.error(`Report: ${reportPath}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
