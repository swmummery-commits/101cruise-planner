#!/usr/bin/env node
/** Rebuild Phase 8 core manifest from production phase8_controlled_import rows. */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createMaintenanceSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { NCL_LINE_ID } = require(path.join(root, "netlify/functions/lib/norwegian-discovery-writes"));

const BATCH_ID = process.argv[2] || `norwegian-phase8-export-${new Date().toISOString().replace(/[:.]/g, "-")}`;

async function main() {
  const sb = createMaintenanceSupabase(root);
  const rows = await sb(
    `discovered_cruises?cruise_line_id=eq.${NCL_LINE_ID}&select=id,ship_id,destination_id,departure_date,nights,departure_port,itinerary,official_url,source_url,external_key,identity_key,official_sailing_id,status,raw_extract&order=official_sailing_id.asc`
  );
  const phase8 = rows.filter((r) => r.raw_extract?.ncl_phase === "phase8_controlled_import");
  if (phase8.length !== 50) throw new Error(`Expected 50 phase8 rows, found ${phase8.length}`);
  const entries = phase8.map((row, index) => {
    const rx = row.raw_extract || {};
    const itineraryCode = rx.ncl_itinerary_code || row.itinerary;
    return {
      batch_position: index + 1,
      itinerary_code: itineraryCode,
      departure_date: row.departure_date,
      official_sailing_id: row.official_sailing_id,
      external_key: row.external_key,
      ship_code: rx.ncl_ship_code,
      resolved_ship_id: row.ship_id,
      embark_port_code: rx.ncl_embark_port_code,
      resolved_departure_port: row.departure_port,
      duration: row.nights,
      destination_codes: rx.ncl_destination_codes || [],
      resolved_destination_id: row.destination_id,
      source_url: row.source_url || row.official_url,
      proposed_status: "match_required",
      existing_record_id: row.id,
      candidate: {
        cruise_line_id: NCL_LINE_ID,
        ship_id: row.ship_id,
        destination_id: row.destination_id,
        departure_date: row.departure_date,
        nights: row.nights,
        departure_port: row.departure_port,
        itinerary: itineraryCode,
        official_url: row.official_url,
        source_url: row.source_url || row.official_url,
        external_key: row.external_key,
        identity_key: row.identity_key,
        official_sailing_id: row.official_sailing_id,
        status: row.status,
        raw_extract: row.raw_extract
      }
    };
  });
  const out = path.join(root, `reports/norwegian-phase8-controlled-batch-manifest-${BATCH_ID}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify({ batch_id: BATCH_ID, generated_at: new Date().toISOString(), entries }, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, path: out, count: entries.length }, null, 2));
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
