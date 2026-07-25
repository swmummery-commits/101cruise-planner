#!/usr/bin/env node
/**
 * Read-only investigation of Royal Caribbean International logo Media Library duplicates.
 *
 * Never INSERT / UPDATE / DELETE. Never Storage writes. Never DEV.
 *
 *   node scripts/investigate-royal-caribbean-logo-duplicate.mjs --target=production
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "tmp", "media-coverage-audit");

export const ROYAL_CARIBBEAN_LINE_ID = "1cea3c83-5fd5-41d0-b5f7-4026fee00ab5";
export const ROYAL_CARIBBEAN_LINE_NAME = "Royal Caribbean International";

const MEDIA_SELECT = [
  "id",
  "title",
  "media_type",
  "cruise_line_id",
  "ship_id",
  "public_url",
  "source_url",
  "storage_bucket",
  "storage_path",
  "original_filename",
  "import_source",
  "content_hash",
  "created_at",
  "updated_at",
  "mime_type",
  "is_active",
  "is_default"
].join(",");

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

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
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

async function urlReachable(url) {
  if (!url || !String(url).trim()) return null;
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

async function storageObjectProbe(env, storagePath) {
  if (!storagePath) {
    return { exists: null, info: null, head_ok: null };
  }
  const encoded = String(storagePath)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  let info = null;
  let infoOk = false;
  assertAuditHttpMethod("GET");
  try {
    const res = await fetch(
      `${env.url}/storage/v1/object/info/public/${MEDIA_BUCKET}/${encoded}`,
      {
        method: "GET",
        headers: {
          apikey: env.key,
          Authorization: `Bearer ${env.key}`
        }
      }
    );
    infoOk = res.ok;
    if (res.ok) {
      const text = await res.text();
      try {
        info = JSON.parse(text);
      } catch {
        info = { raw: text };
      }
    }
  } catch {
    infoOk = false;
  }

  assertAuditHttpMethod("HEAD");
  let headOk = false;
  try {
    const head = await fetch(`${env.url}/storage/v1/object/${MEDIA_BUCKET}/${encoded}`, {
      method: "HEAD",
      headers: {
        apikey: env.key,
        Authorization: `Bearer ${env.key}`
      }
    });
    headOk = head.ok;
  } catch {
    headOk = false;
  }

  return {
    exists: infoOk || headOk,
    info,
    head_ok: headOk,
    info_ok: infoOk
  };
}

function uniqById(rows) {
  const map = new Map();
  for (const r of rows || []) {
    if (r?.id) map.set(String(r.id), r);
  }
  return [...map.values()];
}

function classifyDuplicate(records, canonicalLogoUrl) {
  const logoRows = (records || []).filter((r) => !r.ship_id);
  if (logoRows.length < 2) {
    return {
      classification: "false-positive audit result",
      reason: `Expected ≥2 logo Media Library rows, found ${logoRows.length}`
    };
  }

  const paths = new Set(logoRows.map((r) => r.storage_path || ""));
  const hashes = new Set(logoRows.map((r) => r.content_hash || ""));
  const publics = new Set(logoRows.map((r) => r.public_url || ""));

  const samePath = paths.size === 1 && [...paths][0];
  const sameHash = hashes.size === 1 && [...hashes][0];
  const samePublic = publics.size === 1 && [...publics][0];

  if (samePath && sameHash) {
    return {
      classification: "exact duplicate rows pointing to the same Storage object",
      reason: "Identical storage_path and content_hash across logo Media Library rows"
    };
  }
  if (sameHash && !samePath) {
    return {
      classification: "duplicate binaries stored at different Storage paths",
      reason: "Same content_hash with different storage_path values"
    };
  }

  const matchingCanonical = logoRows.filter(
    (r) => String(r.public_url || "").trim() === String(canonicalLogoUrl || "").trim()
  );
  const notMatching = logoRows.filter(
    (r) => String(r.public_url || "").trim() !== String(canonicalLogoUrl || "").trim()
  );
  if (matchingCanonical.length >= 1 && notMatching.length >= 1) {
    return {
      classification: "old superseded logo retained alongside the canonical logo",
      reason:
        "One or more rows match ci_cruise_lines.logo_url; other logo row(s) point elsewhere"
    };
  }

  if (!sameHash && !samePath && !samePublic) {
    return {
      classification: "another clearly explained category",
      reason: "Multiple logo rows with different hashes, paths, and public URLs"
    };
  }

  return {
    classification: "another clearly explained category",
    reason: `paths=${paths.size}, hashes=${hashes.size}, publics=${publics.size}`
  };
}

function pickCanonicalRecord(records, canonicalLogoUrl) {
  const logoRows = (records || []).filter((r) => !r.ship_id);
  const byUrl = logoRows.find(
    (r) => String(r.public_url || "").trim() === String(canonicalLogoUrl || "").trim()
  );
  if (byUrl) {
    return {
      remain: byUrl,
      reason:
        "Matches canonical ci_cruise_lines.logo_url (promoted Squarespace migration target)"
    };
  }
  const withHash = logoRows.filter((r) => r.content_hash);
  if (withHash.length) {
    const newest = [...withHash].sort((a, b) =>
      String(b.created_at || "").localeCompare(String(a.created_at || ""))
    )[0];
    return {
      remain: newest,
      reason: "No exact public_url match; newest content_hash row selected as provisional"
    };
  }
  return {
    remain: logoRows[0] || null,
    reason: "Fallback: first logo Media Library row"
  };
}

async function main() {
  const target = parseTargetArg(process.argv);
  if (target == null) {
    console.error("REFUSED: require --target=production");
    process.exit(2);
  }
  if (target !== "production") {
    console.error("REFUSED: investigation requires --target=production");
    process.exit(2);
  }

  loadEnvFile();
  let env;
  try {
    env = resolveMigrationTarget({
      target: "production",
      mode: "dry-run",
      env: process.env
    });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  if (env.project_ref !== PRODUCTION_REF || env.target !== "production") {
    console.error("REFUSED: Original project only");
    process.exit(2);
  }

  console.log("\n=== Royal Caribbean logo duplicate investigation (READ-ONLY) ===");
  console.log(formatTargetBanner(env, "dry-run"));
  console.log("Operations: GET/HEAD only — zero writes\n");

  const lines = await supabaseGet(
    env,
    "ci_cruise_lines",
    `?id=eq.${encodeURIComponent(ROYAL_CARIBBEAN_LINE_ID)}&select=id,name,logo_url,active,updated_at,created_at`
  );
  const line = Array.isArray(lines) ? lines[0] : null;
  if (!line) {
    console.error("REFUSED: Royal Caribbean International line not found");
    process.exit(1);
  }
  if (String(line.name).trim() !== ROYAL_CARIBBEAN_LINE_NAME) {
    console.error(
      `REFUSED: unexpected name "${line.name}" (expected ${ROYAL_CARIBBEAN_LINE_NAME})`
    );
    process.exit(1);
  }

  const byLineId = await supabaseGet(
    env,
    "media_library",
    `?cruise_line_id=eq.${encodeURIComponent(ROYAL_CARIBBEAN_LINE_ID)}&select=${MEDIA_SELECT}&order=created_at.asc`
  );

  const logoUrl = line.logo_url || "";
  let byPublicUrl = [];
  if (logoUrl) {
    byPublicUrl = await supabaseGet(
      env,
      "media_library",
      `?public_url=eq.${encodeURIComponent(logoUrl)}&select=${MEDIA_SELECT}`
    );
  }

  const logoRowsForLine = (byLineId || []).filter((r) => !r.ship_id);
  const sourceUrls = [
    ...new Set(logoRowsForLine.map((r) => r.source_url).filter(Boolean))
  ];
  const hashes = [...new Set(logoRowsForLine.map((r) => r.content_hash).filter(Boolean))];

  let bySourceUrl = [];
  for (const src of sourceUrls) {
    const rows = await supabaseGet(
      env,
      "media_library",
      `?source_url=eq.${encodeURIComponent(src)}&select=${MEDIA_SELECT}`
    );
    bySourceUrl.push(...(rows || []));
  }

  let byHash = [];
  for (const hash of hashes) {
    const rows = await supabaseGet(
      env,
      "media_library",
      `?content_hash=eq.${encodeURIComponent(hash)}&select=${MEDIA_SELECT}`
    );
    byHash.push(...(rows || []));
  }

  const related = uniqById([
    ...(byLineId || []),
    ...(byPublicUrl || []),
    ...bySourceUrl,
    ...byHash
  ]);

  const logoRelated = related.filter((r) => !r.ship_id);
  const shipRelated = related.filter((r) => r.ship_id);

  const detailed = [];
  for (const row of related) {
    const reachable = await urlReachable(row.public_url);
    const storage = await storageObjectProbe(env, row.storage_path);
    const matchesCanonical =
      String(row.public_url || "").trim() === String(logoUrl || "").trim();
    const relationshipCorrect =
      String(row.cruise_line_id) === ROYAL_CARIBBEAN_LINE_ID && !row.ship_id
        ? true
        : String(row.cruise_line_id) === ROYAL_CARIBBEAN_LINE_ID;
    const sameHashPeers = related.filter(
      (o) =>
        o.id !== row.id &&
        row.content_hash &&
        o.content_hash &&
        String(o.content_hash) === String(row.content_hash)
    );
    detailed.push({
      media_library_uuid: row.id,
      title: row.title || null,
      media_type: row.media_type || null,
      cruise_line_id: row.cruise_line_id || null,
      ship_id: row.ship_id || null,
      public_url: row.public_url || null,
      source_url: row.source_url || null,
      storage_bucket: row.storage_bucket || null,
      storage_path: row.storage_path || null,
      original_filename: row.original_filename || null,
      import_source: row.import_source || null,
      content_hash: row.content_hash || null,
      created_at: row.created_at || null,
      updated_at: row.updated_at || null,
      mime_type: row.mime_type || null,
      is_active: row.is_active,
      is_default: row.is_default,
      public_url_reachable: reachable === true ? "yes" : reachable === false ? "no" : "n/a",
      storage_object_exists: storage.exists === true ? "yes" : storage.exists === false ? "no" : "n/a",
      storage_probe: {
        info_ok: storage.info_ok,
        head_ok: storage.head_ok,
        info: storage.info
      },
      matches_canonical_logo_url: matchesCanonical,
      relationship_correct: relationshipCorrect && !row.ship_id ? true : relationshipCorrect,
      is_line_logo_row: !row.ship_id,
      content_hash_matches_other_records: sameHashPeers.map((p) => p.id),
      binary_shared_with_count: sameHashPeers.length
    });
  }

  const classification = classifyDuplicate(logoRelated, logoUrl);
  const { remain, reason: remainReason } = pickCanonicalRecord(logoRelated, logoUrl);
  const duplicates = logoRelated.filter((r) => remain && r.id !== remain.id);

  // Would deleting duplicate ML rows orphan Storage?
  const orphanAnalysis = duplicates.map((dup) => {
    const path = dup.storage_path || "";
    const othersUsingPath = related.filter(
      (r) => r.id !== dup.id && String(r.storage_path || "") === path && path
    );
    const remainUsesSamePath =
      remain && path && String(remain.storage_path || "") === path;
    return {
      media_library_id: dup.id,
      storage_path: path || null,
      other_media_library_rows_using_path: othersUsingPath.map((r) => r.id),
      canonical_uses_same_path: Boolean(remainUsesSamePath),
      storage_would_become_orphaned_if_ml_row_deleted:
        Boolean(path) && othersUsingPath.length === 0 && !remainUsesSamePath,
      note:
        remainUsesSamePath || othersUsingPath.length > 0
          ? "Storage object still referenced by another Media Library row — deleting ML row alone would NOT orphan Storage"
          : path
            ? "No other Media Library row references this storage_path — deleting ML row would leave an unreferenced Storage object (orphan candidate)"
            : "No storage_path on duplicate row"
    };
  });

  const recommended = {
    do_not_perform: true,
    steps: [
      "Keep the Media Library row whose public_url equals ci_cruise_lines.logo_url",
      ...(duplicates.length
        ? [
            `Delete ONLY the duplicate Media Library row(s): ${duplicates.map((d) => d.id).join(", ")}`,
            "Do NOT change ci_cruise_lines.logo_url",
            "Do NOT delete Storage objects in the same operation unless confirmed unreferenced after ML cleanup"
          ]
        : ["No duplicate logo rows to delete"])
    ],
    ci_logo_url_change_required: false,
    sufficient_to_delete_ml_row_only: orphanAnalysis.every(
      (o) =>
        o.canonical_uses_same_path ||
        o.other_media_library_rows_using_path.length > 0 ||
        !o.storage_path
    )
      ? true
      : "depends — see storage_orphan_analysis; prefer ML-row-only delete first, then optional Storage GC"
  };

  const report = {
    mode: "read-only-investigation",
    target: "production",
    project_ref: env.project_ref,
    generated_at: new Date().toISOString(),
    writes: {
      insert: 0,
      update: 0,
      delete: 0,
      storage_writes: 0,
      dev_writes: 0
    },
    cruise_line: {
      id: line.id,
      name: line.name,
      active: line.active,
      logo_url: line.logo_url,
      created_at: line.created_at,
      updated_at: line.updated_at
    },
    media_library_counts: {
      by_cruise_line_id_total: (byLineId || []).length,
      by_cruise_line_id_logo_rows: logoRowsForLine.length,
      by_cruise_line_id_ship_rows: (byLineId || []).filter((r) => r.ship_id).length,
      by_canonical_public_url: (byPublicUrl || []).length,
      unique_related_after_url_source_hash_union: related.length,
      logo_rows_in_investigation_set: logoRelated.length,
      ship_rows_in_investigation_set: shipRelated.length
    },
    records: detailed,
    classification: classification.classification,
    classification_reason: classification.reason,
    canonical_record_to_remain: remain
      ? {
          media_library_uuid: remain.id,
          public_url: remain.public_url,
          storage_path: remain.storage_path,
          content_hash: remain.content_hash,
          source_url: remain.source_url,
          import_source: remain.import_source,
          created_at: remain.created_at
        }
      : null,
    remain_reason: remainReason,
    duplicate_or_superseded_records: duplicates.map((d) => ({
      media_library_uuid: d.id,
      public_url: d.public_url,
      storage_path: d.storage_path,
      content_hash: d.content_hash,
      source_url: d.source_url,
      import_source: d.import_source,
      created_at: d.created_at
    })),
    storage_orphan_analysis: orphanAnalysis,
    recommended_cleanup: recommended,
    risks: [
      "Deleting the wrong Media Library row could break Admin Media Library references if any UI/bookmarks use that UUID",
      "source_url on a deleted row is lost unless captured in this report first",
      "Sprint 16E rollback manifests reference Storage public URLs / prior CI URLs, not Media Library UUIDs — ML-row cleanup does not undo CI logo_url",
      "If a Storage object is deleted while still referenced, canonical logo_url could break",
      "Do not change ci_cruise_lines.logo_url as part of duplicate cleanup unless investigation proves it is wrong"
    ]
  };

  const outPath = path.join(OUT_DIR, "royal-caribbean-logo-duplicate-investigation.json");
  writeJson(outPath, report);

  console.log(`Line: ${line.name} (${line.id})`);
  console.log(`Canonical logo_url:\n  ${line.logo_url}`);
  console.log(`Media Library rows by cruise_line_id: ${(byLineId || []).length}`);
  console.log(`  logo rows (no ship_id): ${logoRowsForLine.length}`);
  console.log(`  ship rows: ${(byLineId || []).filter((r) => r.ship_id).length}`);
  console.log(`Classification: ${classification.classification}`);
  console.log(`Remain: ${remain?.id || "none"}`);
  console.log(
    `Duplicate/superseded: ${duplicates.map((d) => d.id).join(", ") || "none"}`
  );
  console.log(`Report: ${outPath}`);
  console.log("Writes: 0 / 0 / 0 (insert/update/delete); Storage writes: 0; DEV: 0\n");

  for (const rec of detailed.filter((r) => r.is_line_logo_row)) {
    console.log("--- Logo Media Library record ---");
    console.log(`  id:              ${rec.media_library_uuid}`);
    console.log(`  title:           ${rec.title}`);
    console.log(`  media_type:      ${rec.media_type}`);
    console.log(`  public_url:      ${rec.public_url}`);
    console.log(`  source_url:      ${rec.source_url}`);
    console.log(`  storage_path:    ${rec.storage_path}`);
    console.log(`  original_file:   ${rec.original_filename}`);
    console.log(`  import_source:   ${rec.import_source}`);
    console.log(`  content_hash:    ${rec.content_hash}`);
    console.log(`  created_at:      ${rec.created_at}`);
    console.log(`  updated_at:      ${rec.updated_at}`);
    console.log(`  reachable:       ${rec.public_url_reachable}`);
    console.log(`  storage exists:  ${rec.storage_object_exists}`);
    console.log(`  matches logo:    ${rec.matches_canonical_logo_url}`);
    console.log(`  relationship ok: ${rec.relationship_correct}`);
    console.log(
      `  hash peers:      ${rec.content_hash_matches_other_records.join(", ") || "none"}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
