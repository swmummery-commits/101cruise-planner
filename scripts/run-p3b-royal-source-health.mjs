#!/usr/bin/env node
/**
 * Royal Caribbean P3B — zero-write source-health investigation.
 * Enumerates twice after the uncapped missing-ID detail lookup.
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

const { createMaintenanceSupabase, getSupabaseConfig, fetchAllPaginated } = require(
  path.join(root, "scripts/lib/supabase-rest.cjs")
);
const { runRoyalCaribbeanWeeklyMaintenance } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-runner")
);
const { perthCalendarDate, daysUntilDeparture } = require(
  path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory")
);
const { isLegacyHtmlDiscoveryRow } = require(
  path.join(root, "netlify/functions/lib/royal-caribbean-discovery-writes")
);

function classifyMissing({ row, detail, perthToday }) {
  const days = daysUntilDeparture(row?.departure_date, perthToday);
  if (row && isLegacyHtmlDiscoveryRow(row)) return "LEGACY";
  if (days != null && days < 0) return "EXPIRED/CUTOFF";
  if (days != null && days <= 21) return "EXPIRED/CUTOFF";
  if (detail?.retrievable) return "CURRENT_NOT_IN_UNION";
  if (detail?.detail_ok === true && detail?.sailing_present_in_detail === false) return "SOURCE_REMOVED";
  if (detail?.reason === "missing_group_id") return "UNEXPLAINED";
  return "UNEXPLAINED";
}

function compactPass(result, perthToday, productionRows = []) {
  const summary = result.summary || {};
  const health = summary.enumeration_health || {};
  const lookups = summary.detail_lookup_audit || [];
  const byId = new Map(productionRows.map((row) => [row.official_sailing_id, row]));
  const classified = lookups.map((detail) => {
    const row = byId.get(detail.official_sailing_id) || null;
    const classification = classifyMissing({ row, detail, perthToday });
    return {
      official_sailing_id: detail.official_sailing_id,
      production_uuid: row?.id || null,
      status: row?.status || null,
      departure_date: row?.departure_date || null,
      days_until_departure: daysUntilDeparture(row?.departure_date, perthToday),
      detail_ok: detail.detail_ok ?? null,
      sailing_present_in_detail: detail.sailing_present_in_detail ?? null,
      retrievable: detail.retrievable === true,
      reason: detail.reason || null,
      classification
    };
  });
  const counts = classified.reduce((acc, row) => {
    acc[row.classification] = (acc[row.classification] || 0) + 1;
    return acc;
  }, {
    CURRENT_NOT_IN_UNION: 0,
    IDENTITY_REMAP: 0,
    SOURCE_REMOVED: 0,
    "EXPIRED/CUTOFF": 0,
    LEGACY: 0,
    UNEXPLAINED: 0
  });
  return {
    ok: result.ok === true,
    status: result.blocked ? "blocked" : result.ok ? "completed" : "failed",
    snapshot: summary.source_snapshot_id || null,
    union_sailing_identities: summary.union_sailing_identities ?? null,
    recognised: summary.recognised_existing_eligible_sailings ?? null,
    proposed_inserts: summary.proposed_inserts ?? null,
    royal_caribbean_source_enumeration_ok: summary.royal_caribbean_source_enumeration_ok === true,
    enumeration_failures: health.failures || [],
    production_absent_from_union_count: health.production_absent_from_union_count ?? classified.length,
    detail_lookup_count: lookups.length,
    weekly_health: summary.weekly_health || null,
    classification_counts: counts,
    classified
  };
}

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const perthToday = perthCalendarDate();
  const passes = [];
  for (const pass of [1, 2]) {
    const startedAt = new Date().toISOString();
    const result = await runRoyalCaribbeanWeeklyMaintenance({
      supabase: sb,
      dryRun: true,
      performWrites: false,
      skipLock: true,
      runId: `p3b-royal-enum-${pass}-${startedAt.replace(/[:.]/g, "-")}`,
      triggerType: "p3b_readonly",
      today: perthToday
    });
    const line = (await sb(`ci_cruise_lines?slug=eq.royal-caribbean-international&select=id&limit=1`))?.[0];
    const productionRows = await fetchAllPaginated(
      root,
      `discovered_cruises?cruise_line_id=eq.${line.id}&select=id,status,official_sailing_id,departure_date,return_date,nights,ship_id,departure_port,official_url,raw_extract&order=id.asc`
    );
    passes.push({ pass, started_at: startedAt, ...compactPass(result, perthToday, productionRows) });
  }
  const reproducible =
    passes[0].snapshot === passes[1].snapshot &&
    passes[0].union_sailing_identities === passes[1].union_sailing_identities &&
    passes[0].production_absent_from_union_count === passes[1].production_absent_from_union_count;
  const enumOk = passes.every((p) => p.royal_caribbean_source_enumeration_ok === true);
  const unexplained = passes[1].classification_counts.UNEXPLAINED;
  const classification =
    enumOk && unexplained === 0
      ? "READY_FOR_CONTROLLED_CATCHUP"
      : "SOURCE_REPAIR_REQUIRED";
  const out = {
    generated_at: new Date().toISOString(),
    writes: 0,
    perth_today: perthToday,
    public_booking_cutoff_days: 21,
    reproducible,
    exact_failure_cause: passes[1].enumeration_failures.join(",") || null,
    royal_caribbean_source_enumeration_ok: enumOk,
    classification,
    passes
  };
  const file = path.join(root, "reports/royal-caribbean-p3b-source-health-2026-09-09.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(
    JSON.stringify(
      {
        ok: true,
        file,
        classification,
        enum_ok: enumOk,
        union: passes.map((p) => p.union_sailing_identities),
        missing: passes.map((p) => p.production_absent_from_union_count),
        counts: passes[1].classification_counts
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
