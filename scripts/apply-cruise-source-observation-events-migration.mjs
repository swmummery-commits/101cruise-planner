#!/usr/bin/env node
/**
 * Apply M7A cruise source observation events migration only.
 *   node scripts/apply-cruise-source-observation-events-migration.mjs --audit
 *   node scripts/apply-cruise-source-observation-events-migration.mjs --apply-migration --use-netlify-db
 *   node scripts/apply-cruise-source-observation-events-migration.mjs --verify
 *
 * Does NOT use Supabase CLI bulk migration commands.
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const MIGRATION_FILE = "supabase/migrations/20260824_cruise_source_observation_events.sql";
const M4_MIGRATION_FILE = "supabase/migrations/20260823_cruise_source_observation_state.sql";
const SILVERSEA_LINE_SLUG = "silversea-cruises";
const SN_CANARY = "SN280222C25";

function parseArgs(argv) {
  const args = {
    verify: false,
    applyMigration: false,
    applyM7bOnly: false,
    audit: false,
    all: false,
    useNetlifyDb: false
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--verify") args.verify = true;
    if (arg === "--apply-migration") args.applyMigration = true;
    if (arg === "--apply-m7b-only") args.applyM7bOnly = true;
    if (arg === "--audit") args.audit = true;
    if (arg === "--all") args.all = true;
    if (arg === "--use-netlify-db") args.useNetlifyDb = true;
  }
  if (args.all) {
    args.verify = true;
    args.applyMigration = true;
  }
  if (!args.verify && !args.applyMigration && !args.applyM7bOnly && !args.audit) args.audit = true;
  return args;
}

function projectRefFromUrl(rawUrl) {
  try {
    const host = new URL(String(rawUrl || "")).hostname;
    const parts = host.split(".");
    if (parts[0] === "db" && parts.length >= 3) return parts[1] || null;
    if (parts[0] === "postgres" && parts.length >= 2 && parts[1]) return parts[1].split("-")[0] || parts[1];
    return parts[0] || null;
  } catch {
    return null;
  }
}

function isPostgresUrl(value) {
  const v = String(value || "").trim().replace(/^["']|["']$/g, "");
  return /^postgres(ql)?:\/\//i.test(v) && !/^\*+/.test(v);
}

function netlifyEnvGet(key) {
  const netlifyBin =
    process.env.NETLIFY_CLI_BIN ||
    "/Users/stevemummery/.npm/_npx/5897f426ba328dd1/node_modules/.bin/netlify";
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
      const line = lines[i];
      if (line && !/^\*+$/.test(line)) return line;
    }
  } catch {
    /* ignore */
  }
  return "";
}

