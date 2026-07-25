#!/usr/bin/env node
/**
 * Sprint 16E — Migrate Squarespace (and other remote) CI logos/heroes into
 * Media Library + cruise-media Storage.
 *
 * Extends CI media ownership documented in scripts/migrate-ci-media.mjs
 * (that script only copies URL strings). This script owns binary copy +
 * explicit promote of logo_url / hero_image_url.
 *
 * Required:
 *   --target=dev | --target=production
 *
 * Modes:
 *   --dry-run     (default) inspect only — no DB/Storage writes
 *   --copy        DEV freely; Original/production only with gated confirmation
 *   --promote     DEV freely; Original/production only with gated confirmation
 *   --repair-logo Original/production only — Princess logo_url repair gate
 *   --rollback --manifest <path>   DEV only (broad Original rollback blocked)
 *
 * Gated Original-project copy (Princess only):
 *   --copy --target=production --line-id c19f40a7-… --confirm-production-copy=PRINCESS
 *
 * Gated Original-project promote (Princess logo + Crown Princess hero only):
 *   --promote --target=production --line-id c19f40a7-… --confirm-production-promote=PRINCESS
 *
 * Gated Original-project logo repair (Princess logo_url only):
 *   --repair-logo --target=production --line-id c19f40a7-… --confirm-production-logo-repair=PRINCESS
 *
 * Production --rollback remains blocked.
 * Target is never inferred from whichever env vars exist.
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
import {
  parseTargetArg,
  resolveMigrationTarget,
  formatTargetBanner,
  PRODUCTION_REF
} from "./lib/squarespace-ci-media/target.js";
import {
  parseConfirmProductionCopy,
  assertProductionCopyCliGate,
  assertProductionCopyPlan,
  assertCopyDidNotChangeCiUrls,
  formatProductionCopyBanner
} from "./lib/squarespace-ci-media/production-copy-gate.js";
import {
  parseConfirmProductionPromote,
  assertProductionPromoteCliGate,
  buildProductionPromotePlan,
  assertProductionPromotePublicUrls,
  buildProductionPromoteManifest,
  formatProductionPromoteBanner,
  applyVerifiedSequentialProductionPromote
} from "./lib/squarespace-ci-media/production-promote-gate.js";
import {
  parseConfirmProductionLogoRepair,
  assertProductionLogoRepairCliGate,
  buildProductionLogoRepairPlan,
  assertProductionLogoRepairPublicUrl,
  buildProductionLogoRepairManifest,
  formatProductionLogoRepairBanner,
  ADMIN_STALE_FORM_WARNING
} from "./lib/squarespace-ci-media/production-logo-repair-gate.js";
import {
  verifiedCiFieldWrite,
  applyVerifiedSequentialUpdates
} from "./lib/squarespace-ci-media/verified-ci-patch.js";

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
  if (hasFlag("--repair-logo")) return "repair-logo";
  if (hasFlag("--promote")) return "promote";
  if (hasFlag("--copy")) return "copy";
  return "dry-run";
}

function resolveEnv(mode) {
  const target = parseTargetArg(process.argv);
  return resolveMigrationTarget({ target, mode, env: process.env });
}

async function supabaseRestDetailed(env, method, tablePath, { query = "", body, headers = {} } = {}) {
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
  return { status: response.status, ok: response.ok, body: data, text };
}

async function supabaseRest(env, method, tablePath, opts = {}) {
  const { status, ok, body, text } = await supabaseRestDetailed(env, method, tablePath, opts);
  if (!ok) {
    throw new Error((body && body.message) || `Supabase HTTP ${status}: ${text}`);
  }
  return body;
}

function makeVerifiedWrite(env) {
  return async ({ table, id, field, value }) =>
    verifiedCiFieldWrite({
      table,
      id,
      field,
      value,
      patchRow: async ({ table: t, id: rowId, field: f, value: v }) => {
        const { status, body } = await supabaseRestDetailed(env, "PATCH", t, {
          query: `?id=eq.${encodeURIComponent(rowId)}&select=id,${encodeURIComponent(f)}`,
          body: { [f]: v },
          headers: { Prefer: "return=representation" }
        });
        return { status, body };
      },
      readRow: async ({ table: t, id: rowId, field: f }) => {
        const rows = await supabaseRest(env, "GET", t, {
          query: `?id=eq.${encodeURIComponent(rowId)}&select=id,${encodeURIComponent(f)}&limit=1`
        });
        return Array.isArray(rows) ? rows[0] || null : null;
      }
    });
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
  let env;
  try {
    env = resolveEnv(mode);
  } catch (error) {
    console.error(error.message);
    if (error.code === "missing_target" || error.code === "invalid_target") {
      console.error("Example: node scripts/migrate-squarespace-ci-media.mjs --dry-run --target=production");
    }
    process.exit(error.code === "production_write_forbidden" ? 2 : 1);
  }

  // Print selected target before any asset inspection / remote work.
  console.log(`\n=== Squarespace CI media migration ===`);
  console.log(formatTargetBanner(env, mode));

  const scope = parseScope();
  console.log(`Scope:`, JSON.stringify(scope));

  if (env.target === "production" && mode === "copy") {
    try {
      assertProductionCopyCliGate({
        target: env.target,
        mode,
        projectRef: env.project_ref,
        expectedProductionRef: PRODUCTION_REF,
        scope,
        confirmToken: parseConfirmProductionCopy(process.argv)
      });
    } catch (error) {
      console.error(error.message);
      process.exit(2);
    }
  }

  if (env.target === "production" && mode === "promote") {
    try {
      assertProductionPromoteCliGate({
        target: env.target,
        mode,
        projectRef: env.project_ref,
        expectedProductionRef: PRODUCTION_REF,
        scope,
        confirmToken: parseConfirmProductionPromote(process.argv)
      });
    } catch (error) {
      console.error(error.message);
      process.exit(2);
    }
  }

  if (env.target === "production" && mode === "repair-logo") {
    try {
      assertProductionLogoRepairCliGate({
        target: env.target,
        mode,
        projectRef: env.project_ref,
        expectedProductionRef: PRODUCTION_REF,
        scope,
        confirmToken: parseConfirmProductionLogoRepair(process.argv)
      });
    } catch (error) {
      console.error(error.message);
      process.exit(2);
    }
  }

  if (mode === "repair-logo" && env.target !== "production") {
    console.error("REFUSED: --repair-logo requires --target=production.");
    process.exit(2);
  }

  if (env.target === "production" && mode === "rollback") {
    console.error("REFUSED: --rollback is not allowed with --target=production.");
    process.exit(2);
  }

  const outDir = path.join(ROOT, "tmp", "squarespace-migration");
  fs.mkdirSync(outDir, { recursive: true });

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

  const verifiedWrite = makeVerifiedWrite(env);

  // Gated Original-project logo repair: Princess logo_url only.
  if (env.target === "production" && mode === "repair-logo") {
    const line = lines.find((l) => String(l.id) === String(scope.lineId));
    let plan;
    try {
      plan = buildProductionLogoRepairPlan({ line, mediaRows: media });
      await assertProductionLogoRepairPublicUrl(plan, verifyPublicUrl);
    } catch (error) {
      console.error(error.message);
      process.exit(2);
    }

    console.log(formatProductionLogoRepairBanner(plan, env.project_ref));
    console.log(`\n${ADMIN_STALE_FORM_WARNING}\n`);

    const stamp = Date.now();
    const manifest = buildProductionLogoRepairManifest(plan, {
      projectRef: env.project_ref,
      timestamp: new Date().toISOString()
    });
    const manifestPath = path.join(outDir, `rollback-manifest-production-logo-repair-${stamp}.json`);
    writeJson(manifestPath, manifest);
    console.log(`Rollback manifest written (before CI update): ${manifestPath}`);

    let applyResult;
    try {
      applyResult = await applyVerifiedSequentialUpdates(plan.updates, {
        verifiedWrite,
        failureLabel: "REPAIR",
        rolledBackCode: "production_logo_repair_rolled_back"
      });
    } catch (error) {
      console.error(error.message);
      const failPath = path.join(outDir, `logo-repair-production-failed-${stamp}.json`);
      writeJson(failPath, {
        mode: "repair-logo",
        target: env.target,
        project_ref: env.project_ref,
        ok: false,
        strategy: "verified_sequential_update_with_compensating_rollback",
        error: error.message,
        code: error.code || null,
        cause_code: error.cause?.code || null,
        applied: error.applied || [],
        restored: error.restored || [],
        manifest_path: manifestPath
      });
      process.exit(2);
    }

    const repairPath = path.join(outDir, `logo-repair-production-${stamp}.json`);
    writeJson(repairPath, {
      mode: "repair-logo",
      target: env.target,
      project_ref: env.project_ref,
      strategy: applyResult.strategy,
      uploads: 0,
      media_library_inserts: 0,
      ships_updated: 0,
      fields_updated: ["ci_cruise_lines.logo_url"],
      results: applyResult.applied,
      admin_stale_form_warning: ADMIN_STALE_FORM_WARNING,
      manifest_path: manifestPath
    });
    console.log(`\nLogo repair complete (verified sequential update). Report: ${repairPath}`);
    console.log(`Rollback manifest: ${manifestPath}`);
    console.log("No uploads. No media_library inserts. No ship updates. No Storage deletes.");
    console.log(`\n${ADMIN_STALE_FORM_WARNING}`);
    return;
  }

  // Gated Original-project promote: CI URL patches only — no Squarespace fetch, no upload, no ML insert.
  if (env.target === "production" && mode === "promote") {
    const line = lines.find((l) => String(l.id) === String(scope.lineId));
    let plan;
    try {
      plan = buildProductionPromotePlan({ line, ships, mediaRows: media });
      await assertProductionPromotePublicUrls(plan, verifyPublicUrl);
    } catch (error) {
      console.error(error.message);
      process.exit(2);
    }

    console.log(formatProductionPromoteBanner(plan, env.project_ref));

    const stamp = Date.now();
    const manifest = buildProductionPromoteManifest(plan, {
      projectRef: env.project_ref,
      timestamp: new Date().toISOString()
    });
    const manifestPath = path.join(outDir, `rollback-manifest-production-promote-${stamp}.json`);
    writeJson(manifestPath, manifest);
    console.log(`Rollback manifest written (before CI updates): ${manifestPath}`);
    console.log(`Guarded restore (not enabled yet):\n${manifest.guarded_restore_command}`);

    let applyResult;
    try {
      applyResult = await applyVerifiedSequentialProductionPromote(plan, { verifiedWrite });
    } catch (error) {
      console.error(error.message);
      const failPath = path.join(outDir, `promote-production-failed-${stamp}.json`);
      writeJson(failPath, {
        mode: "promote",
        target: env.target,
        project_ref: env.project_ref,
        ok: false,
        strategy: "verified_sequential_update_with_compensating_rollback",
        error: error.message,
        code: error.code || null,
        cause_code: error.cause?.code || null,
        applied: error.applied || [],
        restored: error.restored || [],
        manifest_path: manifestPath
      });
      process.exit(2);
    }

    const promotePath = path.join(outDir, `promote-production-${stamp}.json`);
    writeJson(promotePath, {
      mode: "promote",
      target: env.target,
      project_ref: env.project_ref,
      strategy: applyResult.strategy,
      uploads: 0,
      media_library_inserts: 0,
      fields_updated: plan.updates.map((u) => `${u.table}.${u.field}`),
      results: applyResult.applied,
      manifest_path: manifestPath
    });
    console.log(
      `\nPromote complete (verified sequential update with compensating rollback). Report: ${promotePath}`
    );
    console.log(`Rollback manifest: ${manifestPath}`);
    console.log("No uploads. No media_library inserts. No Storage deletes.");
    return;
  }

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
    target: env.target,
    label: env.label,
    project_ref: env.project_ref,
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
    const lineMeta = lines.find((l) => String(l.id) === String(scope.lineId));
    const summary = {
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
    };

    if (env.target === "production") {
      let planGate;
      try {
        planGate = assertProductionCopyPlan({
          inspected,
          summary,
          lineName: lineMeta?.name
        });
      } catch (error) {
        console.error(error.message);
        process.exit(2);
      }
      console.log(
        formatProductionCopyBanner({
          projectRef: env.project_ref,
          lineId: scope.lineId,
          lineName: lineMeta?.name,
          candidateCount: planGate.candidate_count,
          estimatedBytes: planGate.estimated_bytes
        })
      );
    }

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
      uploadObject: (args) => {
        if (args.bucket && args.bucket !== MEDIA_BUCKET) {
          throw new Error(`Refused upload to bucket ${args.bucket}`);
        }
        return uploadObject(env, args);
      },
      insertMedia: async (row) => {
        // media_library only — never patch CI tables from copy path
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

    try {
      assertCopyDidNotChangeCiUrls(copyResults);
    } catch (error) {
      console.error(error.message);
      process.exit(2);
    }

    const copyPath = path.join(outDir, `copy-${Date.now()}.json`);
    writeJson(copyPath, {
      mode: "copy",
      target: env.target,
      project_ref: env.project_ref,
      ci_urls_changed: false,
      canonical_url_changes: 0,
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
