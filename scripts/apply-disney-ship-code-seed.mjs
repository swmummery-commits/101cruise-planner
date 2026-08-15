#!/usr/bin/env node
/**
 * Apply approved Disney official_line_ship_id seed (update only official_line_ship_id).
 *
 *   node scripts/apply-disney-ship-code-seed.mjs --precheck
 *   node scripts/apply-disney-ship-code-seed.mjs --apply
 *   node scripts/apply-disney-ship-code-seed.mjs --verify
 *   node scripts/apply-disney-ship-code-seed.mjs --all
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const source = require(path.join(root, "netlify/functions/lib/disney-discovery-source"));

const MANIFEST_PATH = path.join(root, "reports/disney-ship-code-seed-manifest.json");
const DISNEY_LINE_ID = "8f7aadcb-7843-4060-b0cb-a60631936b3a";
const EXPECTED_UPDATES = 8;
const BELIEVE_NAME = "Disney Believe";

function parseArgs(argv) {
  const args = { precheck: false, apply: false, verify: false, all: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--precheck") args.precheck = true;
    if (arg === "--apply") args.apply = true;
    if (arg === "--verify") args.verify = true;
    if (arg === "--all") args.all = true;
  }
  if (args.all) {
    args.precheck = true;
    args.apply = true;
    args.verify = true;
  }
  if (!args.precheck && !args.apply && !args.verify) args.precheck = true;
  return args;
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) throw new Error(`Manifest missing: ${MANIFEST_PATH}`);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  if (manifest.cruise_line_id !== DISNEY_LINE_ID) {
    throw new Error(`Disney line id mismatch: ${manifest.cruise_line_id}`);
  }
  if ((manifest.ships || []).length !== EXPECTED_UPDATES) {
    throw new Error(`Expected ${EXPECTED_UPDATES} ships in manifest`);
  }
  const codes = manifest.ships.map((s) => String(s.official_line_ship_id).toUpperCase());
  if (new Set(codes).size !== codes.length) throw new Error("Duplicate official_line_ship_id in manifest");
  return manifest;
}

async function fetchDisneyShips(sb) {
  return sb.get(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(DISNEY_LINE_ID)}&select=id,name,official_line_ship_id,active,status,slug,cruise_line_id&order=name.asc`
  );
}

async function fetchSourceShipCodes() {
  const filters = await source.fetchDisneyFilterOptions({ requestDelayMs: 100 });
  const shipEntries = filters.byType?.ship || [];
  return shipEntries.map((entry) => ({
    code: String(entry.filterValue || "").split(";")[0].trim().toUpperCase(),
    name: entry.name || entry.filterValue
  }));
}

function buildAuditTable(manifest, dbShips, sourceShips) {
  const sourceByCode = new Map(sourceShips.map((s) => [s.code, s]));
  const dbByName = new Map(dbShips.map((s) => [s.name, s]));

  return manifest.ships.map((entry) => {
    const code = String(entry.official_line_ship_id).toUpperCase();
    const src = sourceByCode.get(code);
    const db = dbByName.get(entry.name);
    return {
      source_code: code,
      source_name: src?.name || entry.name,
      supabase_ship_id: db?.id || null,
      supabase_ship_name: db?.name || entry.name,
      current_official_line_ship_id: db?.official_line_ship_id || null,
      proposed_official_line_ship_id: code,
      discrepancy: !db
        ? "missing_supabase_ship"
        : !src
          ? "missing_source_code"
          : db.official_line_ship_id && db.official_line_ship_id.toUpperCase() !== code
            ? "existing_code_conflict"
            : null
    };
  });
}

async function runPrecheck(sb) {
  const manifest = loadManifest();
  const dbShips = await fetchDisneyShips(sb);
  const sourceShips = await fetchSourceShipCodes();
  const audit = buildAuditTable(manifest, dbShips, sourceShips);
  const conflicts = audit.filter((r) => r.discrepancy);
  const believe = dbShips.find((s) => s.name === BELIEVE_NAME);

  const codeOwners = new Map();
  for (const row of dbShips) {
    const code = row.official_line_ship_id ? String(row.official_line_ship_id).toUpperCase() : null;
    if (code) codeOwners.set(code, row.name);
  }

  return {
    phase: "precheck",
    manifest_path: MANIFEST_PATH,
    expected_updates: EXPECTED_UPDATES,
    audit_table: audit,
    conflicts,
    disney_believe: {
      name: BELIEVE_NAME,
      official_line_ship_id: believe?.official_line_ship_id || null,
      unchanged_required: true
    },
    source_ship_count: sourceShips.length,
    db_disney_ship_count: dbShips.length,
    ready: conflicts.length === 0 && audit.every((r) => r.supabase_ship_id) && dbShips.length >= 9
  };
}

async function runApply(sb) {
  const manifest = loadManifest();
  const pre = await runPrecheck(sb);
  if (!pre.ready) throw new Error(`Precheck failed: ${JSON.stringify(pre.conflicts)}`);

  const dbShips = await fetchDisneyShips(sb);
  const changed = [];
  const skipped = [];

  for (const entry of manifest.ships) {
    const code = String(entry.official_line_ship_id).toUpperCase();
    const row = dbShips.find((s) => s.name === entry.name);
    if (!row) throw new Error(`Ship not found: ${entry.name}`);

    const current = row.official_line_ship_id ? String(row.official_line_ship_id).toUpperCase() : null;
    if (current === code) {
      skipped.push({ ship_id: row.id, name: row.name, official_line_ship_id: code, reason: "already_set" });
      continue;
    }
    if (current && current !== code) {
      throw new Error(`Refusing to overwrite ${row.name}: ${current} -> ${code}`);
    }

    await sb.patch(`ci_cruise_ships?id=eq.${encodeURIComponent(row.id)}`, {
      official_line_ship_id: code
    });
    changed.push({
      ship_id: row.id,
      name: row.name,
      before: current,
      after: code
    });
  }

  return { phase: "apply", changed, skipped, disney_believe_unchanged: true };
}

async function runVerify(sb) {
  const manifest = loadManifest();
  const dbShips = await fetchDisneyShips(sb);
  const believe = dbShips.find((s) => s.name === BELIEVE_NAME);
  const verified = manifest.ships.map((entry) => {
    const row = dbShips.find((s) => s.name === entry.name);
    const expected = String(entry.official_line_ship_id).toUpperCase();
    const actual = row?.official_line_ship_id ? String(row.official_line_ship_id).toUpperCase() : null;
    return {
      name: entry.name,
      expected,
      actual,
      ok: actual === expected
    };
  });

  const duplicateCodes = new Map();
  for (const row of dbShips) {
    const code = row.official_line_ship_id ? String(row.official_line_ship_id).toUpperCase() : null;
    if (!code) continue;
    if (!duplicateCodes.has(code)) duplicateCodes.set(code, []);
    duplicateCodes.get(code).push(row.name);
  }
  const dupes = [...duplicateCodes.entries()].filter(([, names]) => names.length > 1);

  return {
    phase: "verify",
    verified,
    all_match: verified.every((v) => v.ok),
    duplicate_official_line_ship_id: dupes,
    disney_believe: {
      name: BELIEVE_NAME,
      official_line_ship_id: believe?.official_line_ship_id || null,
      unchanged: !believe?.official_line_ship_id
    }
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createSupabaseRest(root);
  const results = {};

  if (args.precheck) {
    results.precheck = await runPrecheck(sb);
    console.log(JSON.stringify(results.precheck, null, 2));
    if (!results.precheck.ready && !args.apply) process.exit(1);
  }
  if (args.apply) {
    results.apply = await runApply(sb);
    console.log(JSON.stringify(results.apply, null, 2));
  }
  if (args.verify) {
    results.verify = await runVerify(sb);
    console.log(JSON.stringify(results.verify, null, 2));
    if (!results.verify.all_match || results.verify.duplicate_official_line_ship_id.length) process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
