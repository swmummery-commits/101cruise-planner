#!/usr/bin/env node
/**
 * Celebrity Discovery Phase 1 + hold control tests.
 *   npm run test:celebrity-discovery
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import fs from "fs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const automation = require(path.join(root, "netlify/functions/lib/cruise-discovery-automation"));
const halMode = require(path.join(root, "netlify/functions/lib/holland-america-discovery-mode"));
const celebrityAuto = require(path.join(root, "netlify/functions/lib/celebrity-discovery-automation"));
const celebrityBatch = require(path.join(root, "netlify/functions/lib/celebrity-discovery-batch"));
const celebrityAdapter = require(path.join(root, "netlify/functions/lib/celebrity-discovery-adapter"));
const celebrityMapping = require(path.join(root, "netlify/functions/lib/celebrity-destination-mapping"));
const { isExcludedCruiseLine } = require(path.join(root, "netlify/functions/lib/cruise-finder-departure-match"));

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value == null) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prev == null) delete process.env[key];
    else process.env[key] = prev;
  }
}

await test("1. General cron exits when disabled", () => {
  withEnv("CRUISE_DISCOVERY_AUTOMATION_ENABLED", undefined, () => {
    if (automation.isCruiseDiscoveryAutomationEnabled()) throw new Error("enabled");
    let blocked = false;
    try {
      automation.assertCruiseDiscoveryAutomationEnabled();
    } catch (err) {
      blocked = err.code === "discovery_automation_disabled";
    }
    if (!blocked) throw new Error("not blocked");
  });
});

await test("2. Expire-sailed exits when disabled", () => {
  withEnv("CRUISE_DISCOVERY_EXPIRE_SAILED_ENABLED", undefined, () => {
    let blocked = false;
    try {
      automation.assertExpireSailedEnabled();
    } catch (err) {
      blocked = err.code === "expire_sailed_disabled";
    }
    if (!blocked) throw new Error("not blocked");
  });
});

await test("3. Background wave is blocked when automation disabled", () => {
  const src = fs.readFileSync(path.join(root, "netlify/functions/cruise-discovery-wave-background.js"), "utf8");
  if (!src.includes('reason: "discovery_automation_disabled"')) throw new Error("missing block");
});

await test("4. Admin start_discovery is blocked when automation disabled", () => {
  const src = fs.readFileSync(path.join(root, "netlify/functions/cruise-discovery.js"), "utf8");
  if (!src.includes("assertCruiseDiscoveryAutomationEnabled")) throw new Error("missing assert");
});

await test("5. Admin expire_sailed is blocked when disabled", () => {
  const src = fs.readFileSync(path.join(root, "netlify/functions/cruise-discovery.js"), "utf8");
  if (!src.includes("assertExpireSailedEnabled")) throw new Error("missing assert");
});

await test("6. HAL flags cannot enable general Discovery", () => {
  withEnv("HAL_DISCOVERY_WRITE_ENABLED", "true", () =>
    withEnv("HAL_AUTOMATIC_CONTINUATION_ENABLED", "true", () => {
      if (automation.isCruiseDiscoveryAutomationEnabled()) throw new Error("HAL enabled full discovery");
    })
  );
});

await test("7. Disabled cron does not create line-by-line run rows", () => {
  const src = fs.readFileSync(path.join(root, "netlify/functions/cruise-discovery-cron.js"), "utf8");
  if (!src.includes("scheduled_wave_skipped") || !src.includes("lines_processed: 0")) {
    throw new Error("missing skipped run contract");
  }
});

await test("8. GraphQL pagination is stable", async () => {
  const a = await celebrityAdapter.fetchCelebritySearchPage({ skip: 0, count: 10 });
  const b = await celebrityAdapter.fetchCelebritySearchPage({ skip: 0, count: 10 });
  if (!a.ok || !b.ok) throw new Error("fetch failed");
  const idA = a.cruises?.[0]?.sailings?.[0]?.id;
  const idB = b.cruises?.[0]?.sailings?.[0]?.id;
  if (idA !== idB) throw new Error(`unstable ${idA} vs ${idB}`);
});

await test("9. Sailing id is the official identity", () => {
  const key = celebrityAdapter.officialProductKey({ official_sailing_id: "RF3BH165_2026-11-06" });
  if (key !== "RF3BH165_2026-11-06") throw new Error(key);
});

await test("10. Group id remains supporting evidence", () => {
  const raw = { group_id: "RF03FLL-247688799", official_sailing_id: "RF3BH165_2026-11-06" };
  if (celebrityAdapter.officialGroupKey(raw) !== "RF03FLL-247688799") throw new Error("group");
});

await test("11. Cruisetours detected from structured land-tour data", () => {
  const type = celebrityAdapter.classifyCelebrityProductType({ pre_tour_duration: 3 });
  if (type.productType !== "cruisetour") throw new Error(type.productType);
});

await test("12. Cruise products are not misclassified as cruisetours", () => {
  const type = celebrityAdapter.classifyCelebrityProductType({ voyage_type: "OCEAN", itinerary_name: "Western Caribbean" });
  if (type.productType !== "cruise") throw new Error(type.productType);
});

await test("13. Destination codes map deterministically", () => {
  const hint = celebrityMapping.resolveCelebrityDestinationHints({
    destination_code: "ALCAN",
    destination_name: "Alaska",
    itinerary_name: "Alaska Experience"
  });
  if (hint.slug !== "alaska") throw new Error(JSON.stringify(hint));
});

await test("14. Crossing voyages override broad regional labels", () => {
  const hint = celebrityMapping.resolveCelebrityDestinationHints({
    destination_code: "T.ATL",
    destination_name: "Transatlantic",
    itinerary_name: "Spain & Bermuda Transatlantic"
  });
  if (hint.slug !== "transatlantic") throw new Error(JSON.stringify(hint));
});

await test("15. No Alaska fallback exists", () => {
  if (celebrityMapping.hasAlaskaFallback()) throw new Error("fallback exists");
});

await test("16. Unknown destination products are skipped without review flag in metrics", () => {
  const norm = celebrityAdapter.normaliseCelebrityProduct(
    {
      official_sailing_id: "X1_2028-01-01",
      departure_date: "2028-01-01",
      ship_name: "Celebrity Edge",
      departure_port: "Miami",
      destination_code: "SAMER",
      destination_name: "South America",
      itinerary_name: "Patagonia & Argentina Holiday",
      nights: 14,
      official_url: "https://www.celebritycruises.com/itinerary/example",
      voyage_type: "OCEAN"
    },
    { cruiseLine: { id: "line", name: "Celebrity Cruises" }, ships: [], destinations: [] }
  );
  if (norm.complete_high_confidence) throw new Error("should skip");
  if (norm.destination_resolution?.status === "ambiguous") throw new Error("should not review");
});

await test("17. Ship resolution meets fixture expectation", () => {
  const norm = celebrityAdapter.normaliseCelebrityProduct(
    {
      official_sailing_id: "RF3BH165_2026-11-06",
      departure_date: "2026-11-06",
      ship_name: "Celebrity Reflection",
      ship_code: "RF",
      departure_port: "Fort Lauderdale",
      destination_code: "BAHAM",
      destination_name: "Bahamas",
      itinerary_name: "Key West & Bahamas",
      nights: 3,
      official_url: "https://www.celebritycruises.com/itinerary/example",
      voyage_type: "OCEAN"
    },
    {
      cruiseLine: { id: "line", name: "Celebrity Cruises" },
      ships: [{ id: "ship-1", name: "Celebrity Reflection", cruise_line_id: "line" }],
      destinations: [{ id: "d1", name: "Caribbean", slug: "caribbean", classification_enabled: true }]
    }
  );
  if (!norm.ship_resolution?.resolved) throw new Error("ship not resolved");
});

await test("18. Departure-port resolution meets fixture expectation", () => {
  const norm = celebrityAdapter.normaliseCelebrityProduct(
    {
      official_sailing_id: "RF3BH165_2026-11-06",
      departure_date: "2026-11-06",
      ship_name: "Celebrity Reflection",
      departure_port: "Fort Lauderdale",
      destination_code: "BAHAM",
      destination_name: "Bahamas",
      itinerary_name: "Key West & Bahamas",
      nights: 3,
      official_url: "https://www.celebritycruises.com/itinerary/example",
      voyage_type: "OCEAN"
    },
    {
      cruiseLine: { id: "line", name: "Celebrity Cruises" },
      ships: [{ id: "ship-1", name: "Celebrity Reflection", cruise_line_id: "line" }],
      destinations: [{ id: "d1", name: "Caribbean", slug: "caribbean", classification_enabled: true }]
    }
  );
  if (norm.departure_port_resolution?.status !== "resolved") throw new Error("port unresolved");
});

await test("19. Simulation cannot write", async () => {
  const result = await celebrityBatch.runCelebrityDiscoveryBatch({
    mode: "production_read_only",
    maxPages: 1,
    maxCandidates: 5,
    cruiseLine: { id: "line", name: "Celebrity Cruises" },
    ships: [],
    destinations: []
  });
  if (result.writes_performed) throw new Error("writes performed");
});

await test("20. Smoke endpoint cannot write", () => {
  const src = fs.readFileSync(path.join(root, "netlify/functions/celebrity-discovery-smoke.js"), "utf8");
  if (!src.includes("writesPerformed: false") || !src.includes("production_read_only")) {
    throw new Error("smoke not read-only");
  }
});

await test("21. Automatic continuation defaults disabled", () => {
  withEnv("CELEBRITY_AUTOMATIC_CONTINUATION_ENABLED", undefined, () => {
    if (celebrityAuto.isCelebrityAutomaticContinuationEnabled()) throw new Error("auto on");
    if (celebrityAuto.isCelebrityDiscoveryWriteEnabled()) throw new Error("write on");
  });
});

await test("22. Permanent aliases remain disabled", () => {
  const { AUTO_ALIAS_WRITES_ENABLED } = require(path.join(root, "netlify/functions/lib/discovery-ship-resolver"));
  if (AUTO_ALIAS_WRITES_ENABLED) throw new Error("aliases enabled");
});

await test("23. P&O Cruises Australia remains excluded", () => {
  if (!isExcludedCruiseLine("P&O Cruises Australia")) throw new Error("P&O not excluded");
});

await test("24. Existing HAL inventory gate remains separate", () => {
  withEnv("HAL_DISCOVERY_WRITE_ENABLED", undefined, () => {
    const gate = halMode.resolveHalDiscoveryMode("production_write");
    if (gate.writes_allowed) throw new Error("HAL writes allowed");
  });
});

console.log(`\ntest-celebrity-discovery: ${passed} passed`);
