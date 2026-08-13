#!/usr/bin/env node
/**
 * Apply approved Norwegian port reference-data changes to Supabase.
 *
 *   node scripts/apply-norwegian-port-reference-data.mjs --dry-run
 *   node scripts/apply-norwegian-port-reference-data.mjs --apply
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

const APPLY = process.argv.includes("--apply");
const REPORT_PATH = path.join(root, "reports/norwegian-port-reference-data-phase3.json");

const NEW_PORTS = [
  {
    canonical_name: "Great Stirrup Cay",
    display_name: "Great Stirrup Cay, Bahamas",
    city: "Great Stirrup Cay",
    country: "Bahamas",
    country_code: "BS",
    region: "Bahamas",
    latitude: 25.817,
    longitude: -77.913,
    aliases: ["NCL Great Stirrup Cay", "Great Stirrup Cay Bahamas"],
    status: "verified"
  },
  {
    canonical_name: "Incheon",
    display_name: "Incheon, South Korea",
    city: "Incheon",
    country: "South Korea",
    country_code: "KR",
    region: "East Asia",
    latitude: 37.456,
    longitude: 126.617,
    aliases: ["Seoul (Incheon)", "Seoul (Incheon), South Korea", "Incheon Port"],
    status: "verified"
  },
  {
    canonical_name: "San Antonio",
    display_name: "San Antonio, Chile",
    city: "San Antonio",
    country: "Chile",
    country_code: "CL",
    region: "South America",
    latitude: -33.595,
    longitude: -71.619,
    aliases: ["Santiago (San Antonio)", "Santiago (San Antonio), Chile", "San Antonio Chile"],
    status: "verified"
  },
  {
    canonical_name: "Jacksonville",
    display_name: "Jacksonville, Florida",
    city: "Jacksonville",
    country: "United States",
    country_code: "US",
    region: "Caribbean",
    latitude: 30.39,
    longitude: -81.54,
    aliases: ["JAXPORT", "Jacksonville Port"],
    status: "verified"
  },
  {
    canonical_name: "Philadelphia",
    display_name: "Philadelphia, Pennsylvania",
    city: "Philadelphia",
    country: "United States",
    country_code: "US",
    region: "North America Atlantic",
    latitude: 39.93,
    longitude: -75.14,
    aliases: ["Philadelphia Cruise Terminal", "PhilaPort"],
    status: "verified"
  }
];

const ALIAS_UPDATES = [
  {
    canonical_name: "Tarragona",
    aliases: ["Barcelona (Tarragona)", "Barcelona (Tarragona), Spain"],
    reason: "NCL TAR code maps to Tarragona, not Barcelona"
  },
  {
    canonical_name: "Ravenna",
    aliases: ["Porto Corsini", "Venice (Ravenna)", "Venice (Ravenna), Italy"],
    reason: "NCL RAV code maps to Ravenna, not Venice"
  },
  {
    canonical_name: "Trieste",
    aliases: ["Venice (Trieste)", "Venice (Trieste), Italy"],
    reason: "NCL VCE code maps to Trieste, not Venice"
  },
  {
    canonical_name: "Ketchikan",
    aliases: ["Ketchikan (Ward Cove)", "Ketchikan (Ward Cove), Alaska", "Ward Cove"],
    reason: "Ward Cove is NCL's Ketchikan terminal context"
  },
  {
    canonical_name: "Valparaiso",
    aliases: ["Santiago Valparaiso", "Valparaiso Santiago"],
    reason: "Remove bare Santiago alias that could collide with San Antonio, Chile"
  }
];

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

async function findPort(rest, canonicalName) {
  const rows = await rest.get(`ports?canonical_name=eq.${encodeURIComponent(canonicalName)}&select=id,canonical_name,aliases,country,match_key&limit=1`);
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

  for (const entry of NEW_PORTS) {
    const existing = await findPort(rest, entry.canonical_name);
    if (existing) {
      report.skipped.push({ action: "insert_port", canonical_name: entry.canonical_name, reason: "already_exists", id: existing.id });
      continue;
    }
    const body = {
      id: crypto.randomUUID(),
      ...entry,
      match_key: buildMatchKey(entry.canonical_name, entry.country),
      source: "seed:norwegian_phase3",
      image_status: "NO_IMAGE"
    };
    report.writes.push({ table: "ports", action: "insert", before: null, after: body, reason: "NCL embark/port-of-call reference data" });
    if (APPLY) {
      await rest.request("ports", { method: "POST", body, prefer: "return=representation" });
    }
  }

  for (const entry of ALIAS_UPDATES) {
    const existing = await findPort(rest, entry.canonical_name);
    if (!existing) {
      report.skipped.push({ action: "update_aliases", canonical_name: entry.canonical_name, reason: "port_not_found_in_supabase" });
      continue;
    }
    const before = existing.aliases || [];
    const after = [...new Set(entry.aliases)];
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

  report.write_count = report.writes.length;
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ report_path: REPORT_PATH, mode: report.mode, write_count: report.write_count, skipped: report.skipped.length }, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
