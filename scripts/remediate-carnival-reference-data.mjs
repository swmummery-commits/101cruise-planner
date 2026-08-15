#!/usr/bin/env node
/**
 * Carnival Prompt 3 — controlled reference-data remediation.
 *
 *   node scripts/remediate-carnival-reference-data.mjs --precheck
 *   node scripts/remediate-carnival-reference-data.mjs --apply --confirm=CARNIVAL-REFERENCE-REMEDIATION-PROMPT3
 *   node scripts/remediate-carnival-reference-data.mjs --verify
 *
 * Scope (reference data only):
 * - Missing Carnival ships (short_vessel naming)
 * - official_line_ship_id backfill for live Carnival source ships
 * - Carnival ship aliases for new ships
 * - Mobile, Alabama embark port (CSV + ports table)
 *
 * Does NOT write cruises or discovered_cruises.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
  require("dotenv").config({ path: path.join(root, ".env.local") });
} catch {
  /* optional */
}

const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { resolveShipForLine } = require(path.join(root, "netlify/functions/lib/discovery-ship-resolver"));
const { resolveRawPortText, resetPortsCache } = require(path.join(root, "netlify/functions/lib/discovery-departure-port"));
const adapter = require(path.join(root, "netlify/functions/lib/carnival-discovery-adapter"));
const source = require(path.join(root, "netlify/functions/lib/carnival-discovery-source"));

const CCL_LINE_ID = "dfc49fc6-42ed-44fa-b52a-0a48dd8fc6b6";
const CCL_LINE_NAME = "Carnival Cruise Line";
const CCL_LINE_SLUG = "carnival-cruise-line";
const APPLY_CONFIRMATION = "CARNIVAL-REFERENCE-REMEDIATION-PROMPT3";
const PORTS_CSV = path.join(root, "data/ports/ports-catalogue.csv");
const REPORT_DIR = path.join(root, "reports");
const EXCLUDED_SHIP_NAME = "Tropicale";

const GUARDS = Object.freeze({
  max_new_ships: 12,
  max_official_id_updates: 35,
  max_new_aliases: 12,
  max_port_inserts: 1
});

const MOBILE_SPEC = {
  canonical_name: "Mobile",
  display_name: "Mobile, Alabama",
  city: "Mobile",
  country: "United States",
  country_code: "US",
  region: "North America Atlantic",
  latitude: 30.695,
  longitude: -88.039,
  aliases: ["Mobile AL", "Mobile, AL", "MOB"]
};

