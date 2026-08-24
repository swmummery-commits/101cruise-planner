#!/usr/bin/env node
/**
 * Apply empty-luggage-weight column on packing profile tables.
 *
 *   node scripts/apply-packing-empty-luggage-weight-migration.mjs --apply-migration --use-netlify-db
 *   node scripts/apply-packing-empty-luggage-weight-migration.mjs --verify
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const MIGRATION_FILE = "supabase/migrations/20260826_packing_empty_luggage_weight.sql";

function parseArgs(argv) {
  const args = { applyMigration: false, verify: false, useNetlifyDb: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--apply-migration") args.applyMigration = true;
    if (arg === "--verify") args.verify = true;
    if (arg === "--use-netlify-db") args.useNetlifyDb = true;
    if (arg === "--all") {
      args.applyMigration = true;
      args.verify = true;
    }
  }
  if (!args.applyMigration && !args.verify) args.verify = true;
  return args;
}

function isPostgresUrl(value) {
  const v = String(value || "").trim().replace(/^["']|["']$/g, "");
  return /^postgres(ql)?:\/\//i.test(v) && !/^\*+/.test(v);
}

function netlifyEnvListJson() {
  const netlifyBin =
    process.env.NETLIFY_CLI_BIN ||
    "/Users/stevemummery/.npm/_npx/5897f426ba328dd1/node_modules/.bin/netlify";
  const raw = execSync(`${netlifyBin} env:list --context production --json`, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 240000
  });
  const start = raw.indexOf("{");
  if (start < 0) return {};
  return JSON.parse(raw.slice(start));
}

function loadDatabaseUrl({ useNetlifyDb = false } = {}) {
  const candidates = [process.env.DATABASE_URL, process.env.SUPABASE_DB_URL, process.env.POSTGRES_URL, process.env.DIRECT_URL]
    .map((value) => String(value || "").trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  for (const candidate of candidates) {
    if (isPostgresUrl(candidate)) return candidate;
  }
  if (!useNetlifyDb) return "";
  const env = netlifyEnvListJson();
  for (const key of ["DIRECT_URL", "SUPABASE_DB_URL", "POSTGRES_URL", "DATABASE_URL"]) {
    const value = String(env[key] || "").trim().replace(/^["']|["']$/g, "");
    if (isPostgresUrl(value)) return value;
  }
  return "";
}

async function columnExists(table) {
  const { url, key } = getSupabaseConfig(root);
  const response = await fetch(`${url}/rest/v1/${table}?select=empty_luggage_weight_kg&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  if (response.ok) return true;
  const body = await response.text();
  if (/does not exist|PGRST205|PGRST204|42703/i.test(body)) return false;
  throw new Error(`${table} probe failed: ${response.status} ${body.slice(0, 180)}`);
}

async function applyMigration(options) {
  const dbUrl = loadDatabaseUrl(options);
  if (!dbUrl) throw new Error("DATABASE_URL required (--use-netlify-db or env)");
  const sql = fs.readFileSync(path.join(root, MIGRATION_FILE), "utf8");
  const { Client } = require("pg");
  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.applyMigration) {
    await applyMigration(args);
    console.log("applied", MIGRATION_FILE);
  }
  const customer = await columnExists("customer_packing_profiles");
  let planner = false;
  try {
    planner = await columnExists("user_packing_v2_profiles");
  } catch {
    planner = false;
  }
  const report = {
    customer_packing_profiles: customer,
    user_packing_v2_profiles: planner,
    passed: customer === true
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exit(1);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
