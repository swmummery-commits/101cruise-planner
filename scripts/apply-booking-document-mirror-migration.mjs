#!/usr/bin/env node
/**
 * Apply and verify booking document mirror migration on production.
 *
 *   node scripts/apply-booking-document-mirror-migration.mjs --audit
 *   node scripts/apply-booking-document-mirror-migration.mjs --apply-migration --use-netlify-db
 *   node scripts/apply-booking-document-mirror-migration.mjs --verify --use-netlify-db
 *   node scripts/apply-booking-document-mirror-migration.mjs --all --use-netlify-db
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const MIGRATION_FILE = "supabase/migrations/20260806_booking_document_mirror_hardening.sql";

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

function parseArgs(argv) {
  const args = { audit: false, applyMigration: false, verify: false, all: false, useNetlifyDb: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--audit") args.audit = true;
    if (arg === "--apply-migration") args.applyMigration = true;
    if (arg === "--verify") args.verify = true;
    if (arg === "--all") args.all = true;
    if (arg === "--use-netlify-db") args.useNetlifyDb = true;
  }
  if (args.all) {
    args.audit = true;
    args.applyMigration = true;
    args.verify = true;
  }
  if (!args.audit && !args.applyMigration && !args.verify) args.audit = true;
  return args;
}

function loadDatabaseUrl({ useNetlifyDb = false } = {}) {
  const candidates = [
    process.env.DATABASE_URL,
    process.env.SUPABASE_DB_URL,
    process.env.POSTGRES_URL,
    process.env.DIRECT_URL
  ]
    .map((value) => String(value || "").trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  for (const candidate of candidates) {
    if (/^postgres(ql)?:\/\//i.test(candidate)) return candidate;
  }
  if (!useNetlifyDb) return "";
  const netlifyBin =
    process.env.NETLIFY_CLI_BIN ||
    "/Users/stevemummery/.npm/_npx/5897f426ba328dd1/node_modules/.bin/netlify";
  try {
    const raw = execSync(`${netlifyBin} env:get DATABASE_URL --context production`, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 240000
    });
    const lines = raw
      .split("\n")
      .map((line) => line.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean)
      .filter((line) => !line.startsWith("npm warn"));
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (/^postgres(ql)?:\/\//i.test(lines[i])) return lines[i];
    }
  } catch {
    /* ignore */
  }
  return "";
}

