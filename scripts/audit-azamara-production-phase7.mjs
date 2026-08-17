#!/usr/bin/env node
/**
 * Read-only Azamara production audit for Phase 7 closure.
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createMaintenanceSupabase } = require("./lib/supabase-rest.cjs");
const { isOfficialAzamaraRecord } = require("../netlify/functions/lib/azamara-discovery-adapter");

const AZAMARA_LINE_ID = "245e6de9-9ec2-480b-ab72-ed8943fe4f22";
const TODAY = new Date().toISOString().slice(0, 10);

async function main() {
  const sb = createMaintenanceSupabase(root);
  const line = (await sb(`ci_cruise_lines?slug=eq.azamara&select=id,name,slug&limit=1`))[0];
  const rows = await sb(
    `discovered_cruises?cruise_line_id=eq.${line.id}&select=id,status,departure_date,return_date,nights,departure_port,destination_id,ship_id,official_sailing_id,raw_extract&order=departure_date.asc`
  );

  const official = rows.filter((r) => isOfficialAzamaraRecord(r));
  const active = official.filter((r) => r.status === "active");
  const hidden = official.filter((r) => r.status === "hidden");
  const activeUpcoming = active.filter((r) => !r.departure_date || r.departure_date >= TODAY);
  const missingNights = active.filter((r) => !Number.isFinite(Number(r.nights)) || Number(r.nights) <= 0);
  const missingReturn = active.filter((r) => !r.return_date);
  const cruisetours = active.filter((r) => /-CT[AB]\d/i.test(String(r.official_sailing_id || "")));
  const hiddenCruisetours = hidden.filter((r) => /-CT[AB]\d/i.test(String(r.official_sailing_id || "")));

  const shipIds = [...new Set(activeUpcoming.map((r) => r.ship_id).filter(Boolean))];
  const ships = shipIds.length
    ? await sb(`ci_cruise_ships?id=in.(${shipIds.join(",")})&select=id,name`)
    : [];
  const shipNameById = Object.fromEntries((ships || []).map((s) => [s.id, s.name]));
  const byShip = {};
  for (const r of activeUpcoming) {
    const ship = shipNameById[r.ship_id] || r.ship_id;
    byShip[ship] = (byShip[ship] || 0) + 1;
  }

  const sailingIds = official.map((r) => String(r.official_sailing_id || "").trim()).filter(Boolean);
  const sailingDupes = sailingIds.filter((id, i) => sailingIds.indexOf(id) !== i);
  const identityKeys = official.map((r) => `${r.official_sailing_id}|${r.departure_date || ""}`);
  const identityDupes = identityKeys.filter((k, i) => identityKeys.indexOf(k) !== i);

  const pr261002 = official.find((r) => r.official_sailing_id === "PR261002-014");
  let pr261002Destination = null;
  if (pr261002?.destination_id) {
    pr261002Destination =
      (await sb(`destinations?id=eq.${pr261002.destination_id}&select=name&limit=1`))[0]?.name || null;
  }

  const dates = activeUpcoming.map((r) => r.departure_date).filter(Boolean).sort();
  const recentRuns = await sb(
    `cruise_discovery_runs?cruise_line_id=eq.${line.id}&scope=eq.cruise_line&order=created_at.desc&limit=5&select=id,status,stats,created_at,finished_at`
  );

  const report = {
    generated_at: new Date().toISOString(),
    total_official: official.length,
    active: active.length,
    active_upcoming: activeUpcoming.length,
    hidden: hidden.length,
    active_by_ship: byShip,
    earliest_upcoming: dates[0] || null,
    latest_upcoming: dates[dates.length - 1] || null,
    active_missing_nights: missingNights.length,
    active_missing_return_date: missingReturn.length,
    active_cruisetours: cruisetours.length,
    hidden_policy_excluded_cruisetours: hiddenCruisetours.length,
    duplicate_official_sailing_ids: [...new Set(sailingDupes)].length,
    duplicate_identity_keys: [...new Set(identityDupes)].length,
    pr261002_014: pr261002
      ? {
          departure_port: pr261002.departure_port,
          destination: pr261002Destination,
          departure_date: pr261002.departure_date
        }
      : null,
    recent_weekly_runs: (recentRuns || []).map((r) => ({
      id: r.id,
      status: r.status,
      run_type: r.stats?.run_type,
      trigger_type: r.stats?.trigger_type,
      dispatch_id: r.stats?.dispatch_id,
      would_insert: r.stats?.would_insert,
      would_update: r.stats?.would_update,
      global_lock: r.stats?.global_lock,
      created_at: r.created_at,
      finished_at: r.finished_at
    }))
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message || String(e) }));
  process.exit(1);
});
