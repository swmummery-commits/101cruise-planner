#!/usr/bin/env node
/**
 * Phase 6B — audit safe-metadata recurrence for previously applied rows.
 */

import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
} catch {
  /* optional */
}

const APPLIED = [
  "PR270805-020",
  "PR270805-034",
  "PR270813-012",
  "PR270909-012",
  "PR270909-058",
  "ON270923-009",
  "JR271010-009",
  "QS280105-019",
  "QS280124-049",
  "JR280129-009"
];

const { createMaintenanceSupabase, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { simulateAzamaraDiscovery } = require(path.join(root, "netlify/functions/lib/azamara-discovery-adapter"));
const { indexExistingAzamaraRecords } = require(path.join(root, "netlify/functions/lib/azamara-discovery-writes"));
const { classifyAzamaraUpdateRisk, refineProposedActionForWeekly } = require(path.join(
  root,
  "netlify/functions/lib/azamara-weekly-update-policy"
));
const {
  projectAzamaraWeeklySafeMetadata,
  azamaraStableRawExtractEquivalent
} = require(path.join(root, "netlify/functions/lib/azamara-weekly-safe-metadata"));
const { loadClassificationDestinations } = require(path.join(root, "netlify/functions/lib/destination-queries"));
const { loadShipAliases, loadDestinationAliases } = require(path.join(root, "netlify/functions/lib/cruise-discovery-ops"));

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const line = (await sb("ci_cruise_lines?slug=eq.azamara&select=id,name,slug&limit=1"))?.[0];
  const [ships, shipAliases, destinations, destinationAliases, indexes] = await Promise.all([
    sb(`ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&active=eq.true&select=id,name&order=name.asc`),
    loadShipAliases(line.id),
    loadClassificationDestinations((p) => sb(p)),
    loadDestinationAliases(),
    indexExistingAzamaraRecords(sb, line.id)
  ]);
  const sim = await simulateAzamaraDiscovery({
    cruiseLine: line,
    ships,
    destinations,
    shipAliases,
    destinationAliases,
    existingOfficialBySailingId: indexes.officialBySailingId
  });

  const rows = [];
  for (const sailingId of APPLIED) {
    const existing = indexes.officialBySailingId.get(sailingId);
    const product = (sim.products || []).find((p) => String(p.official_sailing_id).toUpperCase() === sailingId);
    const candidate = product?.candidate;
    const risk = classifyAzamaraUpdateRisk(existing, candidate);
    const action = refineProposedActionForWeekly("update_official_match", existing, candidate);
    rows.push({
      official_sailing_id: sailingId,
      action,
      stable_equivalent: azamaraStableRawExtractEquivalent(existing?.raw_extract, candidate?.raw_extract),
      safe_metadata_changes: risk.safe_metadata_changes,
      production_stable: projectAzamaraWeeklySafeMetadata(existing?.raw_extract),
      source_stable: projectAzamaraWeeklySafeMetadata(candidate?.raw_extract)
    });
  }
  console.log(JSON.stringify({ rows, still_proposing_update: rows.filter((r) => r.action === "update_safe_metadata_allowed").length }, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
