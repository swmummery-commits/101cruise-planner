#!/usr/bin/env node
/**
 * Princess P3N read-only forensic of today's W40 run.
 * Zero discovered_cruises writes.
 */

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

const { createMaintenanceSupabase, fetchAllPaginated } = require(path.join(
  root,
  "scripts/lib/supabase-rest.cjs"
));
const { dedupeSourceAbsentByUuid } = require(path.join(
  root,
  "netlify/functions/lib/princess-canonical-reconciliation"
));
const { comparePrincessVoyageIdentityFields } = require(path.join(
  root,
  "netlify/functions/lib/princess-deterministic-remap"
));

const RUN_RECORD_ID = "347d47ad-387d-44f0-ada8-9ebd55098a7c";
const PRINCESS_LINE_ID = "c19f40a7-c160-4035-a845-14dada550e1f";
const REVIEW_PAIRS = [
  { source: "SFV33A|MJ|2026-11-19", production: "SFS33A|MJ|2026-11-19", label: "SF* 2026-11-19" },
  { source: "SBV15A|MJ|2026-12-07", production: "SBS15A|MJ|2026-12-07", label: "SB* 2026-12-07" },
  { source: "SVB15A|MJ|2026-12-22", production: "SSB15C|MJ|2026-12-22", label: "VB 2026-12-22" }
];

async function loadByOfficial(sb, official) {
  return sb(
    `discovered_cruises?cruise_line_id=eq.${PRINCESS_LINE_ID}&official_sailing_id=eq.${encodeURIComponent(official)}&select=id,status,official_sailing_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,external_key,identity_key,official_url,itinerary,raw_extract`
  );
}

async function main() {
  const sb = createMaintenanceSupabase(root);
  const runRows = await sb(
    `cruise_discovery_runs?id=eq.${RUN_RECORD_ID}&select=id,status,started_at,finished_at,stats,error_message`
  );
  const run = runRows?.[0] || null;
  const stats = run?.stats || {};

  const absentIds = stats.source_absent_sailing_ids || [];
  const idCounts = new Map();
  for (const id of absentIds) idCounts.set(id, (idCounts.get(id) || 0) + 1);
  const duplicateIds = [...idCounts.entries()].filter(([, n]) => n > 1).map(([id, n]) => ({ id, count: n }));

  const active = await fetchAllPaginated(
    root,
    `discovered_cruises?cruise_line_id=eq.${PRINCESS_LINE_ID}&status=eq.active&select=id,official_sailing_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,external_key,identity_key,status`,
    { pageSize: 1000 }
  );

  const pairs = [];
  for (const pair of REVIEW_PAIRS) {
    const prod = (await loadByOfficial(sb, pair.production)) || [];
    pairs.push({
      label: pair.label,
      source_official_id: pair.source,
      production_official_id: pair.production,
      production_rows: prod.map((row) => ({
        id: row.id,
        status: row.status,
        official_sailing_id: row.official_sailing_id,
        ship_id: row.ship_id,
        destination_id: row.destination_id,
        departure_date: row.departure_date,
        return_date: row.return_date,
        nights: row.nights,
        departure_port: row.departure_port,
        external_key: row.external_key,
        identity_key: row.identity_key,
        itinerary: row.itinerary
      }))
    });
  }

  const report = {
    ok: true,
    discovered_cruises_writes: 0,
    run: {
      id: run?.id || null,
      status: run?.status || null,
      terminal_status: stats.terminal_status || null,
      started_at: run?.started_at || null,
      finished_at: run?.finished_at || null,
      inserts: stats.inserts ?? null,
      updates: stats.updates ?? null,
      failed_writes: stats.failed_writes ?? null,
      inventory_changed: stats.inventory_changed ?? null,
      eligible_total: stats.eligible_total ?? null,
      active_production_total: stats.active_production_total ?? null,
      recognised_existing_eligible: stats.recognised_existing_eligible ?? stats.unchanged ?? null,
      proposed_updates: stats.proposed_updates ?? null,
      proposed_updates_identity_review: stats.proposed_updates_identity_review ?? null,
      identity_review_sailing_ids: stats.identity_review_sailing_ids || [],
      source_absent_active: stats.source_absent_active ?? null,
      source_absent_sailing_ids: absentIds,
      unexplained_active_rows: stats.unexplained_active_rows ?? null,
      snapshot_id: stats.snapshot_id || null
    },
    source_absence_duplicates: {
      array_length: absentIds.length,
      unique_ids: idCounts.size,
      duplicate_ids: duplicateIds,
      uuid_dedupe: dedupeSourceAbsentByUuid(
        absentIds.map((id, index) => ({ discovered_cruise_id: `unknown-${index}`, official_sailing_id: id }))
      ).duplicate_entries.length
    },
    active_production_loaded: active.length,
    review_pairs: pairs
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
