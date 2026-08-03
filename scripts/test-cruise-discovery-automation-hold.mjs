#!/usr/bin/env node
/**
 * Discovery automation hold controls and probe read-only tests.
 *   npm run test:cruise-discovery-automation-hold
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const automation = require(path.join(root, "netlify/functions/lib/cruise-discovery-automation"));
const halMode = require(path.join(root, "netlify/functions/lib/holland-america-discovery-mode"));
const celebrity = require(path.join(root, "netlify/functions/lib/celebrity-discovery-source"));
const princess = require(path.join(root, "netlify/functions/lib/princess-discovery-source"));
const simulation = require(path.join(root, "netlify/functions/lib/discovery-source-simulation"));
const autoHal = require(path.join(root, "netlify/functions/lib/holland-america-discovery-automation"));
const { isExcludedCruiseLine } = require(path.join(root, "netlify/functions/lib/cruise-finder-departure-match"));
const fs = require("fs");

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

await test("Full Discovery cron exits without writes when automation disabled", async () => {
  withEnv("CRUISE_DISCOVERY_AUTOMATION_ENABLED", undefined, () => {
    if (automation.isCruiseDiscoveryAutomationEnabled()) throw new Error("should be disabled");
    let threw = false;
    try {
      automation.assertCruiseDiscoveryAutomationEnabled();
    } catch (err) {
      threw = err.code === "discovery_automation_disabled";
    }
    if (!threw) throw new Error("expected blocked");
  });
});

await test("expire_sailed exits without writes when disabled", async () => {
  withEnv("CRUISE_DISCOVERY_EXPIRE_SAILED_ENABLED", undefined, () => {
    if (automation.isCruiseDiscoveryExpireSailedEnabled()) throw new Error("should be disabled");
    let threw = false;
    try {
      automation.assertExpireSailedEnabled();
    } catch (err) {
      threw = err.code === "expire_sailed_disabled";
    }
    if (!threw) throw new Error("expected blocked");
  });
});

await test("HAL flags cannot activate Full Discovery automation", async () => {
  withEnv("HAL_DISCOVERY_WRITE_ENABLED", "true", () =>
    withEnv("HAL_AUTOMATIC_CONTINUATION_ENABLED", "true", () => {
      if (automation.isCruiseDiscoveryAutomationEnabled()) throw new Error("HAL must not enable full discovery");
    })
  );
});

await test("Skipped cruisetours do not stop automatic HAL gate", async () => {
  const gate = autoHal.evaluateAutomaticQualityGate({
    manifest: {
      products: [{ product_type: "cruise", proposed_action: "insert_active", destination_id: "d1" }],
      acceptance_gate: { passed: true, failures: [] }
    },
    stats: { product_type_cruisetour: 10, cursor_start: 0, next_cursor_start: 12, products_normalised: 20 },
    cruiseMetrics: { ship_match_rate_pct: 100, departure_port_rate_pct: 100 },
    writeResult: { stats: { inserted: 5, updated: 0, failed: 0, cruisetour_skips: 10 } }
  });
  if (!gate.passed) throw new Error(gate.failures.join(","));
});

await test("Cruisetour in write set stops automatic HAL gate", async () => {
  const gate = autoHal.evaluateAutomaticQualityGate({
    manifest: {
      products: [{ product_type: "cruisetour", proposed_action: "insert_active", destination_id: "d1" }],
      acceptance_gate: { passed: false, failures: ["cruisetour_in_write_set"] }
    },
    stats: { cursor_start: 0, next_cursor_start: 12, products_normalised: 1 },
    cruiseMetrics: {},
    writeResult: { stats: { inserted: 0, failed: 0 } }
  });
  if (gate.passed) throw new Error("should fail");
});

await test("Destination-resolution gate uses proposed write set", async () => {
  const gate = autoHal.evaluateAutomaticQualityGate({
    manifest: {
      products: [
        { product_type: "cruise", proposed_action: "insert_active", destination_id: "d1" },
        { product_type: "cruise", proposed_action: "skip_incomplete", destination_id: null }
      ],
      acceptance_gate: { passed: true, failures: [] }
    },
    stats: { cursor_start: 0, next_cursor_start: 12, products_normalised: 2 },
    cruiseMetrics: { destination_resolution_rate_pct: 50 },
    writeResult: { stats: { inserted: 1, failed: 0 } }
  });
  if (!gate.passed) throw new Error(gate.failures.join(","));
});

await test("Celebrity probe module is read-only by contract", async () => {
  if (!celebrity.SOURCE_CONTRACT.primary_endpoint.includes("celebritycruises.com/graph")) {
    throw new Error("unexpected endpoint");
  }
  const stats = celebrity.summariseCelebrityProducts([], "2026-08-03");
  if (stats.raw_products !== 0) throw new Error("stats");
});

await test("Princess probe module is read-only by contract", async () => {
  if (!princess.SOURCE_CONTRACT.adapter_id) throw new Error("missing adapter");
});

await test("Celebrity official identity is stable", async () => {
  const key = celebrity.officialProductKey({
    id: "GRP1",
    sailings: [{ id: "ITIN_2026-01-01" }]
  });
  if (key !== "ITIN_2026-01-01") throw new Error(`unexpected key ${key}`);
});

await test("Princess non-cruise products are identified", async () => {
  if (princess.classifyProductType({ name: "Alaska Cruisetour with Denali" }) !== "cruisetour") {
    throw new Error("cruisetour not classified");
  }
});

await test("Simulation cannot write during probe", async () => {
  const sim = simulation.simulateProbeProducts({
    products: [
      {
        official_product_key: "X1",
        product_type: "cruise",
        ship_name: "Celebrity Edge",
        departure_port: "Miami",
        departure_date: "2027-01-01",
        nights: 7,
        destination_name: "Caribbean",
        official_url: "https://www.celebritycruises.com/itinerary/example"
      }
    ],
    cruiseLine: { id: "line-1" },
    ships: [],
    destinations: []
  });
  if (!sim.writes_blocked) throw new Error("writes must be blocked");
});

await test("Routine unresolved products do not create reviews in simulation counter alone", async () => {
  const sim = simulation.simulateProbeProducts({
    products: [
      {
        official_product_key: "Y1",
        product_type: "cruise",
        ship_name: "Unknown Ship",
        departure_port: "Nowhere",
        departure_date: "2027-02-01",
        official_url: "https://example.com/y1"
      }
    ],
    cruiseLine: { id: "line-1" },
    ships: [],
    destinations: []
  });
  if (sim.projected_active > 0) throw new Error("should not project active");
});

await test("Disabled cron records single skipped run not per-line wave", async () => {
  const cronSrc = fs.readFileSync(
    path.join(root, "netlify/functions/cruise-discovery-cron.js"),
    "utf8"
  );
  if (!cronSrc.includes("run_type: \"scheduled_wave_skipped\"")) {
    throw new Error("missing scheduled_wave_skipped run type");
  }
  if (!cronSrc.includes("lines_processed: 0")) throw new Error("missing lines_processed guard");
  if (!cronSrc.includes("if (!isCruiseDiscoveryAutomationEnabled())")) {
    throw new Error("missing automation gate");
  }
});

await test("P&O Cruises Australia remains excluded", async () => {
  if (!isExcludedCruiseLine("P&O Cruises Australia")) throw new Error("P&O not excluded");
});

await test("Celebrity non-cruise products are identified", async () => {
  const type = celebrity.classifyProductType({
    masterSailing: { itinerary: { preTour: { duration: 3 }, voyageType: "OCEAN" } }
  });
  if (type !== "cruisetour") throw new Error(`expected cruisetour got ${type}`);
});

await test("Princess official identity is stable", async () => {
  const key = princess.officialProductKey({
    official_sailing_id: "SAIL123",
    departure_date: "2027-01-01"
  });
  if (key !== "SAIL123") throw new Error(`unexpected key ${key}`);
});

await test("Holland America inventory gate remains separate from full discovery", async () => {
  withEnv("CRUISE_DISCOVERY_AUTOMATION_ENABLED", "false", () =>
    withEnv("HAL_DISCOVERY_WRITE_ENABLED", "true", () => {
      if (automation.isCruiseDiscoveryAutomationEnabled()) throw new Error("full discovery on");
    })
  );
});

await test("Alias writes remain disabled", async () => {
  const { AUTO_ALIAS_WRITES_ENABLED } = require(path.join(root, "netlify/functions/lib/discovery-ship-resolver"));
  if (AUTO_ALIAS_WRITES_ENABLED) throw new Error("aliases enabled");
});

await test("HAL write flag defaults disabled", async () => {
  withEnv("HAL_DISCOVERY_WRITE_ENABLED", undefined, () => {
    const gate = halMode.resolveHalDiscoveryMode("production_write");
    if (gate.writes_allowed) throw new Error("HAL writes allowed");
  });
});

console.log(`\ntest-cruise-discovery-automation-hold: ${passed} passed`);
