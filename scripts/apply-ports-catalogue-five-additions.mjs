#!/usr/bin/env node
/**
 * Add five missing canonical cruise ports to production.
 *
 *   node scripts/apply-ports-catalogue-five-additions.mjs --dry-run
 *   node scripts/apply-ports-catalogue-five-additions.mjs --apply
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

const ADDITIONS = [
  {
    canonical_name: "Busan",
    display_name: "Busan, South Korea",
    city: "Busan",
    country: "South Korea",
    country_code: "KR",
    region: "East Asia",
    latitude: 35.1028,
    longitude: 129.0403,
    aliases: ["Pusan", "Busan South Korea"]
  },
  {
    canonical_name: "Kagoshima",
    display_name: "Kagoshima, Japan",
    city: "Kagoshima",
    country: "Japan",
    country_code: "JP",
    region: "Japan",
    latitude: 31.5894,
    longitude: 130.5611,
    aliases: ["Kagoshima Japan"]
  },
  {
    canonical_name: "Cozumel",
    display_name: "Cozumel, Mexico",
    city: "Cozumel",
    country: "Mexico",
    country_code: "MX",
    region: "Caribbean",
    latitude: 20.508,
    longitude: -86.948,
    aliases: ["Isla Cozumel", "Cozumel Mexico"]
  },
  {
    canonical_name: "George Town",
    display_name: "George Town, Grand Cayman",
    city: "George Town",
    country: "Cayman Islands",
    country_code: "KY",
    region: "Caribbean",
    latitude: 19.2866,
    longitude: -81.3745,
    aliases: ["Grand Cayman", "Grand Cayman Cayman Islands", "Georgetown"]
  },
  {
    canonical_name: "Santorini",
    display_name: "Santorini (Athíniós), Greece",
    city: "Santorini",
    country: "Greece",
    country_code: "GR",
    region: "Eastern Mediterranean",
    latitude: 36.385,
    longitude: 25.429,
    aliases: ["Thira", "Fira", "Athinios", "Santorini Greece"]
  }
];

async function findByMatchKey(rest, matchKey) {
  const rows = await rest.get(
    `ports?select=id,canonical_name,country,match_key,aliases&match_key=eq.${encodeURIComponent(matchKey)}&limit=1`
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function findAlternate(rest, spec) {
  const patterns = [
    spec.canonical_name,
    ...(spec.aliases || [])
  ];
  for (const name of patterns) {
    const rows = await rest.get(
      `ports?select=id,canonical_name,country,match_key,aliases&canonical_name=ilike.${encodeURIComponent(name)}&limit=5`
    );
    if (!Array.isArray(rows)) continue;
    const hit = rows.find((row) => String(row.country || "").toLowerCase() === String(spec.country || "").toLowerCase());
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
    results.push({ action: "create", port: spec.canonical_name, match_key: matchKey, payload });
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
