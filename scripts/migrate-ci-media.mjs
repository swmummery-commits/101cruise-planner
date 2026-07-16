#!/usr/bin/env node
/**
 * Migrate legacy cruise_lines / ships media URLs into Cruise Intelligence tables.
 * Also reports cabin breakdown conversion candidates.
 *
 * Usage:
 *   node scripts/migrate-ci-media.mjs --dry-run
 *   node scripts/migrate-ci-media.mjs --apply
 *
 * Env (from process env or project .env):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function loadEnvFile() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile();

const APPLY = process.argv.includes("--apply");
const DRY = !APPLY;

function normName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(cruises?|line|international|journeys|expeditions?)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function supabaseRequest(env, method, table, { query = "", body } = {}) {
  const response = await fetch(`${env.url}/rest/v1/${table}${query}`, {
    method,
    headers: {
      apikey: env.key,
      Authorization: `Bearer ${env.key}`,
      "Content-Type": "application/json",
      Prefer: method === "GET" ? "count=exact" : "return=representation"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    throw new Error((data && data.message) || `Supabase HTTP ${response.status}: ${text}`);
  }
  return data;
}

async function listAll(env, table, select, order = "name") {
  const pageSize = 200;
  let offset = 0;
  const all = [];
  while (offset < 10000) {
    const rows = await supabaseRequest(env, "GET", table, {
      query: `?select=${encodeURIComponent(select)}&order=${order}.asc&limit=${pageSize}&offset=${offset}`
    });
    const list = Array.isArray(rows) ? rows : [];
    all.push(...list);
    if (list.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

function buildLookup(rows) {
  const exact = new Map();
  const normalised = new Map();
  for (const row of rows) {
    const exactKey = String(row.name || "").toLowerCase().trim();
    const softKey = normName(row.name);
    if (exactKey) {
      if (!exact.has(exactKey)) exact.set(exactKey, []);
      exact.get(exactKey).push(row);
    }
    if (softKey) {
      if (!normalised.has(softKey)) normalised.set(softKey, []);
      normalised.get(softKey).push(row);
    }
  }
  return { exact, normalised };
}

function matchOne(name, lookup) {
  const exactKey = String(name || "").toLowerCase().trim();
  const softKey = normName(name);
  const exactHits = lookup.exact.get(exactKey) || [];
  if (exactHits.length === 1) return { row: exactHits[0], method: "exact" };
  if (exactHits.length > 1) return { row: null, method: "ambiguous-exact", candidates: exactHits };
  const softHits = lookup.normalised.get(softKey) || [];
  if (softHits.length === 1) return { row: softHits[0], method: "normalised" };
  if (softHits.length > 1) return { row: null, method: "ambiguous-normalised", candidates: softHits };

  // Unique containment fallback
  const contains = [];
  for (const [key, rows] of lookup.normalised.entries()) {
    if (!softKey || !key) continue;
    if (key.includes(softKey) || softKey.includes(key)) contains.push(...rows);
  }
  const unique = [...new Map(contains.map((r) => [r.id, r])).values()];
  if (unique.length === 1) return { row: unique[0], method: "contains" };
  if (unique.length > 1) return { row: null, method: "ambiguous-contains", candidates: unique };
  return { row: null, method: "unmatched" };
}

function humaniseCabinKey(key) {
  const map = {
    inside: "Inside",
    oceanview: "Oceanview",
    ocean_view: "Oceanview",
    balcony: "Balcony",
    suites: "Suites",
    suite: "Suites",
    owners_suites: "Owners Suites",
    owner_suites: "Owners Suites"
  };
  const lower = String(key || "").toLowerCase();
  if (map[lower]) return map[lower];
  return String(key || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function summaryToBreakdown(summary) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return null;
  const rows = [];
  for (const [key, value] of Object.entries(summary)) {
    if (value === null || value === "") continue;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) continue;
    rows.push({ label: humaniseCabinKey(key), count: Math.round(n) });
  }
  return rows.length ? rows : null;
}

function breakdownIsEmpty(value) {
  if (value == null) return true;
  if (typeof value === "string") {
    const t = value.trim();
    return !t || t === "null" || t === "[]";
  }
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    return !Object.values(value).some((v) => v !== null && v !== "" && Number(v) > 0);
  }
  return true;
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const env = { url: url.replace(/\/$/, ""), key };

  console.log(DRY ? "\n=== CI media migration DRY RUN ===\n" : "\n=== CI media migration APPLY ===\n");

  const [legacyLines, legacyShips, ciLines, ciShips] = await Promise.all([
    listAll(env, "cruise_lines", "id,name,logo_url,active"),
    listAll(env, "ships", "id,name,hero_image_url,cruise_line_id,active"),
    listAll(env, "ci_cruise_lines", "id,name,logo_url"),
    listAll(env, "ci_cruise_ships", "id,name,hero_image_url,cruise_line_id,cabin_type_summary,stateroom_breakdown,stateroom_count")
  ]);

  const ciLineLookup = buildLookup(ciLines);
  const report = {
    logosMigrated: 0,
    logosSkippedExisting: 0,
    logosUnmatched: [],
    logosAmbiguous: [],
    heroesMigrated: 0,
    heroesSkippedExisting: 0,
    heroesUnmatched: [],
    heroesAmbiguous: [],
    breakdownsConverted: 0,
    breakdownsAlreadyPresent: 0,
    breakdownsNoSource: 0,
    invalidSummarySkipped: 0
  };

  // Logos
  for (const legacy of legacyLines) {
    if (!legacy.logo_url) continue;
    const match = matchOne(legacy.name, ciLineLookup);
    if (!match.row) {
      if (match.method.startsWith("ambiguous")) {
        report.logosAmbiguous.push({
          legacy: legacy.name,
          method: match.method,
          candidates: (match.candidates || []).map((c) => c.name)
        });
      } else {
        report.logosUnmatched.push(legacy.name);
      }
      continue;
    }
    if (match.row.logo_url) {
      report.logosSkippedExisting += 1;
      continue;
    }
    report.logosMigrated += 1;
    if (!DRY) {
      await supabaseRequest(env, "PATCH", "ci_cruise_lines", {
        query: `?id=eq.${encodeURIComponent(match.row.id)}`,
        body: { logo_url: legacy.logo_url }
      });
      match.row.logo_url = legacy.logo_url;
    }
  }

  // Heroes — match ships by name; prefer unique global ship name, else within line
  const ciShipLookup = buildLookup(ciShips);
  const legacyLineById = new Map(legacyLines.map((l) => [l.id, l]));
  const ciLineById = new Map(ciLines.map((l) => [l.id, l]));

  for (const legacy of legacyShips) {
    if (!legacy.hero_image_url) continue;
    let match = { row: null, method: "unmatched" };
    const legacyLine = legacyLineById.get(legacy.cruise_line_id);

    // Prefer line-scoped matching first (handles short names like "Journey").
    if (legacyLine) {
      const lineMatch = matchOne(legacyLine.name, ciLineLookup);
      if (lineMatch.row) {
        const candidates = ciShips.filter((s) => {
          if (s.cruise_line_id !== lineMatch.row.id) return false;
          const shipExact = String(s.name).toLowerCase().trim() === String(legacy.name).toLowerCase().trim();
          const shipNorm = normName(s.name) === normName(legacy.name);
          const shipEnds = String(s.name).toLowerCase().trim().endsWith(String(legacy.name).toLowerCase().trim());
          const shipContains = normName(s.name).includes(normName(legacy.name));
          return shipExact || shipNorm || shipEnds || shipContains;
        });
        const unique = [...new Map(candidates.map((c) => [c.id, c])).values()];
        if (unique.length === 1) match = { row: unique[0], method: "line+name" };
        else if (unique.length > 1) {
          report.heroesAmbiguous.push({
            legacy: legacy.name,
            line: legacyLine.name,
            candidates: unique.map((c) => c.name)
          });
          continue;
        }
      }
    }

    if (!match.row) match = matchOne(legacy.name, ciShipLookup);

    if (!match.row) {
      if (match.method?.startsWith("ambiguous")) {
        report.heroesAmbiguous.push({
          legacy: legacy.name,
          method: match.method,
          candidates: (match.candidates || []).map((c) => c.name)
        });
      } else {
        report.heroesUnmatched.push({
          ship: legacy.name,
          line: legacyLine?.name || null
        });
      }
      continue;
    }
    if (match.row.hero_image_url) {
      report.heroesSkippedExisting += 1;
      continue;
    }
    report.heroesMigrated += 1;
    if (!DRY) {
      await supabaseRequest(env, "PATCH", "ci_cruise_ships", {
        query: `?id=eq.${encodeURIComponent(match.row.id)}`,
        body: { hero_image_url: legacy.hero_image_url }
      });
      match.row.hero_image_url = legacy.hero_image_url;
    }
  }

  // Breakdown conversion from cabin_type_summary (script-side report; SQL migration also does this)
  for (const ship of ciShips) {
    if (!breakdownIsEmpty(ship.stateroom_breakdown)) {
      report.breakdownsAlreadyPresent += 1;
      continue;
    }
    const converted = summaryToBreakdown(ship.cabin_type_summary);
    if (!converted) {
      if (ship.cabin_type_summary && typeof ship.cabin_type_summary === "object") {
        report.invalidSummarySkipped += 1;
      } else {
        report.breakdownsNoSource += 1;
      }
      continue;
    }
    report.breakdownsConverted += 1;
    if (!DRY) {
      await supabaseRequest(env, "PATCH", "ci_cruise_ships", {
        query: `?id=eq.${encodeURIComponent(ship.id)}`,
        body: { stateroom_breakdown: converted }
      });
    }
  }

  console.log(`Legacy lines with logos:     ${legacyLines.filter((l) => l.logo_url).length}`);
  console.log(`Legacy ships with heroes:    ${legacyShips.filter((s) => s.hero_image_url).length}`);
  console.log(`CI lines / ships:            ${ciLines.length} / ${ciShips.length}`);
  console.log(`Logos migrated:              ${report.logosMigrated}`);
  console.log(`Logos skipped (had URL):     ${report.logosSkippedExisting}`);
  console.log(`Logos unmatched:             ${report.logosUnmatched.length}`);
  console.log(`Logos ambiguous:             ${report.logosAmbiguous.length}`);
  console.log(`Heroes migrated:             ${report.heroesMigrated}`);
  console.log(`Heroes skipped (had URL):    ${report.heroesSkippedExisting}`);
  console.log(`Heroes unmatched:            ${report.heroesUnmatched.length}`);
  console.log(`Heroes ambiguous:            ${report.heroesAmbiguous.length}`);
  console.log(`Breakdowns converted:        ${report.breakdownsConverted}`);
  console.log(`Breakdowns already present:  ${report.breakdownsAlreadyPresent}`);
  console.log(`Breakdowns no source:        ${report.breakdownsNoSource}`);
  console.log(`Invalid/empty summaries:     ${report.invalidSummarySkipped}`);

  if (report.logosUnmatched.length) {
    console.log("\nUnmatched logos:");
    report.logosUnmatched.forEach((n) => console.log(`  - ${n}`));
  }
  if (report.logosAmbiguous.length) {
    console.log("\nAmbiguous logos:");
    report.logosAmbiguous.forEach((item) =>
      console.log(`  - ${item.legacy} (${item.method}): ${(item.candidates || []).join(", ")}`)
    );
  }
  if (report.heroesUnmatched.length) {
    console.log("\nUnmatched ship heroes (first 40):");
    report.heroesUnmatched.slice(0, 40).forEach((item) =>
      console.log(`  - ${item.ship}${item.line ? ` (${item.line})` : ""}`)
    );
    if (report.heroesUnmatched.length > 40) {
      console.log(`  … and ${report.heroesUnmatched.length - 40} more`);
    }
  }
  if (report.heroesAmbiguous.length) {
    console.log("\nAmbiguous ship heroes:");
    report.heroesAmbiguous.forEach((item) =>
      console.log(`  - ${item.legacy}: ${(item.candidates || []).join(", ")}`)
    );
  }
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
