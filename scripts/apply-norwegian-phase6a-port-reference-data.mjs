#!/usr/bin/env node
/**
 * Apply Norwegian Phase 6A port reference-data (16 audited NCL port-of-call codes).
 *
 *   node scripts/apply-norwegian-phase6a-port-reference-data.mjs --dry-run
 *   node scripts/apply-norwegian-phase6a-port-reference-data.mjs --apply
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const poc = require(path.join(root, "netlify/functions/lib/norwegian-port-of-call-mappings"));

const PHASE6A_CODES = [
  "ACA",
  "PRQ",
  "PCL",
  "HOR",
  "LXO",
  "AST",
  "BRI",
  "KCZ",
  "NAH",
  "NII",
  "CMY",
  "HAN",
  "ESS",
  "DEN",
  "SVU",
  "DRA"
];

const APPLY = process.argv.includes("--apply");
const REPORT_PATH = path.join(root, "reports/norwegian-phase6a-port-reference-data.json");

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
  Mexico: "Mexican Riviera",
  Guatemala: "Central America",
  "Costa Rica": "Central America",
  Portugal: "Atlantic Islands",
  "United States": "North America",
  Italy: "Adriatic",
  Japan: "Japan",
  Vietnam: "Southeast Asia",
  Australia: "Australia",
  Fiji: "South Pacific"
};

const COUNTRY_CODE = {
  Mexico: "MX",
  Guatemala: "GT",
  "Costa Rica": "CR",
  Portugal: "PT",
  "United States": "US",
  Italy: "IT",
  Japan: "JP",
  Vietnam: "VN",
  Australia: "AU",
  Fiji: "FJ"
};

const COORDS = {
  Acapulco: [16.853, -99.823],
  "Puerto Quetzal": [13.933, -90.783],
  "Puerto Caldera": [9.952, -84.713],
  Horta: [38.535, -28.626],
  Leixoes: [41.185, -8.698],
  "Astoria Oregon": [46.188, -123.834],
  Bari: [41.117, 16.871],
  "Kochi Japan": [33.559, 133.531],
  Naha: [26.212, 127.679],
  Niigata: [37.916, 139.036],
  "Chan May": [16.327, 107.741],
  "Halong Bay": [20.951, 107.07],
  "Phillip Island": [-38.483, 145.238],
  Denarau: [-18.126, 177.317],
  Savusavu: [-16.782, 179.326],
  Dravuni: [-18.783, 178.533]
};

function extraAliases(mapping) {
  const aliases = [mapping.source_name];
  if (mapping.code === "PCL") aliases.push("Puntarenas");
  if (mapping.code === "LXO") aliases.push("Oporto", "Porto", "Leixões");
  if (mapping.code === "HAN") aliases.push("Hanoi (Ha Long Bay)", "Halong Bay");
  if (mapping.code === "DEN") aliases.push("Port Denarau");
  return aliases;
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
    codes_audited: PHASE6A_CODES.length,
    writes: [],
    skipped: []
  };

  for (const code of PHASE6A_CODES) {
    const mapping = poc.getPortOfCallMapping(code);
    if (!mapping) {
      report.skipped.push({ code, reason: "mapping_missing" });
      continue;
    }

    const existing = await findPort(rest, mapping.canonical_name);
    const aliases = extraAliases(mapping);

    if (mapping.classification === "EXISTING_ALIAS" || existing) {
      if (!existing) {
        report.skipped.push({ code, canonical_name: mapping.canonical_name, reason: "expected_existing_port_not_found" });
        continue;
      }
      const before = existing.aliases || [];
      const after = [...new Set([...(before || []), ...aliases])];
      if (after.length === before.length) {
        report.skipped.push({ code, canonical_name: mapping.canonical_name, reason: "aliases_already_present", id: existing.id });
        continue;
      }
      report.writes.push({
        table: "ports",
        action: "update_aliases",
        code,
        record_id: existing.id,
        canonical_name: mapping.canonical_name,
        before,
        after,
        reason: `NCL Phase 6A ${code} alias reference data`
      });
      if (APPLY) {
        await rest.request(`ports?id=eq.${encodeURIComponent(existing.id)}`, {
          method: "PATCH",
          body: { aliases: after },
          prefer: "return=minimal"
        });
      }
      continue;
    }

    if (existing) {
      report.skipped.push({ code, canonical_name: mapping.canonical_name, reason: "already_exists", id: existing.id });
      continue;
    }

    const [lat, lon] = COORDS[mapping.canonical_name] || [null, null];
    const body = {
      id: crypto.randomUUID(),
      canonical_name: mapping.canonical_name,
      display_name: mapping.source_name,
      city: mapping.canonical_name,
      country: mapping.country,
      country_code: COUNTRY_CODE[mapping.country] || "XX",
      region: REGION_BY_COUNTRY[mapping.country] || mapping.country,
      latitude: lat,
      longitude: lon,
      aliases: [...new Set(aliases)],
      match_key: buildMatchKey(mapping.canonical_name, mapping.country),
      source: "seed:norwegian_phase6a",
      status: "verified",
      image_status: "NO_IMAGE"
    };

    report.writes.push({
      table: "ports",
      action: "insert",
      code,
      before: null,
      after: body,
      classification: mapping.classification,
      reason: `NCL Phase 6A ${code} port-of-call reference data`
    });

    if (APPLY) {
      await rest.request("ports", { method: "POST", body, prefer: "return=representation" });
    }
  }

  report.write_count = report.writes.length;
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      { ok: true, report_path: REPORT_PATH, mode: report.mode, write_count: report.write_count, skipped: report.skipped.length },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
