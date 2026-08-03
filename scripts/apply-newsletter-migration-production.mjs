#!/usr/bin/env node
/**
 * Pre-check, audit, apply, and verify newsletter migration on production.
 *
 *   node scripts/apply-newsletter-migration-production.mjs --audit
 *   node scripts/apply-newsletter-migration-production.mjs --apply-migration --use-netlify-db
 *   node scripts/apply-newsletter-migration-production.mjs --verify
 *   node scripts/apply-newsletter-migration-production.mjs --all --use-netlify-db
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.
 * Migration requires DATABASE_URL (direct Postgres — never logged).
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

const MIGRATION_FILE = "supabase/migrations/20260803_newsletters_table.sql";
const MIGRATION_VERSION = "20260803_newsletters_table";

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
  try {
    const netlifyBin =
      process.env.NETLIFY_CLI_BIN ||
      "/Users/stevemummery/.npm/_npx/5897f426ba328dd1/node_modules/.bin/netlify";
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
      const candidate = lines[i];
      if (/^postgres(ql)?:\/\//i.test(candidate)) return candidate;
    }
    return "";
  } catch {
    return "";
  }
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

async function fetchNewsletterCruiseRows(sb, { includeNewsletterId = false } = {}) {
  const select = includeNewsletterId
    ? "id,newsletter_number,newsletter_publication_date,newsletter_id"
    : "id,newsletter_number,newsletter_publication_date";
  const rows = [];
  let offset = 0;
  const limit = 1000;
  while (true) {
    const batch = await sb.get(
      `featured_cruises?select=${select}&newsletter_number=not.is.null&order=newsletter_number.asc&offset=${offset}&limit=${limit}`
    );
    if (!Array.isArray(batch) || !batch.length) break;
    rows.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return rows;
}

async function runAudit(sb) {
  const { url } = getSupabaseConfig(root);
  const projectRef = new URL(url).hostname.split(".")[0];
  const cruiseCount = await headCount(sb, "featured_cruises");
  const rows = await fetchNewsletterCruiseRows(sb);
  const byNum = new Map();
  for (const row of rows) {
    const num = row.newsletter_number;
    if (!byNum.has(num)) byNum.set(num, { dates: new Map(), total: 0 });
    const group = byNum.get(num);
    group.total += 1;
    if (row.newsletter_publication_date) {
      group.dates.set(
        row.newsletter_publication_date,
        (group.dates.get(row.newsletter_publication_date) || 0) + 1
      );
    }
  }

  const conflicts = [];
  for (const [newsletter_number, group] of byNum.entries()) {
    if (group.dates.size > 1) {
      conflicts.push({
        newsletter_number,
        conflicting_dates: [...group.dates.entries()].map(([date, cruise_count]) => ({ date, cruise_count }))
      });
    }
  }

  const report = {
    phase: "audit",
    project_ref: projectRef,
    featured_cruises_count: cruiseCount,
    newsletter_numbers_with_cruises: byNum.size,
    conflict_count: conflicts.length,
    conflicts,
    passed: conflicts.length === 0
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exit(2);
  return report;
}

async function applyMigration(options = {}) {
  const dbUrl = loadDatabaseUrl(options);
  if (!dbUrl) {
    throw new Error("DATABASE_URL is required (set env or pass --use-netlify-db)");
  }

  const sqlPath = path.join(root, MIGRATION_FILE);
  const sql = fs.readFileSync(sqlPath, "utf8");
  const executable = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .trim();

  let pg;
  try {
    pg = require("pg");
  } catch {
    throw new Error("pg package required — run npm install pg");
  }

  const sb = createSupabaseRest(root);
  const newslettersBefore = await headCount(sb, "newsletters").catch(() => 0);
  const before = {
    featured_cruises: await headCount(sb, "featured_cruises"),
    newsletters: newslettersBefore,
    linked_cruises: 0
  };

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(executable);
  } finally {
    await client.end();
  }

  const after = {
    featured_cruises: await headCount(sb, "featured_cruises"),
    newsletters: await headCount(sb, "newsletters"),
    linked_cruises: await headCount(sb, "featured_cruises", "newsletter_id=not.is.null")
  };

  return {
    phase: "migration",
    migration_version: MIGRATION_VERSION,
    sql_executed: MIGRATION_FILE,
    counts_before: before,
    counts_after: after,
    newsletter_records_created: Math.max(0, after.newsletters - before.newsletters),
    cruises_linked: after.linked_cruises
  };
}

async function verifyMigration(sb) {
  const https = require("https");
  const { url, key } = getSupabaseConfig(root);

  async function pgMeta(query) {
    let pg;
    try {
      pg = require("pg");
    } catch {
      throw new Error("pg package required for schema verify");
    }
    const dbUrl = loadDatabaseUrl({ useNetlifyDb: process.argv.includes("--use-netlify-db") });
    if (!dbUrl) throw new Error("DATABASE_URL required for schema verify");
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
      const res = await client.query(query);
      return res.rows;
    } finally {
      await client.end();
    }
  }

  const tableExists = await pgMeta(
    `SELECT to_regclass('public.newsletters') IS NOT NULL AS newsletters_exists`
  );
  const uniqueIdx = await pgMeta(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'newsletters' AND indexname = 'newsletters_number_uidx'`
  );
  const fk = await pgMeta(
    `SELECT conname, pg_get_constraintdef(oid) AS definition
     FROM pg_constraint
     WHERE conname = 'featured_cruises_newsletter_id_fkey'`
  );
  const column = await pgMeta(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'featured_cruises' AND column_name = 'newsletter_id'`
  );

  const newsletterCount = await headCount(sb, "newsletters");
  const linkedCount = await headCount(sb, "featured_cruises", "newsletter_id=not.is.null");
  const cruiseCount = await headCount(sb, "featured_cruises");
  const duplicateNewsletters = await pgMeta(
    `SELECT newsletter_number, COUNT(*) AS row_count
     FROM public.newsletters
     GROUP BY newsletter_number
     HAVING COUNT(*) > 1`
  );

  const sampleLinked = await sb.get(
    "featured_cruises?select=id,newsletter_number,newsletter_publication_date,newsletter_id&newsletter_id=not.is.null&limit=5"
  );

  const report = {
    phase: "verify",
    newsletters_table_exists: tableExists[0]?.newsletters_exists === true,
    unique_newsletter_number_index: uniqueIdx.length > 0,
    featured_cruises_newsletter_id_column: column.length > 0,
    newsletter_id_fk: fk[0] || null,
    fk_uses_on_delete_set_null: String(fk[0]?.definition || "").includes("ON DELETE SET NULL"),
    newsletter_count: newsletterCount,
    linked_cruise_count: linkedCount,
    featured_cruises_count: cruiseCount,
    duplicate_newsletter_rows: duplicateNewsletters,
    sample_linked_cruises: sampleLinked,
    passed:
      tableExists[0]?.newsletters_exists === true &&
      uniqueIdx.length > 0 &&
      column.length > 0 &&
      fk.length > 0 &&
      String(fk[0]?.definition || "").includes("ON DELETE SET NULL") &&
      duplicateNewsletters.length === 0
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exit(1);
  return report;
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createSupabaseRest(root);
  const results = [];

  if (args.audit) results.push(await runAudit(sb));
  if (args.applyMigration) results.push(await applyMigration({ useNetlifyDb: args.useNetlifyDb }));
  if (args.verify) results.push(await verifyMigration(sb));

  if (results.length > 1) {
    console.log(JSON.stringify({ summary: results.map((r) => r.phase) }, null, 2));
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
