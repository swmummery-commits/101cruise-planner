#!/usr/bin/env node
/**
 * Add four missing canonical cruise ports to production.
 *
 *   node scripts/apply-ports-catalogue-four-additions.mjs --dry-run
 *   node scripts/apply-ports-catalogue-four-additions.mjs --apply
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

/**
 * Costa Maya: Mahahual is the physical cruise port locality — deliberate alias, not Cozumel/Ensenada.
 */
const ADDITIONS = [
  {
    canonical_name: "Darwin",
    display_name: "Darwin, Northern Territory, Australia",
    city: "Darwin",
    country: "Australia",
    country_code: "AU",
    region: "Northern Territory",
    latitude: -12.4634,
    longitude: 130.8444,
    aliases: ["Darwin NT", "Darwin Northern Territory", "Darwin Australia"]
  },
  {
    canonical_name: "Picton",
    display_name: "Picton, Marlborough, New Zealand",
    city: "Picton",
    country: "New Zealand",
    country_code: "NZ",
    region: "Marlborough",
    latitude: -41.2901,
    longitude: 174.004,
    aliases: ["Picton Marlborough", "Picton New Zealand", "Queen Charlotte Sound"]
  },
  {
    canonical_name: "Prince Rupert",
    display_name: "Prince Rupert, British Columbia, Canada",
    city: "Prince Rupert",
    country: "Canada",
    country_code: "CA",
    region: "British Columbia",
    latitude: 54.315,
    longitude: -130.3209,
    aliases: ["Prince Rupert BC", "Prince Rupert Canada"]
  },
  {
    canonical_name: "Costa Maya",
    display_name: "Costa Maya, Mexico",
    city: "Mahahual",
    country: "Mexico",
    country_code: "MX",
    region: "Caribbean",
    latitude: 18.713,
    longitude: -87.709,
    aliases: ["Mahahual", "Costa Maya Mexico"],
    notes:
      "Mahahual is the physical cruise port locality for the Costa Maya destination; aliases exclude Ensenada, Cozumel, and Playa del Carmen."
  }
];

async function findByMatchKey(rest, matchKey) {
  const rows = await rest.get(
    `ports?select=id,canonical_name,country,match_key,aliases&match_key=eq.${encodeURIComponent(matchKey)}&limit=1`
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function findAlternate(rest, spec) {
  const patterns = [spec.canonical_name, ...(spec.aliases || [])];
  for (const name of patterns) {
    const rows = await rest.get(
      `ports?select=id,canonical_name,country,match_key,aliases&canonical_name=ilike.${encodeURIComponent(name)}&limit=5`
    );
    if (!Array.isArray(rows)) continue;
    const hit = rows.find(
      (row) => String(row.country || "").toLowerCase() === String(spec.country || "").toLowerCase()
    );
    if (hit) return hit;
  }
  return null;
}

async function main() {
  const rest = createSupabaseRest(root);
  const results = [];

  for (const spec of ADDITIONS) {
    const matchKey = buildMatchKey(spec.canonical_name, spec.country);
    const existing = (await findByMatchKey(rest, matchKey)) || (await findAlternate(rest, spec));
    if (existing) {
      results.push({ action: "exists", port: spec.canonical_name, match_key: existing.match_key, id: existing.id });
      continue;
    }

    const payload = {
      ...spec,
      status: "verified",
      source: "admin:port_image_catalogue_additions",
      match_key: matchKey
    };
    delete payload.notes;
    results.push({ action: "create", port: spec.canonical_name, match_key: matchKey, payload, notes: spec.notes || null });
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
