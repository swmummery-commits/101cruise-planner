#!/usr/bin/env node
/**
 * Sprint 14A — Engine V2 development-only proof of concept.
 *
 * Usage:
 *   npm run poc:cruise-finder-v2
 *   node scripts/run-cruise-finder-v2-poc.mjs --provider=fixture
 *   node scripts/run-cruise-finder-v2-poc.mjs --provider=vacationstogo
 *
 * HOLD DEPLOY. No production UI. No DB writes. No prices.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const { runEngineV2Search } = require(path.join(
  root,
  "netlify/functions/lib/cruise-finder-v2/engine.js"
));
const { FEASIBILITY } = require(path.join(
  root,
  "netlify/functions/lib/cruise-finder-v2/providers/vacationstogo-provider.js"
));

function parseArgs(argv) {
  const flags = {};
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--")) {
      const [k, v] = arg.slice(2).split("=");
      flags[k] = v == null ? true : v;
    }
  }
  return flags;
}

function summariseEnrichment(enrichment) {
  const line = { MATCHED: 0, AMBIGUOUS: 0, NOT_FOUND: 0 };
  const ship = { MATCHED: 0, AMBIGUOUS: 0, NOT_FOUND: 0 };
  const port = { MATCHED: 0, AMBIGUOUS: 0, NOT_FOUND: 0, total: 0 };
  for (const row of enrichment || []) {
    line[row.cruiseLineMatch?.status] = (line[row.cruiseLineMatch?.status] || 0) + 1;
    ship[row.shipMatch?.status] = (ship[row.shipMatch?.status] || 0) + 1;
    for (const p of row.portMatches || []) {
      port.total += 1;
      port[p.status] = (port[p.status] || 0) + 1;
    }
  }
  return { cruiseLine: line, ship, port };
}

async function main() {
  const flags = parseArgs(process.argv);
  const providerId = String(flags.provider || "fixture");

  const questionnaireBody = {
    destination: "mediterranean",
    destinationName: "Mediterranean",
    timingMode: "month",
    month: null,
    year: 2026,
    startDate: null,
    endDate: null,
    durationId: "flexible",
    departure: "anywhere",
    styles: [],
    cruiseLines: ["Oceania Cruises", "Celebrity Cruises", "Princess Cruises"],
    forceRefresh: false
  };

  console.log("=== Cruise Finder Engine V2 POC ===");
  console.log("Provider:", providerId);
  console.log("Vacationstogo feasibility:", FEASIBILITY.recommendation);

  const result = await runEngineV2Search(questionnaireBody, {
    providerId,
    limit: 10,
    enrich: true,
    timeoutMs: providerId === "vacationstogo" ? 3000 : 12000
  });

  const outDir = path.join(root, "tmp/cruise-finder-v2-poc");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `poc-${providerId}.json`);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));

  if (!result.ok) {
    console.log("POC ok: false");
    console.log("Error:", result.error);
    console.log("Wrote:", outFile);
    process.exitCode = providerId === "vacationstogo" ? 0 : 1;
    return;
  }

  const rates = summariseEnrichment(result.enrichment);
  console.log("Candidates:", result.candidates.length);
  console.log("Duplicates collapsed:", result.meta.duplicates);
  console.log("Match rates:", JSON.stringify(rates, null, 2));
  console.log("Wrote:", outFile);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
