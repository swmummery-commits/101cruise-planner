#!/usr/bin/env node
/**
 * Sprint 16E — Migrate Squarespace (and other remote) CI logos/heroes into
 * Media Library + cruise-media Storage.
 *
 * Extends CI media ownership documented in scripts/migrate-ci-media.mjs
 * (that script only copies URL strings). This script owns binary copy +
 * explicit promote of logo_url / hero_image_url.
 *
 * Modes:
 *   --dry-run     (default) inspect only — no DB/Storage writes
 *   --copy        upload + media_library insert; CI URLs unchanged
 *   --promote     update CI logo_url / hero_image_url for verified copies
 *   --rollback --manifest <path>
 *
 * Scopes:
 *   --line-id <uuid>   --ship-id <uuid>   --ids <uuid,uuid>
 *   --logos-only       --ships-only       --all-hosts
 *
 * Production safety:
 *   --copy / --promote require SUPABASE_DEV_URL + SUPABASE_DEV_SERVICE_ROLE_KEY
 *   unless ALLOW_PRODUCTION_MEDIA_MIGRATION=1 (explicit, dangerous).
 *
 * HOLD DEPLOY. Do not run --copy/--promote against production without approval.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchRemoteAsset } from "./lib/squarespace-ci-media/fetch-asset.js";
import {
  collectCandidates,
  indexMediaLibrary,
  inspectAsset,
  summariseInspection
} from "./lib/squarespace-ci-media/plan.js";
import {
  runCopy,
  runDryRun,
  runPromote,
  runRollback
} from "./lib/squarespace-ci-media/migrate-core.js";
import { MEDIA_BUCKET } from "./lib/squarespace-ci-media/media-utils.js";

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

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  return process.argv[i + 1] || null;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function resolveMode() {
  if (hasFlag("--rollback")) return "rollback";
  if (hasFlag("--promote")) return "promote";
  if (hasFlag("--copy")) return "copy";
  return "dry-run";
}

function resolveEnv(mode) {
  const hasDev = Boolean(
    process.env.SUPABASE_DEV_URL && process.env.SUPABASE_DEV_SERVICE_ROLE_KEY
  );
  const allowProd = process.env.ALLOW_PRODUCTION_MEDIA_MIGRATION === "1";

  if ((mode === "copy" || mode === "promote") && !hasDev && !allowProd) {
    console.error(
      [
        "REFUSED: --copy / --promote require a Supabase DEV project.",
        "Set SUPABASE_DEV_URL and SUPABASE_DEV_SERVICE_ROLE_KEY.",
        "No SUPABASE_DEV_* is configured in this environment.",
        "Fixture tests and --dry-run (read-only) may still run.",
        "Do not set ALLOW_PRODUCTION_MEDIA_MIGRATION=1 unless explicitly approved."
      ].join("\n")
    );
    process.exit(2);
  }

  if (hasDev) {
    return {
      url: process.env.SUPABASE_DEV_URL.replace(/\/$/, ""),
      key: process.env.SUPABASE_DEV_SERVICE_ROLE_KEY,
      label: "DEV",
      hasDev: true
    };
  }

  const url = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !key) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  return { url, key, label: "PRODUCTION_READ", hasDev: false };
}

async function supabaseRest(env, method, tablePath, { query = "", body, headers = {} } = {}) {
  const response = await fetch(`${env.url}/rest/v1/${tablePath}${query}`, {
    method,
    headers: {
      apikey: env.key,
      Authorization: `Bearer ${env.key}`,
      "Content-Type": "application/json",
      Prefer: method === "GET" ? "count=exact" : "return=representation",
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
  if (!response.ok) {
    throw new Error((data && data.message) || `Supabase HTTP ${response.status}: ${text}`);
  }
  return data;
}

async function listAll(env, table, select) {
  const pageSize = 500;
  let offset = 0;
  const all = [];
  while (offset < 30000) {
    const rows = await supabaseRest(env, "GET", table, {
      query: `?select=${encodeURIComponent(select)}&order=id.asc&limit=${pageSize}&offset=${offset}`
    });
    const list = Array.isArray(rows) ? rows : [];
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
        "x-upsert": "true"
      },
      body: buffer
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Storage upload failed: ${text || response.status}`);
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

function parseScope() {
  const idsRaw = argValue("--ids");
  return {
    lineId: argValue("--line-id"),
    shipId: argValue("--ship-id"),
    entityIds: idsRaw
      ? idsRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : null,
    logosOnly: hasFlag("--logos-only"),
    shipsOnly: hasFlag("--ships-only"),
    squarespaceOnly: !hasFlag("--all-hosts")
  };
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function main() {
  const mode = resolveMode();
  const env = resolveEnv(mode);
  const scope = parseScope();
  const outDir = path.join(ROOT, "tmp", "squarespace-migration");
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`\n=== Squarespace CI media migration (${mode}) ===`);
  console.log(`Target: ${env.label} (${new URL(env.url).host})`);
  console.log(`Scope:`, JSON.stringify(scope));

  if (mode === "rollback") {
    const manifestPath = argValue("--manifest");
    if (!manifestPath) {
      console.error("--rollback requires --manifest <path>");
      process.exit(1);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const entries = Array.isArray(manifest) ? manifest : manifest.entries || [];
    const results = await runRollback(entries, {
      patchCiField: async ({ table, id, field, value }) => {
        await supabaseRest(env, "PATCH", table, {
          query: `?id=eq.${encodeURIComponent(id)}`,
          body: { [field]: value }
        });
      }
    });
    const out = path.join(outDir, `rollback-${Date.now()}.json`);
    writeJson(out, { results });
    console.log(`Rollback restored ${results.length} CI URL(s). Manifest report: ${out}`);
    console.log("Storage / Media Library objects were NOT deleted.");
    return;
  }

  const [lines, ships, media] = await Promise.all([
    listAll(env, "ci_cruise_lines", "id,name,logo_url,hero_image_url"),
    listAll(env, "ci_cruise_ships", "id,name,cruise_line_id,hero_image_url"),
    listAll(
      env,
      "media_library",
      "id,media_type,public_url,storage_bucket,storage_path,cruise_line_id,ship_id,content_hash,import_source,source_url,original_filename"
    ).catch((e) => {
      console.warn("media_library list warning:", e.message);
      return [];
    })
  ]);

  const candidates = collectCandidates(lines, ships, scope);
  const mediaIndex = indexMediaLibrary(media);

  console.log(`Candidates: ${candidates.length}`);

  const inspected = await runDryRun(candidates, {
    fetchAsset: async (url) => {
      const result = await fetchRemoteAsset(url);
      return result;
    },
    inspectAsset,
    supabaseUrl: env.url,
    mediaIndex
  });

  // Attach buffers for copy path (re-fetch only for proposed uploads in --copy)
  const report = summariseInspection(inspected);
  const dryPath = path.join(outDir, `dry-run-${Date.now()}.json`);
  writeJson(dryPath, {
    mode: "dry-run",
    target: env.label,
    host: new URL(env.url).host,
    scope,
    summary: {
      assets_inspected: report.assets_inspected,
      assets_reachable: report.assets_reachable,
      broken_urls: report.broken_urls,
      invalid_mime_types: report.invalid_mime_types,
      too_large: report.too_large,
      ssrf_blocked: report.ssrf_blocked,
      duplicate_binaries: report.duplicate_binaries,
      already_migrated: report.already_migrated,
      already_promoted: report.already_promoted,
      proposed_uploads: report.proposed_uploads,
      proposed_media_library_records: report.proposed_media_library_records,
      proposed_canonical_url_changes: report.proposed_canonical_url_changes,
      estimated_download_bytes: report.estimated_download_bytes,
      estimated_upload_bytes: report.estimated_upload_bytes
    },
    oversized_assets: report.oversized_assets,
    items: report.items.map(({ _buffer, ...rest }) => rest)
  });

  console.log("\nDry-run summary:");
  console.log(JSON.stringify(JSON.parse(fs.readFileSync(dryPath, "utf8")).summary, null, 2));
  console.log(`Full report: ${dryPath}`);
  if (report.oversized_assets.length) {
    console.log(`Oversized flagged: ${report.oversized_assets.length}`);
  }

  if (mode === "dry-run") {
    console.log("\nNo writes performed (dry-run).");
    return;
  }

  if (mode === "copy") {
    // Re-fetch eligible assets for upload buffers
    const withBuffers = [];
    for (const item of inspected) {
      if (item.status !== "proposed_upload") {
        withBuffers.push(item);
        continue;
      }
      const { buffer } = await fetchRemoteAsset(item.original_url);
      withBuffers.push({ ...item, _buffer: buffer });
    }

    const copyResults = await runCopy(withBuffers, {
      uploadObject: (args) => uploadObject(env, args),
      insertMedia: async (row) => {
        const inserted = await supabaseRest(env, "POST", "media_library", {
          body: row,
          headers: { Prefer: "return=representation" }
        });
        return Array.isArray(inserted) ? inserted[0] : inserted;
      },
      findMediaByHash: async (item) => {
        if (item.entity_type === "ship") {
          const rows = await supabaseRest(env, "GET", "media_library", {
            query: `?ship_id=eq.${encodeURIComponent(item.ship_id)}&content_hash=eq.${encodeURIComponent(item.content_hash)}&select=id,public_url,storage_path&limit=1`
          });
          return rows?.[0] || null;
        }
        const rows = await supabaseRest(env, "GET", "media_library", {
          query: `?cruise_line_id=eq.${encodeURIComponent(item.cruise_line_id)}&content_hash=eq.${encodeURIComponent(item.content_hash)}&select=id,public_url,storage_path&limit=1`
        });
        return rows?.[0] || null;
      },
      verifyPublicUrl
    });

    const copyPath = path.join(outDir, `copy-${Date.now()}.json`);
    writeJson(copyPath, {
      mode: "copy",
      ci_urls_changed: false,
      results: copyResults.map(({ _buffer, ...rest }) => rest)
    });
    console.log(`\nCopy complete. CI URLs unchanged. Report: ${copyPath}`);
    return;
  }

  if (mode === "promote") {
    // Promote uses latest copy report or re-derives from already_copied media
    const copyReportPath = argValue("--from-copy");
    let items;
    if (copyReportPath) {
      const data = JSON.parse(fs.readFileSync(copyReportPath, "utf8"));
      items = data.results || [];
    } else {
      // Build promote list from media_library rows with import_source + matching CI field still on Squarespace
      items = inspected
        .filter((i) => i.status === "already_copied" || i.status === "proposed_upload")
        .map((i) => ({
          ...i,
          status: i.media_library_id ? "already_copied" : i.status,
          copy_result: i.media_library_id ? "skipped_already_present" : "not_copied"
        }))
        .filter((i) => i.media_library_id);
    }

    const { results, manifest } = await runPromote(items, {
      patchCiField: async (patch) => {
        await supabaseRest(env, "PATCH", patch.table, {
          query: `?id=eq.${encodeURIComponent(patch.id)}`,
          body: { [patch.field]: patch.new_url }
        });
      }
    });

    const stamp = Date.now();
    const promotePath = path.join(outDir, `promote-${stamp}.json`);
    const manifestPath = path.join(outDir, `rollback-manifest-${stamp}.json`);
    writeJson(promotePath, { mode: "promote", results });
    writeJson(manifestPath, { entries: manifest });
    console.log(`\nPromote complete. Report: ${promotePath}`);
    console.log(`Rollback manifest: ${manifestPath}`);
    console.log(
      `Rollback: node scripts/migrate-squarespace-ci-media.mjs --rollback --manifest ${manifestPath}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