function normalizePostgresUrl(value) {
  const v = String(value || "").trim().replace(/^["']|["']$/g, "");
  if (!v || /^\*+$/.test(v)) return "";
  if (isPostgresUrl(v)) return v;
  if (/^postgres(ql)?:/i.test(v)) return v.startsWith("postgres://") ? v.replace(/^postgres:\/\//i, "postgresql://") : v;
  if (/@/.test(v) && /\.supabase\./i.test(v)) {
    return v.startsWith("//") ? `postgresql:${v}` : `postgresql://${v.replace(/^\/\//, "")}`;
  }
  return "";
}

function buildDatabaseUrlFromPassword({ useNetlifyDb = false } = {}) {
  let supabaseUrl = "";
  try {
    supabaseUrl = getSupabaseConfig(root).url;
  } catch {
    if (useNetlifyDb) supabaseUrl = netlifyEnvGet("SUPABASE_URL");
  }
  const ref = projectRefFromUrl(supabaseUrl);
  if (!ref) return "";

  const passwordKeys = ["SUPABASE_DB_PASSWORD", "DB_PASSWORD", "POSTGRES_PASSWORD", "PGPASSWORD"];
  for (const key of passwordKeys) {
    let secret = normalizePostgresUrl(process.env[key]);
    if (!secret && useNetlifyDb) secret = normalizePostgresUrl(netlifyEnvGet(key));
    if (isPostgresUrl(secret)) return secret;
    let password = String(process.env[key] || "").trim().replace(/^["']|["']$/g, "");
    if (!password && useNetlifyDb) password = netlifyEnvGet(key);
    if (!password || /^\*+$/.test(password)) continue;
    const encoded = encodeURIComponent(password);
    return `postgresql://postgres:${encoded}@db.${ref}.supabase.co:5432/postgres`;
  }
  return "";
}

function loadDatabaseUrl({ useNetlifyDb = false } = {}) {
  const envCandidates = [
    process.env.DIRECT_URL,
    process.env.SUPABASE_DB_URL,
    process.env.POSTGRES_URL,
    process.env.DATABASE_URL
  ];
  for (const c of envCandidates) {
    const normalized = normalizePostgresUrl(c);
    if (isPostgresUrl(normalized)) return normalized;
  }
  if (useNetlifyDb) {
    for (const key of ["DIRECT_URL", "SUPABASE_DB_URL", "POSTGRES_URL", "DATABASE_URL"]) {
      const normalized = normalizePostgresUrl(netlifyEnvGet(key));
      if (isPostgresUrl(normalized)) return normalized;
    }
  }
  return buildDatabaseUrlFromPassword({ useNetlifyDb });
}

function verifyProductionTarget(dbUrl) {
  const { url: supabaseUrl } = getSupabaseConfig(root);
  const restRef = projectRefFromUrl(supabaseUrl);
  const dbRef = projectRefFromUrl(dbUrl);
  if (!restRef || !dbRef || restRef !== dbRef) {
    throw new Error(`production_db_target_mismatch: rest=${restRef || "unknown"} db=${dbRef || "unknown"}`);
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

async function audit(rest) {
  let eventTablePresent = false;
  let eventCount = null;
  try {
    const rows = await rest.get("cruise_source_observation_events?select=id&limit=1");
    eventTablePresent = true;
    eventCount = Array.isArray(rows) ? rows.length : 0;
  } catch (err) {
    if (!String(err.message || err).includes("schema cache") && !String(err.message || err).includes("PGRST")) {
      throw err;
    }
  }

  const line = (await rest.get(`ci_cruise_lines?slug=eq.${SILVERSEA_LINE_SLUG}&select=id&limit=1`))?.[0];
  let snState = null;
  let snEvents = null;
  if (line?.id) {
    snState = (
      await rest.get(
        `cruise_source_observation_state?cruise_line_id=eq.${line.id}&official_sailing_id=eq.${SN_CANARY}&select=*&limit=1`
      )
    )?.[0];
    if (eventTablePresent) {
      try {
        snEvents = await rest.get(
          `cruise_source_observation_events?official_sailing_id=eq.${SN_CANARY}&select=id&limit=10`
        );
      } catch {
        snEvents = [];
      }
    }
  }

  const report = {
    event_table_present: eventTablePresent,
    event_table_row_probe: eventCount,
    sn280222c25_state: snState || null,
    sn280222c25_event_count: Array.isArray(snEvents) ? snEvents.length : null,
    m4_migration_modified: false,
    m7a_migration_file: MIGRATION_FILE
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

async function verify(rest, dbUrl) {
  await rest.get("cruise_source_observation_events?select=id&limit=0");
  console.log("✓ event table reachable");

  const probe = await rest.post("rpc/advance_cruise_source_absence_observation", {
    p_cruise_line_id: "00000000-0000-0000-0000-000000000000",
    p_official_sailing_id: "__schema_probe__",
    p_source_health: "unhealthy"
  });
  if (probe?.reason !== "unhealthy_source" || probe?.advanced !== false) {
    throw new Error("unexpected advance RPC unhealthy probe");
  }
  console.log("✓ advance RPC unhealthy probe (no write)");

  if (dbUrl) {
    const client = await pgClient(dbUrl);
    try {
      const trig = await client.query(
        `SELECT tgname FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname = 'cruise_source_observation_events'
           AND NOT t.tgisinternal`
      );
      const names = trig.rows.map((r) => r.tgname);
      if (!names.some((n) => n.includes("immutable"))) throw new Error("immutable trigger missing");
      console.log("✓ append-only trigger present");

      const idx = await client.query(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'cruise_source_observation_events'`
      );
      const indexNames = idx.rows.map((r) => r.indexname);
      if (!indexNames.some((n) => n.includes("unique_week"))) throw new Error("week unique index missing");
      if (!indexNames.some((n) => n.includes("unique_snapshot"))) throw new Error("snapshot unique index missing");
      console.log("✓ partial unique indexes present");
    } finally {
      await client.end();
    }
  }
}

async function applyMigration({ useNetlifyDb = false } = {}) {
  const dbUrl = loadDatabaseUrl({ useNetlifyDb });
  if (!dbUrl) throw new Error("DATABASE_URL required for --apply-migration");
  verifyProductionTarget(dbUrl);

  const sqlPath = path.join(root, MIGRATION_FILE);
  if (!fs.existsSync(sqlPath)) throw new Error(`Missing ${MIGRATION_FILE}`);
  const m4Path = path.join(root, M4_MIGRATION_FILE);
  const m4Before = fs.readFileSync(m4Path, "utf8");
  const sql = fs.readFileSync(sqlPath, "utf8");
  if (sql.includes("ALTER TABLE public.cruise_source_observation_state") && /DROP TABLE/i.test(sql)) {
    throw new Error("M7A migration must not drop observation state table");
  }

  const client = await pgClient(dbUrl);
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }

  const m4After = fs.readFileSync(m4Path, "utf8");
  if (m4Before !== m4After) throw new Error("M4 migration file changed during apply — abort");
  console.log("✓ M7A migration applied via pg (M4 file unchanged)");
}

async function applyM7bMigration({ useNetlifyDb = false } = {}) {
  const dbUrl = loadDatabaseUrl({ useNetlifyDb });
  if (!dbUrl) throw new Error("DATABASE_URL required for M7B migration apply");
  verifyProductionTarget(dbUrl);
  const m7bPath = path.join(root, "supabase/migrations/20260825_silversea_m4b_historical_observation_event_rpc.sql");
  if (!fs.existsSync(m7bPath)) throw new Error("Missing M7B migration file");
  const client = await pgClient(dbUrl);
  try {
    await client.query(fs.readFileSync(m7bPath, "utf8"));
    console.log("✓ M7B historical backfill RPC migration applied via pg");
  } finally {
    await client.end();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const rest = createSupabaseRest(root);
  if (args.audit) await audit(rest);
  if (args.applyMigration) {
    await applyMigration({ useNetlifyDb: args.useNetlifyDb });
    await applyM7bMigration({ useNetlifyDb: args.useNetlifyDb });
  } else if (args.applyM7bOnly) {
    await applyM7bMigration({ useNetlifyDb: args.useNetlifyDb });
  }
  if (args.verify) {
    const dbUrl = loadDatabaseUrl({ useNetlifyDb: args.useNetlifyDb });
    await verify(rest, dbUrl);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
