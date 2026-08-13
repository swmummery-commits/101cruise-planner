#!/usr/bin/env node
/** Norwegian Phase 8 port reference-data (Phase 7 cleanup + Phase 8 enrichment ports). */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const poc = require(path.join(root, "netlify/functions/lib/norwegian-port-of-call-mappings"));

const PHASE8_CODES = [
  "NPO", "BHB", "CBR", "ISH", "JJU", "HK1", "MAT", "KAN",
  "RIX", "KLJ", "GDY", "PRM", "BE9", "LBI", "RNN", "RJK", "VIS", "MIY", "SAS", "MUA", "KKB", "PPS", "COR", "VBY"
];
const APPLY = process.argv.includes("--apply");
const REPORT_PATH = path.join(root, "reports/norwegian-phase8-port-reference-data.json");

function buildMatchKey(canonicalName, country) {
  const norm = (v) =>
    String(v || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  return `${norm(canonicalName)}|${norm(country)}`;
}

const REGION = {
  "United States": "North America", "Dominican Republic": "Caribbean", Japan: "Japan", "South Korea": "Asia",
  Australia: "Australia", Latvia: "Baltic", Lithuania: "Baltic", Poland: "Baltic", Portugal: "Europe",
  Canada: "Canada & New England", Denmark: "Northern Europe", Croatia: "Adriatic", Norway: "Northern Europe",
  Brunei: "Southeast Asia", Malaysia: "Southeast Asia", Philippines: "Southeast Asia", Sweden: "Baltic"
};
const CC = {
  "United States": "US", "Dominican Republic": "DO", Japan: "JP", "South Korea": "KR", Australia: "AU",
  Latvia: "LV", Lithuania: "LT", Poland: "PL", Portugal: "PT", Canada: "CA", Denmark: "DK", Croatia: "HR",
  Norway: "NO", Brunei: "BN", Malaysia: "MY", Philippines: "PH", Sweden: "SE"
};
const COORDS = {
  "Newport Rhode Island": [41.49, -71.313], "Bar Harbor": [44.388, -68.204], "Cabo Rojo": [17.975, -71.185],
  Ishigaki: [24.341, 124.156], Jeju: [33.5, 126.531], Fukuoka: [33.59, 130.401], Matsuyama: [33.839, 132.766],
  "Kangaroo Island": [-35.817, 137.417], Riga: [56.95, 24.105], Klaipeda: [55.703, 21.144], Gdynia: [54.519, 18.531],
  Portimao: [37.137, -8.538], Beppu: [33.279, 131.497], Saguenay: [48.336, -70.877], "Ronne Bornholm": [55.1, 14.706],
  Rijeka: [45.327, 14.442], "Vik Norway": [61.089, 6.594], Miyakojima: [24.806, 125.281], Sasebo: [33.16, 129.724],
  Muara: [5.027, 115.071], "Kota Kinabalu": [5.98, 116.073], "Puerto Princesa": [9.739, 118.736], Coron: [12.003, 120.205],
  Visby: [57.635, 18.295]
};

function extraAliases(m) {
  const a = [m.source_name];
  if (m.code === "HK1") a.push("Hakata", "Hakata Fukuoka");
  if (m.code === "NPO") a.push("Newport RI");
  if (m.code === "KAN") a.push("Penneshaw");
  if (m.code === "LBI") a.push("La Baie", "Saguenay La Baie");
  if (m.code === "PRM") a.push("Portimão");
  if (m.code === "VIS") a.push("Vik");
  return a;
}

async function main() {
  const rest = createSupabaseRest(root);
  const report = { mode: APPLY ? "apply" : "dry-run", generated_at: new Date().toISOString(), writes: [], skipped: [] };
  for (const code of PHASE8_CODES) {
    const mapping = poc.getPortOfCallMapping(code);
    const rows = await rest.get(`ports?canonical_name=eq.${encodeURIComponent(mapping.canonical_name)}&select=id,canonical_name&limit=1`);
    if (rows?.[0]) {
      report.skipped.push({ code, canonical_name: mapping.canonical_name, reason: "already_exists", id: rows[0].id });
      continue;
    }
    const [lat, lon] = COORDS[mapping.canonical_name] || [null, null];
    const body = {
      id: crypto.randomUUID(),
      canonical_name: mapping.canonical_name,
      display_name: mapping.source_name,
      city: mapping.canonical_name,
      country: mapping.country,
      country_code: CC[mapping.country] || "XX",
      region: REGION[mapping.country] || mapping.country,
      latitude: lat,
      longitude: lon,
      aliases: [...new Set(extraAliases(mapping))],
      match_key: buildMatchKey(mapping.canonical_name, mapping.country),
      source: "seed:norwegian_phase8",
      status: "verified",
      image_status: "NO_IMAGE"
    };
    report.writes.push({ action: "insert", code, canonical_name: mapping.canonical_name });
    if (APPLY) await rest.request("ports", { method: "POST", body, prefer: "return=minimal" });
  }
  report.write_count = report.writes.length;
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, report_path: REPORT_PATH, write_count: report.write_count, skipped: report.skipped.length }, null, 2));
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
