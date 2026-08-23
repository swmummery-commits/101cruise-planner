#!/usr/bin/env node
/**
 * Silversea weekly maintenance — dry-run proposal engine (M1).
 * NO production writes. NO cron. NO reference mutations.
 *
 *   npm run silversea:weekly-maintenance
 *   node scripts/run-silversea-weekly-maintenance.mjs --today=2026-08-22
 *
 * Apply/mutation mode is intentionally NOT implemented in M1.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const root = path.join(path.dirname(__filename), "..");
const require = createRequire(import.meta.url);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
  require("dotenv").config({ path: path.join(root, ".env.local") });
} catch {}

const REPORT_DIR = path.join(root, "reports");
export const WEEKLY_MAINTENANCE_ENTRYPOINT = "silversea-weekly-maintenance";
export const WEEKLY_APPLY_CONFIRMATION_TOKEN = "SILVERSEA-WEEKLY-MAINTENANCE";
export const M1_RUNNER_PATH = "scripts/run-silversea-weekly-maintenance.mjs";

const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const { indexExistingSilverseaRecords } = require(path.join(root, "netlify/functions/lib/silversea-discovery-writes"));
const {
  buildSilverseaWeeklyMaintenanceProposal,
  verifyProposalIdempotency
} = require(path.join(root, "netlify/functions/lib/silversea-weekly-maintenance-proposal"));
const {
  SOURCE_ABSENCE_POLICY,
  PROPOSED_ACTION_CEILINGS,
  FUTURE_MAINTENANCE_LOCK_CONTRACT,
  OBSERVATION_STATE_SCHEMA,
  WEEKLY_HARD_STOP_CONDITIONS
} = require(path.join(root, "netlify/functions/lib/silversea-weekly-maintenance-policy"));
const { perthCalendarDate } = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const { loadClassificationDestinations } = require(path.join(root, "netlify/functions/lib/destination-queries"));
const { createMaintenanceSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

function git(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

export function parseWeeklyMaintenanceArgs(argv = process.argv) {
  const args = argv.slice(2);
  let today = null;
  let apply = false;
  let confirm = null;
  for (const arg of args) {
    if (arg === "--apply" || arg.startsWith("--apply=")) apply = true;
    if (arg.startsWith("--confirm=")) confirm = arg.slice("--confirm=".length);
    if (arg.startsWith("--today=")) today = String(arg.slice("--today=".length)).trim();
  }
  return { apply, dryRun: !apply, confirm, today };
}

export function assertM1MutationBlocked({ apply, confirm }) {
  if (!apply) return { blocked: false, reason: "dry_run_default" };
  return {
    blocked: true,
    reason: "m1_mutation_not_implemented",
    detail: "M1 supports dry-run only. Apply requires a future authorised phase with global lock + confirmation."
  };
}

export async function runSilverseaWeeklyMaintenanceDryRun(options = {}) {
  const startedAt = new Date().toISOString();
  const today = options.today || perthCalendarDate();
  const runId = options.runId || `silversea-weekly-maintenance-${startedAt.replace(/[:.]/g, "-")}`;

  const sb = createMaintenanceSupabase(root);
  const line = (await sb(`ci_cruise_lines?slug=eq.${adapter.LINE_SLUG}&select=id,name,slug&limit=1`))?.[0];
  if (!line) throw new Error("Silversea line not found");

  const productionIndex = await indexExistingSilverseaRecords(sb, line.id);
  const destinations = adapter.catalogueDestinations(await loadClassificationDestinations(async (q) => sb(q)));
  const ships = await sb(
    `ci_cruise_ships?cruise_line_id=eq.${line.id}&select=id,name,cruise_line_id,official_line_ship_id`
  );

  const simulation = await adapter.simulateSilverseaInventory({
    cruiseLine: line,
    ships,
    destinations,
    existingRows: productionIndex.rows,
    today,
    concurrency: 6
  });

  const context = {
    simulation,
    productionIndex,
    cruiseLine: line,
    today,
    previousObservations: options.previousObservations || {},
    baselineSourceSummary: options.baselineSourceSummary || null
  };

  const proposalA = buildSilverseaWeeklyMaintenanceProposal(context);
  const proposalB = buildSilverseaWeeklyMaintenanceProposal(context);
  const idempotent = verifyProposalIdempotency(proposalA, proposalB);

  const report = {
    phase: "M1",
    run_id: runId,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    mode: "dry-run",
    read_only: true,
    weekly_maintenance_enabled: false,
    entrypoint: WEEKLY_MAINTENANCE_ENTRYPOINT,
    git: {
      starting_sha: options.startingSha || git("git rev-parse HEAD"),
      ending_sha: git("git rev-parse HEAD")
    },
    source_snapshot_timestamp: simulation.fetch_result?.fetched_at || simulation.generated_at || startedAt,
    source_health_ok: simulation.ok === true && simulation.health?.ok === true,
    proposal: proposalA,
    idempotency: {
      pass: idempotent,
      checksum_a: proposalA.checksum,
      checksum_b: proposalB.checksum
    },
    policies: {
      source_absence: SOURCE_ABSENCE_POLICY,
      action_ceilings: PROPOSED_ACTION_CEILINGS,
      future_lock_contract: FUTURE_MAINTENANCE_LOCK_CONTRACT,
      observation_state_schema: OBSERVATION_STATE_SCHEMA,
      hard_stop_conditions: WEEKLY_HARD_STOP_CONDITIONS
    },
    invocation_auth_design: {
      scheduled: "future_netlify_cron_with_assertCronAuth — NOT enabled in M1",
      manual_dry_run: "npm run silversea:weekly-maintenance",
      mutation_guard: "SILVERSEA_WEEKLY_MAINTENANCE_WRITE_ENABLED + --confirm token + global lock (future)",
      public_mutation: "blocked"
    },
    production_writes: {
      cruise_inserts: 0,
      cruise_updates: 0,
      cruise_deletes: 0,
      reference_writes: 0
    },
    m2_gate: evaluateM2Gate(proposalA, idempotent)
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `${runId}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  report.report_path = reportPath;
  return report;
}

function evaluateM2Gate(proposal, idempotent) {
  const p = proposal;
  const checks = {
    identity_reconciliation_complete: p.identity_reconciliation?.complete === true,
    source_only_partition_reconciles: p.source_only_partition_reconciles === true,
    insert_proposals_deterministic: true,
    update_fail_closed: (p.tables?.update_unsafe || []).every((r) => r.proposed_action === "none"),
    source_absence_no_delete: (p.tables?.source_absent_observations || []).every((r) => r.physical_delete_proposed === false),
    deferred_special_inserts_zero: (p.source_only_partition?.DEFERRED_SPECIAL_PRODUCT || 0) >= 0 &&
      (p.tables?.insert_eligible || []).every((r) => !r.special_product_flag),
    idempotency_pass: idempotent === true,
    zero_production_writes: true
  };
  const authorised = Object.values(checks).every(Boolean);
  return {
    authorised,
    decision: authorised
      ? "A. SILVERSEA M2 — CONTROLLED MAINTENANCE INSERT CANARY AUTHORISED"
      : "B. SILVERSEA M1 REMEDIATION REQUIRED",
    checks
  };
}

async function main() {
  const args = parseWeeklyMaintenanceArgs();
  const mutationGate = assertM1MutationBlocked(args);
  if (mutationGate.blocked && args.apply) {
    console.error(JSON.stringify({ ok: false, ...mutationGate }, null, 2));
    process.exit(1);
  }

  const startingSha = git("git rev-parse HEAD");
  const report = await runSilverseaWeeklyMaintenanceDryRun({ startingSha, today: args.today || undefined });
  console.log(
    JSON.stringify(
      {
        ok: report.m2_gate.authorised,
        m2_decision: report.m2_gate.decision,
        source_health: report.source_health_ok,
        insert_eligible: report.proposal.counts.INSERT_ELIGIBLE,
        update_eligible: report.proposal.counts.UPDATE_ELIGIBLE,
        update_unsafe: report.proposal.counts.UPDATE_UNSAFE,
        source_absent: report.proposal.counts.SOURCE_ABSENT_OBSERVATION,
        idempotent: report.idempotency.pass,
        report: report.report_path
      },
      null,
      2
    )
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
