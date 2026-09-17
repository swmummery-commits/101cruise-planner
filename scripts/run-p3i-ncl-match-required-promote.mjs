#!/usr/bin/env node
/**
 * P3I NCL match_required audit + bounded enrichment/promotion of existing UUIDs.
 *
 *   node scripts/run-p3i-ncl-match-required-promote.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createMaintenanceSupabase, getSupabaseConfig, fetchAllPaginated } = require(
  path.join(root, "scripts/lib/supabase-rest.cjs")
);
const { runNorwegianWeeklyMaintenance } = require(
  path.join(root, "netlify/functions/lib/norwegian-weekly-maintenance")
);
const { perthIsoWeek, scheduledWeeklyDispatchKey } = require(
  path.join(root, "netlify/functions/lib/weekly-maintenance-schedule-control")
);
const { loadMaintenanceLockStatus } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks")
);
const { perthCalendarDate } = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));
const { withGlobalCruiseWriteLock } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-global-write-lock")
);
const { persistMaintenanceRollbackManifest } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-manifests")
);
const { promoteNorwegianToActive } = require(
  path.join(root, "netlify/functions/lib/norwegian-maintenance-shared")
);
const {
  applyEnrichmentManifest,
  buildDryRunManifest
} = require(path.join(root, "netlify/functions/lib/norwegian-discovery-enrichment-writes"));
const { classifyNorwegianP3iStagingSet } = require(
  path.join(root, "netlify/functions/lib/norwegian-p3i-staging")
);

const WEDNESDAY_INSERT_IDS = [
  "5c93d5ab-b659-44d9-bc60-4be7200fe0fa",
  "853b168d-211c-455a-96c1-cb97df1d8d89",
  "f7b45eca-0d3e-4b9e-b506-8552da9ed3a0",
  "e4c5d9f9-c8af-423b-b0f5-24512fecd7bb",
  "8a80cf9d-747c-4d8f-8d62-5e07dc7b3346",
  "b78d9945-f08b-48f0-8e88-9256b929fb16",
  "8895202a-ea1d-4436-89f6-5e866cca05ef",
  "3be7ec0c-b6d9-4642-9014-0ffe7005da03",
  "55b4442c-521c-4345-8cf5-0ac675428813",
  "db16abd9-b316-4e2d-8dc8-3bac26869bd1",
  "0a82a3b3-1245-484f-a04e-2390c07edd99"
];
const BATCH_CAP = 30;

function withItineraryCode(row) {
  const code = String(row.official_sailing_id || "").split("|")[0];
  return {
    ...row,
    raw_extract: {
      ...(row.raw_extract || {}),
      ncl_itinerary_code: row.raw_extract?.ncl_itinerary_code || code
    }
  };
}

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const periodKey = scheduledWeeklyDispatchKey("norwegian-cruise-line");
  const before = await loadMaintenanceLockStatus(sb, periodKey);
  const line = (await sb("ci_cruise_lines?slug=eq.norwegian-cruise-line&select=id&limit=1"))[0];
  process.env.NORWEGIAN_WEEKLY_RECONCILIATION_ENABLED = "true";
  const readonly = await runNorwegianWeeklyMaintenance({
    supabase: sb,
    dryRun: true,
    performWrites: false,
    maxWrites: 0,
    runId: `norwegian-p3i-staging-readonly-${perthIsoWeek()}-${Date.now()}`,
    triggerType: "preflight"
  });
  const afterLease = await loadMaintenanceLockStatus(sb, periodKey);
  const productionRows = await fetchAllPaginated(
    root,
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(line.id)}&select=id,official_sailing_id,external_key,identity_key,ship_id,destination_id,departure_date,return_date,nights,departure_port,status,official_url,created_at,raw_extract,itinerary,itinerary_ports`
  );
  const matchRequired = productionRows.filter((row) => row.status === "match_required");
  const sourceEligible = (readonly.simulation?.products || []).map((product) => ({
    ...product,
    official_sailing_id: product.official_sailing_id,
    ship_id: product.ship_id || product.ship_resolution?.ship?.id,
    departure_date: product.departure_date || product.raw?.departure_date,
    return_date: product.return_date || product.raw?.return_date,
    nights: product.nights ?? product.raw?.duration,
    departure_port: product.departure_port || product.departure_port_meta?.canonicalPortName,
    destination_id: product.destination_id || product.destination_resolution?.destination?.id
  }));
  const today = perthCalendarDate();
  const startingAudit = classifyNorwegianP3iStagingSet(matchRequired, {
    today,
    sourceEligible,
    productionRows
  });
  const wednesdayRows = startingAudit.classified.filter((row) => WEDNESDAY_INSERT_IDS.includes(row.uuid));
  const preexisting = startingAudit.classified.filter((row) => !WEDNESDAY_INSERT_IDS.includes(row.uuid));

  const enrichTargets = matchRequired
    .filter((row) => {
      const classified = startingAudit.classified.find((item) => item.uuid === row.id);
      return classified && ["NEEDS_ENRICHMENT", "SOURCE_STILL_INCOMPLETE"].includes(classified.classification) && classified.source_presence;
    })
    .slice(0, BATCH_CAP)
    .map(withItineraryCode);

  const writes = [];
  const rollbackIds = [];
  let stop = false;
  let enrichStats = null;
  if (enrichTargets.length) {
    const dbRowsById = new Map(enrichTargets.map((row) => [row.official_sailing_id, row]));
    const dry = await buildDryRunManifest(
      enrichTargets.map((row) => ({ official_sailing_id: row.official_sailing_id })),
      dbRowsById,
      { supabase: sb }
    );
    const safeEntries = (dry.entries || []).filter((entry) => !entry.blocked && Object.keys(entry.field_changes || {}).length);
    if (safeEntries.length) {
      const runId = `norwegian-p3i-enrich-${Date.now()}`;
      try {
        const applied = await applyEnrichmentManifest({
          dryRunManifest: { ...dry, entries: safeEntries.slice(0, BATCH_CAP) },
          supabase: sb,
          runId
        });
        enrichStats = applied;
        const snapshots = applied?.stats?.rollback_snapshots || [];
        const details = (applied?.stats?.write_details || []).map((detail) => {
          const snap = snapshots.find((row) => row.discovered_cruise_id === detail.discovered_cruise_id);
          return {
            ...detail,
            rollback_before: snap?.before || null,
            before_values: snap?.before || null
          };
        });
        const rollback = await persistMaintenanceRollbackManifest(sb, {
          runId,
          cruiseLineId: line.id,
          lineSlug: "norwegian-cruise-line",
          triggerType: "manual_recovery",
          writeResult: { stats: { write_details: details } }
        }).catch(() => null);
        if (rollback?.manifest_record_id) rollbackIds.push(rollback.manifest_record_id);
        writes.push({
          kind: "enrichment",
          attempted: applied?.stats?.attempted || 0,
          updated: applied?.stats?.updated || 0,
          failed: applied?.stats?.failed || 0
        });
        if ((applied?.stats?.failed || 0) > 0) stop = true;
      } catch (error) {
        stop = true;
        enrichStats = { ok: false, reason: error.message || String(error) };
      }
    }
  }

  const refreshed = await fetchAllPaginated(
    root,
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(line.id)}&select=id,official_sailing_id,external_key,identity_key,ship_id,destination_id,departure_date,return_date,nights,departure_port,status,official_url,created_at,raw_extract,itinerary,itinerary_ports`
  );
  const matchRequiredAfterEnrich = refreshed.filter((row) => row.status === "match_required");
  const midAudit = classifyNorwegianP3iStagingSet(matchRequiredAfterEnrich, {
    today,
    sourceEligible,
    productionRows: refreshed
  });
  const promoteTargets = matchRequiredAfterEnrich.filter((row) => {
    const classified = midAudit.classified.find((item) => item.uuid === row.id);
    return classified?.classification === "READY_TO_PROMOTE";
  }).slice(0, BATCH_CAP);

  if (!stop && promoteTargets.length) {
    const runId = `norwegian-p3i-promote-${Date.now()}`;
    const wrap = await withGlobalCruiseWriteLock(
      sb,
      { ownerId: runId, runId, lineSlug: "norwegian-cruise-line", operation: "norwegian_p3i_promotion" },
      async () => {
        const details = [];
        let failed = 0;
        for (const row of promoteTargets) {
          try {
            const result = await promoteNorwegianToActive({ supabase: sb, row, runId, perthToday: today });
            details.push(result);
            if (result.discovered_cruise_id !== row.id) {
              failed += 1;
              break;
            }
          } catch (error) {
            failed += 1;
            details.push({ discovered_cruise_id: row.id, result_action: "failed", error: error.message });
            break;
          }
        }
        return { stats: { promoted_active: details.filter((row) => row.result_action === "promoted_active").length, failed, write_details: details } };
      }
    );
    if (!wrap.acquired) {
      stop = true;
      writes.push({ kind: "promotion", ok: false, reason: wrap.reason });
    } else {
      const rollback = await persistMaintenanceRollbackManifest(sb, {
        runId,
        cruiseLineId: line.id,
        lineSlug: "norwegian-cruise-line",
        triggerType: "manual_recovery",
        writeResult: {
          stats: {
            ...(wrap.result?.stats || {}),
            write_details: (wrap.result?.stats?.write_details || []).map((detail) => ({
              ...detail,
              rollback_before: detail.rollback_snapshot || detail.rollback_before || null,
              before_values: detail.rollback_snapshot || detail.before_values || null
            }))
          }
        }
      }).catch(() => null);
      if (rollback?.manifest_record_id) rollbackIds.push(rollback.manifest_record_id);
      writes.push({
        kind: "promotion",
        promoted: wrap.result?.stats?.promoted_active || 0,
        failed: wrap.result?.stats?.failed || 0,
        uuids: promoteTargets.map((row) => row.id)
      });
      if ((wrap.result?.stats?.failed || 0) > 0) stop = true;
    }
  }

  const finalRows = await fetchAllPaginated(
    root,
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(line.id)}&select=id,official_sailing_id,status,raw_extract`
  );
  const counts = {
    active: finalRows.filter((row) => row.status === "active").length,
    match_required: finalRows.filter((row) => row.status === "match_required").length,
    expired: finalRows.filter((row) => row.status === "expired").length,
    hidden: finalRows.filter((row) => row.status === "hidden").length,
    validation_failed: finalRows.filter((row) => row.status === "validation_failed").length
  };
  const finalMatch = finalRows.filter((row) => row.status === "match_required");
  const finalAudit = classifyNorwegianP3iStagingSet(
    await fetchAllPaginated(
      root,
      `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(line.id)}&status=eq.match_required&select=id,official_sailing_id,external_key,identity_key,ship_id,destination_id,departure_date,return_date,nights,departure_port,status,official_url,created_at,raw_extract,itinerary,itinerary_ports`
    ),
    { today, sourceEligible, productionRows: refreshed }
  );
  const post = await runNorwegianWeeklyMaintenance({
    supabase: sb,
    dryRun: true,
    performWrites: false,
    maxWrites: 0,
    runId: `norwegian-p3i-post-readonly-${perthIsoWeek()}-${Date.now()}`,
    triggerType: "preflight"
  });
  const reviewItems = post.summary?.review_items || post.manifest?.review_items || [];
  const old34 = reviewItems.filter(
    (item) => item.ambiguity_reason === "SOURCE_FIELD_INCOMPLETE" || item.reason === "incomplete_voyage_equivalence"
  );
  const proposedIds = (post.manifest?.inserts || []).map((row) => row.official_sailing_id);
  const wednesdayOfficials = wednesdayRows.map((row) => row.official_sailing_id);
  const report = {
    generated_at: new Date().toISOString(),
    scheduled_lease_created: before.held !== true && afterLease.held === true,
    starting_match_required: matchRequired.length,
    starting_counts: startingAudit.counts,
    wednesday_11: wednesdayRows,
    preexisting_37: preexisting,
    enrich_stats: enrichStats,
    writes,
    rollback_manifest_ids: rollbackIds,
    stopped_early: stop,
    final_counts: counts,
    final_staging_counts: finalAudit.counts,
    post_write: {
      proposed_inserts: post.summary?.proposed_inserts ?? proposedIds.length,
      duplicate_proposals_for_wednesday_11: proposedIds.filter((id) => wednesdayOfficials.includes(id)),
      old_34_incomplete_reviews: old34.length,
      recognised_wednesday: wednesdayOfficials.filter((id) =>
        (post.simulation?.products || []).some((item) => item.official_sailing_id === id)
      ).length
    }
  };
  const file = path.join(root, "reports", `norwegian-p3i-match-required-promote-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        report_file: file,
        starting: matchRequired.length,
        starting_counts: startingAudit.counts,
        wednesday: wednesdayRows.length,
        writes,
        rollback_manifest_ids: rollbackIds,
        final: counts,
        final_staging: finalAudit.counts,
        proposed_inserts: report.post_write.proposed_inserts,
        old_34: old34.length,
        stopped_early: stop
      },
      null,
      2
    )
  );
  if (report.scheduled_lease_created || stop) process.exit(2);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
