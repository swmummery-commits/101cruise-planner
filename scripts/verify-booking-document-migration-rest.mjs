#!/usr/bin/env node
/**
 * Production migration verification via Supabase REST (no DATABASE_URL required).
 * Does not log credentials, URLs, paths, or secrets.
 */

import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const REQUIRED_COLUMNS = [
  "source_fingerprint",
  "source_file_url_hash",
  "original_filename",
  "storage_bucket",
  "mime_type",
  "file_size",
  "content_hash",
  "last_seen_at",
  "synced_at",
  "is_active",
  "source_deleted_at"
];

const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const sb = createSupabaseRest(root);

async function checkColumns() {
  const present = [];
  const missing = [];
  for (const col of REQUIRED_COLUMNS) {
    try {
      await sb.get(`booking_documents?select=${col}&limit=1`);
      present.push(col);
    } catch {
      missing.push(col);
    }
  }
  return { present, missing, all_present: missing.length === 0 };
}

async function checkBucketPrivacy() {
  const https = require("https");
  const url = process.env.SUPABASE_URL.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return new Promise((resolve) => {
    const u = new URL(`${url}/storage/v1/bucket/booking-documents`);
    const req = https.request(
      u,
      { method: "GET", headers: { apikey: key, Authorization: `Bearer ${key}` } },
      (res) => {
        let raw = "";
        res.on("data", (c) => {
          raw += c;
        });
        res.on("end", () => {
          try {
            const data = JSON.parse(raw);
            resolve({ ok: res.statusCode < 400, public: data?.public === true, exists: res.statusCode < 400 });
          } catch {
            resolve({ ok: false, public: null, exists: false });
          }
        });
      }
    );
    req.on("error", () => resolve({ ok: false, public: null, exists: false }));
    req.end();
  });
}

function findDuplicateGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (row.is_active === false || !row.source_fingerprint || !row.base44_booking_id) continue;
    const key = `${row.base44_booking_id}|${row.source_fingerprint}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row.id);
  }
  return [...groups.entries()].filter(([, ids]) => ids.length > 1).map(([key, ids]) => ({
    group_key: key.split("|")[0],
    fingerprint_prefix: key.split("|")[1]?.slice(0, 8),
    count: ids.length
  }));
}

async function main() {
  const columns = await checkColumns();
  const bucket = await checkBucketPrivacy();

  const select =
    "id,booking_reference,base44_booking_id,document_type,filename,source_fingerprint,is_active,storage_path,storage_bucket,file_url,synced_at,last_seen_at,source_deleted_at,mime_type,file_size,content_hash,source_file_url_hash,original_filename";
  const rows = await sb.get(`booking_documents?select=${select}&source_system=eq.base44`);
  const customerRows = await sb.get("customer_documents?select=id").catch(() => []);

  const active = rows.filter((r) => r.is_active !== false);
  const archived = rows.filter((r) => r.is_active === false);
  const mirrored = rows.filter((r) => r.storage_path);
  const legacy = rows.filter((r) => !r.storage_path && r.file_url);
  const missingFingerprint = active.filter((r) => !r.source_fingerprint);
  const duplicates = findDuplicateGroups(rows);

  const report = {
    phase: "rest_verify",
    database_url_available: false,
    columns,
    unique_index_verified_directly: false,
    unique_index_proxy: {
      duplicate_active_fingerprint_groups: duplicates.length,
      duplicates
    },
    storage_bucket: {
      exists: bucket.exists,
      public: bucket.public,
      private: bucket.exists && bucket.public !== true
    },
    counts: {
      booking_documents_base44: rows.length,
      active_base44: active.length,
      archived_base44: archived.length,
      customer_documents: Array.isArray(customerRows) ? customerRows.length : 0,
      mirrored_storage: mirrored.length,
      legacy_file_url_only: legacy.length
    },
    data_quality: {
      active_missing_source_fingerprint: missingFingerprint.length,
      active_missing_storage_path: active.filter((r) => !r.storage_path).length,
      active_missing_synced_at: active.filter((r) => !r.synced_at).length,
      active_missing_last_seen_at: active.filter((r) => !r.last_seen_at).length,
      unexpected_archived: archived.filter((r) => !r.source_deleted_at).length
    },
    legacy_documents: legacy.map((r) => ({
      booking_reference: r.booking_reference,
      document_type: r.document_type,
      filename: r.filename,
      has_file_url: Boolean(r.file_url)
    })),
    passed:
      columns.all_present &&
      bucket.public !== true &&
      duplicates.length === 0 &&
      missingFingerprint.length === 0
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exit(1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
