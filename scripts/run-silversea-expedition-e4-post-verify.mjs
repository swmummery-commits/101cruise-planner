#!/usr/bin/env node
/**
 * Post-E4 read-only verification when apply succeeded but runner verification failed.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
} catch {
  /* optional */
}

const { createMaintenanceSupabase, exactCountSupabase } = require(path.join(
    root,
    "scripts/lib/supabase-rest.cjs"
));

async function verifyPostApply() {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(root, "scripts/fixtures/silversea/expedition-e3-first-250.json"), "utf8")
  );
  const frozenIds = fixture.selection.selected_official_sailing_ids;
  const { indexExistingSilverseaRecords, buildItineraryPorts } = require(path.join(
    root,
    "netlify/functions/lib/silversea-discovery-writes"
  ));
  const { EXPEDITION_SEMANTIC } = require(path.join(
    root,
    "netlify/functions/lib/silversea-expedition-semantics"
  ));
  const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
  const { classifyExpeditionExclusiveBucket } = require(path.join(
    root,
    "netlify/functions/lib/silversea-expedition-eligibility"
  ));
  const { selectExpeditionCompletePool } = require(path.join(
    root,
    "netlify/functions/lib/silversea-expedition-controlled-batch"
  ));
  const { loadClassificationDestinations } = require(path.join(
    root,
    "netlify/functions/lib/destination-queries"
  ));
  const { perthCalendarDate } = require(path.join(
    root,
    "netlify/functions/lib/public-discovered-cruise-inventory"
  ));

  const sb = createMaintenanceSupabase(root);
  const line = (await sb(`ci_cruise_lines?slug=eq.${adapter.LINE_SLUG}&select=id&limit=1`))[0];
  const indexed = await indexExistingSilverseaRecords(sb, line.id);
  let found = 0;
  const rows = [];
  for (let i = 0; i < frozenIds.length; i += 50) {
    const chunk = frozenIds.slice(i, i + 50);
    const quoted = chunk.map((id) => `"${id}"`).join(",");
    const batch = await sb(
      `discovered_cruises?cruise_line_id=eq.${line.id}&official_sailing_id=in.(${quoted})&select=id,official_sailing_id,status,ship_id,departure_date,return_date,nights,destination_id,itinerary_ports,raw_extract`
    );
    rows.push(...batch);
    found += batch.length;
  }

  const total = await exactCountSupabase(root, "discovered_cruises", `cruise_line_id=eq.${line.id}`);
  const legacy = indexed.rows.filter((r) => !r.official_sailing_id);
  const expeditionOfficial = indexed.rows.filter(
    (r) => r.status === "active" && r.official_sailing_id && /^(E4|EV|OR|WI)/i.test(String(r.official_sailing_id))
  );

  let semanticOk = true;
  for (const row of rows) {
    if (!row.raw_extract?.silversea_expedition_controlled_batch) semanticOk = false;
    if (row.status !== "active") semanticOk = false;
  }

  const today = perthCalendarDate();
  const destinations = adapter.catalogueDestinations(
    await loadClassificationDestinations(async (q) => sb(q))
  );
  const ships = await sb(
    `ci_cruise_ships?cruise_line_id=eq.${line.id}&select=id,name,cruise_line_id,official_line_ship_id`
  );
  const simulation = await adapter.simulateSilverseaInventory({
    cruiseLine: line,
    ships,
    destinations,
    existingRows: indexed.rows,
    today,
    concurrency: 6
  });
  const expRows = simulation.products.filter(
    (row) => String(row.raw?.cruise_type || "").trim().toLowerCase() === "expedition"
  );
  const completePool = selectExpeditionCompletePool(expRows, {
    today,
    existingByOfficialId: indexed.byOfficialId
  });
  const remaining = completePool.eligible_ids.filter(
    (id) => !indexed.byOfficialId.has(String(id).toUpperCase())
  );

  const report = {
    phase: "e4_post_apply_verification",
    generated_at: new Date().toISOString(),
    frozen_ids_found: found,
    expected: 250,
    production_total: total.count,
    expedition_official: expeditionOfficial.length,
    legacy_hidden: legacy.length,
    post_write_verification: found === 250 ? "250/250 PASS" : "FAIL",
    semantic_write_shape_verified: semanticOk,
    remaining_new_complete: remaining.length,
    remaining_ids: remaining
  };

  const reportPath = path.join(
    root,
    "reports",
    `silversea-expedition-e4-post-verify-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ok: found === 250, report: reportPath, ...report }, null, 2));
}

verifyPostApply().catch((e) => {
  console.error(e);
  process.exit(1);
});
