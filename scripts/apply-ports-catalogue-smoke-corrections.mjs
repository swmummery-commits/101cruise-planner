#!/usr/bin/env node
/**
 * Apply smoke-test catalogue corrections to production ports via REST.
 *
 *   node scripts/apply-ports-catalogue-smoke-corrections.mjs --dry-run
 *   node scripts/apply-ports-catalogue-smoke-corrections.mjs --apply
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const APPLY = process.argv.includes("--apply");
const DRY = process.argv.includes("--dry-run") || !APPLY;

function buildMatchKey(name, country) {
  const n = String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const c = String(country || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return c ? `${n}|${c}` : `${n}|`;
}

async function findByMatchKey(rest, matchKey) {
  const rows = await rest.get(`ports?select=id,canonical_name,match_key&match_key=eq.${encodeURIComponent(matchKey)}&limit=1`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function main() {
  const rest = createSupabaseRest(root);
  const results = [];

  const victoria = await rest.get(
    "ports?select=id,canonical_name,region,country,country_code&canonical_name=eq.Victoria%20BC&limit=1"
  );
  if (Array.isArray(victoria) && victoria[0]) {
    const patch = {
      region: "British Columbia",
      display_name: "Victoria, British Columbia",
      city: "Victoria",
      country: "Canada",
      country_code: "CA"
    };
    results.push({ action: "update", port: "Victoria BC", id: victoria[0].id, patch });
    if (APPLY) {
      await rest.request(`ports?id=eq.${victoria[0].id}`, { method: "PATCH", body: patch, prefer: "return=minimal" });
    }
  }

  const dunedin = await rest.get(
    "ports?select=id,canonical_name,city,aliases,match_key&canonical_name=eq.Dunedin&limit=1"
  );
  if (Array.isArray(dunedin) && dunedin[0]) {
    const patch = {
      canonical_name: "Port Chalmers",
      display_name: "Port Chalmers (Dunedin), New Zealand",
      city: "Dunedin",
      region: "Otago",
      country: "New Zealand",
      country_code: "NZ",
      aliases: ["Dunedin", "Port Chalmers", "Port Chalmers Dunedin"],
      match_key: buildMatchKey("Port Chalmers", "New Zealand"),
      status: "verified"
    };
    results.push({ action: "update", port: "Port Chalmers/Dunedin", id: dunedin[0].id, patch });
    if (APPLY) {
      await rest.request(`ports?id=eq.${dunedin[0].id}`, { method: "PATCH", body: patch, prefer: "return=minimal" });
    }
  }

  const albanyKey = buildMatchKey("Albany", "Australia");
  if (!(await findByMatchKey(rest, albanyKey))) {
    const payload = {
      canonical_name: "Albany",
      display_name: "Albany, Western Australia",
      city: "Albany",
      region: "Western Australia",
      country: "Australia",
      country_code: "AU",
      latitude: -35.0244,
      longitude: 117.884,
      aliases: ["Albany WA", "Albany Western Australia"],
      status: "verified",
      source: "admin:port_image_smoke",
      match_key: albanyKey
    };
    results.push({ action: "create", port: "Albany WA", payload });
    if (APPLY) {
      await rest.request("ports", { method: "POST", body: payload, prefer: "return=minimal" });
    }
  }

  const newcastleKey = buildMatchKey("Newcastle", "Australia");
  if (!(await findByMatchKey(rest, newcastleKey))) {
    const payload = {
      canonical_name: "Newcastle",
      display_name: "Newcastle, New South Wales",
      city: "Newcastle",
      region: "New South Wales",
      country: "Australia",
      country_code: "AU",
      latitude: -32.9283,
      longitude: 151.7817,
      aliases: ["Newcastle NSW", "Newcastle Australia"],
      status: "verified",
      source: "admin:port_image_smoke",
      match_key: newcastleKey
    };
    results.push({ action: "create", port: "Newcastle NSW", payload });
    if (APPLY) {
      await rest.request("ports", { method: "POST", body: payload, prefer: "return=minimal" });
    }
  }

  const countRows = await rest.get("ports?select=id&limit=2000");
  console.log(
    JSON.stringify(
      {
        mode: DRY ? "dry-run" : "apply",
        changes: results,
        ports_count: Array.isArray(countRows) ? countRows.length : null
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
