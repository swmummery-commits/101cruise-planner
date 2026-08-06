#!/usr/bin/env node
/**
 * Audit inactive Celebrity Discovery legacy records against current GraphQL inventory.
 *   node scripts/audit-celebrity-legacy-records.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { simulateCelebrityInventory, officialProductKey } = require(path.join(
  root,
  "netlify/functions/lib/celebrity-discovery-adapter"
));
const { catalogueDestinations } = require(path.join(root, "netlify/functions/lib/holland-america-discovery-adapter"));

const OUTPUT = path.join(root, `reports/celebrity-legacy-audit-${new Date().toISOString().slice(0, 10)}.json`);

async function main() {
  const sb = createSupabaseRest(root);
  const today = new Date().toISOString().slice(0, 10);

  const line = (await sb.get("ci_cruise_lines?slug=eq.celebrity-cruises&select=id,name&limit=1"))?.[0];
  if (!line) throw new Error("Celebrity line not found");

  const legacy = await sb.get(
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(line.id)}&status=in.(hidden,match_required,validation_failed)&select=id,status,ship_id,departure_date,departure_port,destination_id,official_url,official_sailing_id,source_url,raw_extract,itinerary&order=departure_date.asc`
  );

  const ships = await sb.get(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&select=id,name`
  );
  const shipById = Object.fromEntries((ships || []).map((s) => [s.id, s.name]));
  const destRows = await sb.get("destinations?select=id,name,slug");
  const destById = Object.fromEntries((destRows || []).map((d) => [d.id, d.name]));

  const simulation = await simulateCelebrityInventory({
    cruiseLine: line,
    ships: ships || [],
    destinations: catalogueDestinations(destRows || []),
    today
  });

  const officialBySailingId = new Map();
  for (const p of simulation.products) {
    const id = officialProductKey(p.raw);
    if (id) officialBySailingId.set(id, p);
  }

  const records = (legacy || []).map((row) => {
    const legacySailingId =
      row.official_sailing_id ||
      row.raw_extract?.celebrity_sailing_id ||
      row.raw_extract?.sailing_id ||
      null;
    const graphqlMatch = legacySailingId ? officialBySailingId.get(legacySailingId) : null;

    let classification = "D";
    if (graphqlMatch) classification = "A";
    else if (!legacySailingId || !row.official_url) classification = "B";
    else if (row.raw_extract?.structured_source && row.raw_extract.structured_source !== "celebrity_graphql") {
      classification = "C";
    } else if (!graphqlMatch) classification = "B";

    return {
      record_id: row.id,
      status: row.status,
      ship: shipById[row.ship_id] || row.raw_extract?.ship_name || null,
      departure_date: row.departure_date,
      departure_port: row.departure_port,
      destination: destById[row.destination_id] || null,
      source_url: row.official_url || row.source_url,
      official_sailing_id: legacySailingId,
      source_identity: row.raw_extract?.celebrity_sailing_id || row.official_sailing_id || null,
      raw_extraction_source: row.raw_extract?.structured_source || row.raw_extract?.source || null,
      reason_for_status: row.raw_extract?.review_reason || row.status,
      graphql_inventory_match: Boolean(graphqlMatch),
      classification,
      treatment:
        classification === "A"
          ? "eligible_for_exact_legacy_match_on_write"
          : classification === "B"
            ? "retain_historical_insert_clean_graphql_record"
            : classification === "C"
              ? "retain_unrelated_legacy"
              : "insufficient_evidence_retain"
    };
  });

  const report = {
    generated_at: new Date().toISOString(),
    legacy_record_count: records.length,
    classification_counts: records.reduce((acc, r) => {
      acc[r.classification] = (acc[r.classification] || 0) + 1;
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {}),
    records
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output: OUTPUT, legacy_record_count: records.length, classification_counts: report.classification_counts }, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
