#!/usr/bin/env node
/**
 * Read-only Royal Caribbean source accounting + three-ID forensic.
 * Does not write discovered_cruises.
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createMaintenanceSupabase, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const {
  fetchRoyalCaribbeanCruiseDetail,
  classifyRoyalAbsentProductionRecord
} = require(path.join(root, "netlify/functions/lib/royal-caribbean-source-enumeration"));
const { perthCalendarDate } = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));

const TARGET_IDS = ["EX07M807_2026-10-17", "BR07M821_2026-10-12", "EX07M840_2026-10-10"];

async function loadProduction(sb, sailingId) {
  const encoded = encodeURIComponent(sailingId);
  const rows = await sb(
    `discovered_cruises?official_sailing_id=eq.${encoded}&select=id,official_sailing_id,external_key,identity_key,ship_id,departure_date,return_date,nights,departure_port,destination_id,status,raw_extract,cruise_line_id`
  );
  return rows?.[0] || null;
}

async function loadShip(sb, shipId) {
  if (!shipId) return null;
  const rows = await sb(`ci_cruise_ships?id=eq.${encodeURIComponent(shipId)}&select=id,name&limit=1`);
  return rows?.[0] || null;
}

async function forensicOne(sb, sailingId, today) {
  const row = await loadProduction(sb, sailingId);
  const ship = row ? await loadShip(sb, row.ship_id) : null;
  const groupId = row?.raw_extract?.royal_caribbean_group_id || row?.raw_extract?.celebrity_group_id || null;
  const detail = groupId ? await fetchRoyalCaribbeanCruiseDetail(groupId) : { ok: false, error: "missing_group_id" };
  const sailing = (detail.cruise?.sailings || []).find((item) => String(item.id) === sailingId) || null;
  return {
    official_sailing_id: sailingId,
    production_uuid: row?.id || null,
    ship: ship?.name || null,
    departure: row?.departure_date || null,
    return: row?.return_date || null,
    nights: row?.nights ?? null,
    departure_port: row?.departure_port || null,
    destination: row?.destination_id || null,
    external_key: row?.external_key || null,
    identity_key: row?.identity_key || null,
    status: row?.status || null,
    group_id: groupId,
    official_detail: {
      ok: detail.ok === true,
      status: detail.status || null,
      error: detail.error || null,
      group_missing: detail.group_missing === true,
      sailing_present: Boolean(sailing),
      sailing_status: sailing?.status || null
    },
    disposition: classifyRoyalAbsentProductionRecord({
      row: row || { official_sailing_id: sailingId },
      unionSailingIds: new Set(),
      today,
      detail: {
        official_sailing_id: sailingId,
        detail_ok: detail.ok === true,
        sailing_present_in_detail: Boolean(sailing),
        retrievable: detail.ok === true && Boolean(sailing),
        group_missing: detail.group_missing === true
      }
    })?.disposition || "UNEXPLAINED_CURRENT"
  };
}

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const today = perthCalendarDate();
  const ids = [];
  for (const id of TARGET_IDS) ids.push(await forensicOne(sb, id, today));
  const report = {
    generated_at: new Date().toISOString(),
    perth_today: today,
    three_id_forensic: ids,
    unexplained_current_ids: ids.filter((row) => row.disposition === "UNEXPLAINED_CURRENT").map((row) => row.official_sailing_id)
  };
  const file = path.join(root, "reports", `royal-p3f-three-id-forensic-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report_file: file, ...report }, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
