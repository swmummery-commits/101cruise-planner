#!/usr/bin/env node
/** Norwegian Phase 10 enrichment port reference-data (5 codes). */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const poc = require(path.join(root, "netlify/functions/lib/norwegian-port-of-call-mappings"));

const PHASE10_CODES = ["VGO", "MBJ", "LIO", "PCG", "HGC"];
const APPLY = process.argv.includes("--apply");
const REPORT_PATH = path.join(root, "reports/norwegian-phase10-port-reference-data.json");

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
  Spain: "Europe",
  Jamaica: "Caribbean",
  "Costa Rica": "Central America",
  Panama: "Central America",
  "United States": "Alaska"
};
const CC = { Spain: "ES", Jamaica: "JM", "Costa Rica": "CR", Panama: "PA", "United States": "US" };
const COORDS = {
  Vigo: [42.231, -8.712],
  "Montego Bay": [18.476, -77.893],
  "Puerto Limon": [9.991, -83.035],
  "Panama Canal Gatun Lake": [9.266, -79.92],
  "Hubbard Glacier": [59.012, -139.819]
};

function extraAliases(m) {
  const a = [m.source_name];
  if (m.code === "LIO") a.push("Limon", "Limón", "Puerto Limón");
  if (m.code === "PCG") a.push("Panama Canal", "Gatun Lake");
  if (m.code === "HGC") a.push("Hubbard Glacier scenic cruising");
  if (m.code === "VGO") a.push("Vigo, Spain");
  return a;
}

async function main() {
  const rest = createSupabaseRest(root);
  const report = { mode: APPLY ? "apply" : "dry-run", generated_at: new Date().toISOString(), writes: [], skipped: [] };

  for (const code of PHASE10_CODES) {
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
      report.writes.push({
        action: "update_aliases",
        code,
        canonical_name: mapping.canonical_name,
        before,
        after
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
      source: "seed:norwegian_phase10",
      status: "verified",
      image_status: "NO_IMAGE"
    };
    report.writes.push({ action: "insert", code, canonical_name: mapping.canonical_name, body });
    if (APPLY) await rest.request("ports", { method: "POST", body, prefer: "return=minimal" });
  }

  report.write_count = report.writes.length;
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, report_path: REPORT_PATH, write_count: report.write_count, skipped: report.skipped.length }, null, 2));
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
