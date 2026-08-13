#!/usr/bin/env node
/**
 * Read-only Seabourn source smoke for local or GitHub Actions.
 *
 *   node scripts/seabourn-source-smoke-ci.mjs
 */

import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const source = require(path.join(root, "netlify/functions/lib/seabourn-discovery-source"));
const adapter = require(path.join(root, "netlify/functions/lib/seabourn-discovery-adapter"));

async function main() {
  const started = Date.now();
  for (const flag of ["SEABOURN_DISCOVERY_WRITE_ENABLED", "SEABOURN_WEEKLY_RECONCILIATION_ENABLED"]) {
    if (String(process.env[flag] || "").toLowerCase() === "true") {
      throw new Error(`${flag} must not be true for Seabourn source smoke`);
    }
  }

  source.clearSeabournFetchCache();
  const catalogue = await source.fetchSeabournCatalogue({ maxApiCalls: 3, pageSize: 100 });
  const sampleDoc = catalogue.docs.find((d) => d.cruiseId && d.departDate);
  const parsed = sampleDoc ? adapter.parseRawVoyageFromDoc(sampleDoc) : null;

  const report = {
    execution_platform: process.env.GITHUB_ACTIONS === "true" ? "github_actions" : "local",
    github_run_id: process.env.GITHUB_RUN_ID || null,
    github_sha: process.env.GITHUB_SHA || null,
    inventory_writes_performed: false,
    endpoint: source.SOURCE_CONTRACT.primary_endpoint,
    http_ok: catalogue.numFound > 0 && catalogue.raw_rows_fetched > 0,
    num_found: catalogue.numFound,
    raw_rows_fetched: catalogue.raw_rows_fetched,
    unique_products_sampled: catalogue.unique_products,
    sample_cruise_id: parsed?.cruise_id || null,
    sample_itinerary_id: parsed?.itinerary_id || null,
    sample_ship: parsed?.ship_name || null,
    sample_departure_date: parsed?.departure_date || null,
    pagination_observed_docs_per_page: catalogue.pagination?.observed_docs_per_page || [],
    ok: Boolean(
      catalogue.numFound > 0 &&
        catalogue.docs.length > 0 &&
        parsed?.cruise_id &&
        parsed?.itinerary_id &&
        parsed?.departure_date
    ),
    elapsed_ms: Date.now() - started
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message || String(err), inventory_writes_performed: false }));
  process.exit(1);
});
