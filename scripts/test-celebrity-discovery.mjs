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

await test("11. Ocean cruisetours detected from structured land-tour data", () => {
  const type = celebrityAdapter.classifyCelebrityProductType({ pre_tour_duration: 3, voyage_type: "OCEAN" });
  if (type.productType !== "ocean_cruisetour") throw new Error(type.productType);
});

await test("12. Ocean cruise products are not misclassified as cruisetours", () => {
  const type = celebrityAdapter.classifyCelebrityProductType({ voyage_type: "OCEAN", itinerary_name: "Western Caribbean" });
  if (type.productType !== "ocean_cruise") throw new Error(type.productType);
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

const riverShipFixtures = [
  { code: "RC", name: "Celebrity Compass", id: "ship-rc" },
  { code: "RS", name: "Celebrity Seeker", id: "ship-rs" },
  { code: "RB", name: "Celebrity Boundless", id: "ship-rb" },
  { code: "RR", name: "Celebrity Roamer", id: "ship-rr" },
  { code: "RW", name: "Celebrity Wanderer", id: "ship-rw" }
];
const lineCtx = { cruiseLine: { id: "line", name: "Celebrity Cruises" } };
const riverDest = {
  id: "dest-erc",
  name: "European River Cruises",
  slug: "european-river-cruises",
  classification_enabled: true,
  status: "draft"
};

for (const ship of riverShipFixtures) {
  await test(`25.${ship.code}. ${ship.name} resolves to canonical river ship`, () => {
    const norm = celebrityAdapter.normaliseCelebrityProduct(
      {
        official_sailing_id: `${ship.code}_2027-08-01`,
        departure_date: "2027-08-01",
        ship_name: ship.name,
        ship_code: ship.code,
        departure_port: "Nuremberg",
        destination_code: "EUROP",
        destination_name: "Europe",
        itinerary_name: "Danube – Nuremberg-Vienna",
        nights: 7,
        official_url: "https://www.celebritycruises.com/itinerary/example",
        voyage_type: "RIVER"
      },
      {
        ...lineCtx,
        ships: [{ id: ship.id, name: ship.name, cruise_line_id: "line", official_line_ship_id: ship.code }],
        destinations: [riverDest]
      }
    );
    if (!norm.ship_resolution?.resolved || norm.ship_resolution.ship.id !== ship.id) {
      throw new Error(`ship not resolved for ${ship.name}`);
    }
  });
}

await test("26. Celebrity Flora remains ocean/expedition ship", () => {
  const type = celebrityAdapter.classifyCelebrityProductType({
    ship_code: "FL",
    ship_name: "Celebrity Flora",
    voyage_type: "OCEAN",
    itinerary_name: "Galapagos Outer Loop"
  });
  if (type.productType !== "ocean_cruise") throw new Error(type.productType);
  if (celebrityMapping.isCelebrityRiverProduct({ ship_code: "FL", voyage_type: "OCEAN" })) {
    throw new Error("Flora misclassified as river");
  }
});

await test("27. Standard river sailing is classified river_cruise", () => {
  const type = celebrityAdapter.classifyCelebrityProductType({
    voyage_type: "RIVER",
    ship_code: "RC",
    itinerary_name: "Danube – Nuremberg-Vienna"
  });
  if (type.productType !== "river_cruise") throw new Error(type.productType);
});

await test("28. Bundled river land package is classified river_cruisetour", () => {
  const type = celebrityAdapter.classifyCelebrityProductType({
    voyage_type: "RIVER",
    ship_code: "RC",
    pre_tour_duration: 2,
    itinerary_name: "Danube with Prague"
  });
  if (type.productType !== "river_cruisetour") throw new Error(type.productType);
});

await test("29. Optional land extensions do not reclassify base river sailing", () => {
  const type = celebrityAdapter.classifyCelebrityProductType({
    voyage_type: "RIVER",
    ship_code: "RC",
    itinerary_name: "Danube – Nuremberg-Vienna with optional hotel stay"
  });
  if (type.productType !== "river_cruise") throw new Error(type.productType);
});

await test("30. River cruise maps to European River Cruises", () => {
  const hint = celebrityMapping.resolveCelebrityDestinationHints({
    ship_code: "RC",
    voyage_type: "RIVER",
    itinerary_name: "Danube – Nuremberg-Vienna",
    departure_port: "Nuremberg"
  });
  if (hint.slug !== "european-river-cruises") throw new Error(JSON.stringify(hint));
});

await test("31. River products are included in eligible simulation metrics", () => {
  const metrics = celebrityAdapter.computeCelebrityMetrics([
    {
      product_type: "river_cruise",
      complete_high_confidence: true,
      ship_resolution: { resolved: true },
      departure_port_resolution: { status: "resolved" },
      destination_resolution: { status: "resolved" },
      failure_reasons: []
    },
    {
      product_type: "ocean_cruise",
      complete_high_confidence: false,
      ship_resolution: { resolved: true },
      departure_port_resolution: { status: "resolved" },
      destination_resolution: { status: "resolved" },
      failure_reasons: ["confidence:needs_review"]
    }
  ]);
  if (metrics.combined_eligible.eligible_river_cruises !== 1) throw new Error("river not counted");
  if (metrics.combined_eligible.total_projected_active_inserts !== 1) throw new Error("insert count wrong");
});

await test("32. River cruisetours do not enter the proposed write set", () => {
  const norm = celebrityAdapter.normaliseCelebrityProduct(
    {
      official_sailing_id: "RC_2027-08-01",
      departure_date: "2027-08-01",
      ship_name: "Celebrity Compass",
      ship_code: "RC",
      departure_port: "Nuremberg",
      itinerary_name: "Danube with Prague",
      pre_tour_duration: 3,
      nights: 10,
      official_url: "https://www.celebritycruises.com/itinerary/example",
      voyage_type: "RIVER"
    },
    {
      ...lineCtx,
      ships: [{ id: "ship-rc", name: "Celebrity Compass", cruise_line_id: "line", official_line_ship_id: "RC" }],
      destinations: [riverDest]
    }
  );
  if (norm.product_type !== "river_cruisetour") throw new Error(norm.product_type);
  if (norm.complete_high_confidence) throw new Error("cruisetour should not be complete");
  if (norm.proposed_action !== "skip_incomplete") throw new Error(norm.proposed_action);
});

await test("33. Inland embarkation locations are not discarded as invalid seaports", () => {
  const port = celebrityAdapter.normaliseCelebrityProduct(
    {
      official_sailing_id: "RC_2027-08-01",
      departure_date: "2027-08-01",
      ship_name: "Celebrity Compass",
      ship_code: "RC",
      departure_port: "Vilshofen",
      itinerary_name: "Danube - Vienna & Budapest",
      nights: 7,
      official_url: "https://www.celebritycruises.com/itinerary/example",
      voyage_type: "RIVER"
    },
    {
      ...lineCtx,
      ships: [{ id: "ship-rc", name: "Celebrity Compass", cruise_line_id: "line", official_line_ship_id: "RC" }],
      destinations: [riverDest]
    }
  );
  if (port.departure_port_resolution?.status !== "resolved") throw new Error("inland port rejected");
});

await test("34. Ship seed manifest is idempotent by design", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "reports/celebrity-river-ship-seed-manifest-2026-08-03.json"), "utf8")
  );
  const codes = manifest.ships.map((s) => s.official_line_ship_id);
  if (new Set(codes).size !== codes.length) throw new Error("duplicate ship codes in manifest");
  if (manifest.ships.some((s) => s.proposed_action !== "insert")) throw new Error("unexpected action");
});

