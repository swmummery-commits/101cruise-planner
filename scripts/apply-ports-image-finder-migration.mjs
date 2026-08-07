#!/usr/bin/env node
/**
 * Apply and verify Port Image Finder migration on production.
 *
 *   node scripts/apply-ports-image-finder-migration.mjs --audit --use-netlify-db
 *   node scripts/apply-ports-image-finder-migration.mjs --apply-migration --use-netlify-db
 *   node scripts/apply-ports-image-finder-migration.mjs --verify --use-netlify-db
 *   node scripts/apply-ports-image-finder-migration.mjs --all --use-netlify-db
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const MIGRATION_FILE = "supabase/migrations/20260807_ports_image_finder.sql";

const REQUIRED_COLUMNS = [
  "hero_media_id",
  "image_status",
  "image_source",
  "image_source_url",
  "image_credit",
  "image_license",
  "image_search_query",
  "image_confidence",
  "image_last_checked_at",
  "image_candidates"
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

async function runAudit(sb, dbUrl) {
  const ports = await sb.get("ports?select=id&limit=1");
  const countRows = dbUrl
    ? await pgQuery(dbUrl, "SELECT COUNT(*)::int AS count FROM public.ports")
    : [{ count: ports?.length ?? 0 }];

  const existingCols = dbUrl
    ? await pgQuery(
        dbUrl,
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'ports'
           AND column_name = ANY(ARRAY[${REQUIRED_COLUMNS.map((c) => `'${c}'`).join(",")}])`
      )
    : [];

  const report = {
    phase: "audit",
    migration_file: MIGRATION_FILE,
    ports_table_reachable: true,
    ports_count: countRows[0]?.count ?? null,
    image_columns_already_present: existingCols.map((r) => r.column_name).sort(),
    migration_needed: existingCols.length < REQUIRED_COLUMNS.length,
    passed: true
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

async function applyMigration(options = {}) {
  const dbUrl = loadDatabaseUrl(options);
  if (!dbUrl) throw new Error("DATABASE_URL required (--use-netlify-db or env)");

  const sb = createSupabaseRest(root);
  const beforeRows = await pgQuery(dbUrl, "SELECT COUNT(*)::int AS count FROM public.ports");
  const sql = fs.readFileSync(path.join(root, MIGRATION_FILE), "utf8");

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

  const afterRows = await pgQuery(dbUrl, "SELECT COUNT(*)::int AS count FROM public.ports");
  void sb;

  return {
    phase: "migration",
    migration_file: MIGRATION_FILE,
    ports_count_before: beforeRows[0]?.count ?? null,
    ports_count_after: afterRows[0]?.count ?? null,
    ports_preserved: beforeRows[0]?.count === afterRows[0]?.count
  };
}

async function verifyMigration(dbUrl) {
  if (!dbUrl) throw new Error("DATABASE_URL required for schema verify");

  const columnRows = await pgQuery(
    dbUrl,
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'ports'
       AND column_name IN (${REQUIRED_COLUMNS.map((c) => `'${c}'`).join(",")})`
  );

  const indexRows = await pgQuery(
    dbUrl,
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'ports'
       AND indexname IN ('ports_hero_media_idx', 'ports_image_status_idx', 'ports_image_last_checked_idx')`
  );

  const constraintRows = await pgQuery(
    dbUrl,
    `SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.ports'::regclass
       AND conname IN ('ports_image_status_check', 'ports_image_confidence_range', 'ports_image_candidates_is_array')`
  );

  const sample = await pgQuery(
    dbUrl,
    `SELECT id, canonical_name, hero_media_id, image_status
     FROM public.ports ORDER BY canonical_name ASC LIMIT 3`
  );

  const report = {
    phase: "verify",
    migration_file: MIGRATION_FILE,
    columns_present: columnRows.map((r) => r.column_name).sort(),
    columns_required: [...REQUIRED_COLUMNS].sort(),
    indexes_present: indexRows.map((r) => r.indexname).sort(),
    constraints_present: constraintRows.map((r) => r.conname).sort(),
    sample_ports: sample,
    passed:
      columnRows.length === REQUIRED_COLUMNS.length &&
      indexRows.length >= 2 &&
      constraintRows.length === 3
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
  if (args.applyMigration) {
    const applied = await applyMigration({ useNetlifyDb: args.useNetlifyDb });
    console.log(JSON.stringify(applied, null, 2));
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