function parseArgs(argv) {
  const args = { precheck: false, apply: false, verify: false, confirm: null };
  for (const arg of argv.slice(2)) {
    if (arg === "--precheck" || arg === "--dry-run") args.precheck = true;
    if (arg === "--apply") args.apply = true;
    if (arg === "--verify") args.verify = true;
    if (arg.startsWith("--confirm=")) args.confirm = arg.slice("--confirm=".length);
  }
  if (!args.precheck && !args.apply && !args.verify) args.precheck = true;
  return args;
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function normaliseShipName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function stripCarnivalPrefix(name) {
  const norm = normaliseShipName(name);
  for (const prefix of [CCL_LINE_NAME, "Carnival"]) {
    const p = normaliseShipName(prefix);
    if (p && norm.startsWith(`${p} `)) return norm.slice(p.length + 1).trim();
  }
  return norm;
}

function slugFromShortName(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildMatchKey(name, country) {
  const n = normaliseShipName(name);
  const c = normaliseShipName(country);
  return c ? `${n}|${c}` : `${n}|`;
}

function titleCaseShortName(stripped) {
  return stripped
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function fetchCclLine(sb) {
  const row = (
    await sb.get(
      `ci_cruise_lines?slug=eq.${encodeURIComponent(CCL_LINE_SLUG)}&select=id,name,slug,ship_naming_style&limit=1`
    )
  )?.[0];
  if (!row?.id) throw new Error(`Cruise line not found: ${CCL_LINE_SLUG}`);
  return row;
}

async function fetchCclShips(sb) {
  return sb.get(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(CCL_LINE_ID)}&select=id,name,cruise_line_id,official_line_ship_id,active,status,slug&order=name.asc`
  );
}

async function fetchCclAliases(sb) {
  return sb.get(
    `cruise_ship_aliases?cruise_line_id=eq.${encodeURIComponent(CCL_LINE_ID)}&select=id,ship_id,raw_alias,normalised_alias,active`
  );
}

async function fetchLiveSourceShips() {
  source.clearCarnivalFetchCache();
  adapter.clearCclFetchCache();
  const fetchResult = await source.fetchCarnivalCatalogue({ maxApiCalls: source.DEFAULT_MAX_API_CALLS });
  const expanded = adapter.expandItineraryGroupsToRawSailings(fetchResult.itinerary_groups || []);
  const byCode = new Map();
  for (const row of expanded.products) {
    const code = String(row.ship_code || "").trim().toUpperCase();
    const name = String(row.ship_name || "").trim();
    if (!code || !name) continue;
    if (!byCode.has(code)) {
      byCode.set(code, {
        source_name: name,
        source_code: code,
        short_name: titleCaseShortName(stripCarnivalPrefix(name))
      });
    }
  }
  return {
    source_ships: [...byCode.values()].sort((a, b) => a.source_code.localeCompare(b.source_code)),
    fetch_meta: {
      api_calls: fetchResult.api_calls,
      groups: fetchResult.unique_group_count
    }
  };
}

function matchDbShip(sourceShip, dbShips) {
  const short = titleCaseShortName(stripCarnivalPrefix(sourceShip.source_name));
  const byName = dbShips.find((row) => normaliseShipName(row.name) === normaliseShipName(short));
  if (byName) return { ship: byName, method: "short_vessel_exact_name", short_name: short };

  const byCode = dbShips.find(
    (row) => String(row.official_line_ship_id || "").trim().toUpperCase() === sourceShip.source_code
  );
  if (byCode) return { ship: byCode, method: "existing_official_line_ship_id", short_name: short };

  const inactive = dbShips.find(
    (row) => normaliseShipName(row.name) === normaliseShipName(sourceShip.source_name) && row.active === false
  );
  if (inactive) return { ship: inactive, method: "inactive_name_match", short_name: short, conflict: "inactive_existing_ship" };

  return { ship: null, method: null, short_name: short };
}

function buildShipPreflight(sourceShips, dbShips) {
  return sourceShips.map((sourceShip) => {
    const match = matchDbShip(sourceShip, dbShips);
    const db = match.ship;
    const currentCode = db?.official_line_ship_id ? String(db.official_line_ship_id).toUpperCase() : null;
    const proposedCode = sourceShip.source_code;

    let proposed_action = "no_change";
    let conflict = null;

    if (match.conflict) {
      proposed_action = "conflict — STOP";
      conflict = match.conflict;
    } else if (!db) {
      proposed_action = "create missing ship + official ID";
    } else if (!currentCode) {
      proposed_action = "populate official ID";
    } else if (currentCode !== proposedCode) {
      proposed_action = "conflict — STOP";
      conflict = "existing_official_id_mismatch";
    }

    return {
      source_name: sourceShip.source_name,
      source_code: proposedCode,
      current_db_match: db?.name || null,
      db_ship_id: db?.id || null,
      match_method: match.method,
      current_official_id: currentCode,
      proposed_action,
      conflict,
      proposed_short_name: match.short_name,
      proposed_alias: `Carnival ${match.short_name}`
    };
  });
}

function csvHasMobile() {
  const text = fs.readFileSync(PORTS_CSV, "utf8");
  return /(^|\n)Mobile,/.test(text) || /Mobile, Alabama/.test(text);
}

function ensureMobileCsvLine() {
  const line = `${MOBILE_SPEC.canonical_name},"${MOBILE_SPEC.display_name}",${MOBILE_SPEC.city},${MOBILE_SPEC.country},${MOBILE_SPEC.country_code},${MOBILE_SPEC.region},${MOBILE_SPEC.latitude},${MOBILE_SPEC.longitude},${MOBILE_SPEC.aliases.join("|")}`;
  const text = fs.readFileSync(PORTS_CSV, "utf8");
  if (csvHasMobile()) return { action: "csv_exists", line: null };
  const next = text.includes("\nGalveston,")
    ? text.replace("\nGalveston,", `\n${line}\nGalveston,`)
    : `${text.trim()}\n${line}\n`;
  return { action: "csv_add", line, next };
}

async function buildMobilePlan(sb) {
  const search = await sb.get(
    `ports?or=(canonical_name.ilike.${encodeURIComponent("*Mobile*")},display_name.ilike.${encodeURIComponent("*Mobile*")})&select=id,canonical_name,display_name,country,match_key,aliases&limit=20`
  );
  const alabama = (search || []).filter((row) => /alabama|united states/i.test(String(row.country || row.display_name || "")));
  const exact = alabama.filter((row) => normaliseShipName(row.canonical_name) === "mobile");
  const csvPlan = ensureMobileCsvLine();
  if (exact.length === 1) {
    return { action: "port_exists", before: exact[0], after: exact[0], csvPlan, search };
  }
  if (exact.length > 1) {
    return { action: "conflict_multiple_mobile", search, csvPlan };
  }
  const matchKey = buildMatchKey(MOBILE_SPEC.canonical_name, MOBILE_SPEC.country);
  const byKey = (
    await sb.get(`ports?match_key=eq.${encodeURIComponent(matchKey)}&select=id,canonical_name,country,match_key,aliases&limit=1`)
  )?.[0];
  if (byKey) {
    return { action: "port_exists_by_match_key", before: byKey, after: byKey, csvPlan, search };
  }
  return {
    action: "insert_mobile_port",
    before: null,
    after: {
      ...MOBILE_SPEC,
      status: "verified",
      source: "admin:carnival_prompt3_reference_remediation",
      match_key: matchKey
    },
    csvPlan,
    search
  };
}

function summarisePreflight(shipTable, mobilePlan) {
  const creates = shipTable.filter((row) => row.proposed_action === "create missing ship + official ID");
  const updates = shipTable.filter((row) => row.proposed_action === "populate official ID");
  const conflicts = shipTable.filter((row) => row.proposed_action === "conflict — STOP");
  const unchanged = shipTable.filter((row) => row.proposed_action === "no_change");

  const guardViolations = [];
  if (creates.length > GUARDS.max_new_ships) {
    guardViolations.push(`expected at most ${GUARDS.max_new_ships} new ships, found ${creates.length}`);
  }
  if (updates.length > GUARDS.max_official_id_updates) {
    guardViolations.push(
      `expected at most ${GUARDS.max_official_id_updates} official ID updates, found ${updates.length}`
    );
  }

  return {
    ships_to_create: creates.length,
    official_ids_to_populate: updates.length,
    aliases_to_create: creates.length,
    ships_unchanged: unchanged.length,
    conflicts,
    guard_violations: guardViolations,
    ready: conflicts.length === 0 && guardViolations.length === 0
  };
}

function verifyPortResolver() {
  resetPortsCache();
  return {
    mobile_name: resolveRawPortText("Mobile, AL", { sourceField: source.SOURCE_ID }),
    mobile_alias: resolveRawPortText("Mobile, Alabama", { sourceField: source.SOURCE_ID }),
    london_ambiguous: resolveRawPortText("London, England", { sourceField: source.SOURCE_ID }),
    london_dover: adapter.resolveCclDeparturePort({
      departure_port_name: "London, England",
      departure_port_code: "LON",
      ports_to_display: ["Dover (London)", "Le Havre (Paris)"]
    })
  };
}

async function verifyShipResolver(sb, shipTable) {
  const ships = await fetchCclShips(sb);
  const aliases = await fetchCclAliases(sb);
  const samples = shipTable
    .filter((row) => row.proposed_action !== "conflict — STOP")
    .slice(0, 5)
    .map((row) => {
      const resolved = resolveShipForLine({
        rawShipName: row.source_name,
        rawShipCode: row.source_code,
        cruiseLineId: CCL_LINE_ID,
        cruiseLineName: CCL_LINE_NAME,
        ships,
        aliases
      });
      return {
        source_name: row.source_name,
        source_code: row.source_code,
        resolved: resolved.resolved,
        method: resolved.method,
        ship_name: resolved.ship?.name || null
      };
    });
  return { samples, ship_count: ships.length, alias_count: aliases.length };
}

async function runPrecheck(sb) {
  const line = await fetchCclLine(sb);
  const dbShips = await fetchCclShips(sb);
  const live = await fetchLiveSourceShips();
  const shipTable = buildShipPreflight(live.source_ships, dbShips);
  const mobilePlan = await buildMobilePlan(sb);
  const summary = summarisePreflight(shipTable, mobilePlan);
  const tropicale = dbShips.find((row) => row.name === EXCLUDED_SHIP_NAME);

  return {
    phase: "precheck",
    writes_performed: 0,
    cruise_line: line,
    source_fetch: live.fetch_meta,
    live_source_ship_count: live.source_ships.length,
    db_ship_count: dbShips.length,
    ship_preflight_table: shipTable,
    ship_summary: summary,
    mobile_plan: mobilePlan,
    resolver_preview: verifyPortResolver(),
    excluded_ship: tropicale
      ? {
          id: tropicale.id,
          name: tropicale.name,
          official_line_ship_id: tropicale.official_line_ship_id,
          note: "Absent from future-sailing source — must remain unchanged"
        }
      : null,
    guards: GUARDS,
    ready: summary.ready && !["conflict_multiple_mobile"].includes(mobilePlan.action)
  };
}

function writeAuditManifest(payload) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const file = path.join(REPORT_DIR, `carnival-reference-remediation-${timestampSlug()}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

async function runApply(sb, args) {
  if (args.confirm !== APPLY_CONFIRMATION) {
    throw new Error(`--confirm=${APPLY_CONFIRMATION} is required`);
  }

  const pre = await runPrecheck(sb);
  if (!pre.ready) {
    throw new Error(
      `Precheck blocked: ${JSON.stringify({ conflicts: pre.ship_summary.conflicts, guard_violations: pre.ship_summary.guard_violations })}`
    );
  }

  const beforeShips = await fetchCclShips(sb);
  const beforeAliases = await fetchCclAliases(sb);
  const audit = {
    created_at: new Date().toISOString(),
    phase: "apply",
    before: {
      ships: beforeShips,
      aliases: beforeAliases
    },
    intended_mutations: pre.ship_preflight_table.filter((row) => row.proposed_action !== "no_change"),
    applied: [],
    skipped: [],
    conflicts_skipped: [],
    ids_created: [],
    ids_updated: [],
    aliases_created: [],
    port_changes: [],
    rollback: []
  };

  const dbShips = [...beforeShips];
  const creates = pre.ship_preflight_table.filter((row) => row.proposed_action === "create missing ship + official ID");
  const updates = pre.ship_preflight_table.filter((row) => row.proposed_action === "populate official ID");

  for (const row of creates) {
    const insertRow = {
      cruise_line_id: CCL_LINE_ID,
      name: row.proposed_short_name,
      slug: slugFromShortName(row.proposed_short_name),
      status: "active",
      active: true,
      official_line_ship_id: row.source_code
    };
    const inserted = await sb.post("ci_cruise_ships", insertRow, { prefer: "return=representation" });
    const ship = Array.isArray(inserted) ? inserted[0] : inserted;
    audit.applied.push({ table: "ci_cruise_ships", action: "insert", before: null, after: ship });
    audit.ids_created.push({ table: "ci_cruise_ships", id: ship?.id, name: ship?.name });
    audit.rollback.push({ action: "delete", table: "ci_cruise_ships", id: ship?.id });
    if (ship) dbShips.push(ship);

    const aliasRow = {
      cruise_line_id: CCL_LINE_ID,
      ship_id: ship.id,
      raw_alias: row.proposed_alias,
      normalised_alias: normaliseShipName(row.proposed_alias),
      active: true
    };
    const aliasInserted = await sb.post("cruise_ship_aliases", aliasRow, { prefer: "return=representation" });
    const alias = Array.isArray(aliasInserted) ? aliasInserted[0] : aliasInserted;
    audit.applied.push({ table: "cruise_ship_aliases", action: "insert", before: null, after: alias });
    audit.aliases_created.push(alias);
    audit.rollback.push({ action: "delete", table: "cruise_ship_aliases", id: alias?.id });
  }

  for (const row of updates) {
    const current = dbShips.find((ship) => ship.id === row.db_ship_id);
    if (!current) throw new Error(`Missing ship for update: ${row.source_name}`);
    const currentCode = current.official_line_ship_id ? String(current.official_line_ship_id).toUpperCase() : null;
    if (currentCode && currentCode !== row.source_code) {
      audit.conflicts_skipped.push({ ...row, reason: "existing_official_id_mismatch_at_apply" });
      throw new Error(`Conflict on ${current.name}: current=${currentCode} proposed=${row.source_code}`);
    }
    if (currentCode === row.source_code) {
      audit.skipped.push({ ship_id: current.id, name: current.name, reason: "already_set" });
      continue;
    }
    const updated = await sb.patch(
      `ci_cruise_ships?id=eq.${encodeURIComponent(current.id)}&cruise_line_id=eq.${encodeURIComponent(CCL_LINE_ID)}&official_line_ship_id=is.null`,
      { official_line_ship_id: row.source_code }
    );
    audit.applied.push({
      table: "ci_cruise_ships",
      action: "update_official_line_ship_id",
      before: { id: current.id, official_line_ship_id: current.official_line_ship_id },
      after: { id: current.id, official_line_ship_id: row.source_code, patch_result: updated }
    });
    audit.ids_updated.push({ id: current.id, name: current.name, official_line_ship_id: row.source_code });
    audit.rollback.push({
      action: "patch",
      table: "ci_cruise_ships",
      id: current.id,
      restore: { official_line_ship_id: current.official_line_ship_id }
    });
    current.official_line_ship_id = row.source_code;
  }

  const mobile = pre.mobile_plan;
  if (mobile.csvPlan.action === "csv_add") {
    fs.writeFileSync(PORTS_CSV, mobile.csvPlan.next);
    audit.port_changes.push({ table: "data/ports/ports-catalogue.csv", action: "insert_csv_row", line: mobile.csvPlan.line });
  }
  if (mobile.action === "insert_mobile_port") {
    const inserted = await sb.request("ports", {
      method: "POST",
      body: mobile.after,
      prefer: "return=representation"
    });
    const port = Array.isArray(inserted) ? inserted[0] : inserted;
    audit.port_changes.push({ table: "ports", action: "insert", before: null, after: port });
    audit.ids_created.push({ table: "ports", id: port?.id, canonical_name: port?.canonical_name });
    audit.rollback.push({ action: "delete", table: "ports", id: port?.id });
  }

  resetPortsCache();
  audit.after = {
    ships: await fetchCclShips(sb),
    aliases: await fetchCclAliases(sb)
  };
  audit.verify = {
    ports: verifyPortResolver(),
    ships: await verifyShipResolver(sb, pre.ship_preflight_table)
  };

  const manifestPath = writeAuditManifest(audit);
  return {
    phase: "apply",
    writes_performed: audit.applied.length + audit.port_changes.length,
    ships_created: creates.length,
    official_ids_populated: audit.ids_updated.length,
    aliases_created: audit.aliases_created.length,
    port_changes: audit.port_changes.length,
    manifest_path: manifestPath,
    verify: audit.verify,
    tropicale_unchanged: audit.after.ships.some((row) => row.name === EXCLUDED_SHIP_NAME)
  };
}

async function runVerify(sb) {
  const pre = await runPrecheck(sb);
  const ships = await fetchCclShips(sb);
  const aliases = await fetchCclAliases(sb);
  const codes = ships
    .map((row) => (row.official_line_ship_id ? String(row.official_line_ship_id).toUpperCase() : null))
    .filter(Boolean);
  const duplicateCodes = codes.filter((code, index) => codes.indexOf(code) !== index);
  const live = await fetchLiveSourceShips();
  const unresolved = live.source_ships.filter((sourceShip) => {
    const resolved = resolveShipForLine({
      rawShipName: sourceShip.source_name,
      rawShipCode: sourceShip.source_code,
      cruiseLineId: CCL_LINE_ID,
      cruiseLineName: CCL_LINE_NAME,
      ships,
      aliases
    });
    return !resolved.resolved;
  });

  return {
    phase: "verify",
    precheck_ready: pre.ready,
    duplicate_official_line_ship_id: [...new Set(duplicateCodes)],
    live_source_ship_count: live.source_ships.length,
    unresolved_live_source_ships: unresolved,
    resolver: verifyPortResolver(),
    tropicale_present: ships.some((row) => row.name === EXCLUDED_SHIP_NAME),
    ok: pre.ready && duplicateCodes.length === 0 && unresolved.length === 0
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createSupabaseRest(root);
  let out;
  if (args.apply) out = await runApply(sb, args);
  else if (args.verify) out = await runVerify(sb);
  else out = await runPrecheck(sb);

  console.log(JSON.stringify(out, null, 2));
  if (out.ready === false || out.ok === false) process.exit(1);
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
