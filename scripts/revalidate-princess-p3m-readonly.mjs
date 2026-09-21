#!/usr/bin/env node
/**
 * Princess P3M read-only revalidation of the 2026-09-20 false-failure run.
 * Zero discovered_cruises writes. Optional accepted-baseline stats patch only.
 *
 *   node scripts/revalidate-princess-p3m-readonly.mjs
 *   node scripts/revalidate-princess-p3m-readonly.mjs --accept-baseline
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

const { createMaintenanceSupabase, exactCountSupabase } = require(path.join(
  root,
  "scripts/lib/supabase-rest.cjs"
));
const { runPrincessWeeklyMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-runner"
));
const {
  patchMaintenanceRunAcceptedBaseline,
  PRINCESS_POSTHOC_VERIFIED_BASELINE_REASON
} = require(path.join(root, "netlify/functions/lib/princess-accepted-baseline-lifecycle"));
const verification = require(path.join(root, "netlify/functions/lib/princess-post-write-verification"));

const PRINCESS_LINE_ID = "c19f40a7-c160-4035-a845-14dada550e1f";
const RUN_RECORD_ID = "03d66de4-6f93-4eb5-98b0-b3b65d05dee8";
const MANIFEST_ID = "773017ba-a894-410e-82ff-971520c8822c";
const INSERTED_UUID = "ba3373b9-5fb0-4acf-a20d-5a558e8c53cc";
const OFFICIAL_ID = "FFA25B|CB|2028-02-24";
const EXPECTED_ELIGIBLE = 1958;
const EXPECTED_SNAPSHOT = "c14b4a71d6ab513f885c16947c1b1d4eca8fb3897db85b5455fc662197143ddd";
const HAL_RUN_ID = "0084a770-86b9-4eb1-946c-ce4a50736341";
const CELEBRITY_RUN_ID = "63a57e52-c6ad-410b-9153-dc57e861c22f";

const acceptBaseline = process.argv.includes("--accept-baseline");
const skipSource = process.argv.includes("--skip-source");

function fail(message, extra) {
  console.error(JSON.stringify({ ok: false, error: message, extra: extra || null }, null, 2));
  process.exit(1);
}

async function main() {
  const sb = createMaintenanceSupabase(root);

  const rows = await sb(
    `discovered_cruises?id=eq.${INSERTED_UUID}&select=id,status,official_sailing_id,cruise_line_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,official_url,raw_extract`
  );
  const row = rows?.[0] || null;
  const rowVerification = row ? verification.verifyInsertedRows([row]) : { ok: false, issues: [{ issue: "row_missing" }] };

  const duplicates = await sb(
    `discovered_cruises?cruise_line_id=eq.${PRINCESS_LINE_ID}&official_sailing_id=eq.${encodeURIComponent(OFFICIAL_ID)}&select=id,status`
  );
  const duplicateCount = (duplicates || []).length;

  const runRows = await sb(
    `cruise_discovery_runs?id=eq.${RUN_RECORD_ID}&select=id,status,started_at,finished_at,stats,error_message`
  );
  const run = runRows?.[0] || null;

  const manifestRows = await sb(
    `cruise_discovery_maintenance_manifests?id=eq.${MANIFEST_ID}&select=id,manifest_type,run_record_id,manifest`
  );
  const manifestRow = manifestRows?.[0] || null;
  const manifest = manifestRow?.manifest || {};
  const insertedEntry = (manifest.inserted || []).find(
    (entry) =>
      entry.discovered_cruise_id === INSERTED_UUID || entry.official_sailing_id === OFFICIAL_ID
  );

  const { count: activeCount } = await exactCountSupabase(
    root,
    "discovered_cruises",
    `cruise_line_id=eq.${PRINCESS_LINE_ID}&status=eq.active`
  );

  const otherRuns = {};
  for (const [label, id] of [
    ["holland_america", HAL_RUN_ID],
    ["celebrity", CELEBRITY_RUN_ID]
  ]) {
    const found = await sb(
      `cruise_discovery_runs?id=eq.${id}&select=id,status,stats,started_at,finished_at`
    );
    const other = found?.[0] || null;
    otherRuns[label] = other
      ? {
          id: other.id,
          status: other.status,
          terminal_status: other.stats?.terminal_status || null,
          inserts: other.stats?.inserts ?? null,
          updates: other.stats?.updates ?? null,
          quality_gate: other.stats?.quality_gate?.passed ?? other.stats?.quality_gate?.passed
        }
      : null;
  }

  let source = null;
  if (!skipSource) {
    const dry = await runPrincessWeeklyMaintenance({
      dryRun: true,
      performWrites: false,
      maxWrites: 0,
      runId: `princess-p3m-revalidation-${Date.now()}`,
      supabase: sb,
      triggerType: "weekly_post_write_reconciliation",
      writeMode: "production_read_only"
    });
    const summary = dry.summary || {};
    const outstandingIds = (dry.manifest?.products || [])
      .filter((p) => p.proposed_action === "insert_active")
      .map((p) => p.official_princess_sailing_id || p.stable_identity_key);
    const recognised = (dry.manifest?.products || []).find(
      (p) =>
        (p.official_princess_sailing_id || p.stable_identity_key) === OFFICIAL_ID &&
        p.proposed_action === "duplicate_skip"
    );
    source = {
      ok: dry.ok === true,
      quality_gate: summary.quality_gate?.passed === true ? "PASS" : "FAIL",
      eligible_total: summary.eligible_total ?? null,
      snapshot_id: summary.snapshot_id ?? null,
      active_production_total: summary.active_production_total ?? null,
      recognised_existing_eligible: summary.recognised_existing_eligible ?? null,
      outstanding_eligible_inserts: summary.outstanding_eligible_inserts ?? null,
      proposed_updates: summary.proposed_updates ?? null,
      proposed_identity_review_updates: summary.proposed_updates_identity_review ?? 0,
      source_absent_active: summary.source_absent_active ?? null,
      reconciliation_arithmetic_ok: summary.reconciliation_arithmetic_ok === true,
      source_recognises_inserted: Boolean(recognised),
      outstanding_proposal_for_inserted: outstandingIds.includes(OFFICIAL_ID),
      duplicate_official_identities: summary.resolution_rates?.duplicate_official_identities ?? null
    };
  }

  const checks = {
    row_active: row?.status === "active",
    official_identity_correct: row?.official_sailing_id === OFFICIAL_ID,
    row_verification_ok: rowVerification.ok === true,
    duplicate_count: duplicateCount,
    no_duplicate_identity: duplicateCount === 1,
    rollback_manifest_exists: Boolean(manifestRow),
    rollback_contains_insert: Boolean(insertedEntry),
    run_exists: Boolean(run),
    source_recognises_inserted: source ? source.source_recognises_inserted === true : null,
    no_outstanding_proposal: source ? source.outstanding_proposal_for_inserted === false : null,
    source_quality_pass: source ? source.quality_gate === "PASS" : null
  };

  const allPass =
    checks.row_active &&
    checks.official_identity_correct &&
    checks.row_verification_ok &&
    checks.no_duplicate_identity &&
    checks.rollback_manifest_exists &&
    checks.rollback_contains_insert &&
    checks.run_exists &&
    (skipSource || (checks.source_recognises_inserted && checks.no_outstanding_proposal && checks.source_quality_pass));

  const acceptedEligible = source?.eligible_total ?? EXPECTED_ELIGIBLE;
  const acceptedHash = source?.snapshot_id ?? EXPECTED_SNAPSHOT;
  const usedHistoricalSnapshot =
    acceptedEligible === EXPECTED_ELIGIBLE && acceptedHash === EXPECTED_SNAPSHOT;

  let baselinePatch = null;
  if (acceptBaseline) {
    if (!allPass) fail("refusing to accept baseline; revalidation failed", { checks, source });
    baselinePatch = await patchMaintenanceRunAcceptedBaseline(sb, RUN_RECORD_ID, {
      eligible_total: acceptedEligible,
      snapshot_id: acceptedHash
    }, {
      acceptedAt: new Date().toISOString(),
      reason: PRINCESS_POSTHOC_VERIFIED_BASELINE_REASON
    });
  }

  const payload = {
    ok: allPass,
    discovered_cruises_writes: 0,
    accept_baseline: acceptBaseline,
    checks,
    row: row
      ? {
          id: row.id,
          status: row.status,
          official_sailing_id: row.official_sailing_id,
          departure_date: row.departure_date,
          return_date: row.return_date,
          nights: row.nights,
          departure_port: row.departure_port
        }
      : null,
    row_verification: rowVerification,
    run: run
      ? {
          id: run.id,
          status: run.status,
          trigger_type: run.trigger_type || run.stats?.trigger_type,
          started_at: run.started_at,
          finished_at: run.finished_at,
          terminal_status: run.stats?.terminal_status,
          inserts: run.stats?.inserts,
          updates: run.stats?.updates,
          failed_writes: run.stats?.failed_writes,
          eligible_total: run.stats?.eligible_total,
          snapshot_id: run.stats?.source_snapshot_id || run.stats?.snapshot_id,
          accepted_inventory_baseline: run.stats?.accepted_inventory_baseline === true
        }
      : null,
    manifest: manifestRow
      ? {
          id: manifestRow.id,
          manifest_type: manifestRow.manifest_type,
          run_record_id: manifestRow.run_record_id,
          inserted_count: (manifest.inserted || []).length,
          inserted_record_ids: manifest.inserted_record_ids || [],
          official_sailing_ids: manifest.official_sailing_ids || []
        }
      : null,
    current_active_production: activeCount,
    source,
    other_monday_lines: otherRuns,
    accepted_baseline: acceptBaseline
      ? {
          run_record_id: RUN_RECORD_ID,
          accepted: Boolean(baselinePatch),
          accepted_eligible_total: acceptedEligible,
          accepted_eligible_hash: acceptedHash,
          used_historical_w39_snapshot: usedHistoricalSnapshot,
          reason: PRINCESS_POSTHOC_VERIFIED_BASELINE_REASON,
          original_status_unchanged: true,
          original_timestamps_unchanged: true
        }
      : {
          eligible_total: acceptedEligible,
          snapshot_id: acceptedHash,
          used_historical_w39_snapshot: usedHistoricalSnapshot
        }
  };

  console.log(JSON.stringify(payload, null, 2));
  if (!allPass) process.exit(1);
  process.exit(0);
}

main().catch((error) => {
  fail(error.message || String(error));
});
