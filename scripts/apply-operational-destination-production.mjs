#!/usr/bin/env node
/**
 * Apply approved operational destination migration + seed to production.
 *
 *   node scripts/apply-operational-destination-production.mjs --precheck
 *   node scripts/apply-operational-destination-production.mjs --apply-migration
 *   node scripts/apply-operational-destination-production.mjs --apply-seed
 *   node scripts/apply-operational-destination-production.mjs --all
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.
 * Migration requires DATABASE_URL (direct Postgres — not logged).
 * No cruise, alias, review, or Discovery writes beyond approved destination seed rows.
 */

import fs from "fs";
import crypto from "crypto";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const MIGRATION_FILE = "supabase/migrations/20260802_destination_classification.sql";
const MIGRATION_VERSION = "20260802_destination_classification";
const SEED_MANIFEST_PATH = path.join(root, "reports/operational-destination-seed-manifest.json");
const ALASKA_ID = "c8eb51fa-aeca-4d93-9bd9-bfe8ce66a83c";
const EXPECTED_TOTAL = 20;
const EXPECTED_PUBLISHED = 1;
const EXPECTED_DRAFT = 19;

function parseArgs(argv) {
  const args = {
    precheck: false,
    applyMigration: false,
    applySeed: false,
    verify: false,
    all: false,
    rollback: false,
    useNetlifyDb: false
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--precheck") args.precheck = true;
    if (arg === "--apply-migration") args.applyMigration = true;
    if (arg === "--apply-seed") args.applySeed = true;
    if (arg === "--verify") args.verify = true;
    if (arg === "--all") args.all = true;
    if (arg === "--rollback") args.rollback = true;
    if (arg === "--use-netlify-db") args.useNetlifyDb = true;
  }
  if (args.all) {
    args.precheck = true;
    args.applyMigration = true;
    args.applySeed = true;
    args.verify = true;
  }
  if (!args.precheck && !args.applyMigration && !args.applySeed && !args.verify && !args.rollback) {
    args.precheck = true;
  }
  return args;
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
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

function projectRefFromUrl(url) {
  try {
    return new URL(url).hostname.split(".")[0];
  } catch {
    return null;
  }
}

async function columnExists(sb, column) {
  try {
    await sb.get(`destinations?select=${column}&limit=1`);
    return true;
  } catch (err) {
    const msg = String(err.message || "").toLowerCase();
    if (msg.includes(column.toLowerCase()) && msg.includes("does not exist")) return false;
    throw err;
  }
}

async function fetchTableCounts(sb) {
  const tables = [
    "destinations",
    "destination_ports",
    "cruise_destination_aliases",
    "discovered_cruises",
    "discovered_cruise_destinations",
    "cruise_discovery_review_items",
    "cruise_ship_aliases",
    "cruise_discovery_resolution_audit"
  ];
  const out = {};
  for (const table of tables) {
    const rows = await sb.get(`${table}?select=id&limit=1`);
    const countHeader = rows?._count;
    void countHeader;
    const res = await sb.request(`${table}?select=id`, { method: "HEAD", prefer: "count=exact" }).catch(() => null);
    if (res && typeof res === "number") {
      out[table] = res;
      continue;
    }
    const all = await sb.get(`${table}?select=id&limit=5000`);
    out[table] = Array.isArray(all) ? all.length : 0;
  }
  return out;
}

async function headCount(sb, table) {
  return new Promise((resolve, reject) => {
    const https = require("https");
    const { url, key } = getSupabaseConfig(root);
    const u = new URL(`${url}/rest/v1/${table}?select=id`);
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

async function fetchAllCounts(sb) {
  const tables = [
    "destinations",
    "destination_ports",
    "cruise_destination_aliases",
    "discovered_cruises",
    "discovered_cruise_destinations",
    "cruise_discovery_review_items",
    "cruise_ship_aliases",
    "cruise_discovery_resolution_audit"
  ];
  const out = {};
  for (const table of tables) {
    out[table] = await headCount(sb, table);
  }
  return out;
}

function loadSeedManifest() {
  if (!fs.existsSync(SEED_MANIFEST_PATH)) {
    throw new Error(`Seed manifest missing: ${SEED_MANIFEST_PATH}`);
  }
  const manifest = JSON.parse(fs.readFileSync(SEED_MANIFEST_PATH, "utf8"));
  return manifest;
}

function validateManifest(manifest) {
  const entries = manifest.entries || [];
  if (entries.length !== EXPECTED_TOTAL) {
    throw new Error(`Manifest entry_count ${entries.length} !== ${EXPECTED_TOTAL}`);
  }
  const names = entries.map((e) => e.canonical_name);
  const slugs = entries.map((e) => e.slug);
  const dupNames = names.filter((n, i) => names.indexOf(n) !== i);
  const dupSlugs = slugs.filter((s, i) => slugs.indexOf(s) !== i);
  if (dupNames.length) throw new Error(`Duplicate canonical names: ${dupNames.join(", ")}`);
  if (dupSlugs.length) throw new Error(`Duplicate slugs: ${dupSlugs.join(", ")}`);

  const alaska = entries.find((e) => e.slug === "alaska");
  if (!alaska || alaska.existing_id !== ALASKA_ID) {
    throw new Error("Alaska manifest entry missing or id mismatch");
  }
  if (alaska.public_status !== "published") throw new Error("Alaska must remain published");

  const newDrafts = entries.filter((e) => e.proposed_id_strategy !== "use_existing_row");
  if (newDrafts.length !== EXPECTED_DRAFT) {
    throw new Error(`Expected ${EXPECTED_DRAFT} new destinations, found ${newDrafts.length}`);
  }
  for (const e of newDrafts) {
    if (e.public_status !== "draft") throw new Error(`${e.slug} must be draft, got ${e.public_status}`);
    if (e.classification_enabled !== true) throw new Error(`${e.slug} must be classification_enabled=true`);
  }

  const pacific = entries.find((e) => e.slug === "pacific-coast");
  if (!pacific || pacific.canonical_name !== "Pacific Coast") {
    throw new Error("Pacific Coast missing or wrong canonical name");
  }
  const anz = entries.find((e) => e.slug === "australia-new-zealand");
  if (!anz || anz.canonical_name !== "Australia and New Zealand") {
    throw new Error("Australia and New Zealand naming mismatch");
  }
  const cne = entries.find((e) => e.slug === "canada-new-england");
  if (!cne || cne.canonical_name !== "Canada and New England") {
    throw new Error("Canada and New England naming mismatch");
  }

  return { entries, alaska, newDrafts };
}

async function runPrecheck(sb) {
  const hasColumn = await columnExists(sb, "classification_enabled");
  const destinations = await sb.get("destinations?select=*&order=slug.asc");
  const alaska = destinations.find((d) => d.slug === "alaska");

  const report = {
    phase: "precheck",
    migration_applied: hasColumn,
    classification_enabled_exists: hasColumn,
    destination_count: destinations.length,
    destinations: destinations.map((d) => ({
      id: d.id,
      name: d.name,
      slug: d.slug,
      status: d.status,
      classification_enabled: d.classification_enabled ?? null
    })),
    alaska: alaska
      ? { id: alaska.id, status: alaska.status, matches_manifest: alaska.id === ALASKA_ID }
      : null,
    table_counts: await fetchAllCounts(sb)
  };

  if (destinations.length !== 1) {
    throw new Error(`Expected 1 destination before seed, found ${destinations.length}`);
  }
  if (!alaska || alaska.status !== "published") {
    throw new Error("Alaska row missing or not published");
  }
  if (alaska.id !== ALASKA_ID) {
    throw new Error("Alaska id mismatch vs manifest");
  }

  const manifest = loadSeedManifest();
  validateManifest(manifest);

  console.log(JSON.stringify(report, null, 2));
  return report;
}

async function applyMigration(options = {}) {
  const dbUrl = loadDatabaseUrl(options);
  if (!dbUrl) {
    throw new Error("DATABASE_URL is required for migration apply (set env or pass --use-netlify-db)");
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

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(executable);
    const col = await client.query(
      `SELECT column_name, data_type, column_default, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'destinations' AND column_name = 'classification_enabled'`
    );
    const alaska = await client.query(
      `SELECT id, name, slug, status, classification_enabled FROM public.destinations WHERE slug = 'alaska' LIMIT 1`
    );
    return {
      phase: "migration",
      migration_version: MIGRATION_VERSION,
      sql_executed: MIGRATION_FILE,
      column: col.rows[0] || null,
      alaska: alaska.rows[0] || null
    };
  } finally {
    await client.end();
  }
}

async function verifyPostMigration(sb) {
  const hasColumn = await columnExists(sb, "classification_enabled");
  if (!hasColumn) throw new Error("classification_enabled still missing after migration");

  const alaskaRows = await sb.get(
    `destinations?slug=eq.alaska&select=id,name,slug,status,classification_enabled&limit=1`
  );
  const alaska = alaskaRows?.[0];
  if (!alaska) throw new Error("Alaska missing after migration");
  if (alaska.status !== "published") throw new Error("Alaska no longer published");
  if (alaska.classification_enabled !== true) {
    throw new Error("Alaska classification_enabled is not true");
  }

  return {
    phase: "post_migration_verify",
    classification_enabled_exists: true,
    alaska,
    destination_count: await headCount(sb, "destinations")
  };
}

async function createBackup(sb, manifestChecksum) {
  const { url } = getSupabaseConfig(root);
  const destinations = await sb.get("destinations?select=*&order=slug.asc");
  const destIds = destinations.map((d) => d.id);
  let aliases = [];
  let ports = [];
  if (destIds.length) {
    const inList = destIds.map((id) => encodeURIComponent(id)).join(",");
    aliases = await sb.get(`cruise_destination_aliases?destination_id=in.(${inList})&select=*`).catch(() => []);
    ports = await sb.get(`destination_ports?destination_id=in.(${inList})&select=*`).catch(() => []);
  }

  const backup = {
    created_at: new Date().toISOString(),
    supabase_project_ref: projectRefFromUrl(url),
    migration_version: MIGRATION_VERSION,
    seed_manifest_path: "reports/operational-destination-seed-manifest.json",
    seed_manifest_sha256: manifestChecksum,
    destinations,
    cruise_destination_aliases: aliases || [],
    destination_ports: ports || [],
    table_counts: await fetchAllCounts(sb)
  };

  const outPath = path.join(root, `reports/operational-destination-backup-${timestampSlug()}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(backup, null, 2));
  return { backup_path: outPath, backup };
}

async function applySeed(sb, manifest) {
  const { entries } = validateManifest(manifest);
  const existing = await sb.get("destinations?select=id,name,slug,status,classification_enabled,primary_region,display_order");
  const bySlug = Object.fromEntries(existing.map((d) => [d.slug.toLowerCase(), d]));

  const results = {
    phase: "seed_apply",
    preserved: [],
    inserted: [],
    updated: [],
    skipped: [],
    failures: []
  };

  for (const entry of entries) {
    const slugKey = entry.slug.toLowerCase();
    const current = bySlug[slugKey];

    if (entry.proposed_id_strategy === "use_existing_row") {
      if (!current) {
        results.failures.push({ slug: entry.slug, error: "existing_row_missing" });
        continue;
      }
      if (current.id !== entry.existing_id) {
        results.failures.push({ slug: entry.slug, error: "existing_id_mismatch", found: current.id });
        continue;
      }
      results.preserved.push({ id: current.id, slug: entry.slug, name: current.name, status: current.status });
      continue;
    }

    if (current) {
      results.skipped.push({ slug: entry.slug, reason: "already_exists", id: current.id });
      continue;
    }

    const row = {
      name: entry.canonical_name,
      slug: entry.slug,
      status: entry.public_status,
      primary_region: entry.primary_region || null,
      display_order: entry.display_order ?? 100,
      classification_enabled: entry.classification_enabled === true
    };

    try {
      const inserted = await sb.post("destinations", row, { prefer: "return=representation" });
      const created = Array.isArray(inserted) ? inserted[0] : inserted;
      results.inserted.push({
        id: created?.id,
        slug: entry.slug,
        name: entry.canonical_name,
        status: created?.status
      });
      if (created?.id) bySlug[slugKey] = created;
    } catch (err) {
      results.failures.push({ slug: entry.slug, error: err.message });
    }
  }

  const finalRows = await sb.get("destinations?select=id,name,slug,status,classification_enabled&order=slug.asc");
  results.final = {
    total: finalRows.length,
    published: finalRows.filter((d) => d.status === "published").length,
    draft: finalRows.filter((d) => d.status === "draft").length,
    classification_enabled: finalRows.filter((d) => d.classification_enabled === true).length,
    duplicate_names: finalRows
      .map((d) => d.name)
      .filter((n, i, a) => a.indexOf(n) !== i),
    duplicate_slugs: finalRows
      .map((d) => d.slug)
      .filter((s, i, a) => a.indexOf(s) !== i)
  };

  if (results.final.total !== EXPECTED_TOTAL) {
    throw new Error(`Final destination count ${results.final.total} !== ${EXPECTED_TOTAL}`);
  }
  if (results.final.published !== EXPECTED_PUBLISHED) {
    throw new Error(`Published count ${results.final.published} !== ${EXPECTED_PUBLISHED}`);
  }
  if (results.final.draft !== EXPECTED_DRAFT) {
    throw new Error(`Draft count ${results.final.draft} !== ${EXPECTED_DRAFT}`);
  }
  if (results.final.classification_enabled !== EXPECTED_TOTAL) {
    throw new Error(`classification_enabled count ${results.final.classification_enabled} !== ${EXPECTED_TOTAL}`);
  }
  if (results.failures.length) {
    throw new Error(`Seed failures: ${JSON.stringify(results.failures)}`);
  }

  return results;
}

function createRollbackManifest(backup, seedResult) {
  const rollback = {
    created_at: new Date().toISOString(),
    migration_version: MIGRATION_VERSION,
    backup_reference: path.basename(backup.backup_path),
    actions: [],
    preserve_alaska_id: ALASKA_ID,
    note: "Execute only if post-seed verification fails and rollback is explicitly approved."
  };

  for (const row of seedResult.inserted) {
    rollback.actions.push({
      action: "delete_destination",
      id: row.id,
      slug: row.slug,
      reason: "seed_inserted_row"
    });
  }

  rollback.actions.push({
    action: "preserve_destination",
    id: ALASKA_ID,
    slug: "alaska",
    reason: "existing_published_shell"
  });

  const outPath = path.join(root, `reports/operational-destination-seed-rollback-${timestampSlug()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(rollback, null, 2));

  const applyReportPath = path.join(root, `reports/operational-destination-seed-apply-${timestampSlug()}.json`);
  fs.writeFileSync(
    applyReportPath,
    JSON.stringify(
      {
        seed_result: seedResult,
        rollback_manifest: path.basename(outPath),
        backup_reference: path.basename(backup.backup_path)
      },
      null,
      2
    )
  );

  return { rollback_path: outPath, apply_report_path: applyReportPath };
}

async function executeRollback(sb, rollbackPath) {
  const rollback = JSON.parse(fs.readFileSync(rollbackPath, "utf8"));
  const deleted = [];
  for (const action of rollback.actions) {
    if (action.action !== "delete_destination") continue;
    await sb.request(`destinations?id=eq.${encodeURIComponent(action.id)}`, { method: "DELETE" });
    deleted.push(action.slug);
  }
  return { deleted, rollback_path: rollbackPath };
}

async function verifyPostSeed(sb) {
  const publicRows = await sb.get("destinations?status=eq.published&select=id,name,slug,status&order=name.asc");
  const allRows = await sb.get("destinations?select=id,name,slug,status,classification_enabled&order=slug.asc");
  const draftSlugs = allRows.filter((d) => d.status === "draft").map((d) => d.slug);

  return {
    phase: "post_seed_verify",
    public_destination_count: publicRows.length,
    public_destinations: publicRows.map((d) => d.slug),
    total_destinations: allRows.length,
    draft_destinations: draftSlugs,
    classification_enabled_count: allRows.filter((d) => d.classification_enabled === true).length,
    table_counts: await fetchAllCounts(sb)
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createSupabaseRest(root);
  const manifest = loadSeedManifest();
  const manifestChecksum = sha256File(SEED_MANIFEST_PATH);
  const dbOptions = { useNetlifyDb: args.useNetlifyDb };

  console.log("Seed manifest checksum:", manifestChecksum);
  console.log(
    "Approved destinations:",
    manifest.entries.map((e) => `${e.canonical_name} (${e.slug})`).join(", ")
  );

  let countsBefore = null;
  if (args.precheck || args.applyMigration || args.applySeed) {
    countsBefore = await fetchAllCounts(sb);
    console.log("Table counts (before):", JSON.stringify(countsBefore));
  }

  if (args.precheck) {
    await runPrecheck(sb);
  }

  if (args.applyMigration) {
    const hasColumn = await columnExists(sb, "classification_enabled");
    if (hasColumn) {
      console.log(JSON.stringify({ phase: "migration", skipped: true, reason: "already_applied" }, null, 2));
    } else {
      await runPrecheck(sb);
      const migrationResult = await applyMigration(dbOptions);
      console.log(JSON.stringify(migrationResult, null, 2));
      const verify = await verifyPostMigration(sb);
      console.log(JSON.stringify(verify, null, 2));
    }
  }

  if (args.applySeed) {
    const hasColumn = await columnExists(sb, "classification_enabled");
    if (!hasColumn) {
      throw new Error("Migration must be applied before seed");
    }
    await verifyPostMigration(sb);
    const backup = await createBackup(sb, manifestChecksum);
    console.log("Backup written:", backup.backup_path);
    const seedResult = await applySeed(sb, manifest);
    console.log(JSON.stringify(seedResult, null, 2));
    const rollback = createRollbackManifest(backup, seedResult);
    console.log("Rollback manifest:", rollback.rollback_path);
    const post = await verifyPostSeed(sb);
    console.log(JSON.stringify(post, null, 2));
  }

  if (args.verify) {
    const post = await verifyPostSeed(sb);
    console.log(JSON.stringify(post, null, 2));
    const countsAfter = await fetchAllCounts(sb);
    console.log("Table counts (after):", JSON.stringify(countsAfter));
  }

  if (args.rollback) {
    const files = fs
      .readdirSync(path.join(root, "reports"))
      .filter((f) => f.startsWith("operational-destination-seed-rollback-"))
      .sort()
      .reverse();
    if (!files.length) throw new Error("No rollback manifest found");
    const result = await executeRollback(sb, path.join(root, "reports", files[0]));
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
