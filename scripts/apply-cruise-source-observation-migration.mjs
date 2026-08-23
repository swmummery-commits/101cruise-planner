#!/usr/bin/env node
/**
 * Apply cruise source observation state migration (M4A infrastructure only).
 *   node scripts/apply-cruise-source-observation-migration.mjs --verify
 *   node scripts/apply-cruise-source-observation-migration.mjs --apply-migration --use-netlify-db
 *   node scripts/apply-cruise-source-observation-migration.mjs --all --use-netlify-db
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const MIGRATION_FILE = "supabase/migrations/20260823_cruise_source_observation_state.sql";
const SILVERSEA_LINE_SLUG = "silversea-cruises";

function parseArgs(argv) {
  const args = { verify: false, applyMigration: false, audit: false, all: false, useNetlifyDb: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--verify") args.verify = true;
    if (arg === "--apply-migration") args.applyMigration = true;
    if (arg === "--audit") args.audit = true;
    if (arg === "--all") args.all = true;
    if (arg === "--use-netlify-db") args.useNetlifyDb = true;
  }
  if (args.all) {
    args.verify = true;
    args.applyMigration = true;
  }
  if (!args.verify && !args.applyMigration && !args.audit) args.verify = true;
  return args;
}

function projectRefFromUrl(rawUrl) {
  try {
    const host = new URL(String(rawUrl || "")).hostname;
    const ref = host.split(".")[0];
    return ref || null;
  } catch {
    return null;
  }
}

function isPostgresUrl(value) {
  const v = String(value || "").trim().replace(/^["']|["']$/g, "");
  return /^postgres(ql)?:\/\//i.test(v) && !/^\*+/.test(v);
}

function loadDatabaseUrl({ useNetlifyDb = false } = {}) {
  const envCandidates = [
    process.env.DIRECT_URL,
    process.env.SUPABASE_DB_URL,
    process.env.POSTGRES_URL,
    process.env.DATABASE_URL
  ];
  for (const c of envCandidates) {
    if (isPostgresUrl(c)) return String(c).trim().replace(/^["']|["']$/g, "");
  }
  if (!useNetlifyDb) return "";
  const netlifyBin =
    process.env.NETLIFY_CLI_BIN ||
    "/Users/stevemummery/.npm/_npx/5897f426ba328dd1/node_modules/.bin/netlify";
  const netlifyKeys = ["DIRECT_URL", "SUPABASE_DB_URL", "POSTGRES_URL", "DATABASE_URL"];
  for (const key of netlifyKeys) {
    try {
      const raw = execSync(`${netlifyBin} env:get ${key} --context production`, {
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
        if (isPostgresUrl(lines[i])) return lines[i];
      }
    } catch {
      /* try next key */
    }
  }
  return "";
}

function verifyProductionTarget(dbUrl) {
  const { url: supabaseUrl } = getSupabaseConfig(root);
  const restRef = projectRefFromUrl(supabaseUrl);
  const dbRef = projectRefFromUrl(dbUrl);
  if (!restRef || !dbRef || restRef !== dbRef) {
    throw new Error(
      `production_db_target_mismatch: rest=${restRef || "unknown"} db=${dbRef || "unknown"}`
    );
  }
  return { project_ref: restRef, verified: true };
}

async function pgClient(dbUrl) {
  let pg;
  try {
    pg = require("pg");
  } catch {
    throw new Error("pg package required — run npm install pg");
  }
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  return client;
}

async function auditObservationStore(rest) {
  let tablePresent = true;
  try {
    await rest.get("cruise_source_observation_state?select=id&limit=0");
  } catch (err) {
    if (String(err.message || err).includes("schema cache") || String(err.message || err).includes("PGRST")) {
      tablePresent = false;
    } else {
      throw err;
    }
  }

  let silverseaRows = null;
  if (tablePresent) {
    const line = (
      await rest.get(`ci_cruise_lines?slug=eq.${SILVERSEA_LINE_SLUG}&select=id&limit=1`)
    )?.[0];
    if (line?.id) {
      silverseaRows = await rest.get(
        `cruise_source_observation_state?cruise_line_id=eq.${line.id}&select=id,official_sailing_id,observation_type,consecutive_healthy_absence_count&limit=100`
      );
    }
  }

  const report = {
    observation_table_present: tablePresent,
    silversea_observation_rows: Array.isArray(silverseaRows) ? silverseaRows.length : null,
    sn280222c25_row: Array.isArray(silverseaRows)
      ? silverseaRows.find((r) => String(r.official_sailing_id).toUpperCase() === "SN280222C25") || null
      : null
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

async function verify(rest) {
  await rest.get("cruise_source_observation_state?select=id&limit=0");
  console.log("✓ table reachable: cruise_source_observation_state");

  const probe = await rest.post("rpc/advance_cruise_source_absence_observation", {
    p_cruise_line_id: "00000000-0000-0000-0000-000000000000",
    p_official_sailing_id: "__schema_probe__",
    p_source_health: "unhealthy"
  });
  if (probe?.reason !== "unhealthy_source" || probe?.advanced !== false) {
    throw new Error("unexpected advance RPC unhealthy probe response");
  }
  console.log("✓ advance_cruise_source_absence_observation RPC (unhealthy probe, no write)");

  const dbUrl = loadDatabaseUrl({ useNetlifyDb: false });
  if (dbUrl) {
    const client = await pgClient(dbUrl);
    try {
      const fn = await client.query(
        `SELECT proname FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND proname = 'resolve_cruise_source_absence_observation'`
      );
      if (!fn.rows.length) throw new Error("resolve_cruise_source_absence_observation missing");
      console.log("✓ resolve_cruise_source_absence_observation present");
    } finally {
      await client.end();
    }
  } else {
    console.log("✓ resolve RPC assumed present (no DATABASE_URL for pg catalog check)");
  }
}

async function applyMigration({ useNetlifyDb = false } = {}) {
  const dbUrl = loadDatabaseUrl({ useNetlifyDb });
  if (!dbUrl) throw new Error("DATABASE_URL required for --apply-migration");
  const target = verifyProductionTarget(dbUrl);
  console.log(`✓ production DB target verified: ${target.project_ref}`);

  const sqlPath = path.join(root, MIGRATION_FILE);
  if (!fs.existsSync(sqlPath)) throw new Error(`Missing ${MIGRATION_FILE}`);
  const sql = fs.readFileSync(sqlPath, "utf8");

  const client = await pgClient(dbUrl);
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
  console.log("✓ migration applied via pg");
}

async function main() {
  const args = parseArgs(process.argv);
  const rest = createSupabaseRest(root);
  if (args.audit) await auditObservationStore(rest);
  if (args.applyMigration) await applyMigration({ useNetlifyDb: args.useNetlifyDb });
  if (args.verify) await verify(rest);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
