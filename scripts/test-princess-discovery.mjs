#!/usr/bin/env node
/**
 * Princess Cruises discovery tests (unit + optional live source probe).
 *   npm run test:princess-discovery
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const source = require(path.join(root, "netlify/functions/lib/princess-discovery-source"));
const adapter = require(path.join(root, "netlify/functions/lib/princess-discovery-adapter"));
const maintenance = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));
const inv = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { loadClassificationDestinations } = require(path.join(
  root,
  "netlify/functions/lib/destination-queries"
));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const FIXTURE_GROUP = {
  id: "ECR12A",
  trades: [{ id: "E" }],
  embkDbkPortIds: ["CPH", "CPH"],
  cruiseDuration: 12,
  ships: [
    { id: "SA", sailDates: ["20260807"] },
    { id: "CB", sailDates: ["20270506"] }
  ]
};

test("1. official identity formula itinerary|ship|date", () => {
  const key = source.officialProductKey({
    itinerary_id: "ECR12A",
    ship_code: "SA",
    departure_date: "2026-08-07"
  });
  if (key !== "ECR12A|SA|2026-08-07") throw new Error(key);
});

test("2. expand light product groups to dated sailings", () => {
  const expanded = source.expandProductGroupsToRawSailings([FIXTURE_GROUP], {
    shipsById: { SA: { id: "SA", name: "Sky Princess" }, CB: { id: "CB", name: "Caribbean Princess" } },
    portsById: { CPH: { id: "CPH", name: "Copenhagen, Denmark" } },
    today: "2026-08-06"
  });
  if (expanded.products.length !== 2) throw new Error(`expected 2 got ${expanded.products.length}`);
});

test("3. cruisetour classifier excludes land-tour names", () => {
  if (source.classifyProductType({ name: "Ultimate Alaska Cruisetour" }) !== "cruisetour") {
    throw new Error("cruisetour name");
  }
  if (source.classifyProductType({ name: "Norway & Sweden Cruise" }) !== "cruise") {
    throw new Error("cruise name");
  }
});

test("4. 21-day cutoff excludes near-departure Princess sailings during ingestion", () => {
  const { withinCutoff } = inv.partitionByPublicBookingCutoff(
    [{ departure_date: "2026-08-27" }, { departure_date: "2026-09-01" }],
    (row) => row.departure_date,
    "2026-08-06"
  );
  if (withinCutoff.length !== 1) throw new Error("cutoff partition");
});

test("5. Princess weekly flag defaults false", () => {
  if (maintenance.isPrincessWeeklyReconciliationEnabled()) throw new Error("default enabled");
});

test("6. Princess maintenance run type and cron", () => {
  if (maintenance.PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE !== "princess_weekly_maintenance") {
    throw new Error("run type");
  }
  if (maintenance.MAINTENANCE_SCHEDULES.princess_weekly.cron_utc !== "0 20 * * 0") {
    throw new Error("cron");
  }
});

test("7. buildOfficialUrl uses voyageCode query params", () => {
  const url = source.buildOfficialUrl({
    itinerary_id: "ECR12A",
    ship_code: "SA",
    sail_date: "2026-08-07"
  });
  if (!url.toLowerCase().includes("voyagecode=ecr12a") || !url.toLowerCase().includes("shipcode=sa")) {
    throw new Error(url);
  }
});

async function optionalLiveProbe() {
  const fetchResult = await source.fetchAllPrincessRawSailings({ today: inv.perthCalendarDate() });
  if (!fetchResult.ok) {
    console.log(`⚠ live Princess resdb probe skipped: ${fetchResult.error || "source unreachable"}`);
    return;
  }

  const sb = createSupabaseRest(root);
  const lines = await sb.get("ci_cruise_lines?slug=eq.princess-cruises&select=id,name,slug&limit=1");
  const line = lines?.[0];
  if (!line) throw new Error("Princess line missing");

  const destRows = await loadClassificationDestinations(sb.get.bind(sb));
  const destinations = adapter.catalogueDestinations(destRows || []);
  const ships = await sb.get(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&active=eq.true&select=id,name,cruise_line_id,official_line_ship_id,ship_class`
  );

  const simulation = await adapter.simulatePrincessInventory({
    today: inv.perthCalendarDate(),
    cruiseLine: line,
    ships: ships || [],
    destinations
  });

  console.log(
    JSON.stringify(
      {
        live_probe: true,
        source_groups: simulation.raw_group_count,
        expanded_sailings: simulation.raw_sailing_count,
        within_21_day_excluded: simulation.within_public_cutoff?.length || 0,
        ship_resolution_pct: simulation.metrics?.ship_resolution_pct,
        port_resolution_pct: simulation.metrics?.departure_port_resolution_pct,
        destination_resolution_pct: simulation.metrics?.destination_resolution_pct,
        complete_high_confidence: simulation.complete_high_confidence?.length || 0
      },
      null,
      2
    )
  );

  if ((simulation.raw_group_count || 0) < 500) throw new Error("live source group count too low");
  if ((simulation.raw_sailing_count || 0) < 1000) throw new Error("live sailing count too low");
  passed += 1;
  console.log("✓ 8. live Princess resdb source probe");
}

optionalLiveProbe()
  .then(() => {
    console.log(`\ntest-princess-discovery: ${passed} passed`);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
