#!/usr/bin/env node
/**
 * Norwegian weekly production-equivalent READ-ONLY run (no writes).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
try {
  require("dotenv").config({ path: path.join(root, ".env") });
} catch {}

const { createMaintenanceSupabase, fetchAllPaginated, getSupabaseConfig } = require(
  path.join(root, "scripts/lib/supabase-rest.cjs")
);
const { runNorwegianWeeklyMaintenance } = require(
  path.join(root, "netlify/functions/lib/norwegian-weekly-maintenance")
);
const { classifyNorwegianP3bEligibleSet } = require(
  path.join(root, "netlify/functions/lib/norwegian-voyage-identity-classifier")
);

const passArg = process.argv.find((arg) => arg.startsWith("--pass="));
const pass = passArg ? String(passArg.split("=")[1] || "1") : "1";

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const startedAt = new Date().toISOString();
  const result = await runNorwegianWeeklyMaintenance({
    supabase: sb,
    dryRun: true,
    performWrites: false,
    runId: `p3b-ncl-readonly-${pass}-${startedAt.replace(/[:.]/g, "-")}`,
    triggerType: "p3b_readonly"
  });
  const line = (await sb(`ci_cruise_lines?slug=eq.norwegian-cruise-line&select=id&limit=1`))?.[0];
  const productionRows = await fetchAllPaginated(
    root,
    `discovered_cruises?cruise_line_id=eq.${line.id}&select=id,status,official_sailing_id,external_key,identity_key,ship_id,destination_id,departure_date,return_date,nights,departure_port&order=id.asc`
  );
  const eligible = (result.simulation?.products || []).filter((p) => {
    const mapped = {
      official_sailing_id: p.official_sailing_id,
      ship_id: p.ship_id || p.ship_resolution?.ship?.id,
      departure_date: p.departure_date || p.raw?.departure_date,
      return_date: p.return_date || p.raw?.return_date,
      nights: p.nights ?? p.raw?.duration,
      departure_port: p.departure_port || p.departure_port_meta?.canonicalPortName,
      external_key: p.external_key,
      identity_key: p.identity_key
    };
    p._p3b = mapped;
    return p.complete_eligible && p.itinerary_classification?.category === "ocean";
  });
  const waterfall = classifyNorwegianP3bEligibleSet(
    eligible.map((p) => p._p3b),
    productionRows
  );
  const summary = result.summary || {};
  const out = {
    generated_at: new Date().toISOString(),
    pass,
    ok: result.ok !== false,
    reason: result.reason || null,
    source_eligible: summary.source_counts?.eligible_ocean ?? eligible.length,
    recognised: summary.recognised_eligible ?? null,
    active: summary.active_production_total ?? null,
    match_required: summary.match_required_count ?? null,
    total_outstanding_inserts: summary.total_outstanding_inserts ?? summary.proposed_inserts ?? null,
    planned_this_run: summary.planned_this_run ?? null,
    proposed_inserts: summary.proposed_inserts ?? null,
    source_absent: summary.source_absent_active ?? null,
    insert_classification_counts: summary.insert_classification_counts || null,
    p3b_waterfall: waterfall
      ? { counts: waterfall.counts, total: waterfall.total, outstanding_total: waterfall.outstanding_total, accounting_ok: waterfall.accounting_ok }
      : null,
    writes: 0,
    summary
  };
  const file = path.join(root, `reports/norwegian-p3b-readonly-pass${pass}-2026-09-09.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ok: true, file, total_outstanding: out.total_outstanding_inserts, planned: out.planned_this_run, eligible: out.source_eligible }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
