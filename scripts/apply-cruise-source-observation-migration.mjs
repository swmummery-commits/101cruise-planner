#!/usr/bin/env node
/**
 * Apply cruise source observation state migration.
 *   node scripts/apply-cruise-source-observation-migration.mjs --verify
 *   node scripts/apply-cruise-source-observation-migration.mjs --apply-migration
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const MIGRATION_FILE = "supabase/migrations/20260823_cruise_source_observation_state.sql";

function parseArgs(argv) {
  const args = { verify: false, applyMigration: false, all: false, useNetlifyDb: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--verify") args.verify = true;
    if (arg === "--apply-migration") args.applyMigration = true;
    if (arg === "--all") args.all = true;
    if (arg === "--use-netlify-db") args.useNetlifyDb = true;
  }
  if (args.all) {
    args.verify = true;
    args.applyMigration = true;
  }
  if (!args.verify && !args.applyMigration) args.verify = true;
  return args;
}

function loadDatabaseUrl({ useNetlifyDb = false } = {}) {
  const candidates = [process.env.DATABASE_URL, process.env.SUPABASE_DB_URL, process.env.POSTGRES_URL, process.env.DIRECT_URL]
    .map((v) => String(v || "").trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  for (const c of candidates) {
    if (/^postgres(ql)?:\/\//i.test(c)) return c;
  }
  if (!useNetlifyDb) return "";
  try {
    const raw = execSync("npm exec -- netlify env:get DATABASE_URL --context production", {
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

async function verify(rest) {
  await rest.get("cruise_source_observation_state?select=id&limit=0");
  console.log("✓ table reachable: cruise_source_observation_state");
  const probe = await rest.post("rpc/advance_cruise_source_absence_observation", {
    p_cruise_line_id: "00000000-0000-0000-0000-000000000000",
    p_official_sailing_id: "__schema_probe__",
    p_source_health: "unhealthy"
  });
  if (probe?.reason !== "unhealthy_source") {
    throw new Error("unexpected RPC probe response");
  }
  console.log("✓ advance_cruise_source_absence_observation RPC");
}

function applyMigration({ useNetlifyDb = false } = {}) {
  const dbUrl = loadDatabaseUrl({ useNetlifyDb });
  if (!dbUrl) throw new Error("DATABASE_URL required for --apply-migration");
  const sqlPath = path.join(root, MIGRATION_FILE);
  execSync(`psql "${dbUrl}" -v ON_ERROR_STOP=1 -f "${sqlPath}"`, { stdio: "inherit" });
  console.log("✓ migration applied");
}

async function main() {
  const args = parseArgs(process.argv);
  const rest = createSupabaseRest(root);
  if (args.applyMigration) applyMigration({ useNetlifyDb: args.useNetlifyDb });
  if (args.verify) await verify(rest);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
