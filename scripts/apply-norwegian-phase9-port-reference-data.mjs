#!/usr/bin/env node
/** Norwegian Phase 9 enrichment port reference-data (16 codes). */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const poc = require(path.join(root, "netlify/functions/lib/norwegian-port-of-call-mappings"));

const PHASE9_CODES = [
  "LPA", "SPU", "SCT", "PTG", "GOT", "BBO", "LVN", "ACE", "LCG", "GRU", "SHI", "SCP", "GIJ", "LRH", "PDR", "TKS"
];
const APPLY = process.argv.includes("--apply");
const REPORT_PATH = path.join(root, "reports/norwegian-phase9-port-reference-data.json");

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
  Spain: "Europe", Croatia: "Adriatic", "Cape Verde": "Atlantic Islands", Sweden: "Baltic", France: "Europe",
  Iceland: "Northern Europe", Japan: "Japan"
};
const CC = { Spain: "ES", Croatia: "HR", "Cape Verde": "CV", Sweden: "SE", France: "FR", Iceland: "IS", Japan: "JP" };
const COORDS = {
  "Las Palmas": [28.124, -15.43], Split: [43.508, 16.44], "Santa Cruz de Tenerife": [28.463, -16.251],
  "Porto Grande": [16.89, -25.0], Gothenburg: [57.709, 11.974], Bilbao: [43.263, -2.935], "Le Verdon": [45.544, -1.064],
  Arrecife: [28.963, -13.547], "La Coruna": [43.362, -8.411], Grundarfjordur: [64.924, -23.263], Shimonoseki: [33.957, 130.941],
  "Santa Cruz de la Palma": [28.683, -17.764], Gijon: [43.545, -5.661], "La Rochelle": [46.16, -1.151],
  "Puerto del Rosario": [28.499, -13.862], Takamatsu: [34.342, 134.043]
};

function extraAliases(m) {
  const a = [m.source_name];
  if (m.code === "LVN") a.push("Le Verdon", "Bordeaux Le Verdon");
  if (m.code === "PTG") a.push("Mindelo");
  if (m.code === "LCG") a.push("La Coruña");
  if (m.code === "GIJ") a.push("Gijón");
  return a;
}

async function main() {
  const rest = createSupabaseRest(root);
  const report = { mode: APPLY ? "apply" : "dry-run", generated_at: new Date().toISOString(), writes: [], skipped: [] };
  for (const code of PHASE9_CODES) {
    const mapping = poc.getPortOfCallMapping(code);
    const rows = await rest.get(`ports?canonical_name=eq.${encodeURIComponent(mapping.canonical_name)}&select=id&limit=1`);
    if (rows?.[0]) {
      report.skipped.push({ code, canonical_name: mapping.canonical_name, reason: "already_exists" });
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
      source: "seed:norwegian_phase9",
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
