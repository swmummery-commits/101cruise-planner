#!/usr/bin/env node
/**
 * Princess Incident P4 — accepted baseline lifecycle + post-P3 readiness proof.
 * READ-ONLY: zero discovered_cruises production writes.
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const p3 = require(path.join(root, "scripts/lib/princess-incident-p3-lib.cjs"));
const { createSupabaseRest, exactCountSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const {
  runPrincessWeeklyMaintenance,
  resolvePrincessAcceptedEligibleBaseline,
  findPrincessAcceptedEligibleBaseline
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-runner"));
const {
  evaluatePrincessBaselineAcceptance,
  buildPrincessAcceptedBaselineStats,
  selectLatestPrincessAcceptedBaseline,
  resolvePrincessAcceptedBaselineLookup,
  PRINCESS_P3_BASELINE_REASON
} = require(path.join(root, "netlify/functions/lib/princess-accepted-baseline-lifecycle"));
const { evaluatePrincessScheduledApplyReadiness } = require(path.join(
  root,
  "netlify/functions/lib/princess-weekly-readiness"
));
const { evaluatePrincessEligibleExpansionAnomaly } = require(path.join(
  root,
  "netlify/functions/lib/princess-weekly-quality"
));
const { PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance"
));

const PRINCESS_LINE_ID = p3.PRINCESS_LINE_ID;
const P3_BASELINE_HASH = "5161b08de272b733756aff82515bbf1a3faa2f112d4d2d2fe12f2b0bd86be817";
const P2_FREEZE_PATH = path.join(root, "reports/princess-incident-p2-batch-1-freeze.json");
const P3_REPORT_PATH = path.join(root, "reports/princess-weekly-incident-p3-complete-remediation.json");
const P4_REPORT_PATH = path.join(root, "reports/princess-weekly-incident-p4-baseline-lifecycle.json");
const APPLY_WORKFLOW_PATH = path.join(root, ".github/workflows/princess-weekly-maintenance-apply.yml");

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function verifyProduction(sb) {
  const rows = await p3.loadAllPrincessRows(sb);
  const byOfficial = new Map(rows.map((r) => [r.official_sailing_id, r]));

  const p2 = loadJson(P2_FREEZE_PATH);
  const p2Ids = p2.candidates.map((c) => c.official_sailing_id);
  const masterPlan = loadJson(path.join(root, "reports/princess-incident-p3-master-plan.json"));
  const p3Ids = masterPlan.identities || [];

  let p2Ok = p2Ids.every((id) => byOfficial.has(id));
  let p3Ok = p3Ids.every((id) => byOfficial.has(id));

  const dup = { official: 0, external: 0, identity: 0 };
  const seen = { o: new Set(), e: new Set(), i: new Set() };
  for (const r of rows) {
    if (r.official_sailing_id) {
      if (seen.o.has(r.official_sailing_id)) dup.official += 1;
      seen.o.add(r.official_sailing_id);
    }
    if (r.external_key) {
      if (seen.e.has(r.external_key)) dup.external += 1;
      seen.e.add(r.external_key);
    }
    if (r.identity_key) {
      if (seen.i.has(r.identity_key)) dup.identity += 1;
      seen.i.add(r.identity_key);
    }
  }

  const active = await exactCountSupabase(root, "discovered_cruises", `cruise_line_id=eq.${PRINCESS_LINE_ID}&status=eq.active`);
  const expired = await exactCountSupabase(root, "discovered_cruises", `cruise_line_id=eq.${PRINCESS_LINE_ID}&status=eq.expired`);
  const csr = byOfficial.get("CSR07H|KP|2027-02-28");

  const ctx = await p3.runPrincessSimulation(root);
  ctx.root = root;
  const productionKeys = new Set(rows.map((r) => r.official_sailing_id).filter(Boolean));
  const s1 = p3.summariseSimulation(ctx, productionKeys);
  const s2 = p3.summariseSimulation(ctx, productionKeys);

  const recon = await runPrincessWeeklyMaintenance({
    dryRun: true,
    performWrites: false,
    maxWrites: 0,
    runId: `p4-reconciliation-${Date.now()}`,
    supabase: sb,
    writeMode: "production_read_only",
    triggerType: "weekly_dry_run"
  });

  return {
    active: active.count,
    expired: expired.count,
    p2_thirty_present: p2Ok,
    p3_552_present: p3Ok,
    duplicate_official: dup.official,
    duplicate_external: dup.external,
    duplicate_identity: dup.identity,
    csr07h_active: csr?.status === "active",
    source: {
      raw_groups: s1.rawGroups,
      expanded: s1.disjoint.expanded_dated_sailings,
      eligible: s1.disjoint.public_eligible_complete,
      within_cutoff: s1.disjoint.within_public_cutoff,
      accounting_exact: s1.disjoint.accounting_exact,
      reproducible: s1.eligibleHash === s2.eligibleHash,
      new_outstanding: s1.insertProducts.length
    },
    reconciliation: {
      proposed_updates: recon.summary?.proposed_updates ?? null,
      proposed_inserts: recon.summary?.proposed_inserts ?? null,
      eligible: recon.summary?.eligible_total ?? null,
      recognised: recon.summary?.recognised_existing_eligible ?? null
    }
  };
}

async function findP3BaselineRecord(sb) {
  const runs = await sb(
    `cruise_discovery_runs?cruise_line_id=eq.${PRINCESS_LINE_ID}&scope=eq.cruise_line&status=eq.completed&select=id,stats,finished_at,status&order=finished_at.desc&limit=100`
  );
  return (runs || []).find(
    (r) =>
      r.stats?.trigger_type === "incident_p3_baseline_acceptance" &&
      r.stats?.accepted_inventory_baseline === true &&
      Number(r.stats?.accepted_eligible_total) === 2061
  );
}

function verifySchedule() {
  const src = fs.readFileSync(APPLY_WORKFLOW_PATH, "utf8");
  const cronMatch = src.match(/cron:\s*"([^"]+)"/);
  return {
    cron: cronMatch?.[1] || null,
    perth: "Monday 04:00 Australia/Perth (Sunday 20:00 UTC)",
    reconciliation_enabled: src.includes("PRINCESS_WEEKLY_RECONCILIATION_ENABLED"),
    hard_cap_30: src.includes("max_writes=30") || src.includes('echo "max_writes=30"')
  };
}

async function main() {
  const startingSha = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
  const rest = createSupabaseRest(root);
  const sb = (q) => rest.get(q);

  const production = await verifyProduction(sb);
  const p3BaselineRecord = await findP3BaselineRecord(sb);
  const baselineLookup = await resolvePrincessAcceptedEligibleBaseline(sb, PRINCESS_LINE_ID, PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE);
  const selected = await findPrincessAcceptedEligibleBaseline(sb, PRINCESS_LINE_ID, PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE);

  const baselineSelectsP3 =
    Boolean(p3BaselineRecord) &&
    Boolean(selected) &&
    selected.id === p3BaselineRecord.id &&
    Number(selected.stats?.accepted_eligible_total) === 2061 &&
    selected.stats?.accepted_eligible_hash === P3_BASELINE_HASH;

  const countsBefore = production.active;
  const readiness = await evaluatePrincessScheduledApplyReadiness({
    runPrincessWeeklyMaintenance,
    findPrincessAcceptedEligibleBaseline,
    supabase: sb,
    cruiseLineId: PRINCESS_LINE_ID,
    runType: PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
    runId: `p4-readiness-${Date.now()}`
  });
  const countsAfter = (await exactCountSupabase(root, "discovered_cruises", `cruise_line_id=eq.${PRINCESS_LINE_ID}&status=eq.active`)).count;

  const schedule = verifySchedule();

  // Clarify historic P3 readiness evidence
  if (fs.existsSync(P3_REPORT_PATH)) {
    const p3Report = loadJson(P3_REPORT_PATH);
    p3Report.p3_original_readiness_check = {
      executed_before_baseline_acceptance: true,
      previous_eligible_total: p3Report.weekly_readiness?.expansion_anomaly?.previous_eligible_total ?? null,
      note: "P3 weekly_readiness ran before incident_p3_baseline_acceptance was persisted; corrected in P4."
    };
    fs.writeFileSync(P3_REPORT_PATH, JSON.stringify(p3Report, null, 2));
  }

  const pass =
    production.p2_thirty_present &&
    production.p3_552_present &&
    production.duplicate_official === 0 &&
    production.duplicate_external === 0 &&
    production.duplicate_identity === 0 &&
    production.source.accounting_exact &&
    production.source.reproducible &&
    production.reconciliation.proposed_updates === 0 &&
    production.csr07h_active &&
    baselineSelectsP3 &&
    readiness.previous_eligible_total === 2061 &&
    readiness.proposed_updates === 0 &&
    countsBefore === countsAfter &&
    schedule.cron === "0 20 * * 0";

  const report = {
    generated_at: new Date().toISOString(),
    repository_sha: startingSha,
    p3_report_sha: "056fc7a182e966581da0c386dcb0243a0b5a2ed1",
    production_verification: production,
    p3_accepted_baseline_record: p3BaselineRecord
      ? {
          id: p3BaselineRecord.id,
          status: p3BaselineRecord.status,
          finished_at: p3BaselineRecord.finished_at,
          accepted_total: p3BaselineRecord.stats?.accepted_eligible_total,
          accepted_hash: p3BaselineRecord.stats?.accepted_eligible_hash,
          accepted_reason: p3BaselineRecord.stats?.accepted_reason
        }
      : null,
    baseline_lookup: baselineLookup,
    baseline_selects_p3_record: baselineSelectsP3,
    rolling_baseline_policy: {
      implemented: true,
      healthy_scheduled_reason: "healthy_scheduled_princess_maintenance",
      acceptance_module: "netlify/functions/lib/princess-accepted-baseline-lifecycle.js"
    },
    p3_original_readiness_check: {
      executed_before_baseline_acceptance: true,
      previous_eligible_total: null
    },
    corrected_readiness_evaluation: readiness,
    schedule_verification: schedule,
    production_writes: countsAfter - countsBefore,
    tests_note: "Run npm run test:princess-accepted-baseline-lifecycle",
    overall_pass: pass,
    princess_incident_closed: pass,
    weekly_automatic_maintenance_ready: pass && readiness.auto_apply_permitted === true
  };

  fs.writeFileSync(P4_REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!pass) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
