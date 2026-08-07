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

test("2b. expand attaches official itinerary_name from name map", () => {
  const expanded = source.expandProductGroupsToRawSailings([FIXTURE_GROUP], {
    shipsById: { SA: { id: "SA", name: "Sky Princess" } },
    portsById: { CPH: { id: "CPH", name: "Copenhagen, Denmark" } },
    itineraryNamesById: new Map([["ECR12A", "Norway & Sweden Cruise"]]),
    today: "2026-08-06"
  });
  if (expanded.products[0]?.itinerary_name !== "Norway & Sweden Cruise") {
    throw new Error(`expected marketing name got ${expanded.products[0]?.itinerary_name}`);
  }
});

test("2c. adapter stores marketing itinerary name instead of voyage code", () => {
  const result = adapter.normalisePrincessProduct(
    {
      source: "princess_resdb",
      structured_source: "princess_resdb_products",
      itinerary_id: "ANG07A",
      itinerary_name: "Voyage of the Glaciers (Northbound)",
      ship_code: "XP",
      ship_name: "Discovery Princess",
      departure_date: "2026-08-29",
      return_date: "2026-09-05",
      nights: 7,
      departure_port_code: "YVR",
      departure_port: "Vancouver, Canada",
      arrival_port: "Anchorage (Whittier), Alaska",
      trade_ids: ["A"],
      official_url: "https://www.princess.com/cruise-search/details?voyagecode=ang07a"
    },
    {
      cruiseLine: { id: "line-1", name: "Princess Cruises" },
      ships: [{ id: "ship-1", name: "Discovery Princess", cruise_line_id: "line-1", official_line_ship_id: "XP" }],
      destinations: adapter.catalogueDestinations([
        { id: "dest-1", name: "Alaska", slug: "alaska", status: "published", classification_enabled: true }
      ])
    }
  );
  if (result.candidate.itinerary !== "Voyage of the Glaciers (Northbound)") {
    throw new Error(`expected marketing name got ${result.candidate.itinerary}`);
  }
  if (result.candidate.raw_extract?.princess_itinerary_id !== "ANG07A") {
    throw new Error("missing princess_itinerary_id in raw_extract");
  }
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

test("8. individual sailing gate uses structured Princess evidence", () => {
  const { provesIndividualSailing } = require(path.join(root, "netlify/functions/lib/discovery-non-sailing-filter"));
  const individual = provesIndividualSailing({
    ship_id: "ship-1",
    departure_date: "2026-09-01",
    departure_port: "Sydney, Australia",
    departure_port_meta: { status: "resolved" },
    shipResolution: { resolved: true, confidence: 100 },
    ships: [{ id: "ship-1", name: "Sapphire Princess", cruise_line_id: "line" }],
    ship_name_guess: "Sapphire Princess"
  });
  if (!individual.proven) throw new Error(JSON.stringify(individual));
});

test("9. all 17 active Princess resdb ship codes in approved seed manifest", () => {
  const expected = [
    "SU", "GP", "EX", "DI", "CB", "SA", "KP", "ST", "EP", "YP", "XP", "AP", "RP", "CO", "MJ", "IP", "RU"
  ];
  const manifest = JSON.parse(
    require("fs").readFileSync(path.join(root, "reports/princess-ship-code-seed-manifest-2026-08-07.json"), "utf8")
  );
  const codes = manifest.ships.map((s) => s.official_line_ship_id);
  if (new Set(codes).size !== 17) throw new Error("duplicate seed code");
  if (codes.sort().join(",") !== expected.sort().join(",")) throw new Error(`codes mismatch ${codes.join(",")}`);
});

test("10. trade code Z maps to australia-new-zealand", () => {
  if (adapter.PRINCESS_TRADE_CODE_SLUG.Z !== "australia-new-zealand") {
    throw new Error(`Z mapped to ${adapter.PRINCESS_TRADE_CODE_SLUG.Z}`);
  }
});

test("11. trade code 0 has no forced destination mapping", () => {
  if (adapter.PRINCESS_TRADE_CODE_SLUG["0"]) throw new Error("trade code 0 must remain unresolved");
});

test("12. controlled batch max writes capped at 20 for first batch", () => {
  const src = require("fs").readFileSync(path.join(root, "scripts/run-princess-first-production-batch.mjs"), "utf8");
  if (!src.includes("FIRST_BATCH_MAX = 20")) throw new Error("FIRST_BATCH_MAX not 20");
});

test("13. Princess discovery write flag defaults false", () => {
  const effective =
    String(process.env.PRINCESS_DISCOVERY_WRITE_ENABLED || "").trim().toLowerCase() === "true";
  if (effective) throw new Error("PRINCESS_DISCOVERY_WRITE_ENABLED must be false during tests");
});

test("14. seed manifest excludes MS Excellence Princess from guessed code", () => {
  const manifest = JSON.parse(
    require("fs").readFileSync(path.join(root, "reports/princess-ship-code-seed-manifest-2026-08-07.json"), "utf8")
  );
  const excellence = manifest.ships.find((s) => /excellence/i.test(s.name));
  if (excellence) throw new Error("excellence must not be in seed manifest");
  if (manifest.notes && !manifest.notes.includes("Excellence")) throw new Error("missing excellence note");
});

test("15b. Princess duplicate skip treats itinerary name upgrade as update", () => {
  const writes = require(path.join(root, "netlify/functions/lib/princess-discovery-writes"));
  const existing = {
    cruise_line_id: "line-1",
    official_sailing_id: "ANG07A|XP|2026-08-29",
    ship_id: "ship-1",
    destination_id: "dest-1",
    departure_date: "2026-08-29",
    return_date: "2026-09-05",
    nights: 7,
    departure_port: "Vancouver, Canada",
    itinerary: "ANG07A",
    status: "active"
  };
  const row = {
    product_type: "cruise",
    complete_high_confidence: true,
    raw: {
      itinerary_id: "ANG07A",
      ship_code: "XP",
      departure_date: "2026-08-29"
    },
    candidate: {
      ship_id: "ship-1",
      destination_id: "dest-1",
      departure_date: "2026-08-29",
      return_date: "2026-09-05",
      nights: 7,
      departure_port: "Vancouver, Canada",
      itinerary: "Voyage of the Glaciers (Northbound)",
      official_url: "https://www.princess.com/example"
    }
  };
  const action = writes.classifyProposedAction(row, existing);
  if (action !== "update_exact_legacy_match") {
    throw new Error(`expected update_exact_legacy_match got ${action}`);
  }
});

test("15. Princess writer rejects null cruise_line_id before database write", () => {
  const writes = require(path.join(root, "netlify/functions/lib/princess-discovery-writes"));
  let threw = false;
  try {
    writes.assertPrincessWriteCandidate(
      { ship_id: "ship-1", cruise_line_id: null, official_sailing_id: "X|Y|2026-09-01" },
      { id: "line-1" }
    );
  } catch (error) {
    threw = error.code === "princess_write_candidate_missing_cruise_line_id";
  }
  if (!threw) throw new Error("expected cruise_line_id validation error");
});

test("16. Princess writer uses upsertCandidateRecord(candidate, stats, options) contract", () => {
  const src = require("fs").readFileSync(
    path.join(root, "netlify/functions/lib/princess-discovery-writes.js"),
    "utf8"
  );
  if (src.includes("upsertCandidateRecord(supabase,")) {
    throw new Error("positional supabase argument regression");
  }
  if (!src.includes("upsertCandidateRecord(candidate, upsertStats")) {
    throw new Error("expected named upsert contract");
  }
});

test("17. Princess weekly lock key is registered for DB maintenance locks", () => {
  const locks = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks"));
  if (!locks.DEFAULT_LEASE_SECONDS["princess-cruises:weekly"]) {
    throw new Error("missing princess lease seconds");
  }
});

test("18. controlled batch script blocks duplicate apply when 20 active records exist", () => {
  const src = require("fs").readFileSync(path.join(root, "scripts/run-princess-first-production-batch.mjs"), "utf8");
  if (!src.includes("countsBefore.princess_active >= FIRST_BATCH_MAX")) {
    throw new Error("missing duplicate controlled apply guard");
  }
  if (!src.includes("loadMaintenanceLockStatus")) throw new Error("missing preflight lock check");
});

test("19. catch-up batch requires explicit --next-batch checkpoint args", () => {
  const src = require("fs").readFileSync(path.join(root, "scripts/run-princess-first-production-batch.mjs"), "utf8");
  if (!src.includes("--next-batch")) throw new Error("missing next-batch flag");
  if (!src.includes("--expected-snapshot-id=")) throw new Error("missing snapshot checkpoint");
  if (!src.includes("CATCHUP_MAX = 100")) throw new Error("missing 100 cap");
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
  console.log("✓ 20. live Princess resdb source probe");
}

optionalLiveProbe()
  .then(() => {
    console.log(`\ntest-princess-discovery: ${passed} passed`);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
