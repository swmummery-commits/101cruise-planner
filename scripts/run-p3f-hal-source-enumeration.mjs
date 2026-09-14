#!/usr/bin/env node
/**
 * Two uncached HAL source enumerations after the P3F pagination repair.
 * Read-only. Forces process exit so HTTP keep-alive cannot hang the script.
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  simulateHalDiscovery,
  clearHalFetchCache,
  officialProductKey
} = require(path.join(root, "netlify/functions/lib/holland-america-discovery-adapter"));
const { loadClassificationDestinations } = require(path.join(root, "netlify/functions/lib/destination-queries"));
const { perthCalendarDate } = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));
const { createMaintenanceSupabase, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const REPORT_DIR = path.join(root, "reports");

function identityHash(voyages = []) {
  const keys = voyages.map((row) => officialProductKey(row) || `${row.cruise_id}|${row.departure_date}`).sort();
  return {
    count: keys.length,
    first: keys[0] || null,
    last: keys[keys.length - 1] || null,
    sample: keys.slice(0, 8)
  };
}

async function loadHalContext(sb) {
  const lines = await sb("ci_cruise_lines?slug=eq.holland-america-line&select=id,name,slug&limit=1");
  const line = lines?.[0];
  if (!line) throw new Error("HAL line not found");
  const ships = await sb(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&select=id,name,cruise_line_id,official_line_ship_id,ship_class,active`
  );
  const destinations = await loadClassificationDestinations(sb);
  return { line, ships: ships || [], destinations };
}

async function runOnce(label, context) {
  clearHalFetchCache();
  const started = Date.now();
  const simulation = await simulateHalDiscovery({
    cruiseLine: context.line,
    ships: context.ships,
    destinations: context.destinations,
    today: perthCalendarDate(),
    useCache: false
  });
  const pagination = simulation.pagination || {};
  const voyages = simulation.raw_voyages || simulation.voyages || [];
  return {
    label,
    elapsed_ms: Date.now() - started,
    http_ok: pagination.truncated !== true && simulation.fetch_failed !== true,
    num_found: pagination.num_found ?? simulation.num_found_official ?? null,
    pages_fetched: pagination.pages_fetched ?? null,
    rows_per_page: pagination.rows_per_page ?? null,
    expected_pages: pagination.expected_pages ?? null,
    raw_docs_seen: pagination.raw_docs_seen ?? null,
    pagination_complete: pagination.complete === true || pagination.truncated === false,
    pagination_truncated: pagination.truncated === true,
    truncated_reason: pagination.truncated_reason || null,
    source_identities: pagination.unique_source_identities ?? voyages.length,
    identity: identityHash(voyages),
    eligible: simulation.complete_high_confidence ?? simulation.eligible_total ?? voyages.length,
    fetch_failed: simulation.fetch_failed === true,
    ship_resolution: simulation.ship_audit || null,
    port_resolution: simulation.port_audit || null,
    destination: simulation.destination_audit || null,
    identity_coverage: simulation.identity || null,
    pagination
  };
}

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const context = await loadHalContext(sb);
  const run1 = await runOnce("hal-p3f-source-run-1", context);
  const run2 = await runOnce("hal-p3f-source-run-2", context);
  const report = {
    generated_at: new Date().toISOString(),
    perth_today: perthCalendarDate(),
    run_1: run1,
    run_2: run2,
    reproducible:
      run1.num_found === run2.num_found &&
      run1.source_identities === run2.source_identities &&
      run1.identity.first === run2.identity.first &&
      run1.identity.last === run2.identity.last,
    collapsed: [run1.eligible, run2.eligible].some((value) => Number(value) > 0 && Number(value) < 200)
  };
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const file = path.join(REPORT_DIR, `hal-p3f-source-enumerations-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report_file: file, ...report }, null, 2));
  if (report.collapsed) {
    console.error("HAL source remained collapsed — STOP");
    process.exit(2);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