await test("35. Destination seed manifest is idempotent by design", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "reports/celebrity-river-ship-seed-manifest-2026-08-03.json"), "utf8")
  );
  if (manifest.destination.slug !== "european-river-cruises") throw new Error("slug mismatch");
  if (manifest.destination.status !== "draft") throw new Error("must remain draft");
});

await test("36. Draft European River Cruises destination remains private", () => {
  const { isPublicLivingDestination } = require(path.join(root, "netlify/functions/lib/destination-classification"));
  if (isPublicLivingDestination({ status: "draft", classification_enabled: true })) {
    throw new Error("draft destination treated as public");
  }
});

await test("37. European River Cruises is in operational catalogue", () => {
  const { OPERATIONAL_DESTINATION_CATALOGUE } = require(path.join(
    root,
    "netlify/functions/lib/destination-classification"
  ));
  const entry = OPERATIONAL_DESTINATION_CATALOGUE.find((d) => d.slug === "european-river-cruises");
  if (!entry || entry.classification_enabled !== true) throw new Error("catalogue entry missing");
});

const celebrityWrites = require(path.join(root, "netlify/functions/lib/celebrity-discovery-writes"));
const celebrityMode = require(path.join(root, "netlify/functions/lib/celebrity-discovery-mode"));

await test("38. Controlled manifest cannot exceed 40 writes", () => {
  const products = Array.from({ length: 50 }, (_, i) => ({
    product_type: i % 2 ? "river_cruise" : "ocean_cruise",
    complete_high_confidence: true,
    official_product_key: `ID_${i}`,
    destination_resolution: { destinationKey: "caribbean", status: "resolved" },
    candidate: { destination_id: "d1", departure_port: "Miami" },
    raw: { official_sailing_id: `ID_${i}`, official_url: "https://example.com", ship_code: "RF" },
    ship_resolution: { resolved: true, ship: { id: "s1", name: "Celebrity Reflection" } }
  }));
  const selected = celebrityWrites.selectControlledBatchProducts(products, { oceanTarget: 20, riverTarget: 20, maxWrites: 40 });
  if (selected.length > 40) throw new Error(`too many ${selected.length}`);
});

