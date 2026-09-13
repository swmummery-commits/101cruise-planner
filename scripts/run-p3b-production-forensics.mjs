#!/usr/bin/env node
/**
 * P3B production-only forensics (no source fetch, no discovered_cruises writes).
 *
 *   node scripts/run-p3b-production-forensics.mjs
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

const { createMaintenanceSupabase, fetchAllPaginated, getSupabaseConfig } = require(
  path.join(root, "scripts/lib/supabase-rest.cjs")
);
const { PUBLIC_BOOKING_CUTOFF_DAYS } = require(
  path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory")
);
const { strictVoyageFingerprint } = require(
  path.join(root, "netlify/functions/lib/princess-voyage-identity-classifier")
);
const { voyageEquivalenceKey: nclVoyageKey } = require(
  path.join(root, "netlify/functions/lib/norwegian-voyage-identity-classifier")
);

const PRINCESS_SLUG = "princess-cruises";
const NCL_SLUG = "norwegian-cruise-line";
const SEABOURN_SLUG = "seabourn-cruise-line";

function voyageFingerprint(row) {
  return [
    String(row.ship_id || "").trim(),
    String(row.departure_date || "").slice(0, 10),
    String(row.return_date || "").slice(0, 10),
    String(row.nights ?? ""),
    String(row.departure_port || "").trim()
  ].join("|");
}

function canonicalChoice(rows) {
  const active = rows.filter((r) => r.status === "active");
  const pool = active.length ? active : rows;
  const withOfficial = pool.filter((r) => r.official_sailing_id);
  const ranked = (withOfficial.length ? withOfficial : pool).slice().sort((a, b) => {
    const aTime = Date.parse(a.created_at || a.updated_at || 0);
    const bTime = Date.parse(b.created_at || b.updated_at || 0);
    return aTime - bTime;
  });
  const canonical = ranked[0] || rows[0];
  return {
    canonical_uuid: canonical?.id || null,
    reason: active.length
      ? "earliest_created_active_row_with_official_id_preferred"
      : "no_active_row_earliest_created_preferred",
    same_actual_voyage:
      new Set(rows.map(voyageFingerprint)).size === 1 &&
      rows.every((r) => String(r.nights ?? "") === String(rows[0].nights ?? ""))
  };
}

async function loadLine(sb, slug) {
  const line = (await sb(`ci_cruise_lines?slug=eq.${encodeURIComponent(slug)}&select=id,name,slug&limit=1`))?.[0];
  if (!line) throw new Error(`line not found: ${slug}`);
  return line;
}

async function loadCruises(rootDir, lineId) {
  return fetchAllPaginated(
    rootDir,
    `discovered_cruises?cruise_line_id=eq.${lineId}&select=id,status,official_sailing_id,external_key,identity_key,ship_id,destination_id,departure_date,return_date,nights,departure_port,created_at,updated_at,source_url,official_url,raw_extract&order=id.asc`
  );
}

function groupDuplicates(rows, keyFn) {
  const unique = [];
  const seen = new Set();
  for (const row of rows || []) {
    if (!row?.id || seen.has(row.id)) continue;
    seen.add(row.id);
    unique.push(row);
  }
  const groups = new Map();
  for (const row of unique) {
    const key = keyFn(row);
    if (!key || key.split("|").some((part) => part === "")) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()]
    .filter(([, members]) => new Set(members.map((row) => row.id)).size > 1)
    .map(([fingerprint, members]) => {
      const choice = canonicalChoice(members);
      return {
        fingerprint,
        production_record_count: members.length,
        same_actual_voyage: choice.same_actual_voyage,
        canonical_uuid: choice.canonical_uuid,
        canonical_reason: choice.reason,
        remap_blocked: true,
        remap_block_reason: "multiple_production_uuids_for_same_voyage_fingerprint",
        records: members.map((row) => ({
          uuid: row.id,
          status: row.status,
          official_sailing_id: row.official_sailing_id,
          external_key: row.external_key,
          identity_key: row.identity_key,
          discovered_at: row.created_at,
          updated_at: row.updated_at,
          destination_id: row.destination_id,
          source_url: row.source_url,
          official_url: row.official_url,
          source_provenance:
            row.raw_extract?.source ||
            row.raw_extract?.provenance ||
            row.raw_extract?.adapter_id ||
            row.raw_extract?.princess_p1_official_id_remap ||
            null
        }))
      };
    });
}

async function latestRuns(sb, lineId, limit = 8) {
  return (
    (await sb(
      `cruise_discovery_runs?cruise_line_id=eq.${encodeURIComponent(
        lineId
      )}&scope=eq.cruise_line&select=id,status,stats,started_at,finished_at,error_message&order=started_at.desc&limit=${limit}`
    )) || []
  );
}

async function dailyExpiryRuns(sb) {
  const rows =
    (await sb(
      `cruise_discovery_runs?scope=eq.full&select=id,status,stats,started_at,finished_at,error_message&order=started_at.desc&limit=40`
    )) || [];
  return rows.filter((row) => row.stats?.run_type === "daily_expiry_maintenance");
}

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const princessLine = await loadLine(sb, PRINCESS_SLUG);
  const nclLine = await loadLine(sb, NCL_SLUG);
  const seabournLine = await loadLine(sb, SEABOURN_SLUG);

  const [princessRows, nclRows, seabournRows] = await Promise.all([
    loadCruises(root, princessLine.id),
    loadCruises(root, nclLine.id),
    loadCruises(root, seabournLine.id)
  ]);

  const princessGroups = groupDuplicates(princessRows, (row) => strictVoyageFingerprint(row) || voyageFingerprint(row));
  const nclGroups = groupDuplicates(nclRows, nclVoyageKey);

  const princessForensic = {
    generated_at: new Date().toISOString(),
    line: "princess-cruises",
    production_rows: princessRows.length,
    status_counts: princessRows.reduce((acc, row) => {
      acc[row.status] = (acc[row.status] || 0) + 1;
      return acc;
    }, {}),
    duplicate_voyage_group_count: princessGroups.length,
    deletion_performed: false,
    merging_performed: false,
    groups: princessGroups
  };
  const princessPath = path.join(root, "reports/princess-p3b-duplicate-voyage-forensic.json");
  fs.mkdirSync(path.dirname(princessPath), { recursive: true });
  fs.writeFileSync(princessPath, JSON.stringify(princessForensic, null, 2));

  const insertCandidate = seabournRows.filter(
    (row) =>
      row.official_sailing_id === "W9W46A|6910D" ||
      String(row.official_sailing_id || "").includes("6910") ||
      String(row.identity_key || "").includes("W9W46A")
  );
  const reviewLike = seabournRows.filter((row) => row.status === "identity_review" || row.status === "match_required");

  const healthySlugs = [
    "holland-america-line",
    "celebrity-cruises",
    "explora-journeys",
    "azamara"
  ];
  const healthy = {};
  for (const slug of healthySlugs) {
    const line = await loadLine(sb, slug);
    const rows = await loadCruises(root, line.id);
    const runs = await latestRuns(sb, line.id, 3);
    healthy[slug] = {
      production_rows: rows.length,
      status_counts: rows.reduce((acc, row) => {
        acc[row.status] = (acc[row.status] || 0) + 1;
        return acc;
      }, {}),
      latest_runs: runs.map((run) => ({
        id: run.id,
        status: run.status,
        started_at: run.started_at,
        finished_at: run.finished_at,
        dry_run: run.stats?.dry_run ?? null,
        quality_gate: run.stats?.quality_gate?.passed ?? run.stats?.quality_gate,
        eligible_total: run.stats?.eligible_total ?? null,
        proposed_inserts: run.stats?.proposed_inserts ?? null,
        proposed_updates: run.stats?.proposed_updates ?? null,
        writes: (run.stats?.inserts || 0) + (run.stats?.updates || 0),
        reason: run.stats?.failure_reason || run.error_message || null
      }))
    };
  }

  const expiry = await dailyExpiryRuns(sb);
  const byPerthDate = {};
  for (const run of expiry) {
    const perth = run.stats?.perth_date || String(run.started_at || "").slice(0, 10);
    if (!byPerthDate[perth]) byPerthDate[perth] = [];
    byPerthDate[perth].push({
      id: run.id,
      status: run.status,
      started_at: run.started_at,
      finished_at: run.finished_at,
      already_dispatched: run.stats?.already_dispatched === true
    });
  }

  const snapshot = {
    generated_at: new Date().toISOString(),
    public_booking_cutoff_days: PUBLIC_BOOKING_CUTOFF_DAYS,
    princess: {
      production_rows: princessRows.length,
      duplicate_voyage_groups: princessGroups.length,
      forensic: "reports/princess-p3b-duplicate-voyage-forensic.json"
    },
    norwegian: {
      production_rows: nclRows.length,
      status_counts: nclRows.reduce((acc, row) => {
        acc[row.status] = (acc[row.status] || 0) + 1;
        return acc;
      }, {}),
      duplicate_voyage_groups: nclGroups.length,
      match_required: nclRows.filter((row) => row.status === "match_required").length
    },
    seabourn: {
      production_rows: seabournRows.length,
      w9w46a_or_6910_rows: insertCandidate.map((row) => ({
        uuid: row.id,
        status: row.status,
        official_sailing_id: row.official_sailing_id,
        identity_key: row.identity_key,
        ship_id: row.ship_id,
        departure_date: row.departure_date,
        return_date: row.return_date,
        nights: row.nights,
        departure_port: row.departure_port
      })),
      identity_review_or_match_required: reviewLike.map((row) => ({
        uuid: row.id,
        status: row.status,
        official_sailing_id: row.official_sailing_id,
        identity_key: row.identity_key
      }))
    },
    healthy,
    daily_expiry: {
      latest: expiry[0] || null,
      execution_records_returned: expiry.length,
      by_perth_date: byPerthDate
    }
  };
  const snapshotPath = path.join(root, "reports/p3b-production-inventory-snapshot-2026-09-09.json");
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
  console.log(
    JSON.stringify(
      {
        ok: true,
        princess_duplicate_groups: princessGroups.length,
        ncl_duplicate_groups: nclGroups.length,
        princess_forensic: princessPath,
        snapshot: snapshotPath,
        cutoff_days: PUBLIC_BOOKING_CUTOFF_DAYS
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
