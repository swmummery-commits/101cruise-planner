#!/usr/bin/env node
/**
 * Apply approved Norwegian official_line_ship_id seed (update only official_line_ship_id).
 *
 *   node scripts/apply-norwegian-ship-code-seed.mjs --precheck
 *   node scripts/apply-norwegian-ship-code-seed.mjs --apply
 *   node scripts/apply-norwegian-ship-code-seed.mjs --verify
 *   node scripts/apply-norwegian-ship-code-seed.mjs --all
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const source = require(path.join(root, "netlify/functions/lib/norwegian-discovery-source"));

const MANIFEST_PATH = path.join(root, "reports/norwegian-ship-code-seed-manifest.json");
const NCL_LINE_ID = "c5f5361f-ebe5-4ff4-babe-7eb07f609bae";
const EXPECTED_UPDATES = 22;

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
  if (manifest.cruise_line_id !== NCL_LINE_ID) {
    throw new Error(`Norwegian line id mismatch: ${manifest.cruise_line_id}`);
  }
  if ((manifest.ships || []).length !== EXPECTED_UPDATES) {
    throw new Error(`Expected ${EXPECTED_UPDATES} ships in manifest`);
  }
  const codes = manifest.ships.map((s) => String(s.official_line_ship_id).toUpperCase());
  if (new Set(codes).size !== codes.length) throw new Error("Duplicate official_line_ship_id in manifest");
  return manifest;
}

async function fetchNorwegianShips(sb) {
  return sb.get(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(NCL_LINE_ID)}&select=id,name,official_line_ship_id,active,status,slug,cruise_line_id&order=name.asc`
  );
}

async function fetchSourceShipCodes() {
  const filters = await source.fetchNorwegianFilters();
  const values = Array.isArray(filters.filters?.ships?.values) ? filters.filters.ships.values : [];
  return values.map((entry) => ({
    code: String(entry.code || "").trim().toUpperCase(),
    name: String(entry.title || "").trim()
  }));
}

function buildAuditTable(manifest, dbShips, sourceShips) {
  const sourceByCode = new Map(sourceShips.map((s) => [s.code, s]));
  const dbByName = new Map(dbShips.map((s) => [s.name, s]));

  return manifest.ships.map((entry) => {
    const code = String(entry.official_line_ship_id).toUpperCase();
    const source = sourceByCode.get(code);
    const db = dbByName.get(entry.name);
    return {
      source_code: code,
      source_name: source?.name || entry.name,
      supabase_ship_id: db?.id || null,
      supabase_ship_name: db?.name || entry.name,
      current_official_line_ship_id: db?.official_line_ship_id || null,
      proposed_official_line_ship_id: code,
      active: db?.active ?? null,
      status: db?.status ?? null,
      discrepancy:
        !db
          ? "missing_supabase_ship"
          : !source
            ? "missing_source_code"
            : source.name !== db.name
              ? "name_mismatch"
              : db.official_line_ship_id && db.official_line_ship_id.toUpperCase() !== code
                ? "existing_code_conflict"
                : null
    };
  });
}

async function runPrecheck(sb) {
  const manifest = loadManifest();
  const dbShips = await fetchNorwegianShips(sb);
  const sourceShips = await fetchSourceShipCodes();
  const audit = buildAuditTable(manifest, dbShips, sourceShips);
  const conflicts = audit.filter((r) => r.discrepancy);
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
    existing_code_conflicts: audit.filter((r) => r.discrepancy === "existing_code_conflict"),
    source_ship_count: sourceShips.length,
    db_norwegian_ship_count: dbShips.length,
    ready:
      conflicts.length === 0 &&
      audit.every((r) => r.supabase_ship_id) &&
      dbShips.length >= EXPECTED_UPDATES
  };
}

async function runApply(sb) {
  const manifest = loadManifest();
  const pre = await runPrecheck(sb);
  if (!pre.ready) throw new Error(`Precheck failed: ${JSON.stringify(pre.conflicts)}`);

  const dbShips = await fetchNorwegianShips(sb);
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
      throw new Error(`Conflict on ${row.name}: current=${current} proposed=${code}`);
    }

    const updated = await sb.patch(
      `ci_cruise_ships?id=eq.${encodeURIComponent(row.id)}&cruise_line_id=eq.${encodeURIComponent(NCL_LINE_ID)}&or=(official_line_ship_id.is.null,official_line_ship_id.eq.${encodeURIComponent(current || "")})`,
      { official_line_ship_id: code }
    );
    const after = Array.isArray(updated) ? updated[0] : updated;
    changed.push({
      ship_id: row.id,
      name: row.name,
      before: current,
      after: after?.official_line_ship_id || code
    });
  }

  return {
    phase: "apply",
    changed_count: changed.length,
    skipped_count: skipped.length,
    changed,
    skipped
  };
}

async function runVerify(sb) {
  const manifest = loadManifest();
  const dbShips = await fetchNorwegianShips(sb);
  const codes = dbShips
    .map((s) => (s.official_line_ship_id ? String(s.official_line_ship_id).toUpperCase() : null))
    .filter(Boolean);
  const dupCodes = codes.filter((c, i) => codes.indexOf(c) !== i);
  const seeded = manifest.ships.map((entry) => {
    const row = dbShips.find((s) => s.name === entry.name);
    return {
      name: entry.name,
      code: entry.official_line_ship_id,
      ship_id: row?.id,
      official_line_ship_id: row?.official_line_ship_id || null,
      ok: row && String(row.official_line_ship_id || "").toUpperCase() === String(entry.official_line_ship_id).toUpperCase()
    };
  });

  return {
    phase: "verify",
    seeded_ok: seeded.filter((s) => s.ok).length,
    seeded_total: EXPECTED_UPDATES,
    duplicate_official_line_ship_id: [...new Set(dupCodes)],
    seeded
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createSupabaseRest(root);
  let out;
  if (args.precheck) out = await runPrecheck(sb);
  else if (args.apply) out = await runApply(sb);
  else if (args.verify) out = await runVerify(sb);

  console.log(JSON.stringify(out, null, 2));
  if (out.ready === false || (out.phase === "verify" && out.seeded_ok !== EXPECTED_UPDATES)) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