async function headCount(sb, table, filter = "") {
  const https = require("https");
  const { url, key } = getSupabaseConfig(root);
  const q = filter ? `${table}?${filter}&select=id` : `${table}?select=id`;
  return new Promise((resolve, reject) => {
    const u = new URL(`${url}/rest/v1/${q}`);
    const req = https.request(
      u,
      { method: "HEAD", headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" } },
      (res) => {
        const range = res.headers["content-range"] || "";
        const m = range.match(/\/(\d+)/);
        resolve(m ? Number(m[1]) : 0);
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function pgQuery(dbUrl, query) {
  let pg;
  try {
    pg = require("pg");
  } catch {
    throw new Error("pg package required — run npm install pg");
  }
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    return (await client.query(query)).rows;
  } finally {
    await client.end();
  }
}

async function runAudit(sb, dbUrl) {
  const before = {
    booking_documents: await headCount(sb, "booking_documents"),
    customer_documents: await headCount(sb, "customer_documents"),
    base44_rows: await headCount(sb, "booking_documents", "source_system=eq.base44")
  };

  let duplicates = [];
  if (dbUrl) {
    duplicates = await pgQuery(
      dbUrl,
      `SELECT base44_booking_id, source_fingerprint, COUNT(*) AS row_count
       FROM public.booking_documents
       WHERE source_system = 'base44'
         AND is_active = true
         AND source_fingerprint IS NOT NULL
         AND base44_booking_id IS NOT NULL
       GROUP BY base44_booking_id, source_fingerprint
       HAVING COUNT(*) > 1`
    );
  }

  const report = {
    phase: "audit",
    counts: before,
    duplicate_active_fingerprint_groups: duplicates.length,
    duplicates,
    passed: true
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

async function applyMigration(options = {}) {
  const dbUrl = loadDatabaseUrl(options);
  if (!dbUrl) throw new Error("DATABASE_URL required (--use-netlify-db or env)");

  const sb = createSupabaseRest(root);
  const before = {
    booking_documents: await headCount(sb, "booking_documents"),
    customer_documents: await headCount(sb, "customer_documents"),
    base44_active: await headCount(sb, "booking_documents", "source_system=eq.base44&is_active=eq.true").catch(() =>
      headCount(sb, "booking_documents", "source_system=eq.base44")
    )
  };

  const sqlPath = path.join(root, MIGRATION_FILE);
  const sql = fs.readFileSync(sqlPath, "utf8");

  let pg;
  try {
    pg = require("pg");
  } catch {
    throw new Error("pg package required — run npm install pg");
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }

  const after = {
    booking_documents: await headCount(sb, "booking_documents"),
    customer_documents: await headCount(sb, "customer_documents"),
    base44_active: await headCount(sb, "booking_documents", "source_system=eq.base44&is_active=eq.true").catch(() =>
      headCount(sb, "booking_documents", "source_system=eq.base44")
    )
  };

  return {
    phase: "migration",
    migration_file: MIGRATION_FILE,
    counts_before: before,
    counts_after: after,
    rows_removed: Math.max(0, before.booking_documents - after.booking_documents),
    customer_documents_changed: after.customer_documents - before.customer_documents
  };
}

async function verifyMigration(sb, dbUrl) {
  if (!dbUrl) throw new Error("DATABASE_URL required for schema verify");

  const columns = await pgQuery(
    dbUrl,
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'booking_documents'
       AND column_name = ANY($1::text[])`,
    // pg via query with array - use inline list instead
  ).catch(() => []);

  const columnRows = await pgQuery(
    dbUrl,
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'booking_documents'
       AND column_name IN (${REQUIRED_COLUMNS.map((c) => `'${c}'`).join(",")})`
  );

  const indexRows = await pgQuery(
    dbUrl,
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'booking_documents'
       AND indexname = 'booking_documents_base44_source_fingerprint_uidx'`
  );

  const bucketPublic = await pgQuery(
    dbUrl,
    `SELECT id, public FROM storage.buckets WHERE id = 'booking-documents'`
  );

  const duplicateGroups = await pgQuery(
    dbUrl,
    `SELECT COUNT(*)::int AS groups
     FROM (
       SELECT base44_booking_id, source_fingerprint
       FROM public.booking_documents
       WHERE source_system = 'base44'
         AND is_active = true
         AND source_fingerprint IS NOT NULL
         AND base44_booking_id IS NOT NULL
       GROUP BY base44_booking_id, source_fingerprint
       HAVING COUNT(*) > 1
     ) d`
  );

  const missingFingerprint = await pgQuery(
    dbUrl,
    `SELECT COUNT(*)::int AS count
     FROM public.booking_documents
     WHERE source_system = 'base44'
       AND source_fingerprint IS NULL`
  );

  const counts = {
    booking_documents: await headCount(sb, "booking_documents"),
    customer_documents: await headCount(sb, "customer_documents"),
    base44_active: await headCount(sb, "booking_documents", "source_system=eq.base44&is_active=eq.true"),
    base44_archived: await headCount(sb, "booking_documents", "source_system=eq.base44&is_active=eq.false")
  };

  const report = {
    phase: "verify",
    migration_file: MIGRATION_FILE,
    columns_present: columnRows.map((r) => r.column_name).sort(),
    columns_required: REQUIRED_COLUMNS.sort(),
    unique_index_exists: indexRows.length > 0,
    booking_documents_bucket_public: bucketPublic[0]?.public === true,
    duplicate_active_fingerprint_groups: duplicateGroups[0]?.groups ?? null,
    base44_rows_missing_fingerprint: missingFingerprint[0]?.count ?? null,
    counts,
    passed:
      columnRows.length === REQUIRED_COLUMNS.length &&
      indexRows.length > 0 &&
      bucketPublic[0]?.public !== true &&
      (duplicateGroups[0]?.groups ?? 0) === 0
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exit(1);
  return report;
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createSupabaseRest(root);
  const dbUrl = loadDatabaseUrl({ useNetlifyDb: args.useNetlifyDb });
  const results = [];

  if (args.audit) results.push(await runAudit(sb, dbUrl));
  if (args.applyMigration) results.push(await applyMigration({ useNetlifyDb: args.useNetlifyDb }));
  if (args.verify) results.push(await verifyMigration(sb, dbUrl));

  if (results.length > 1) {
    console.log(JSON.stringify({ summary: results.map((r) => r.phase) }, null, 2));
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
