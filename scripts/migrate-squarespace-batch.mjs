#!/usr/bin/env node
/**
 * Sprint 16E — Controlled Original-project batch migration runner.
 *
 * Processes an explicit approved cruise-line list one line at a time.
 * Never discovers lines automatically. Never accepts a user-supplied list.
 *
 * Modes: --dry-run | --copy | --promote (separate stages; no combined mode)
 *
 * Batch 1 example:
 *   node scripts/migrate-squarespace-batch.mjs \
 *     --dry-run --target=production \
 *     --batch=batch-1-logo-lines \
 *     --confirm-production-batch=BATCH-1-LOGOS
 *
 * DO NOT use against DEV. Production only.
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
import { runCopy, runDryRun } from "./lib/squarespace-ci-media/migrate-core.js";
import { MEDIA_BUCKET } from "./lib/squarespace-ci-media/media-utils.js";
import {
  parseTargetArg,
  resolveMigrationTarget,
  formatTargetBanner,
  PRODUCTION_REF
} from "./lib/squarespace-ci-media/target.js";
import {
  assertProductionCopyPlan,
  assertCopyDidNotChangeCiUrls
} from "./lib/squarespace-ci-media/production-copy-gate.js";
import {
  buildProductionPromotePlan,
  assertProductionPromotePublicUrls,
  buildProductionPromoteManifest,
  applyVerifiedSequentialProductionPromote
} from "./lib/squarespace-ci-media/production-promote-gate.js";
import { verifiedCiFieldWrite } from "./lib/squarespace-ci-media/verified-ci-patch.js";
import { isSquarespaceHost } from "./lib/squarespace-ci-media/url-safety.js";
import {
  assertProductionBatchCliGate,
  assertApprovedLineOrder,
  assertCanonicalLineMatch,
  assertBatch1LogoOnlyScope,
  BATCH_1_ADMIN_WARNING,
  BATCH_1_LINE_IDS
} from "./lib/squarespace-ci-media/batch-1-logo-lines.js";
import { runApprovedBatch, summariseCopyResults } from "./lib/squarespace-ci-media/batch-runner.js";

const BATCH_1_LINE_IDS_SET = new Set(BATCH_1_LINE_IDS.map(String));

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

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  return process.argv[i + 1] || null;
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

function resolveMode() {
  if (hasFlag("--promote")) return "promote";
  if (hasFlag("--copy")) return "copy";
  if (hasFlag("--dry-run")) return "dry-run";
  return null;
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
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
  if (!ok) throw new Error((body && body.message) || `Supabase HTTP ${status}: ${text}`);
  return body;
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
        "x-upsert": "false"
      },
      body: buffer
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Storage upload failed: ${response.status} ${text}`);
  }
}

async function verifyPublicUrl(url) {
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (res.ok) return true;
    const res2 = await fetch(url, { method: "GET", redirect: "follow" });
    return res2.ok;
  } catch {
    return false;
  }
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

function countLogoAndShipCandidates(line, ships) {
  const logoCandidates =
    line?.logo_url && isSquarespaceHost(line.logo_url)
      ? [{ field: "logo_url", url: line.logo_url }]
      : [];
  const shipHeroCandidates = (ships || [])
    .filter(
      (s) =>
        String(s.cruise_line_id) === String(line.id) &&
        s.hero_image_url &&
        isSquarespaceHost(s.hero_image_url)
    )
    .map((s) => ({ ship_id: s.id, name: s.name, url: s.hero_image_url }));
  return { logoCandidates, shipHeroCandidates };
}

async function main() {
  // ---- CLI gate BEFORE env load / network ----
  const mode = resolveMode();
  const target = parseTargetArg(process.argv);
  const batchId = parseArg("batch");
  const confirmToken = parseArg("confirm-production-batch");

  let batch;
  try {
    if (!mode) {
      throw Object.assign(
        new Error("REFUSED: specify exactly one of --dry-run, --copy, or --promote"),
        { code: "batch_mode_invalid" }
      );
    }
    batch = assertProductionBatchCliGate({
      target,
      mode,
      batchId,
      confirmToken
    });
    assertApprovedLineOrder(batch);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  loadEnvFile();

  let env;
  try {
    env = resolveMigrationTarget({ target, mode, env: process.env });
  } catch (error) {
    console.error(error.message);
    process.exit(error.code === "production_write_forbidden" ? 2 : 1);
  }

  if (env.project_ref !== PRODUCTION_REF || env.target !== "production") {
    console.error("REFUSED: batch runner may only use the Original project.");
    process.exit(2);
  }

  console.log(`\n=== Squarespace CI media BATCH ===`);
  console.log(formatTargetBanner(env, mode));
  console.log(`Batch: ${batch.id}`);
  console.log(`Lines: ${batch.lines.length}`);
  console.log(`Confirm: ${batch.confirm_token}`);
  if (mode === "promote") {
    console.log(`\n*** WARNING ***\n${BATCH_1_ADMIN_WARNING}\n`);
  }

  const outDir = path.join(ROOT, "tmp", "squarespace-migration", "batches");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = Date.now();
  const verifiedWrite = makeVerifiedWrite(env);

  const summary = await runApprovedBatch({
    mode,
    batch,
    projectRef: env.project_ref,
    loadCatalogue: async () => {
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
      return { lines, ships, media };
    },
    processLine: async ({ approved, resolvedLine, catalogue }) => {
      assertCanonicalLineMatch(approved, resolvedLine);
      const lineShips = (catalogue.ships || []).filter(
        (s) => String(s.cruise_line_id) === String(approved.id)
      );
      const { logoCandidates, shipHeroCandidates } = countLogoAndShipCandidates(
        resolvedLine,
        lineShips
      );
      assertBatch1LogoOnlyScope({
        logoCandidates,
        shipHeroCandidates,
        lineName: approved.name
      });

      const scope = {
        lineId: approved.id,
        shipId: null,
        entityIds: null,
        logosOnly: true,
        shipsOnly: false,
        squarespaceOnly: true
      };
      const candidates = collectCandidates([resolvedLine], lineShips, scope);
      if (candidates.length !== 1 || candidates[0].entity_type !== "cruise_line") {
        throw Object.assign(
          new Error(
            `REFUSED: expected exactly one cruise-line logo candidate, got ${candidates.length}`
          ),
          { code: "batch_logo_candidate_count" }
        );
      }

      const mediaForLine = (catalogue.media || []).filter(
        (m) => String(m.cruise_line_id) === String(approved.id)
      );
      const mediaIndex = indexMediaLibrary(catalogue.media || []);

      const lineReportBase = {
        order: approved.order,
        line_id: approved.id,
        line_name: approved.name,
        candidate_count: 1,
        ship_hero_count: 0
      };

      // -------- dry-run --------
      if (mode === "dry-run") {
        const inspected = await runDryRun(candidates, {
          fetchAsset: async (url) => fetchRemoteAsset(url),
          inspectAsset,
          supabaseUrl: env.url,
          mediaIndex
        });
        const report = summariseInspection(inspected);
        assertProductionCopyPlan({
          inspected,
          summary: {
            broken_urls: report.broken_urls,
            invalid_mime_types: report.invalid_mime_types,
            ssrf_blocked: report.ssrf_blocked,
            too_large: report.too_large,
            estimated_upload_bytes: report.estimated_upload_bytes,
            proposed_canonical_url_changes: report.proposed_canonical_url_changes
          },
          lineId: approved.id,
          lineName: approved.name
        });
        const reportPath = path.join(
          outDir,
          `batch-1-${mode}-line-${approved.order}-${approved.id}-${stamp}.json`
        );
        const result = {
          ...lineReportBase,
          status: "ok",
          wrote: false,
          uploaded_count: 0,
          media_library_inserted_count: 0,
          skipped_already_migrated: report.already_migrated || 0,
          duplicate_count: report.duplicate_binaries || 0,
          bytes_uploaded: 0,
          promoted_fields: [],
          dry_run_status: inspected[0]?.status || null,
          public_url: inspected[0]?.proposed_public_url || null,
          report_path: reportPath,
          rollback_manifest_path: null
        };
        writeJson(reportPath, { ...result, inspected: inspected.map(({ _buffer, ...r }) => r) });
        console.log(`[${approved.order}/13] dry-run OK — ${approved.name} (${inspected[0]?.status})`);
        return result;
      }

      // -------- copy --------
      if (mode === "copy") {
        const inspected = await runDryRun(candidates, {
          fetchAsset: async (url) => fetchRemoteAsset(url),
          inspectAsset,
          supabaseUrl: env.url,
          mediaIndex
        });
        assertProductionCopyPlan({
          inspected,
          summary: summariseInspection(inspected),
          lineId: approved.id,
          lineName: approved.name
        });

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
            const inserted = await supabaseRest(env, "POST", "media_library", {
              body: row,
              headers: { Prefer: "return=representation" }
            });
            return Array.isArray(inserted) ? inserted[0] : inserted;
          },
          findMediaByHash: async (item) => {
            const rows = await supabaseRest(env, "GET", "media_library", {
              query: `?cruise_line_id=eq.${encodeURIComponent(item.cruise_line_id)}&content_hash=eq.${encodeURIComponent(item.content_hash)}&select=id,public_url,storage_path&limit=1`
            });
            return rows?.[0] || null;
          },
          verifyPublicUrl
        });
        assertCopyDidNotChangeCiUrls(copyResults);

        const stats = summariseCopyResults(
          copyResults.map((r) => {
            // Normalise Norwegian / already-copied into skipped_already_migrated
            if (
              r.copy_result === "skipped_already_present" ||
              r.copy_result === "skipped_duplicate_hash" ||
              r.status === "already_copied" ||
              r.status === "already_promoted"
            ) {
              return {
                ...r,
                copy_result: "skipped_already_present",
                status: "already_copied"
              };
            }
            return r;
          })
        );

        const reportPath = path.join(
          outDir,
          `batch-1-${mode}-line-${approved.order}-${approved.id}-${stamp}.json`
        );
        const result = {
          ...lineReportBase,
          status: "ok",
          wrote: stats.uploaded_count > 0 || stats.media_library_inserted_count > 0,
          ...stats,
          promoted_fields: [],
          ci_urls_changed: 0,
          copy_outcome:
            stats.uploaded_count === 0 && stats.skipped_already_migrated > 0
              ? "skipped_already_migrated"
              : "copied",
          report_path: reportPath,
          rollback_manifest_path: null
        };
        writeJson(reportPath, {
          ...result,
          results: copyResults.map(({ _buffer, ...r }) => r)
        });
        console.log(
          `[${approved.order}/13] copy ${result.copy_outcome} — ${approved.name} (upload=${stats.uploaded_count}, skip=${stats.skipped_already_migrated})`
        );
        return result;
      }

      // -------- promote --------
      const plan = buildProductionPromotePlan({
        line: resolvedLine,
        ships: lineShips,
        mediaRows: mediaForLine,
        lineId: approved.id
      });
      if (plan.updates.length !== 1 || plan.updates[0].field !== "logo_url") {
        throw Object.assign(
          new Error("REFUSED: batch promote may only update one logo_url field per line"),
          { code: "batch_promote_field_invalid" }
        );
      }
      if (!BATCH_1_LINE_IDS_SET.has(String(plan.updates[0].entity_uuid))) {
        throw Object.assign(new Error("REFUSED: promote target UUID not in Batch 1"), {
          code: "batch_promote_uuid_not_approved"
        });
      }
      await assertProductionPromotePublicUrls(plan, verifyPublicUrl);

      const manifest = buildProductionPromoteManifest(plan, {
        projectRef: env.project_ref,
        timestamp: new Date().toISOString()
      });
      const manifestPath = path.join(
        outDir,
        `batch-1-rollback-manifest-line-${approved.order}-${approved.id}-${stamp}.json`
      );
      writeJson(manifestPath, manifest);

      const applyResult = await applyVerifiedSequentialProductionPromote(plan, {
        verifiedWrite
      });

      const reportPath = path.join(
        outDir,
        `batch-1-${mode}-line-${approved.order}-${approved.id}-${stamp}.json`
      );
      const result = {
        ...lineReportBase,
        status: "ok",
        wrote: true,
        uploaded_count: 0,
        media_library_inserted_count: 0,
        skipped_already_migrated: 0,
        duplicate_count: 0,
        bytes_uploaded: 0,
        promoted_fields: ["ci_cruise_lines.logo_url"],
        public_url: plan.updates[0].new_url,
        verification: applyResult.applied[0]?.verification || null,
        report_path: reportPath,
        rollback_manifest_path: manifestPath
      };
      writeJson(reportPath, { ...result, plan, applyResult });
      console.log(`[${approved.order}/13] promote OK — ${approved.name}`);
      return result;
    }
  });

  // Fix: BATCH_1_LINE_IDS_SET referenced before import - import it
  const summaryPath = path.join(outDir, `batch-1-${mode}-summary-${stamp}.json`);
  writeJson(summaryPath, { ...summary, summary_path: summaryPath });
  console.log(`\nBatch ${summary.stopped_early ? "STOPPED" : "COMPLETE"} — ${mode}`);
  console.log(`Completed lines: ${summary.completed_lines}/${summary.total_lines}`);
  if (summary.failed_line) {
    console.error(
      `Failed: #${summary.failed_line.order} ${summary.failed_line.line_name}: ${summary.failed_line.reason}`
    );
  }
  console.log(`Summary: ${summaryPath}`);
  console.log(`DEV writes: ${summary.dev_writes}`);
  process.exit(summary.stopped_early ? 2 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
