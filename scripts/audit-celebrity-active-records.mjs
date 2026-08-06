#!/usr/bin/env node
/**
 * Deep Celebrity active-record audit vs official eligible inventory.
 *   node scripts/audit-celebrity-active-records.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { simulateCelebrityInventory, catalogueDestinations, isEligibleCelebrityCruise } = require(path.join(
  root,
  "netlify/functions/lib/celebrity-discovery-adapter"
));
const { fetchRowsBySailingIds, summariseActivationAudit } = require(path.join(
  root,
  "scripts/lib/celebrity-batch-audit.cjs"
));

const OUTPUT = path.join(root, "reports/celebrity-active-records-audit-2026-08-06.json");

function loadEnv() {
  try {
    require("dotenv").config({ path: path.join(root, ".env") });
  } catch {
    /* optional */
  }
}
loadEnv();

async function fetchAll(sb, pathSuffix) {
  const rows = [];
  let offset = 0;
  while (true) {
    const batch = await sb.get(`${pathSuffix}&limit=1000&offset=${offset}`);
    if (!batch?.length) break;
    rows.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  return rows;
}

async function main() {
  const sb = createSupabaseRest(root);
  const today = new Date().toISOString().slice(0, 10);
  const line = (await sb.get("ci_cruise_lines?slug=eq.celebrity-cruises&select=id,name&limit=1"))?.[0];
  const ships = await sb.get(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&active=eq.true&select=id,name,cruise_line_id,official_line_ship_id`
  );
  const destRows = await sb.get(
    "destinations?classification_enabled=eq.true&select=id,name,slug,status,classification_enabled"
  );
  const destinations = catalogueDestinations(destRows || []);

  const simulation = await simulateCelebrityInventory({
    cruiseLine: line,
    ships: ships || [],
    destinations,
    today
  });

  const eligible = simulation.products.filter(
    (p) => p.complete_high_confidence && isEligibleCelebrityCruise(p.product_type)
  );
  const eligibleByKey = new Map(eligible.map((p) => [p.official_product_key, p]));
  const eligibleOcean = eligible.filter((p) => p.product_type === "ocean_cruise");
  const eligibleRiver = eligible.filter((p) => p.product_type === "river_cruise");

  const activeRows = await fetchAll(
    sb,
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(line.id)}&status=eq.active&select=id,status,departure_date,official_sailing_id,ship_id,destination_id,departure_port,return_date,nights,official_url,identity_key,created_at,updated_at,raw_extract`
  );

  const sailingIds = activeRows.map((r) => r.official_sailing_id || r.raw_extract?.celebrity_sailing_id).filter(Boolean);
  const audited = await fetchRowsBySailingIds(root, sailingIds);
  const activation = summariseActivationAudit(audited);

  const notInEligible = [];
  const wrongProductType = [];
  const missingFromDb = [];

  for (const row of activeRows) {
    const sid = row.official_sailing_id || row.raw_extract?.celebrity_sailing_id;
    const dbType = row.raw_extract?.celebrity_product_type || null;
    const official = sid ? eligibleByKey.get(sid) : null;
    if (!official) {
      notInEligible.push({
        id: row.id,
        official_sailing_id: sid,
        db_product_type: dbType,
        departure_date: row.departure_date,
        created_at: row.created_at,
        run_marker: row.raw_extract?.celebrity_batch_run_id || row.raw_extract?.celebrity_run_id || null
      });
      continue;
    }
    if (dbType && official.product_type !== dbType) {
      wrongProductType.push({
        id: row.id,
        official_sailing_id: sid,
        db_product_type: dbType,
        official_product_type: official.product_type
      });
    }
  }

  for (const p of eligible) {
    const sid = p.official_product_key;
    const found = activeRows.some(
      (r) => (r.official_sailing_id || r.raw_extract?.celebrity_sailing_id) === sid
    );
    if (!found) missingFromDb.push({ official_sailing_id: sid, product_type: p.product_type });
  }

  const untypedActive = activeRows.filter((r) => !r.raw_extract?.celebrity_product_type);
  const cruisetourActive = activeRows.filter((r) =>
    ["ocean_cruisetour", "river_cruisetour"].includes(r.raw_extract?.celebrity_product_type)
  );
  const hotelOrigin = activeRows.filter((r) => /hotel/i.test(String(r.departure_port || "")));

  const report = {
    generated_at: new Date().toISOString(),
    official_eligible: {
      ocean: eligibleOcean.length,
      river: eligibleRiver.length,
      total: eligible.length
    },
    database_active: {
      total: activeRows.length,
      ocean: activeRows.filter((r) => r.raw_extract?.celebrity_product_type === "ocean_cruise").length,
      river: activeRows.filter((r) => r.raw_extract?.celebrity_product_type === "river_cruise").length,
      untyped: untypedActive.length,
      cruisetours: cruisetourActive.length,
      hotel_origin: hotelOrigin.length
    },
    delta: {
      ocean_over_eligible:
        activeRows.filter((r) => r.raw_extract?.celebrity_product_type === "ocean_cruise").length -
        eligibleOcean.length,
      river_under_eligible:
        eligibleRiver.length -
        activeRows.filter((r) => r.raw_extract?.celebrity_product_type === "river_cruise").length
    },
    activation_audit: activation,
    not_in_eligible_inventory: notInEligible,
    wrong_product_type: wrongProductType,
    missing_eligible_from_db: missingFromDb,
    untyped_active_detail: untypedActive.map((r) => ({
      id: r.id,
      official_sailing_id: r.official_sailing_id,
      raw_extract_keys: Object.keys(r.raw_extract || {})
    }))
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
