#!/usr/bin/env node
/**
 * Generate an idempotent Supabase migration that upserts ports from a CSV catalogue.
 *
 * Usage:
 *   node scripts/generate-ports-seed-migration.mjs
 *   node scripts/generate-ports-seed-migration.mjs --in data/ports/ports-catalogue.csv
 *   node scripts/generate-ports-seed-migration.mjs --out supabase/migrations/20260734_ports_catalogue_seed.sql
 *
 * CSV columns (header required):
 *   canonical_name, display_name, city, country, country_code, region,
 *   latitude, longitude, aliases
 *
 * - match_key is derived the same way as Featured Cruise matching: normalize(name)|normalize(country)
 * - aliases: pipe-separated in CSV (e.g. Rome|Roma) → jsonb array in SQL
 * - blank lat/lng → NULL (fill later via geocode-ports or a follow-up CSV)
 * - Inserts only when match_key is new; updates coords when existing row is missing lat/lng
 *
 * Review the generated SQL, then run it in the Supabase SQL Editor.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const DEFAULT_IN = path.join(ROOT, "data/ports/ports-catalogue.csv");
const DEFAULT_SOURCE = "seed:ports_catalogue";

function parseArgs(argv) {
  const args = { in: DEFAULT_IN, out: "", source: DEFAULT_SOURCE, status: "verified" };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--in") args.in = path.resolve(ROOT, argv[++i] || "");
    else if (a === "--out") args.out = path.resolve(ROOT, argv[++i] || "");
    else if (a === "--source") args.source = String(argv[++i] || DEFAULT_SOURCE);
    else if (a === "--status") args.status = String(argv[++i] || "verified");
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function stripDiacritics(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Mirrors js/featured-cruise-itinerary.js normalizePortText / buildMatchKey. */
function normalizePortText(value) {
  let text = stripDiacritics(value);
  text = text.toLowerCase();
  text = text.replace(/[\u2019']/g, "");
  text = text.replace(/&/g, " and ");
  text = text.replace(/[./\\_+]+/g, " ");
  text = text.replace(/[^\w\s(),-]/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

function buildMatchKey(canonicalName, country) {
  const name = normalizePortText(canonicalName);
  const ctry = normalizePortText(country);
  if (!name) return "";
  return ctry ? `${name}|${ctry}` : `${name}|`;
}

/** Minimal RFC4180-ish CSV parse (quoted fields, escaped quotes). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const s = String(text || "").replace(/^\uFEFF/, "");

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    const next = s[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n" || (ch === "\r" && next === "\n")) {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (ch === "\r") i += 1;
      continue;
    }
    if (ch === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c || "").trim() !== ""));
}

function sqlString(value) {
  if (value == null || value === "") return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlNumber(value) {
  if (value == null || value === "") return "NULL";
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid number: ${value}`);
  }
  return String(n);
}

function parseAliases(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  return text
    .split("|")
    .map((a) => a.trim())
    .filter(Boolean);
}

function sqlJsonArray(aliases) {
  const escaped = aliases.map((a) => JSON.stringify(String(a)));
  return `'[${escaped.join(",")}]'::jsonb`;
}

function defaultOutPath() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return path.join(ROOT, `supabase/migrations/${y}${m}${day}_ports_catalogue_seed.sql`);
}

function loadPorts(csvPath) {
  const raw = fs.readFileSync(csvPath, "utf8");
  const rows = parseCsv(raw);
  if (!rows.length) throw new Error("CSV is empty");

  const header = rows[0].map((h) => String(h || "").trim().toLowerCase());
  const required = ["canonical_name", "country"];
  for (const col of required) {
    if (!header.includes(col)) throw new Error(`CSV missing required column: ${col}`);
  }

  const idx = (name) => header.indexOf(name);
  const ports = [];
  const seenKeys = new Set();

  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r];
    const get = (name) => {
      const i = idx(name);
      return i >= 0 ? String(cells[i] ?? "").trim() : "";
    };

    const canonical_name = get("canonical_name");
    const country = get("country");
    if (!canonical_name) {
      throw new Error(`Row ${r + 1}: canonical_name is required`);
    }
    if (!country) {
      throw new Error(`Row ${r + 1} (${canonical_name}): country is required`);
    }

    const match_key = buildMatchKey(canonical_name, country);
    if (!match_key) throw new Error(`Row ${r + 1}: could not build match_key`);
    if (seenKeys.has(match_key)) {
      throw new Error(`Duplicate match_key in CSV: ${match_key}`);
    }
    seenKeys.add(match_key);

    const city = get("city") || canonical_name;
    const display_name =
      get("display_name") || (country ? `${canonical_name}, ${country}` : canonical_name);
    const country_code = get("country_code").toUpperCase() || null;
    const region = get("region") || null;
    const latitude = get("latitude");
    const longitude = get("longitude");
    const aliases = parseAliases(get("aliases"));

    if ((latitude && !longitude) || (!latitude && longitude)) {
      throw new Error(`Row ${r + 1} (${canonical_name}): provide both latitude and longitude, or neither`);
    }

    ports.push({
      canonical_name,
      display_name,
      city,
      country,
      country_code,
      region,
      latitude: latitude || null,
      longitude: longitude || null,
      aliases,
      match_key
    });
  }

  return ports;
}

function buildMigrationSql(ports, { source, status }) {
  const allowedStatus = new Set(["verified", "provisional", "needs_review"]);
  if (!allowedStatus.has(status)) {
    throw new Error(`Invalid --status ${status}; use verified|provisional|needs_review`);
  }

  const valueRows = ports
    .map((p) => {
      const aliasesSql = sqlJsonArray(p.aliases);
      return `    (${sqlString(p.canonical_name)}, ${sqlString(p.display_name)}, ${sqlString(p.city)}, ${sqlString(p.country)}, ${sqlString(p.country_code)}, ${sqlString(p.region)}, ${sqlNumber(p.latitude)}, ${sqlNumber(p.longitude)}, ${aliasesSql}, ${sqlString(p.match_key)})`;
    })
    .join(",\n");

  const coordUpdates = ports
    .filter((p) => p.latitude != null && p.longitude != null)
    .map((p) => `    (${sqlString(p.match_key)}, ${sqlNumber(p.latitude)}, ${sqlNumber(p.longitude)})`)
    .join(",\n");

  const updateBlock =
    coordUpdates.length > 0
      ? `
-- Backfill coordinates on existing rows that still lack them.
UPDATE public.ports p
SET
  latitude = v.latitude,
  longitude = v.longitude,
  updated_at = timezone('utc', now())
FROM (
  VALUES
${coordUpdates}
) AS v(match_key, latitude, longitude)
WHERE p.match_key = v.match_key
  AND (p.latitude IS NULL OR p.longitude IS NULL);
`
      : "";

  return `-- Ports catalogue seed (generated by scripts/generate-ports-seed-migration.mjs)
-- Additive / idempotent on match_key. Review before running in Supabase SQL Editor.
-- Source: ${source}
-- Rows: ${ports.length}

INSERT INTO public.ports (
  canonical_name, display_name, city, country, country_code, region,
  latitude, longitude, aliases, status, source, match_key, verified_at
)
SELECT
  v.canonical_name, v.display_name, v.city, v.country, v.country_code, v.region,
  v.latitude, v.longitude, v.aliases, '${status}', ${sqlString(source)},
  v.match_key, ${status === "verified" ? "timezone('utc', now())" : "NULL"}
FROM (
  VALUES
${valueRows}
) AS v(
  canonical_name, display_name, city, country, country_code, region,
  latitude, longitude, aliases, match_key
)
WHERE NOT EXISTS (
  SELECT 1 FROM public.ports p WHERE p.match_key = v.match_key
);
${updateBlock}`;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (args.help) {
    console.log(`Usage: node scripts/generate-ports-seed-migration.mjs [options]

Options:
  --in PATH       CSV catalogue (default: data/ports/ports-catalogue.csv)
  --out PATH      Migration SQL path (default: supabase/migrations/YYYYMMDD_ports_catalogue_seed.sql)
  --source LABEL  ports.source value (default: seed:ports_catalogue)
  --status STATUS verified | provisional | needs_review (default: verified)
`);
    return;
  }

  if (!fs.existsSync(args.in)) {
    console.error(`CSV not found: ${args.in}`);
    process.exit(1);
  }

  const ports = loadPorts(args.in);
  const outPath = args.out || defaultOutPath();
  const sql = buildMigrationSql(ports, { source: args.source, status: args.status });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, sql, "utf8");

  console.log(`Wrote ${ports.length} ports → ${path.relative(ROOT, outPath)}`);
  console.log("Next: review the SQL, then run it in the Supabase SQL Editor.");
}

main();
