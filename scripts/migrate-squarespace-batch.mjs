#!/usr/bin/env node
/**
 * Sprint 16E — Controlled Original-project batch migration runner.
 *
 * Processes an explicit approved cruise-line list one line at a time.
 * Never discovers lines automatically. Never accepts a user-supplied list.
 *
 * Modes: --dry-run | --copy | --promote (separate stages; no combined mode)
 *
 * Batch examples:
 *   --batch=batch-1-logo-lines --confirm-production-batch=BATCH-1-LOGOS
 *   --batch=batch-2-mixed-lines --confirm-production-batch=BATCH-2-MIXED
 *   --batch=batch-3-disney --confirm-production-batch=BATCH-3-DISNEY
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
  BATCH_1_LINE_IDS
} from "./lib/squarespace-ci-media/batch-1-logo-lines.js";
import {
  assertBatch2MixedScope,
  assertBatch2PromotePlan,
  BATCH_2_ID,
  BATCH_2_LINE_IDS,
  BATCH_2_SHIP_IDS,
  DISNEY_CRUISE_LINE_ID
} from "./lib/squarespace-ci-media/batch-2-mixed-lines.js";
import {
  assertBatch3DisneyScope,
  assertBatch3PromotePlan,
  BATCH_3_ID,
  BATCH_3_LINE_IDS,
  BATCH_3_SHIP_IDS
} from "./lib/squarespace-ci-media/batch-3-disney.js";
import { runApprovedBatch, summariseCopyResults } from "./lib/squarespace-ci-media/batch-runner.js";

const BATCH_1_LINE_IDS_SET = new Set(BATCH_1_LINE_IDS.map(String));
const BATCH_2_LINE_IDS_SET = new Set(BATCH_2_LINE_IDS.map(String));
const BATCH_2_SHIP_IDS_SET = new Set(BATCH_2_SHIP_IDS.map(String));
const BATCH_3_LINE_IDS_SET = new Set(BATCH_3_LINE_IDS.map(String));
const BATCH_3_SHIP_IDS_SET = new Set(BATCH_3_SHIP_IDS.map(String));

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
  console.log(`Kind: ${batch.kind || "unknown"}`);
  console.log(`Lines: ${batch.lines.length}`);
  console.log(`Confirm: ${batch.confirm_token}`);
  if (mode === "promote") {
    console.log(`\n*** WARNING ***\n${batch.admin_warning}\n`);
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
    processLine: async ({ approved, resolvedLine, catalogue, batch: activeBatch }) => {
      assertCanonicalLineMatch(approved, resolvedLine);
      if (
        activeBatch.excludes_disney &&
        String(approved.id) === DISNEY_CRUISE_LINE_ID
      ) {
        throw Object.assign(new Error("REFUSED: Disney Cruise Line is not in this batch"), {
          code: "batch2_disney_forbidden"
        });
      }
      if (
        activeBatch.disney_only &&
        String(approved.id) !== DISNEY_CRUISE_LINE_ID
      ) {
        throw Object.assign(new Error("REFUSED: Batch 3 may only process Disney Cruise Line"), {
          code: "batch3_non_disney_line"
        });
      }

      const lineShips = (catalogue.ships || []).filter(
        (s) => String(s.cruise_line_id) === String(approved.id)
      );
      const { logoCandidates, shipHeroCandidates } = countLogoAndShipCandidates(
        resolvedLine,
        lineShips
      );

      const kind = activeBatch.kind || "logo-only";
      const isBatch3 = activeBatch.id === BATCH_3_ID;
      const isBatch2 = activeBatch.id === BATCH_2_ID;
      if (kind === "logo-only") {
        assertBatch1LogoOnlyScope({
          logoCandidates,
          shipHeroCandidates,
          lineName: approved.name
        });
      } else if (kind === "mixed" && isBatch3) {
        assertBatch3DisneyScope({
          approved,
          logoCandidates,
          shipHeroCandidates
        });
      } else if (kind === "mixed" && isBatch2) {
        assertBatch2MixedScope({
          approved,
          logoCandidates,
          shipHeroCandidates
        });
      } else if (kind === "mixed") {
        throw Object.assign(new Error(`REFUSED: unapproved mixed batch ${activeBatch.id}`), {
          code: "batch_id_invalid"
        });
      } else {
        throw Object.assign(new Error(`REFUSED: unknown batch kind ${kind}`), {
          code: "batch_kind_invalid"
        });
      }

      const expectedTotal =
        kind === "mixed" ? approved.expected_total : 1;
      const scope = {
        lineId: approved.id,
        shipId: null,
        entityIds: null,
        logosOnly: kind === "logo-only",
        shipsOnly: false,
        squarespaceOnly: true
      };
      const candidates = collectCandidates([resolvedLine], lineShips, scope);
      if (candidates.length !== expectedTotal) {
        const countCode = isBatch3
          ? "batch3_unexpected_total_count"
          : kind === "mixed"
            ? "batch2_unexpected_total_count"
            : "batch_logo_candidate_count";
        throw Object.assign(
          new Error(
            `REFUSED: expected ${expectedTotal} candidate(s) for ${approved.name}, got ${candidates.length}`
          ),
          { code: countCode }
        );
      }
      for (const c of candidates) {
        if (String(c.cruise_line_id) !== String(approved.id)) {
          throw Object.assign(new Error("REFUSED: candidate belongs to another cruise line"), {
            code: isBatch3 ? "batch3_foreign_candidate" : "batch_foreign_candidate"
          });
        }
      }

      const mediaForLine = (catalogue.media || []).filter(
        (m) => String(m.cruise_line_id) === String(approved.id)
      );
      const mediaIndex = indexMediaLibrary(catalogue.media || []);
      const shipNames = (approved.ships || []).map((s) => s.name);
      const lineReportBase = {
        order: approved.order,
        line_id: approved.id,
        line_name: approved.name,
        expected_logo_count: kind === "mixed" ? approved.expected_logo_count : 1,
        expected_ship_hero_count: kind === "mixed" ? approved.expected_ship_hero_count : 0,
        expected_total: expectedTotal,
        actual_logo_count: logoCandidates.length,
        actual_ship_hero_count: shipHeroCandidates.length,
        candidate_count: candidates.length,
        ship_hero_count: shipHeroCandidates.length,
        affected_ships: shipNames
      };
      const totalLines = activeBatch.lines.length;
      const reportPrefix = activeBatch.id;

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
          `${reportPrefix}-${mode}-line-${approved.order}-${approved.id}-${stamp}.json`
        );
        const result = {
          ...lineReportBase,
          status: "ok",
          wrote: false,
          uploaded_count: 0,
          logos_uploaded: 0,
          ship_heroes_uploaded: 0,
          media_library_inserted_count: 0,
          skipped_already_migrated: report.already_migrated || 0,
          duplicate_count: report.duplicate_binaries || 0,
          bytes_uploaded: 0,
          promoted_fields: [],
          public_urls: inspected.map((i) => i.proposed_public_url).filter(Boolean),
          report_path: reportPath,
          rollback_manifest_path: null
        };
        writeJson(reportPath, { ...result, inspected: inspected.map(({ _buffer, ...r }) => r) });
        console.log(
          `[${approved.order}/${totalLines}] dry-run OK — ${approved.name} (${candidates.length} assets)`
        );
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
        assertCopyDidNotChangeCiUrls(copyResults);

        const normalised = copyResults.map((r) => {
          if (
            r.copy_result === "skipped_already_present" ||
            r.copy_result === "skipped_duplicate_hash" ||
            r.status === "already_copied" ||
            r.status === "already_promoted"
          ) {
            return { ...r, copy_result: "skipped_already_present", status: "already_copied" };
          }
          return r;
        });
        const stats = summariseCopyResults(normalised);
        const logosUploaded = normalised.filter(
          (r) => r.entity_type === "cruise_line" && r.copy_result === "uploaded"
        ).length;
        const shipsUploaded = normalised.filter(
          (r) => r.entity_type === "ship" && r.copy_result === "uploaded"
        ).length;

        const reportPath = path.join(
          outDir,
          `${reportPrefix}-${mode}-line-${approved.order}-${approved.id}-${stamp}.json`
        );
        const result = {
          ...lineReportBase,
          status: "ok",
          wrote: stats.uploaded_count > 0 || stats.media_library_inserted_count > 0,
          ...stats,
          logos_uploaded: logosUploaded,
          ship_heroes_uploaded: shipsUploaded,
          promoted_fields: [],
          ci_urls_changed: 0,
          copy_outcome:
            stats.uploaded_count === 0 && stats.skipped_already_migrated > 0
              ? "skipped_already_migrated"
              : "copied",
          public_urls: stats.public_urls,
          report_path: reportPath,
          rollback_manifest_path: null
        };
        writeJson(reportPath, {
          ...result,
          results: copyResults.map(({ _buffer, ...r }) => r)
        });
        console.log(
          `[${approved.order}/${totalLines}] copy ${result.copy_outcome} — ${approved.name} (upload=${stats.uploaded_count}, skip=${stats.skipped_already_migrated})`
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

      if (kind === "logo-only") {
        if (plan.updates.length !== 1 || plan.updates[0].field !== "logo_url") {
          throw Object.assign(
            new Error("REFUSED: Batch 1 promote may only update one logo_url field per line"),
            { code: "batch_promote_field_invalid" }
          );
        }
        if (!BATCH_1_LINE_IDS_SET.has(String(plan.updates[0].entity_uuid))) {
          throw Object.assign(new Error("REFUSED: promote target UUID not in Batch 1"), {
            code: "batch_promote_uuid_not_approved"
          });
        }
      } else if (isBatch3) {
        assertBatch3PromotePlan(plan, approved);
        for (const u of plan.updates) {
          if (u.field === "logo_url" && !BATCH_3_LINE_IDS_SET.has(String(u.entity_uuid))) {
            throw Object.assign(new Error("REFUSED: logo UUID not in Batch 3"), {
              code: "batch3_promote_foreign_line"
            });
          }
          if (u.field === "hero_image_url" && !BATCH_3_SHIP_IDS_SET.has(String(u.entity_uuid))) {
            throw Object.assign(new Error("REFUSED: ship UUID not in Batch 3"), {
              code: "batch3_promote_ship_not_approved"
            });
          }
        }
      } else if (isBatch2) {
        assertBatch2PromotePlan(plan, approved);
        for (const u of plan.updates) {
          if (u.field === "logo_url" && !BATCH_2_LINE_IDS_SET.has(String(u.entity_uuid))) {
            throw Object.assign(new Error("REFUSED: logo UUID not in Batch 2"), {
              code: "batch2_promote_foreign_line"
            });
          }
          if (u.field === "hero_image_url" && !BATCH_2_SHIP_IDS_SET.has(String(u.entity_uuid))) {
            throw Object.assign(new Error("REFUSED: ship UUID not in Batch 2"), {
              code: "batch2_promote_ship_not_approved"
            });
          }
        }
      } else {
        throw Object.assign(new Error(`REFUSED: unapproved promote batch ${activeBatch.id}`), {
          code: "batch_id_invalid"
        });
      }

      await assertProductionPromotePublicUrls(plan, verifyPublicUrl);

      const manifest = buildProductionPromoteManifest(plan, {
        projectRef: env.project_ref,
        timestamp: new Date().toISOString()
      });
      const manifestPath = path.join(
        outDir,
        `${reportPrefix}-rollback-manifest-line-${approved.order}-${approved.id}-${stamp}.json`
      );
      writeJson(manifestPath, manifest);

      const applyResult = await applyVerifiedSequentialProductionPromote(plan, {
        verifiedWrite
      });

      const reportPath = path.join(
        outDir,
        `${reportPrefix}-${mode}-line-${approved.order}-${approved.id}-${stamp}.json`
      );
      const promotedFields = plan.updates.map((u) => `${u.table}.${u.field}`);
      const result = {
        ...lineReportBase,
        status: "ok",
        wrote: true,
        uploaded_count: 0,
        logos_uploaded: 0,
        ship_heroes_uploaded: 0,
        media_library_inserted_count: 0,
        skipped_already_migrated: 0,
        duplicate_count: 0,
        bytes_uploaded: 0,
        promoted_fields: promotedFields,
        logos_promoted: plan.updates.filter((u) => u.field === "logo_url").length,
        ship_heroes_promoted: plan.updates.filter((u) => u.field === "hero_image_url").length,
        public_urls: plan.updates.map((u) => u.new_url),
        verifications: applyResult.applied.map((a) => a.verification),
        report_path: reportPath,
        rollback_manifest_path: manifestPath
      };
      writeJson(reportPath, { ...result, plan, applyResult });
      console.log(
        `[${approved.order}/${totalLines}] promote OK — ${approved.name} (${promotedFields.length} fields)`
      );
      return result;
    }
  });

  const enriched = {
    ...summary,
    batch_kind: batch.kind,
    exact_cruise_lines: batch.lines.map((l) => ({
      order: l.order,
      name: l.name,
      id: l.id,
      expected_logo_count: l.expected_logo_count ?? 1,
      expected_ship_hero_count: l.expected_ship_hero_count ?? 0,
      ships: (l.ships || []).map((s) => ({ id: s.id, name: s.name }))
    })),
    logos_copied: summary.lines.reduce((n, r) => n + (r.logos_uploaded || 0), 0),
    ship_heroes_copied: summary.lines.reduce((n, r) => n + (r.ship_heroes_uploaded || 0), 0),
    logos_promoted: summary.lines.reduce((n, r) => n + (r.logos_promoted || 0), 0),
    ship_heroes_promoted: summary.lines.reduce((n, r) => n + (r.ship_heroes_promoted || 0), 0),
    excludes_disney: batch.excludes_disney || false
  };
  const summaryPath = path.join(outDir, `${batch.id}-${mode}-summary-${stamp}.json`);
  writeJson(summaryPath, { ...enriched, summary_path: summaryPath });
  console.log(`\nBatch ${enriched.stopped_early ? "STOPPED" : "COMPLETE"} — ${mode}`);
  console.log(`Completed lines: ${enriched.completed_lines}/${enriched.total_lines}`);
  if (enriched.failed_line) {
    console.error(
      `Failed: #${enriched.failed_line.order} ${enriched.failed_line.line_name}: ${enriched.failed_line.reason}`
    );
  }
  console.log(`Summary: ${summaryPath}`);
  console.log(`DEV writes: ${enriched.dev_writes}`);
  process.exit(enriched.stopped_early ? 2 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
