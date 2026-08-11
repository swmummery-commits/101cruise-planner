#!/usr/bin/env node
/**
 * Explora runtime module smoke test — every Explora entry module must resolve via require()
 * and expose its documented surface.
 *   npm run test:explora-runtime-modules
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const MODULES = [
  {
    file: "netlify/functions/lib/explora-discovery-source.js",
    exports: [
      "ADAPTER_ID",
      "ADAPTER_VERSION",
      "SOURCE_CONTRACT",
      "SITEMAP_URL",
      "officialProductKey",
      "parseJourneyId",
      "parseSitemapUrl",
      "buildOfficialUrl",
      "classifyProductType",
      "parseJourneyDetailHtml",
      "enrichJourneyFromDetailPage",
      "fetchJourneySitemap",
      "fetchAllExploraRawJourneys"
    ]
  },
  {
    file: "netlify/functions/lib/explora-discovery-adapter.js",
    exports: [
      "ADAPTER_ID",
      "isEligibleExploraCruise",
      "officialProductKey",
      "normaliseExploraProduct",
      "simulateExploraInventory",
      "catalogueDestinations",
      "EXPLORA_REGION_DESTINATION_SLUG"
    ]
  },
  {
    file: "netlify/functions/lib/explora-discovery-writes.js",
    exports: [
      "buildExploraUpsertCandidate",
      "buildExploraBatchManifest",
      "applyExploraBatchWrites",
      "indexExistingExploraRecords",
      "classifyProposedAction"
    ]
  },
  {
    file: "netlify/functions/lib/explora-discovery-mode.js",
    exports: ["EXPLORA_DISCOVERY_WRITE_ENABLED", "resolveExploraDiscoveryMode", "assertExploraWritesAllowed"]
  },
  {
    file: "netlify/functions/lib/explora-post-write-verification.js",
    exports: ["EXPLORA_LINE_ID", "fetchExploraActiveRows", "verifyInsertedRows"]
  },
  {
    file: "netlify/functions/explora-weekly-maintenance-cron.js",
    exports: ["handler"]
  }
];

for (const entry of MODULES) {
  test(`module resolves: ${entry.file}`, () => {
    const abs = path.join(root, entry.file);
    if (!fs.existsSync(abs)) throw new Error(`missing file ${entry.file}`);
    const mod = require(abs);
    for (const name of entry.exports) {
      if (mod[name] === undefined) throw new Error(`${entry.file} missing export ${name}`);
    }
  });
}

test("shared maintenance module exposes Explora wiring", () => {
  const maintenance = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));
  const required = [
    "EXPLORA_WEEKLY_RECONCILIATION_ENABLED",
    "EXPLORA_WEEKLY_MAINTENANCE_RUN_TYPE",
    "isExploraWeeklyReconciliationEnabled",
    "assertExploraWeeklyMaintenanceEnabled"
  ];
  for (const name of required) {
    if (maintenance[name] === undefined) throw new Error(`cruise-discovery-maintenance missing ${name}`);
  }
  if (!maintenance.MAINTENANCE_SCHEDULES.explora_weekly) throw new Error("missing explora_weekly schedule entry");
});

test("shared maintenance runner exports runExploraWeeklyMaintenance", () => {
  const runner = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-runner"));
  if (typeof runner.runExploraWeeklyMaintenance !== "function") {
    throw new Error("runExploraWeeklyMaintenance not exported");
  }
  if (typeof runner.EXPLORA_MAX_WEEKLY_WRITES !== "number") {
    throw new Error("EXPLORA_MAX_WEEKLY_WRITES not exported");
  }
  if (runner.MAX_WEEKLY_WRITES !== 30) throw new Error("Princess weekly cap must remain 30");
});

test("Explora scripts exist", () => {
  const scripts = [
    "scripts/run-explora-weekly-maintenance.mjs",
    "scripts/run-explora-first-production-batch.mjs",
    "scripts/simulate-explora-discovery.mjs",
    "scripts/test-explora-discovery.mjs",
    "scripts/test-explora-weekly-maintenance.mjs",
    "scripts/apply-explora-ship-code-seed.mjs"
  ];
  for (const script of scripts) {
    if (!fs.existsSync(path.join(root, script))) throw new Error(`missing ${script}`);
  }
});

await (async () => {
  const { buildExploraControlledBatchReportPath } = await import(
    path.join(root, "scripts/run-explora-first-production-batch.mjs")
  );
  test("controlled-batch report paths are unique per run id", () => {
    const a = buildExploraControlledBatchReportPath(
      path.join(root, "reports"),
      "explora-apply-2026-08-10T10-04-57-125Z"
    );
    const b = buildExploraControlledBatchReportPath(
      path.join(root, "reports"),
      "explora-apply-2026-08-11T08-16-03-366Z"
    );
    if (a === b) throw new Error("distinct run ids must produce distinct report paths");
    if (!a.endsWith("explora-controlled-batch-explora-apply-2026-08-10T10-04-57-125Z.json")) {
      throw new Error(`unexpected path a: ${a}`);
    }
    if (!b.endsWith("explora-controlled-batch-explora-apply-2026-08-11T08-16-03-366Z.json")) {
      throw new Error(`unexpected path b: ${b}`);
    }
    if (path.basename(a) === "explora-controlled-batch-apply.json") {
      throw new Error("generic apply report filename must not be reused");
    }
  });
  console.log(`\n${passed} runtime module checks passed`);
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