await test("39. Write flag defaults disabled", () => {
  withEnv("CELEBRITY_DISCOVERY_WRITE_ENABLED", undefined, () => {
    const gate = celebrityMode.resolveCelebrityDiscoveryMode("production_write");
    if (gate.writes_allowed) throw new Error("writes allowed");
  });
});

await test("40. Cruisetours cannot enter write set via classifyProposedAction", () => {
  const action = celebrityWrites.classifyProposedAction(
    { product_type: "ocean_cruisetour", complete_high_confidence: true, raw: {} },
    null
  );
  if (action !== "ocean_cruisetour_skip") throw new Error(action);
});

await test("41. Background worker exists for Celebrity batches", () => {
  const src = fs.readFileSync(path.join(root, "netlify/functions/celebrity-discovery-batch-background.js"), "utf8");
  if (!src.includes("runCelebrityDiscoveryBatch")) throw new Error("missing batch runner");
  if (!src.includes("controlled_sailing_ids")) throw new Error("missing controlled ids");
});

await test("42. Celebrity writes module supports exact legacy match action", () => {
  const action = celebrityWrites.classifyProposedAction(
    {
      product_type: "ocean_cruise",
      complete_high_confidence: true,
      raw: { official_sailing_id: "X_2028-01-01" },
      candidate: { ship_id: "s1", destination_id: "d1", departure_date: "2028-01-01", departure_port: "Miami" }
    },
    {
      id: "existing",
      cruise_line_id: "line",
      official_sailing_id: "X_2028-01-01",
      status: "hidden",
      ship_id: "s0",
      destination_id: "d1",
      departure_date: "2028-01-01",
      departure_port: "Miami"
    }
  );
  if (action !== "update_exact_legacy_match") throw new Error(action);
});

console.log(`\ntest-celebrity-discovery: ${passed} passed`);
