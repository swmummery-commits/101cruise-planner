#!/usr/bin/env node
/**
 * Apply and verify newsletter_email_assets mapping table.
 *
 *   node scripts/apply-newsletter-email-assets-migration.mjs --audit --use-netlify-db
 *   node scripts/apply-newsletter-email-assets-migration.mjs --apply-migration --use-netlify-db
 *   node scripts/apply-newsletter-email-assets-migration.mjs --verify --use-netlify-db
 *   node scripts/apply-newsletter-email-assets-migration.mjs --all --use-netlify-db
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const MIGRATION_FILE = "supabase/migrations/20260818_newsletter_email_assets.sql";
const REQUIRED_COLUMNS = [
  "newsletter_id",
  "variant_scope",
  "asset_type",
  "source_url",
  "source_url_normalized",
  "source_checksum",
  "mailchimp_file_id",
  "mailchimp_file_url",
  "mailchimp_folder_id",
  "generated_filename"
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

async function snapshotExistingData(dbUrl) {
  const rows = await pgQuery(
    dbUrl,
    `
    SELECT
      (SELECT COUNT(*)::int FROM public.newsletters) AS newsletters,
      (SELECT COUNT(*)::int FROM public.featured_cruises) AS featured_cruises,
      (SELECT COUNT(*)::int FROM public.featured_cruises WHERE newsletter_id IS NOT NULL) AS featured_cruises_linked,
      (SELECT COALESCE(MAX(updated_at), 'epoch'::timestamptz) FROM public.newsletters) AS newsletters_max_updated_at,
      (SELECT COALESCE(MAX(updated_at), 'epoch'::timestamptz) FROM public.featured_cruises) AS featured_cruises_max_updated_at,
      (SELECT to_regclass('public.newsletter_email_assets') IS NOT NULL) AS email_assets_table_exists,
      (
        SELECT CASE
          WHEN to_regclass('public.newsletter_email_assets') IS NULL THEN 0
          ELSE (SELECT COUNT(*)::int FROM public.newsletter_email_assets)
        END
      ) AS newsletter_email_assets
    `
  );
  const row = rows[0] || {};
  return {
    newsletters: row.newsletters ?? null,
    featured_cruises: row.featured_cruises ?? null,
    featured_cruises_linked: row.featured_cruises_linked ?? null,
    newsletters_max_updated_at: row.newsletters_max_updated_at
      ? new Date(row.newsletters_max_updated_at).toISOString()
      : null,
    featured_cruises_max_updated_at: row.featured_cruises_max_updated_at
      ? new Date(row.featured_cruises_max_updated_at).toISOString()
      : null,
    email_assets_table_exists: Boolean(row.email_assets_table_exists),
    newsletter_email_assets: row.newsletter_email_assets ?? 0
  };
}

async function runAudit(dbUrl) {
  if (!dbUrl) throw new Error("DATABASE_URL required for production audit (--use-netlify-db or env)");
  const snapshot = await snapshotExistingData(dbUrl);
  const existingCols = snapshot.email_assets_table_exists
    ? await pgQuery(
        dbUrl,
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'newsletter_email_assets'
           AND column_name = ANY(ARRAY[${REQUIRED_COLUMNS.map((c) => `'${c}'`).join(",")}])`
      )
    : [];
  const report = {
    phase: "audit",
    migration_file: MIGRATION_FILE,
    counts_before: snapshot,
    columns_already_present: existingCols.map((r) => r.column_name).sort(),
    migration_needed: existingCols.length < REQUIRED_COLUMNS.length,
    passed: true
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

async function applyMigration(options = {}) {
  const dbUrl = loadDatabaseUrl(options);
  if (!dbUrl) throw new Error("DATABASE_URL required (--use-netlify-db or env)");
  const sql = fs.readFileSync(path.join(root, MIGRATION_FILE), "utf8");
  let pg;
  try {
    pg = require("pg");
  } catch {
    throw new Error("pg package required — run npm install pg");
  }
  const before = await snapshotExistingData(dbUrl);
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
  const after = await snapshotExistingData(dbUrl);
  const preserved =
    before.newsletters === after.newsletters &&
    before.featured_cruises === after.featured_cruises &&
    before.featured_cruises_linked === after.featured_cruises_linked &&
    before.newsletters_max_updated_at === after.newsletters_max_updated_at &&
    before.featured_cruises_max_updated_at === after.featured_cruises_max_updated_at;
  return {
    phase: "migration",
    migration_file: MIGRATION_FILE,
    applied: true,
    counts_before: before,
    counts_after: after,
    existing_data_preserved: preserved
  };
}

async function verifyMigration(dbUrl) {
  if (!dbUrl) throw new Error("DATABASE_URL required for schema verify");
  const snapshot = await snapshotExistingData(dbUrl);
  const columnRows = await pgQuery(
    dbUrl,
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'newsletter_email_assets'
       AND column_name IN (${REQUIRED_COLUMNS.map((c) => `'${c}'`).join(",")})`
  );
  const constraintRows = await pgQuery(
    dbUrl,
    `SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.newsletter_email_assets'::regclass
       AND conname IN (
         'newsletter_email_assets_variant_scope_check',
         'newsletter_email_assets_asset_type_check',
         'newsletter_email_assets_newsletter_checksum_key',
         'newsletter_email_assets_newsletter_id_fkey'
       )`
  );
  const rls = await pgQuery(
    dbUrl,
    `SELECT relrowsecurity
     FROM pg_class
     WHERE oid = 'public.newsletter_email_assets'::regclass`
  );
  const report = {
    phase: "verify",
    migration_file: MIGRATION_FILE,
    table_exists: snapshot.email_assets_table_exists,
    columns_present: columnRows.map((r) => r.column_name).sort(),
    columns_required: [...REQUIRED_COLUMNS].sort(),
    constraints_present: constraintRows.map((r) => r.conname).sort(),
    rls_enabled: rls[0]?.relrowsecurity === true,
    newsletter_email_assets_row_count: snapshot.newsletter_email_assets,
    existing_counts: {
      newsletters: snapshot.newsletters,
      featured_cruises: snapshot.featured_cruises,
      featured_cruises_linked: snapshot.featured_cruises_linked
    },
    passed:
      snapshot.email_assets_table_exists &&
      columnRows.length === REQUIRED_COLUMNS.length &&
      rls[0]?.relrowsecurity === true &&
      snapshot.newsletter_email_assets === 0
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exit(1);
  return report;
}

async function main() {
  const args = parseArgs(process.argv);
  const dbUrl = loadDatabaseUrl({ useNetlifyDb: args.useNetlifyDb });
  const results = [];
  if (args.audit) results.push(await runAudit(dbUrl));
  if (args.applyMigration) {
    const applied = await applyMigration({ useNetlifyDb: args.useNetlifyDb });
    console.log(JSON.stringify(applied, null, 2));
    if (applied.existing_data_preserved === false) {
      console.error("Existing newsletter/featured_cruise counts or timestamps changed.");
      process.exit(1);
    }
    results.push(applied);
  }
  if (args.verify) results.push(await verifyMigration(dbUrl));
  if (results.length > 1) {
    console.log(JSON.stringify({ summary: results.map((r) => r.phase) }, null, 2));
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
