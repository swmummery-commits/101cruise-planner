#!/usr/bin/env node
/**
 * Import Base44 CruiseLine / CruiseShip CSV exports into Supabase Cruise Intelligence tables.
 *
 * Usage:
 *   node scripts/import-base44-cruise-data.mjs --dry-run
 *   node scripts/import-base44-cruise-data.mjs --apply
 *
 * Env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Never run automatically on Netlify deploy.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LINE_CSV = path.join(ROOT, "import-data", "CruiseLine_export.csv");
const SHIP_CSV = path.join(ROOT, "import-data", "CruiseShip_export.csv");

const APPROVED_LINE_RULES = [
  { label: "Holland America", test: (n) => /holland\s*america/i.test(n) },
  { label: "Princess", test: (n) => /^princess(\s+cruises)?$/i.test(n.trim()) },
  { label: "Celebrity", test: (n) => /^celebrity(\s+cruises)?$/i.test(n.trim()) },
  { label: "Royal Caribbean", test: (n) => /royal\s*caribbean/i.test(n) },
  { label: "MSC", test: (n) => /^msc(\s+cruises)?$/i.test(n.trim()) },
  { label: "Norwegian", test: (n) => /norwegian(\s+cruise\s+line)?/i.test(n) },
  { label: "Explora", test: (n) => /explora/i.test(n) },
  { label: "Viking", test: (n) => /^viking\b/i.test(n.trim()) },
  { label: "Hurtigruten", test: (n) => /hurtigruten/i.test(n) },
  { label: "Silversea", test: (n) => /silversea/i.test(n) },
  { label: "Seabourn", test: (n) => /seabourn/i.test(n) },
  { label: "Ponant", test: (n) => /^ponant$/i.test(n.trim()) },
  { label: "Carnival", test: (n) => /^carnival(\s+cruise\s+line)?$/i.test(n.trim()) }
];

const EXCLUDED_LINE_RULES = [
  {
    reason: "P&O Cruises Australia is not sold by 101cruise",
    test: (n) => /p\s*&\s*o/.test(n) && /australia/i.test(n)
  },
  {
    reason: "P&O Cruises Australia is not sold by 101cruise",
    test: (n) => /pocruises\.com\.au/i.test(n)
  }
];

function parseArgs(argv) {
  const dryRun = argv.includes("--dry-run") || !argv.includes("--apply");
  const apply = argv.includes("--apply");
  return { dryRun: dryRun && !apply, apply };
}

function die(message) {
  console.error(`\nERROR: ${message}\n`);
  process.exit(1);
}

function cleanText(value, max = 4000) {
  if (value == null) return null;
  let s = String(value).trim();
  if (!s) return null;
  if (/^(null|none|n\/a|na|undefined)$/i.test(s)) return null;
  if (s.length > max) s = s.slice(0, max);
  return s;
}

function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function parseCsv(text) {
  const rows = [];
  let i = 0;
  const len = text.length;
  let field = "";
  let row = [];
  let inQuotes = false;

  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.some((cell) => String(cell).trim() !== "")) rows.push(row);
      row = [];
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length || row.length) {
    row.push(field);
    if (row.some((cell) => String(cell).trim() !== "")) rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => String(h || "").replace(/^\uFEFF/, "").trim());
  return rows.slice(1).map((cells) => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = cells[idx] == null ? "" : cells[idx];
    });
    return obj;
  });
}

function parseInteger(value) {
  const s = cleanText(value, 40);
  if (!s) return null;
  const n = Number(String(s).replace(/,/g, ""));
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { invalid: true, raw: s };
  return { value: n };
}

function parseNumber(value) {
  const s = cleanText(value, 40);
  if (!s) return null;
  const n = Number(String(s).replace(/,/g, ""));
  if (!Number.isFinite(n)) return { invalid: true, raw: s };
  return { value: n };
}

function parseJsonField(value, fieldName, shipName, report) {
  const s = cleanText(value, 20000);
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch (error) {
    report.invalidJson.push({
      ship: shipName,
      field: fieldName,
      message: String(error.message || error).slice(0, 120),
      preview: s.slice(0, 100)
    });
    return null;
  }
}

function isApprovedImageUrl(url) {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith("101cruise.com.au") || host.endsWith("squarespace-cdn.com")) {
      return url;
    }
  } catch (_error) {
    return null;
  }
  return null;
}

function inferLineType(name) {
  const n = String(name || "").toLowerCase();
  if (/yacht/.test(n) || /ritz-carlton yacht|seadream/.test(n)) return "yacht";
  if (/waterways|uniworld|avalon|ama waterways|emerald cruises|scenic luxury/.test(n)) {
    return "river";
  }
  if (/expedition|lindblad|aurora expeditions|atlas cruises|australis/.test(n)) {
    return "expedition";
  }
  return null;
}

function classifyLine(name) {
  for (const rule of EXCLUDED_LINE_RULES) {
    if (rule.test(name)) {
      return {
        sold_by_101cruise: false,
        active: false,
        needs_review: false,
        review_notes: rule.reason
      };
    }
  }
  for (const rule of APPROVED_LINE_RULES) {
    if (rule.test(name)) {
      return {
        sold_by_101cruise: true,
        active: true,
        needs_review: false,
        review_notes: `Matched approved list as ${rule.label}`
      };
    }
  }
  return {
    sold_by_101cruise: false,
    active: true,
    needs_review: true,
    review_notes: "Not in approved 101cruise sold list — review before public use"
  };
}

function uniqueSlug(base, used) {
  let slug = base || "item";
  if (!used.has(slug)) {
    used.add(slug);
    return slug;
  }
  let i = 2;
  while (used.has(`${slug}-${i}`)) i += 1;
  const next = `${slug}-${i}`;
  used.add(next);
  return next;
}

async function supabaseRequest(env, method, tablePath, { query = "", body } = {}) {
  const url = `${env.url}/rest/v1/${tablePath}${query}`;
  const headers = {
    apikey: env.key,
    Authorization: `Bearer ${env.key}`,
    Accept: "application/json",
    "Content-Type": "application/json"
  };
  if (method === "POST" || method === "PATCH") {
    headers.Prefer = "resolution=merge-duplicates,return=representation";
  }
  const response = await fetch(url, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_error) {
    data = text;
  }
  if (!response.ok) {
    const message =
      (data && (data.message || data.error_description || data.error)) ||
      `Supabase HTTP ${response.status}`;
    throw new Error(String(message));
  }
  return data;
}

function loadCsvOrDie(filePath, label) {
  if (!fs.existsSync(filePath)) die(`${label} is missing: ${filePath}`);
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) die(`${label} is empty: ${filePath}`);
  const rows = parseCsv(raw);
  if (!rows.length) die(`${label} has no data rows: ${filePath}`);
  return rows;
}

function prepareLines(rawLines, report) {
  const usedSlugs = new Set();
  const byLegacyId = new Map();
  const prepared = [];

  for (const row of rawLines) {
    const name = cleanText(row.name, 200);
    const legacyId = cleanText(row.id, 80);
    if (!name) {
      report.linesRequiringReview.push({ reason: "Blank cruise line name", row });
      continue;
    }
    if (!legacyId) {
      report.linesRequiringReview.push({ reason: "Missing Base44 id", name });
      continue;
    }

    const flags = classifyLine(name);
    if (!flags.sold_by_101cruise && flags.review_notes && /P&O|not sold/i.test(flags.review_notes) && !flags.active) {
      report.excludedLines.push({ name, reason: flags.review_notes });
    }
    if (flags.needs_review) report.linesRequiringReview.push({ name, reason: flags.review_notes });

    const code = cleanText(row.code, 40);
    const website = cleanText(row.website, 500);
    let websiteUrl = null;
    if (website) {
      try {
        websiteUrl = new URL(website).toString();
      } catch (_error) {
        report.linesRequiringReview.push({ name, reason: `Malformed website URL: ${website}` });
      }
    }

    const logoCandidate = cleanText(row.logo_url, 1000);
    const logoUrl = isApprovedImageUrl(logoCandidate);
    if (logoCandidate && !logoUrl) {
      report.linesRequiringReview.push({
        name,
        reason: "logo_url skipped (not an approved 101cruise/Squarespace host)"
      });
    }

    const slug = uniqueSlug(slugify(name), usedSlugs);
    const record = {
      legacy_base44_id: legacyId,
      name,
      slug,
      code,
      country: cleanText(row.country, 120),
      website_url: websiteUrl,
      description: cleanText(row.description, 8000),
      logo_url: logoUrl,
      hero_image_url: null,
      brand_colour: null,
      line_type: inferLineType(name),
      market_segment: null,
      active: flags.active,
      sold_by_101cruise: flags.sold_by_101cruise,
      needs_review: flags.needs_review,
      review_notes: flags.review_notes,
      source_name: "Base44 CruiseLine export",
      source_url: null,
      last_verified_at: null
    };

    prepared.push(record);
    byLegacyId.set(legacyId, record);
  }

  report.importedLines = prepared.length;
  return { prepared, byLegacyId };
}

function prepareShips(rawShips, lineByLegacyId, lineByCode, report) {
  const usedSlugs = new Set();
  const prepared = [];

  for (const row of rawShips) {
    const name = cleanText(row.name, 200);
    const legacyId = cleanText(row.id, 80);
    let lineLegacy = cleanText(row.cruise_line_id, 80);

    if (!name || !legacyId) {
      report.shipsRequiringReview.push({ reason: "Blank ship name or id", name, legacyId });
      continue;
    }

    let line = lineLegacy ? lineByLegacyId.get(lineLegacy) : null;
    if (!line && lineLegacy && /^[A-Z]{2,6}-?\d*$/i.test(lineLegacy)) {
      const code = lineLegacy.replace(/-\d+$/, "").toUpperCase();
      line = lineByCode.get(code) || null;
      if (line) {
        report.shipsRequiringReview.push({
          ship: name,
          reason: `Mapped non-UUID cruise_line_id ${lineLegacy} → ${line.name} via code ${code}`
        });
        lineLegacy = line.legacy_base44_id;
      }
    }

    if (!line) {
      report.shipsWithoutLine.push({ ship: name, cruise_line_id: lineLegacy });
      continue;
    }

    const yearBuilt = parseInteger(row.year_built);
    const yearRefurb = parseInteger(row.year_refurbished);
    const passengers = parseInteger(row.passenger_capacity);
    const crew = parseInteger(row.crew_count);
    const decks = parseInteger(row.deck_count);
    const staterooms = parseInteger(row.stateroom_count);
    const tonnage = parseNumber(row.gross_tonnage);
    const length = parseNumber(row.length_meters);

    for (const parsed of [yearBuilt, yearRefurb, passengers, crew, decks, staterooms, tonnage, length]) {
      if (parsed && parsed.invalid) {
        report.shipsRequiringReview.push({
          ship: name,
          reason: `Invalid number "${parsed.raw}"`
        });
      }
    }

    const breakdown = parseJsonField(row.stateroom_breakdown, "stateroom_breakdown", name, report);
    const cabinTypes = parseJsonField(row.stateroom_types, "stateroom_types", name, report);
    const facilities = parseJsonField(row.facilities, "facilities", name, report);

    const status = cleanText(row.current_status, 60);
    const slugBase = slugify(name);
    const slug = uniqueSlug(slugBase, usedSlugs);

    const lineSold = Boolean(line.sold_by_101cruise);
    const yearBuiltValue = yearBuilt && !yearBuilt.invalid ? yearBuilt.value : null;
    const yearRefurbValue = yearRefurb && !yearRefurb.invalid ? yearRefurb.value : null;
    const passengersValue = passengers && !passengers.invalid ? passengers.value : null;
    const crewValue = crew && !crew.invalid ? crew.value : null;
    const decksValue = decks && !decks.invalid ? decks.value : null;
    const stateroomsValue = staterooms && !staterooms.invalid ? staterooms.value : null;
    const tonnageValue = tonnage && !tonnage.invalid ? tonnage.value : null;
    const lengthValue = length && !length.invalid ? length.value : null;

    const importantGaps = [];
    if (!facilities) importantGaps.push("facilities");
    if (tonnageValue == null) importantGaps.push("gross_tonnage");
    if (lengthValue == null) importantGaps.push("length_metres");
    if (!breakdown) importantGaps.push("stateroom_breakdown");
    if (!cabinTypes) importantGaps.push("stateroom_types");

    const incompleteProfile = importantGaps.length > 0;
    const reviewBits = [];
    if (!lineSold) reviewBits.push("Parent cruise line is not marked sold_by_101cruise");
    if (incompleteProfile) {
      reviewBits.push(
        `Incomplete ship profile fields: ${importantGaps.join(", ")}. Verify against an official cruise-line source.`
      );
    }

    const record = {
      legacy_base44_id: legacyId,
      _line_legacy_id: line.legacy_base44_id,
      name,
      slug,
      status,
      ship_class: null,
      year_built: yearBuiltValue,
      year_refurbished: yearRefurbValue,
      passenger_capacity: passengersValue,
      crew_count: crewValue,
      deck_count: decksValue,
      stateroom_count: stateroomsValue,
      gross_tonnage: tonnageValue,
      length_metres: lengthValue,
      stateroom_breakdown: breakdown,
      cabin_type_summary: cabinTypes,
      facilities,
      hero_image_url: null,
      image_gallery: null,
      deck_plan_url: null,
      official_ship_url: null,
      active: status !== "retired",
      needs_review: !lineSold || incompleteProfile,
      review_notes: reviewBits.length ? reviewBits.join(" ") : null,
      source_name: "Base44 CruiseShip export",
      source_url: null,
      last_verified_at: null
    };

    for (const field of importantGaps) {
      report.missingImportantFields.push({
        ship: name,
        cruise_line: line.name,
        field
      });
    }

    prepared.push(record);
  }

  report.importedShips = prepared.length;
  return prepared;
}

function printReport(report, { dryRun }) {
  console.log("\n=== Cruise Intelligence import report ===");
  console.log(dryRun ? "Mode: DRY RUN (no writes)" : "Mode: APPLY");
  console.log(`Cruise lines prepared: ${report.importedLines}`);
  console.log(`Ships prepared:        ${report.importedShips}`);
  console.log(`Excluded lines:        ${report.excludedLines.length}`);
  console.log(`Lines requiring review:${report.linesRequiringReview.length}`);
  console.log(`Ships without line:    ${report.shipsWithoutLine.length}`);
  console.log(`Invalid JSON fields:   ${report.invalidJson.length}`);
  console.log(`Duplicates skipped:    ${report.duplicatesSkipped.length}`);
  console.log(`Missing important:     ${report.missingImportantFields.length}`);

  if (report.excludedLines.length) {
    console.log("\nExcluded lines:");
    report.excludedLines.forEach((item) => console.log(`  - ${item.name}: ${item.reason}`));
  }
  if (report.shipsWithoutLine.length) {
    console.log("\nShips with no matching cruise line:");
    report.shipsWithoutLine.slice(0, 20).forEach((item) =>
      console.log(`  - ${item.ship} (cruise_line_id=${item.cruise_line_id})`)
    );
  }
  if (report.invalidJson.length) {
    console.log("\nInvalid JSON (stored as null):");
    report.invalidJson.slice(0, 20).forEach((item) =>
      console.log(`  - ${item.ship}.${item.field}: ${item.message}`)
    );
  }
  if (report.missingImportantFields.length) {
    console.log("\nMissing important ship-profile fields:");
    report.missingImportantFields.slice(0, 40).forEach((item) =>
      console.log(
        `  - ${item.cruise_line ? item.cruise_line + " / " : ""}${item.ship}: ${item.field}`
      )
    );
    if (report.missingImportantFields.length > 40) {
      console.log(`  … and ${report.missingImportantFields.length - 40} more`);
    }
  }
  const reviewLines = report.linesRequiringReview.filter((r) =>
    String(r.reason || "").includes("approved")
  );
  if (reviewLines.length) {
    console.log("\nCruise lines needing sold_by_101cruise review:");
    reviewLines.forEach((item) => console.log(`  - ${item.name}`));
  }
  console.log("");
}

async function upsertLines(env, lines) {
  const chunkSize = 50;
  const idByLegacy = new Map();
  for (let i = 0; i < lines.length; i += chunkSize) {
    const chunk = lines.slice(i, i + chunkSize);
    const data = await supabaseRequest(env, "POST", "ci_cruise_lines", {
      query: "?on_conflict=legacy_base44_id",
      body: chunk
    });
    for (const row of data || []) {
      idByLegacy.set(row.legacy_base44_id, row.id);
    }
  }
  return idByLegacy;
}

async function upsertShips(env, ships, idByLegacy) {
  const chunkSize = 40;
  let written = 0;
  for (let i = 0; i < ships.length; i += chunkSize) {
    const chunk = ships.slice(i, i + chunkSize).map((ship) => {
      const cruise_line_id = idByLegacy.get(ship._line_legacy_id);
      if (!cruise_line_id) return null;
      const { _line_legacy_id, ...rest } = ship;
      return { ...rest, cruise_line_id };
    }).filter(Boolean);

    if (!chunk.length) continue;
    await supabaseRequest(env, "POST", "ci_cruise_ships", {
      query: "?on_conflict=legacy_base44_id",
      body: chunk
    });
    written += chunk.length;
  }
  return written;
}

async function main() {
  const { dryRun, apply } = parseArgs(process.argv.slice(2));
  if (!dryRun && !apply) die("Pass --dry-run or --apply");

  const rawLines = loadCsvOrDie(LINE_CSV, "CruiseLine_export.csv");
  const rawShips = loadCsvOrDie(SHIP_CSV, "CruiseShip_export.csv");

  console.log(`Loaded ${rawLines.length} cruise lines, ${rawShips.length} ships from CSV`);

  const report = {
    importedLines: 0,
    importedShips: 0,
    excludedLines: [],
    linesRequiringReview: [],
    shipsWithoutLine: [],
    shipsRequiringReview: [],
    invalidJson: [],
    duplicatesSkipped: [],
    missingImportantFields: []
  };

  const { prepared: lines, byLegacyId } = prepareLines(rawLines, report);

  const lineByCode = new Map();
  for (const line of lines) {
    if (line.code) {
      const key = line.code.toUpperCase();
      if (!lineByCode.has(key)) lineByCode.set(key, line);
    }
  }

  const ships = prepareShips(rawShips, byLegacyId, lineByCode, report);
  printReport(report, { dryRun });

  if (dryRun) {
    console.log("Dry run complete. Re-run with --apply after applying the Supabase migration.");
    return;
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    die("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for --apply");
  }
  const env = { url: url.replace(/\/$/, ""), key };

  console.log("Upserting cruise lines…");
  const idByLegacy = await upsertLines(env, lines);
  console.log(`Upserted ${idByLegacy.size} cruise lines`);

  console.log("Upserting ships…");
  const written = await upsertShips(env, ships, idByLegacy);
  console.log(`Upserted ${written} ships`);
  console.log("Import complete.");
}

main().catch((error) => {
  die(error && error.message ? error.message : String(error));
});
