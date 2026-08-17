#!/usr/bin/env node
/**
 * Phase 6B — guarded stale production identity corrections for Azamara.
 *
 *   node scripts/run-azamara-stale-production-corrections.mjs --dry-run
 *   AZAMARA_DISCOVERY_WRITE_ENABLED=true node scripts/run-azamara-stale-production-corrections.mjs --apply
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
  require("dotenv").config({ path: path.join(root, ".env.local") });
} catch {
  /* optional */
}

const { createMaintenanceSupabase, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { simulateAzamaraDiscovery } = require(path.join(root, "netlify/functions/lib/azamara-discovery-adapter"));
const { indexExistingAzamaraRecords } = require(path.join(root, "netlify/functions/lib/azamara-discovery-writes"));
const { runAzamaraStaleProductionCorrections } = require(path.join(
  root,
  "netlify/functions/lib/azamara-stale-production-corrections"
));
const { loadClassificationDestinations } = require(path.join(root, "netlify/functions/lib/destination-queries"));
const { loadShipAliases, loadDestinationAliases } = require(path.join(root, "netlify/functions/lib/cruise-discovery-ops"));
const { perthCalendarDate } = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));

const STALE_SAILING_IDS = [
  "QS260913-031",
  "PR261002-014",
  "PR261031-034",
  "QS261031-007",
  "PR261114-020",
  "ON261117-018",
  "ON261128-007",
  "ON261128-014",
  "ON270220-011",
  "JR270310-008",
  "ON270313-021",
  "ON270325-009",
  "QS270402-014",
  "ON270430-008",
  "ON270516-011",
  "ON270620-009",
  "JR270707-013",
  "PR270909-012",
  "ON270923-009",
  "JR271010-009",
  "JR280129-009",
  "PR280315-016",
  "JR280401-007",
  "QS280421-008",
  "JR280425-011",
  "PR280428-014",
  "PR280428-026",
  "ON280602-007",
  "PR280605-012",
  "ON280619-010",
  "PR280629-014",
  "ON280717-009",
  "PR280903-024",
  "QS280913-010",
  "JR280915-008",
  "PR280915-012",
  "ON280917-010",
  "QS280930-009",
  "JR281011-010",
  "QS281017-011",
  "JR281028-007"
];

function parseArgs(argv) {
  return { dryRun: !argv.includes("--apply"), apply: argv.includes("--apply") };
}

async function main() {
  getSupabaseConfig(root);
  const args = parseArgs(process.argv);
  const sb = createMaintenanceSupabase(root);
  const runId = `azamara-stale-corrections-${Date.now()}`;
  const today = perthCalendarDate();

  const line = (await sb("ci_cruise_lines?slug=eq.azamara&select=id,name,slug&limit=1"))?.[0];
  if (!line) throw new Error("Azamara line not found");

  const [ships, shipAliases, destinations, destinationAliases, indexes] = await Promise.all([
    sb(`ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&active=eq.true&select=id,name&order=name.asc`),
    loadShipAliases(line.id),
    loadClassificationDestinations((p) => sb(p)),
    loadDestinationAliases(),
    indexExistingAzamaraRecords(sb, line.id)
  ]);

  const simulation = await simulateAzamaraDiscovery({
    cruiseLine: line,
    ships,
    destinations,
    shipAliases,
    destinationAliases,
    existingOfficialBySailingId: indexes.officialBySailingId,
    today,
    runId
  });

  const byId = new Map(
    (simulation.products || []).map((p) => [String(p.official_sailing_id || "").toUpperCase(), p.candidate])
  );

  const corrections = [];
  const missing = [];
  for (const sailingId of STALE_SAILING_IDS) {
    const candidate = byId.get(sailingId);
    if (!candidate) {
      missing.push(sailingId);
      continue;
    }
    corrections.push({ official_sailing_id: sailingId, candidate });
  }

  const result = await runAzamaraStaleProductionCorrections({
    supabase: sb,
    cruiseLine: line,
    corrections,
    performWrites: args.apply,
    runId
  });

  const report = {
    mode: args.apply ? "apply" : "dry_run",
    run_id: runId,
    missing_source: missing,
    success: result.success,
    blocked: result.blocked || false,
    reason: result.reason || null,
    manifest: {
      total: result.manifest?.total ?? 0,
      skipped: result.manifest?.skipped ?? [],
      entries: (result.manifest?.entries || []).map((e) => ({
        official_sailing_id: e.official_sailing_id,
        production_row_id: e.production_row_id,
        fields: e.fields
      }))
    },
    apply: result.apply || null,
    global_lock: result.global_lock || null
  };

  const reportDir = path.join(root, "reports");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `azamara-stale-production-corrections-${Date.now()}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, report_path: reportPath }, null, 2));
  if (!result.success) process.exit(2);
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
