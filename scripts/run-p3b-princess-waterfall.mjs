#!/usr/bin/env node
/**
 * Princess P3B pass-2 source + complete identity waterfall. Zero writes.
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
const { runPrincessWeeklyMaintenance } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-runner")
);
const { classifyPrincessP3bEligibleSet } = require(
  path.join(root, "netlify/functions/lib/princess-voyage-identity-classifier")
);
const { officialProductKey: princessOfficialProductKey } = require(
  path.join(root, "netlify/functions/lib/princess-discovery-adapter")
);

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const startedAt = new Date().toISOString();
  const result = await runPrincessWeeklyMaintenance({
    dryRun: true,
    performWrites: false,
    maxWrites: 0,
    runId: `p3b-princess-waterfall-${startedAt.replace(/[:.]/g, "-")}`,
    supabase: sb,
    triggerType: "p3b_identity_waterfall",
    writeMode: "production_read_only"
  });
  const line = (
    await sb(`ci_cruise_lines?slug=eq.princess-cruises&select=id&limit=1`)
  )?.[0];
  const productionRows = await fetchAllPaginated(
    root,
    `discovered_cruises?cruise_line_id=eq.${line.id}&select=id,status,official_sailing_id,external_key,identity_key,ship_id,destination_id,departure_date,return_date,nights,departure_port&order=id.asc`
  );
const { partitionByPublicBookingCutoff, perthCalendarDate } = require(
  path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory")
);
  const normalised = result.simulation?.products || [];
  const { publiclyEligible } = partitionByPublicBookingCutoff(
    normalised,
    (p) => p.candidate?.departure_date || p.departure_date || p.raw?.departure_date,
    perthCalendarDate()
  );
  const eligible = publiclyEligible.filter((p) => p.complete_high_confidence === true);
  const mapped = eligible.map((p) => ({
    official_sailing_id:
      p.official_sailing_id || p.official_princess_sailing_id || princessOfficialProductKey(p.raw),
    external_key: p.candidate?.external_key || p.external_key,
    identity_key: p.candidate?.identity_key || p.identity_key,
    ship_id: p.canonical_ship_id || p.candidate?.ship_id || p.ship_resolution?.ship?.id,
    departure_date: p.departure_date || p.candidate?.departure_date || p.raw?.departure_date,
    return_date: p.return_date || p.candidate?.return_date || p.raw?.return_date,
    nights: p.nights ?? p.candidate?.nights ?? p.raw?.nights,
    departure_port:
      p.canonical_departure_port ||
      p.candidate?.departure_port ||
      p.departure_port_resolution?.canonicalPortName ||
      p.raw?.departure_port,
    destination_id: p.destination_id || p.candidate?.destination_id || p.destination_resolution?.destination_id
  }));
  const waterfall = classifyPrincessP3bEligibleSet(mapped, productionRows);
  const summary = result.summary || {};
  const out = {
    generated_at: new Date().toISOString(),
    snapshot_id: summary.snapshot_id || null,
    eligible_total: summary.eligible_total ?? mapped.length,
    proposed_inserts: summary.proposed_inserts ?? null,
    recognised_existing_eligible: summary.recognised_existing_eligible ?? null,
    insert_classification_counts: summary.insert_classification_counts || null,
    waterfall: {
      total: waterfall.total,
      counts: waterfall.counts,
      accounting_ok: waterfall.accounting_ok,
      authorised_automatic: waterfall.authorised_automatic.length,
      review_required: waterfall.review_required.length,
      unique_official_id_remaps: waterfall.classified
        .filter((row) => row.classification === "UNIQUE_OFFICIAL_ID_REMAP")
        .map((row) => ({
          official_sailing_id: row.official_sailing_id,
          existing_uuid: row.existing_uuid,
          previous_official_sailing_id: row.previous_official_sailing_id,
          reason: row.reason
        })),
      true_new: waterfall.classified
        .filter((row) => row.classification === "TRUE_NEW")
        .map((row) => row.official_sailing_id)
    },
    writes: 0,
    quality_gate: summary.quality_gate || null,
    reason: result.reason || null
  };
  const file = path.join(root, "reports/princess-p3b-identity-waterfall-2026-09-09.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ok: true, file, snapshot: out.snapshot_id, waterfall: out.waterfall, eligible: out.eligible_total, inserts: out.proposed_inserts }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message, stack: error.stack }, null, 2));
  process.exit(1);
});
