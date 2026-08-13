#!/usr/bin/env node
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import fs from "fs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
try { require("dotenv").config({ path: path.join(root, ".env") }); } catch {}
try { require("dotenv").config({ path: path.join(root, ".env.local") }); } catch {}

const { createMaintenanceSupabase, exactCountSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { daysUntilDeparture, PUBLIC_BOOKING_CUTOFF_DAYS } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));
const { perthCalendarDate } = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));

const applyReport = JSON.parse(
  fs.readFileSync(
    path.join(root, "reports/seabourn-first-controlled-batch-seabourn-first-batch-2026-08-13T02-43-39-506Z.json"),
    "utf8"
  )
);

const sb = createMaintenanceSupabase(root);
const line = (await sb("ci_cruise_lines?slug=eq.seabourn-cruise-line&select=id,name,slug&limit=1"))?.[0];
const today = perthCalendarDate();
const details = applyReport.write_result?.stats?.write_details || [];
const ids = details.map((d) => d.discovered_cruise_id).filter(Boolean);
const rows = ids.length
  ? await sb(
      `discovered_cruises?id=in.(${ids.join(",")})&select=id,cruise_line_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,status,official_sailing_id,identity_key,official_url,match_confidence,raw_extract`
    )
  : [];
const ships = await sb(`ci_cruise_ships?cruise_line_id=eq.${line.id}&select=id,name`);
const shipMap = Object.fromEntries((ships || []).map((s) => [s.id, s.name]));
const dests = await sb("destinations?select=id,name,slug");
const destMap = Object.fromEntries((dests || []).map((d) => [d.id, d.name]));
const active = (await exactCountSupabase(root, "discovered_cruises", `cruise_line_id=eq.${line.id}&status=eq.active`)).count;
const legacy = await sb(
  `discovered_cruises?cruise_line_id=eq.${line.id}&status=in.(hidden,match_required,validation_failed)&select=id,status`
);
const legacyCounts = {};
for (const r of legacy || []) legacyCounts[r.status] = (legacyCounts[r.status] || 0) + 1;
const dupCheck = await sb(`discovered_cruises?cruise_line_id=eq.${line.id}&status=eq.active&select=official_sailing_id`);
const sailingCounts = {};
for (const r of dupCheck || []) sailingCounts[r.official_sailing_id] = (sailingCounts[r.official_sailing_id] || 0) + 1;
const dups = Object.entries(sailingCounts).filter(([, c]) => c > 1);

const verification = rows.map((r) => {
  const days = daysUntilDeparture(r.departure_date, today);
  return {
    id: r.id,
    official_sailing_id: r.official_sailing_id,
    ship: shipMap[r.ship_id] || null,
    departure: r.departure_date,
    nights: r.nights,
    embarkation: r.departure_port,
    destination: destMap[r.destination_id] || null,
    status: r.status,
    confidence: r.match_confidence,
    source_method: r.raw_extract?.structured_source || null,
    identity_ok: r.official_sailing_id === r.raw_extract?.seabourn_sailing_id,
    line_ok: r.cruise_line_id === line.id,
    days_until_departure: days,
    public_eligible: days != null && days > PUBLIC_BOOKING_CUTOFF_DAYS
  };
});

const missing = details
  .map((d) => d.seabourn_sailing_id)
  .filter((sid) => !(rows || []).some((r) => r.official_sailing_id === sid));

const report = {
  today,
  active_count: active,
  expected_inserted: details.length,
  found_rows: rows.length,
  missing,
  duplicate_official_ids: dups,
  field_mismatches: verification.filter((v) => !v.identity_ok || !v.line_ok || v.status !== "active"),
  public_visibility: {
    all_outside_21_day_cutoff: verification.every((v) => v.public_eligible === true),
    sample: verification.slice(0, 3)
  },
  legacy_status_counts: legacyCounts,
  verification
};

console.log(JSON.stringify(report, null, 2));
if (missing.length || dups.length || report.field_mismatches.length) process.exit(1);
