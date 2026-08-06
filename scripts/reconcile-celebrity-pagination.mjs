#!/usr/bin/env node
/**
 * Full read-only Celebrity GraphQL pagination reconciliation.
 *   node scripts/reconcile-celebrity-pagination.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const { fetchCelebrityInventoryPages, expandGraphGroupsToRawSailings, classifyCelebrityProductType } = require(path.join(
  root,
  "netlify/functions/lib/celebrity-discovery-adapter"
));

const OUTPUT = path.join(root, `reports/celebrity-pagination-reconciliation-${new Date().toISOString().slice(0, 10)}.json`);

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const pageSize = 25;
  const fetchResult = await fetchCelebrityInventoryPages({ pageSize, maxPages: null, startSkip: 0 });

  const expanded = expandGraphGroupsToRawSailings(fetchResult.groups, { today, futureOnly: true });
  const pageLog = fetchResult.page_log || [];
  const offsets = pageLog.map((p) => p.skip);
  const firstTotal = pageLog[0]?.total ?? null;
  const finalTotal = pageLog[pageLog.length - 1]?.total ?? null;
  const missingRanges = [];
  for (let i = 1; i < offsets.length; i += 1) {
    const expected = offsets[i - 1] + pageSize;
    if (offsets[i] !== expected) missingRanges.push({ from: offsets[i - 1], expected_next: expected, actual_next: offsets[i] });
  }

  const productTypes = {
    ocean_cruise: 0,
    river_cruise: 0,
    ocean_cruisetour: 0,
    river_cruisetour: 0,
    malformed_or_unknown: 0
  };
  for (const raw of expanded.products) {
    const type = classifyCelebrityProductType(raw).productType;
    if (productTypes[type] != null) productTypes[type] += 1;
    else productTypes.malformed_or_unknown += 1;
  }

  const endReached =
    offsets.length > 0 &&
    (offsets[offsets.length - 1] + pageSize >= finalTotal || (pageLog[pageLog.length - 1]?.returned || 0) === 0);

  const report = {
    generated_at: new Date().toISOString(),
    first_reported_itinerary_group_total: firstTotal,
    final_reported_itinerary_group_total: finalTotal,
    inventory_total_changed: firstTotal !== finalTotal,
    raw_groups_returned: pageLog.reduce((n, p) => n + (p.returned || 0), 0),
    unique_groups_returned: fetchResult.groups.length,
    duplicate_group_ids: fetchResult.duplicate_group_ids_suppressed || 0,
    empty_groups: 0,
    failed_or_retried_pages: pageLog.filter((p) => !p.ok).length,
    offsets_requested: offsets,
    missing_offset_ranges: missingRanges,
    pagination_silent_skip_suspected: missingRanges.length > 0,
    future_sailing_products: expanded.products.length,
    end_of_inventory_reached: endReached,
    duplicate_sailing_ids: expanded.audit?.duplicate_sailing_ids || 0,
    product_type_counts: productTypes,
    page_log: pageLog
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output: OUTPUT, ...report, page_log: undefined }, null, 2));
  if (missingRanges.length) process.exit(1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
