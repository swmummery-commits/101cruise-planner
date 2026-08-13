#!/usr/bin/env node
/**
 * Apply Norwegian Phase 5C port reference-data and south-america destination to Supabase.
 *
 *   node scripts/apply-norwegian-phase5c-port-reference-data.mjs --dry-run
 *   node scripts/apply-norwegian-phase5c-port-reference-data.mjs --apply
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import crypto from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const poc = require(path.join(root, "netlify/functions/lib/norwegian-port-of-call-mappings"));

const APPLY = process.argv.includes("--apply");
const REPORT_PATH = path.join(root, "reports/norwegian-phase5c-port-reference-data.json");

function buildMatchKey(canonicalName, country) {
  const norm = (value) =>
    String(value || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  return `${norm(canonicalName)}|${norm(country)}`;
}

const REGION_BY_COUNTRY = {
  Malta: "Mediterranean",
  Spain: "Mediterranean",
  Tunisia: "Mediterranean",
  Montenegro: "Adriatic",
  France: "Northern Europe",
  Belgium: "Northern Europe",
  Norway: "Norwegian Fjords",
  Japan: "Japan",
  "United States": "North America",
  Jamaica: "Caribbean",
  "Dominican Republic": "Caribbean",
  Belize: "Caribbean",
  Bermuda: "Atlantic Islands",
  Bahamas: "Bahamas",
  "Falkland Islands": "South America"
};

const COORDS = {
  Valletta: [35.899, 14.514],
  Eastport: [44.906, -67.0],
  Motril: [36.748, -3.518],
  "Puerto Plata": [19.793, -70.688],
  "Portland Maine": [43.659, -70.256],
  Kanazawa: [36.561, 136.656],
  Akita: [39.754, 140.059],
  Hakodate: [41.769, 140.729],
  Shimizu: [35.015, 138.489],
  "Harvest Caye": [16.477, -88.186],
  "Falmouth Jamaica": [18.493, -77.656],
  "La Goulette": [36.818, 10.305],
  Samana: [19.205, -69.336],
  Kotor: [42.424, 18.771],
  "Royal Naval Dockyard": [32.329, -64.834],
  Bar: [42.094, 19.088],
  "Le Havre": [49.494, 0.108],
  Zeebrugge: [51.334, 3.207],
  Maloy: [61.935, 5.113],
  Skjolden: [61.157, 7.146],
  Sakaiminato: [35.539, 133.238],
  Aomori: [40.822, 140.747],
  Nagoya: [35.086, 136.881],
  Sendai: [38.268, 141.022],
  Maizuru: [35.474, 135.386],
  Kona: [19.64, -155.996],
  Melilla: [35.292, -2.938],
  Stanley: [-51.692, -57.859]
};

const ALIAS_ONLY = [
  {
    canonical_name: "Freeport",
    aliases: ["Grand Bahama Island", "Grand Bahama Island, Bahamas"],
    reason: "NCL FPO code maps to Freeport/Grand Bahama cruise port"
  }
];

function buildNewPorts() {
  return poc.NCL_PORT_OF_CALL_CODES.filter((row) =>
    ["NEW_PORT_REQUIRED", "DISTINCT_PORT_REQUIRED"].includes(row.classification)
  ).map((row) => {
    const [lat, lon] = COORDS[row.canonical_name] || [null, null];
    return {
      canonical_name: row.canonical_name,
      display_name: row.source_name,
      city: row.canonical_name,
      country: row.country,
      country_code: row.country === "United States" ? "US" : row.country === "Japan" ? "JP" : "XX",
      region: REGION_BY_COUNTRY[row.country] || "International",
      latitude: lat,
      longitude: lon,
      aliases: [row.source_name],
      status: "verified",
      source_code: row.code
    };
  });
}

async function findPort(rest, canonicalName) {
  const rows = await rest.get(
    `ports?canonical_name=eq.${encodeURIComponent(canonicalName)}&select=id,canonical_name,aliases,country,match_key&limit=1`
  );
  return rows?.[0] || null;
}

async function main() {
  const rest = createSupabaseRest(root);
  const report = {
    mode: APPLY ? "apply" : "dry-run",
    generated_at: new Date().toISOString(),
    writes: [],
    skipped: []
  };

  for (const entry of buildNewPorts()) {
    const existing = await findPort(rest, entry.canonical_name);
    if (existing) {
      report.skipped.push({ action: "insert_port", canonical_name: entry.canonical_name, reason: "already_exists", id: existing.id });
      continue;
    }
    const body = {
      id: crypto.randomUUID(),
      canonical_name: entry.canonical_name,
      display_name: entry.display_name,
      city: entry.city,
      country: entry.country,
      country_code: entry.country_code,
      region: entry.region,
      latitude: entry.latitude,
      longitude: entry.longitude,
      aliases: [...new Set(entry.aliases)],
      match_key: buildMatchKey(entry.canonical_name, entry.country),
      source: "seed:norwegian_phase5c",
      status: entry.status,
      image_status: "NO_IMAGE"
    };
    report.writes.push({
      table: "ports",
      action: "insert",
      source_code: entry.source_code,
      before: null,
      after: body,
      reason: "NCL Phase 5C port-of-call reference data"
    });
    if (APPLY) {
      await rest.request("ports", { method: "POST", body, prefer: "return=representation" });
    }
  }

  for (const entry of ALIAS_ONLY) {
    const existing = await findPort(rest, entry.canonical_name);
    if (!existing) {
      report.skipped.push({ action: "update_aliases", canonical_name: entry.canonical_name, reason: "port_not_found" });
      continue;
    }
    const before = existing.aliases || [];
    const after = [...new Set([...(before || []), ...entry.aliases])];
    report.writes.push({
      table: "ports",
      action: "update_aliases",
      record_id: existing.id,
      canonical_name: entry.canonical_name,
      before,
      after,
      reason: entry.reason
    });
    if (APPLY) {
      await rest.request(`ports?id=eq.${encodeURIComponent(existing.id)}`, {
        method: "PATCH",
        body: { aliases: after },
        prefer: "return=minimal"
      });
    }
  }

  const destExisting = await rest.get(`destinations?slug=eq.south-america&select=id,slug,name&limit=1`);
  if (!destExisting?.[0]) {
    const body = {
      id: crypto.randomUUID(),
      name: "South America",
      slug: "south-america",
      status: "draft",
      primary_region: "South America",
      display_order: 999
    };
    report.writes.push({ table: "destinations", action: "insert", before: null, after: body, reason: "NCL SOUTH_AMERICA code support" });
    if (APPLY) {
      await rest.request("destinations", { method: "POST", body, prefer: "return=representation" });
    }
  } else {
    report.skipped.push({ action: "insert_destination", slug: "south-america", reason: "already_exists", id: destExisting[0].id });
  }

  report.write_count = report.writes.length;
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ report_path: REPORT_PATH, mode: report.mode, write_count: report.write_count, skipped: report.skipped.length }, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
