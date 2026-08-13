#!/usr/bin/env node
/**
 * Royal Caribbean Prompt 3 — minimum metadata corrections only.
 *
 *   node scripts/apply-royal-caribbean-prompt3-metadata.mjs --precheck
 *   node scripts/apply-royal-caribbean-prompt3-metadata.mjs --apply --confirm=ROYAL-CARIBBEAN-PROMPT3-METADATA
 *   node scripts/apply-royal-caribbean-prompt3-metadata.mjs --verify
 *
 * Scope:
 * - Hero of the Seas (ci_cruise_ships) if absent
 * - Colón, Panama (ports) if absent
 *
 * Does NOT import cruises or bulk-seed other ship codes.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
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
const adapter = require(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-adapter"));

const RC_LINE_ID = "1cea3c83-5fd5-41d0-b5f7-4026fee00ab5";
const RC_LINE_NAME = "Royal Caribbean International";
const APPLY_CONFIRMATION = "ROYAL-CARIBBEAN-PROMPT3-METADATA";
const PORTS_CSV = path.join(root, "data/ports/ports-catalogue.csv");

const HERO = {
  name: "Hero of the Seas",
  slug: "hero-of-the-seas",
  official_line_ship_id: "HE",
  status: "active",
  active: true
};

const COLON_SPEC = {
  canonical_name: "Colón",
  display_name: "Colón, Panama",
  city: "Colón",
  country: "Panama",
  country_code: "PA",
  region: "Central America",
  latitude: 9.359,
  longitude: -79.901,
  aliases: ["Colon", "Colon Panama", "Cristobal", "Cristóbal", "ONX"]
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

function buildMatchKey(name, country) {
  const n = String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const c = String(country || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return c ? `${n}|${c}` : `${n}|`;
}

function normaliseShipSearch(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function searchHeroCandidates(sb) {
  const queries = [
    `ci_cruise_ships?name=ilike.${encodeURIComponent("*Hero*")}&select=id,name,cruise_line_id,official_line_ship_id,active,status,slug&limit=50`,
    `ci_cruise_ships?official_line_ship_id=eq.HE&select=id,name,cruise_line_id,official_line_ship_id,active,status,slug&limit=20`,
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(RC_LINE_ID)}&select=id,name,cruise_line_id,official_line_ship_id,active,status,slug&order=name.asc`
  ];
  const rows = [];
  for (const q of queries) {
    const batch = await sb.get(q);
    if (Array.isArray(batch)) rows.push(...batch);
  }
  const byId = new Map();
  for (const row of rows) byId.set(row.id, row);
  const all = [...byId.values()];
  return {
    exact_rc_hero: all.filter(
      (row) =>
        row.cruise_line_id === RC_LINE_ID &&
        normaliseShipSearch(row.name) === normaliseShipSearch(HERO.name)
    ),
    code_he: all.filter((row) => String(row.official_line_ship_id || "").toUpperCase() === "HE"),
    hero_name_any_line: all.filter((row) => /hero/i.test(String(row.name || ""))),
    royal_caribbean_fleet: all.filter((row) => row.cruise_line_id === RC_LINE_ID)
  };
}

async function searchColonCandidates(sb) {
  const patterns = ["Colón", "Colon", "Cristobal", "Cristóbal", "ONX", "Panama City"];
  const hits = [];
  for (const pattern of patterns) {
    const rows = await sb.get(
      `ports?or=(canonical_name.ilike.${encodeURIComponent(`*${pattern}*`)},display_name.ilike.${encodeURIComponent(`*${pattern}*`)})&select=id,canonical_name,display_name,country,match_key,aliases&limit=20`
    );
    if (Array.isArray(rows)) hits.push(...rows.map((row) => ({ ...row, matched_pattern: pattern })));
  }
  const byId = new Map();
  for (const row of hits) byId.set(row.id, row);
  return [...byId.values()];
}

function csvHasColon() {
  const text = fs.readFileSync(PORTS_CSV, "utf8");
  return /(^|\n)Colón,/.test(text) || /Colon, Panama/.test(text);
}

function ensureColonCsvLine() {
  const line = `${COLON_SPEC.canonical_name},"${COLON_SPEC.display_name}",${COLON_SPEC.city},${COLON_SPEC.country},${COLON_SPEC.country_code},${COLON_SPEC.region},${COLON_SPEC.latitude},${COLON_SPEC.longitude},${COLON_SPEC.aliases.join("|")}`;
  const text = fs.readFileSync(PORTS_CSV, "utf8");
  if (csvHasColon()) return { action: "csv_exists", line: null };
  const insertBefore = text.includes("\nPanama City,")
    ? text.replace("\nPanama City,", `\n${line}\nPanama City,`)
    : `${text.trim()}\n${line}\n`;
  return { action: "csv_add", before: !text.includes("\nColón,"), line };
}

async function buildHeroPlan(sb) {
  const search = await searchHeroCandidates(sb);
  if (search.exact_rc_hero.length === 1) {
    const row = search.exact_rc_hero[0];
    const patch =
      row.official_line_ship_id === "HE"
        ? null
        : { official_line_ship_id: "HE", reason: "set_missing_official_code" };
    return {
      action: patch ? "update_hero_official_code" : "hero_exists",
      before: row,
      after: patch ? { ...row, ...patch } : row,
      search
    };
  }
  if (search.exact_rc_hero.length > 1) {
    return { action: "conflict_multiple_hero", search };
  }
  if (search.code_he.some((row) => row.cruise_line_id !== RC_LINE_ID)) {
    return { action: "conflict_he_on_other_line", search };
  }
  return {
    action: "insert_hero",
    before: null,
    after: {
      cruise_line_id: RC_LINE_ID,
      name: HERO.name,
      slug: HERO.slug,
      status: HERO.status,
      active: HERO.active,
      official_line_ship_id: HERO.official_line_ship_id
    },
    search
  };
}

async function buildColonPlan(sb) {
  const search = await searchColonCandidates(sb);
  const panamaHits = search.filter((row) => String(row.country || "").toLowerCase() === "panama");
  const exactColon = panamaHits.filter((row) =>
    ["colón", "colon"].includes(
      String(row.canonical_name || "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
    )
  );
  const csvPlan = ensureColonCsvLine();
  if (exactColon.length === 1) {
    return { action: "port_exists", before: exactColon[0], after: exactColon[0], csvPlan, search };
  }
  if (exactColon.length > 1) {
    return { action: "conflict_multiple_colon", search, csvPlan };
  }
  const matchKey = buildMatchKey(COLON_SPEC.canonical_name, COLON_SPEC.country);
  const existingByKey = (
    await sb.get(`ports?match_key=eq.${encodeURIComponent(matchKey)}&select=id,canonical_name,country,match_key,aliases&limit=1`)
  )?.[0];
  if (existingByKey) {
    return { action: "port_exists_by_match_key", before: existingByKey, after: existingByKey, csvPlan, search };
  }
  return {
    action: "insert_colon_port",
    before: null,
    after: {
      ...COLON_SPEC,
      status: "verified",
      source: "admin:royal_caribbean_prompt3_metadata",
      match_key: matchKey
    },
    csvPlan,
    search
  };
}

function verifyResolver() {
  resetPortsCache();
  const colon = adapter.resolveRoyalCaribbeanPortText("Colón");
  const colonAscii = adapter.resolveRoyalCaribbeanPortText("Colon");
  const colonCode = adapter.classifyItineraryStop({ name: "Colón", code: "ONX" });
  return {
    colon,
    colonAscii,
    colonCode
  };
}

async function verifyHeroResolver(sb) {
  const ships = await sb.get(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(RC_LINE_ID)}&select=id,name,cruise_line_id,official_line_ship_id,active`
  );
  const byName = resolveShipForLine({
    rawShipName: "Hero of the Seas",
    rawShipCode: "HE",
    cruiseLineId: RC_LINE_ID,
    cruiseLineName: RC_LINE_NAME,
    ships: ships || []
  });
  const byCode = resolveShipForLine({
    rawShipName: "Unknown",
    rawShipCode: "HE",
    cruiseLineId: RC_LINE_ID,
    cruiseLineName: RC_LINE_NAME,
    ships: ships || []
  });
  return { byName, byCode, ship_count: (ships || []).length };
}

async function runPrecheck(sb) {
  const hero = await buildHeroPlan(sb);
  const colon = await buildColonPlan(sb);
  return {
    phase: "precheck",
    writes_performed: 0,
    hero,
    colon,
    resolver_preview: verifyResolver(),
    ready:
      !["conflict_multiple_hero", "conflict_he_on_other_line", "conflict_multiple_colon"].includes(hero.action) &&
      !["conflict_multiple_colon"].includes(colon.action)
  };
}

async function runApply(sb, args) {
  if (args.confirm !== APPLY_CONFIRMATION) {
    throw new Error(`--confirm=${APPLY_CONFIRMATION} is required`);
  }
  const pre = await runPrecheck(sb);
  if (!pre.ready) throw new Error(`Precheck blocked: ${JSON.stringify(pre)}`);

  const writes = [];
  const hero = pre.hero;
  if (hero.action === "insert_hero") {
    const inserted = await sb.post("ci_cruise_ships", hero.after, { prefer: "return=representation" });
    writes.push({ table: "ci_cruise_ships", action: "insert", before: null, after: Array.isArray(inserted) ? inserted[0] : inserted });
  } else if (hero.action === "update_hero_official_code") {
    const updated = await sb.patch(
      `ci_cruise_ships?id=eq.${encodeURIComponent(hero.before.id)}&cruise_line_id=eq.${encodeURIComponent(RC_LINE_ID)}`,
      { official_line_ship_id: "HE" }
    );
    writes.push({ table: "ci_cruise_ships", action: "update", before: hero.before, after: { official_line_ship_id: "HE", patch_result: updated } });
  }

  const colon = pre.colon;
  if (colon.csvPlan.action === "csv_add") {
    const text = fs.readFileSync(PORTS_CSV, "utf8");
    const line = `${COLON_SPEC.canonical_name},"${COLON_SPEC.display_name}",${COLON_SPEC.city},${COLON_SPEC.country},${COLON_SPEC.country_code},${COLON_SPEC.region},${COLON_SPEC.latitude},${COLON_SPEC.longitude},${COLON_SPEC.aliases.join("|")}`;
    const next = text.includes("\nPanama City,")
      ? text.replace("\nPanama City,", `\n${line}\nPanama City,`)
      : `${text.trim()}\n${line}\n`;
    fs.writeFileSync(PORTS_CSV, next);
    writes.push({ table: "data/ports/ports-catalogue.csv", action: "insert_csv_row", before: null, after: line });
  }

  if (colon.action === "insert_colon_port") {
    await sb.request("ports", { method: "POST", body: colon.after, prefer: "return=representation" });
    writes.push({ table: "ports", action: "insert", before: null, after: colon.after });
  }

  resetPortsCache();
  return {
    phase: "apply",
    writes_performed: writes.length,
    writes,
    verify: {
      hero: await verifyHeroResolver(sb),
      colon: verifyResolver()
    }
  };
}

async function runVerify(sb) {
  resetPortsCache();
  return {
    phase: "verify",
    hero: await verifyHeroResolver(sb),
    colon: verifyResolver(),
    hero_search: await searchHeroCandidates(sb),
    colon_search: await searchColonCandidates(sb),
    csv_has_colon: csvHasColon()
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createSupabaseRest(root);
  const result = args.apply
    ? await runApply(sb, args)
    : args.verify
      ? await runVerify(sb)
      : await runPrecheck(sb);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
