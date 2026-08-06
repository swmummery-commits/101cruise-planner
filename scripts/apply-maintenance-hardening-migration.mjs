#!/usr/bin/env node
/**
 * Apply maintenance hardening migration (locks + manifests tables).
 *   node scripts/apply-maintenance-hardening-migration.mjs --verify
 *   node scripts/apply-maintenance-hardening-migration.mjs --apply-migration
 *   node scripts/apply-maintenance-hardening-migration.mjs --all
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

const MIGRATION_FILE = "supabase/migrations/20260807_cruise_discovery_maintenance_hardening.sql";

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
  const candidates = [
    process.env.DATABASE_URL,
    process.env.SUPABASE_DB_URL,
    process.env.POSTGRES_URL,
    process.env.DIRECT_URL
  ]
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
  const checks = [
    "cruise_discovery_maintenance_locks?select=lock_key&limit=0",
    "cruise_discovery_maintenance_manifests?select=id&limit=0"
  ];
  for (const path of checks) {
    await rest.get(path);
    console.log(`✓ table reachable: ${path.split("?")[0]}`);
  }
  try {
    await rest.post("rpc/acquire_cruise_discovery_maintenance_lock", {
      p_lock_key: "__verify__",
      p_owner_id: "__verify__",
      p_lease_seconds: 60
    });
    await rest.request("cruise_discovery_maintenance_locks?lock_key=eq.__verify__", { method: "DELETE" });
    console.log("✓ acquire_cruise_discovery_maintenance_lock RPC");
  } catch (err) {
    console.error("✗ lock RPC:", err.message);
    throw err;
  }
}

function applyMigration({ useNetlifyDb = false } = {}) {
  const dbUrl = loadDatabaseUrl({ useNetlifyDb });
  if (!dbUrl) throw new Error("DATABASE_URL (direct Postgres) required for --apply-migration");
  const sqlPath = path.join(root, MIGRATION_FILE);
  if (!fs.existsSync(sqlPath)) throw new Error(`Missing ${MIGRATION_FILE}`);
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
