#!/usr/bin/env node
/** Norwegian Phase 12 enrichment port reference-data (33 codes). */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const poc = require(path.join(root, "netlify/functions/lib/norwegian-port-of-call-mappings"));

const PHASE12_CODES = [
  "RAI", "IVG", "APW", "RAR", "IPO", "PPG", "PTR", "TYN", "TMU", "THE", "BYO", "STW", "KWL", "KLL", "BOR",
  "NTL", "DPS", "ABZ", "ALT", "KRD", "HAU", "CRH", "SKT", "ADQ", "HSY", "THO", "AIT", "SUB", "BUS", "ESP",
  "ALB", "LEM", "LRM"
];
const APPLY = process.argv.includes("--apply");
const REPORT_PATH = path.join(root, "reports/norwegian-phase12-port-reference-data.json");

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
  "French Polynesia": "South Pacific",
  "United Kingdom": "Northern Europe",
  Samoa: "South Pacific",
  "Cook Islands": "South Pacific",
  "American Samoa": "South Pacific",
  "New Zealand": "Australia & New Zealand",
  Greece: "Mediterranean",
  Ireland: "Northern Europe",
  Philippines: "Asia",
  Australia: "Australia & New Zealand",
  Indonesia: "Asia",
  Norway: "Northern Europe",
  Vietnam: "Asia",
  Japan: "Asia",
  "United States": "North America",
  "Faroe Islands": "Northern Europe",
  "Dominican Republic": "Caribbean"
};

const CC = {
  "French Polynesia": "PF",
  "United Kingdom": "GB",
  Samoa: "WS",
  "Cook Islands": "CK",
  "American Samoa": "AS",
  "New Zealand": "NZ",
  Greece: "GR",
  Ireland: "IE",
  Philippines: "PH",
  Australia: "AU",
  Indonesia: "ID",
  Norway: "NO",
  Vietnam: "VN",
  Japan: "JP",
  "United States": "US",
  "Faroe Islands": "FO",
  "Dominican Republic": "DO"
};

function extraAliases(m) {
  return [m.source_name];
}

async function main() {
  const rest = createSupabaseRest(root);
  const report = { mode: APPLY ? "apply" : "dry-run", generated_at: new Date().toISOString(), writes: [], skipped: [] };

  for (const code of PHASE12_CODES) {
    const mapping = poc.getPortOfCallMapping(code);
    if (!mapping) {
      report.skipped.push({ code, reason: "missing_mapping" });
      continue;
    }

    const rows = await rest.get(
      `ports?canonical_name=eq.${encodeURIComponent(mapping.canonical_name)}&select=id,canonical_name,aliases&limit=1`
    );
    const existing = rows?.[0] || null;

    if (mapping.classification === "EXISTING_ALIAS") {
      if (!existing) {
        report.skipped.push({ code, canonical_name: mapping.canonical_name, reason: "alias_target_missing" });
        continue;
      }
      const before = existing.aliases || [];
      const after = [...new Set([...before, ...extraAliases(mapping)])];
      if (after.length === before.length) {
        report.skipped.push({ code, canonical_name: mapping.canonical_name, reason: "aliases_unchanged" });
        continue;
      }
      report.writes.push({ action: "update_aliases", code, canonical_name: mapping.canonical_name, before, after });
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
      report.skipped.push({ code, canonical_name: mapping.canonical_name, reason: "already_exists" });
      continue;
    }

    const body = {
      id: crypto.randomUUID(),
      canonical_name: mapping.canonical_name,
      display_name: mapping.source_name,
      city: mapping.canonical_name,
      country: mapping.country,
      country_code: CC[mapping.country] || "XX",
      region: REGION[mapping.country] || mapping.country,
      latitude: null,
      longitude: null,
      aliases: [...new Set(extraAliases(mapping))],
      match_key: buildMatchKey(mapping.canonical_name, mapping.country),
      source: "seed:norwegian_phase12",
      status: "verified",
      image_status: "NO_IMAGE"
    };
    report.writes.push({ action: "insert_port", code, before: null, after: body });
    if (APPLY) {
      await rest.request("ports", { method: "POST", body, prefer: "return=representation" });
    }
  }

  report.write_count = report.writes.length;
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({ report_path: REPORT_PATH, mode: report.mode, write_count: report.write_count, skipped: report.skipped.length }, null, 2)
  );
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
