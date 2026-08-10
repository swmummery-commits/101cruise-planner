#!/usr/bin/env node
/**
 * Seed official_line_ship_id for Explora Journeys ships (EX/EP/EL/EO/EA).
 *
 * Dry-run/precheck is the default. Apply is a SEPARATE, deliberate step and is intentionally
 * not run as part of the Explora integration task:
 *
 *   node scripts/apply-explora-ship-code-seed.mjs --precheck
 *   node scripts/apply-explora-ship-code-seed.mjs --apply --confirm=EXPLORA-SHIP-CODE-SEED
 *   node scripts/apply-explora-ship-code-seed.mjs --verify
 *
 * Only official_line_ship_id is written, and only when the row currently holds NULL and the
 * ship name matches the official Explora fleet name exactly. The Explora discovery adapter
 * already resolves ships by exact name, so this seed is an accuracy hardening step, not a
 * prerequisite for ingestion.
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { EXPLORA_SHIP_CODE_NAME } = require(path.join(
  root,
  "netlify/functions/lib/explora-discovery-source"
));

const EXPLORA_LINE_ID = "8b28c83e-2bf0-44ce-9795-ec3051c34050";
const APPLY_CONFIRMATION_TOKEN = "EXPLORA-SHIP-CODE-SEED";

/** Ship code → exact ci_cruise_ships.name, confirmed from official journey meta descriptions. */
export const EXPLORA_SHIP_CODE_SEED = Object.entries(EXPLORA_SHIP_CODE_NAME).map(([code, name]) => ({
  official_line_ship_id: code,
  name
}));

function parseArgs(argv) {
  const args = { precheck: false, apply: false, verify: false, confirm: null };
  for (const arg of argv.slice(2)) {
    if (arg === "--precheck" || arg === "--dry-run") args.precheck = true;
    if (arg === "--apply") args.apply = true;
    if (arg === "--verify") args.verify = true;
    if (arg.startsWith("--confirm=")) args.confirm = String(arg.split("=")[1]).trim();
  }
  if (!args.precheck && !args.apply && !args.verify) args.precheck = true;
  return args;
}

async function fetchExploraShips(sb) {
  return sb.get(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(EXPLORA_LINE_ID)}&select=id,name,official_line_ship_id,active,cruise_line_id&order=name.asc`
  );
}

export function buildSeedAudit(dbShips) {
  const byName = new Map((dbShips || []).map((s) => [String(s.name).trim().toUpperCase(), s]));
  return EXPLORA_SHIP_CODE_SEED.map((entry) => {
    const row = byName.get(entry.name.toUpperCase()) || null;
    const current = row?.official_line_ship_id ? String(row.official_line_ship_id).toUpperCase() : null;
    return {
      official_line_ship_id: entry.official_line_ship_id,
      expected_ship_name: entry.name,
      supabase_ship_id: row?.id || null,
      supabase_ship_name: row?.name || null,
      current_official_line_ship_id: current,
      active: row?.active ?? null,
      match_evidence: row ? "official_meta_description_exact_name_match" : "missing_supabase_ship",
      action: !row
        ? "skip_missing_ship"
        : current === entry.official_line_ship_id
          ? "skip_already_set"
          : current
            ? "skip_existing_code_conflict"
            : "seed_official_line_ship_id",
      discrepancy: !row ? "missing_supabase_ship" : current && current !== entry.official_line_ship_id ? "existing_code_conflict" : null
    };
  });
}

async function runPrecheck(sb) {
  const dbShips = await fetchExploraShips(sb);
  const audit = buildSeedAudit(dbShips);
  const conflicts = audit.filter((row) => row.discrepancy);
  return {
    phase: "precheck",
    writes_performed: 0,
    cruise_line_id: EXPLORA_LINE_ID,
    db_explora_ship_count: dbShips.length,
    proposed_seeds: audit.filter((row) => row.action === "seed_official_line_ship_id").length,
    already_set: audit.filter((row) => row.action === "skip_already_set").length,
    conflicts,
    untouched_ships: dbShips
      .filter((s) => !EXPLORA_SHIP_CODE_SEED.some((e) => e.name.toUpperCase() === String(s.name).toUpperCase()))
      .map((s) => ({ id: s.id, name: s.name, official_line_ship_id: s.official_line_ship_id })),
    audit_table: audit,
    ready: conflicts.length === 0,
    apply_note:
      "Apply is a separate manual step: --apply --confirm=EXPLORA-SHIP-CODE-SEED. Not executed automatically."
  };
}

async function runApply(sb, args) {
  if (args.confirm !== APPLY_CONFIRMATION_TOKEN) {
    throw new Error(`--confirm=${APPLY_CONFIRMATION_TOKEN} is required to apply the ship code seed`);
  }
  const pre = await runPrecheck(sb);
  if (!pre.ready) throw new Error(`Precheck failed: ${JSON.stringify(pre.conflicts)}`);

  const changed = [];
  const skipped = [];
  for (const row of pre.audit_table) {
    if (row.action !== "seed_official_line_ship_id") {
      skipped.push(row);
      continue;
    }
    const updated = await sb.patch(
      `ci_cruise_ships?id=eq.${encodeURIComponent(row.supabase_ship_id)}&cruise_line_id=eq.${encodeURIComponent(
        EXPLORA_LINE_ID
      )}&official_line_ship_id=is.null`,
      { official_line_ship_id: row.official_line_ship_id }
    );
    const after = Array.isArray(updated) ? updated[0] : updated;
    changed.push({
      ship_id: row.supabase_ship_id,
      name: row.supabase_ship_name,
      before: null,
      after: after?.official_line_ship_id || row.official_line_ship_id
    });
  }

  return { phase: "apply", changed_count: changed.length, skipped_count: skipped.length, changed, skipped };
}

async function runVerify(sb) {
  const dbShips = await fetchExploraShips(sb);
  const audit = buildSeedAudit(dbShips);
  const codes = dbShips.map((s) => s.official_line_ship_id).filter(Boolean);
  return {
    phase: "verify",
    seeded_ok: audit.filter((row) => row.current_official_line_ship_id === row.official_line_ship_id).length,
    seeded_total: EXPLORA_SHIP_CODE_SEED.length,
    duplicate_official_line_ship_id: [...new Set(codes.filter((c, i) => codes.indexOf(c) !== i))],
    audit_table: audit
  };
}

async function main() {
  const args = parseArgs(process.argv);
  getSupabaseConfig(root);
  const sb = createSupabaseRest(root);

  let out;
  if (args.apply) out = await runApply(sb, args);
  else if (args.verify) out = await runVerify(sb);
  else out = await runPrecheck(sb);

  console.log(JSON.stringify(out, null, 2));
  if (out.ready === false) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
