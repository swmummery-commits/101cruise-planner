#!/usr/bin/env node
/**
 * Princess Monday P1C — approved seven-change controlled remediation.
 *
 *   node scripts/run-princess-monday-p1c-seven-change.mjs --write-freeze
 *   PRINCESS_DISCOVERY_WRITE_ENABLED=true node scripts/run-princess-monday-p1c-seven-change.mjs \
 *     --apply --confirm=PRINCESS-MONDAY-P1C-SEVEN-CHANGE-REMEDIATION
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
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

const FREEZE_PATH = path.join(root, "reports/princess-monday-p1c-seven-change-freeze.json");
const REPORT_PATH = path.join(root, "reports/princess-monday-p1c-seven-change-remediation-2026-08-24.json");
const P1B_REPORT_PATH = path.join(root, "reports/princess-weekly-monday-p1b-seven-change-audit-2026-08-24.json");

const { createMaintenanceSupabase, exactCountSupabase } = require(path.join(
  root,
  "scripts/lib/supabase-rest.cjs"
));
const { fetchAllPrincessRawSailings } = require(path.join(
  root,
  "netlify/functions/lib/princess-discovery-source"
));
const {
  simulatePrincessInventory,
  catalogueDestinations,
  officialProductKey
} = require(path.join(root, "netlify/functions/lib/princess-discovery-adapter"));
const {
  computePrincessDisjointSourceAccounting,
  extractPrincessSourceAccounting
} = require(path.join(root, "netlify/functions/lib/princess-weekly-quality"));
const { perthCalendarDate } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));
const { isEligiblePrincessCruise } = require(path.join(
  root,
  "netlify/functions/lib/princess-discovery-adapter"
));
const {
  createMaintenanceRun,
  finalizeMaintenanceRun,
  buildMaintenanceRunStats,
  resolveMaintenanceRunStatus
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-tracking"));
const { PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance"
));
const { runPrincessWeeklyMaintenance, findPrincessAcceptedEligibleBaseline } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-runner"
));
const { evaluatePrincessScheduledApplyReadiness } = require(path.join(
  root,
  "netlify/functions/lib/princess-weekly-readiness"
));
const p1c = require(path.join(root, "netlify/functions/lib/princess-monday-p1c-seven-change"));
const crypto = require("crypto");

function parseArgs(argv) {
  const args = { writeFreeze: false, apply: false, confirm: null, readinessOnly: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--write-freeze") args.writeFreeze = true;
    if (arg === "--apply") args.apply = true;
    if (arg === "--readiness") args.readinessOnly = true;
    if (arg.startsWith("--confirm=")) args.confirm = arg.split("=")[1];
  }
  return args;
}

function eligibleIdentityHash(products) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([...products].sort()))
    .digest("hex");
}

async function runSourceProbe(label, today, line, ships, destinations) {
  const started = Date.now();
  const fetch = await fetchAllPrincessRawSailings({ today, useCache: false, collectDiagnostics: true });
  const sim = fetch.ok
    ? await simulatePrincessInventory({
        cruiseLine: line,
        ships,
        destinations,
        today,
        collectSourceDiagnostics: true
      })
    : null;
  const accounting = sim
    ? computePrincessDisjointSourceAccounting({
        normalised: sim.products || [],
        today,
        isEligibleProductType: isEligiblePrincessCruise
      })
    : null;
  const eligibleKeys = (sim?.products || [])
    .filter((p) => p.complete_high_confidence && isEligiblePrincessCruise(p.product_type))
    .map((p) => officialProductKey(p.raw))
    .filter(Boolean);
  return {
    label,
    elapsed_ms: Date.now() - started,
    ok: fetch.ok === true,
    fetch_failed: fetch.fetch_failed === true,
    bootstrap_status: fetch.source_diagnostics?.bootstrap?.attempts?.[0]?.http_status ?? null,
    catalogue_status: fetch.source_diagnostics?.catalogue?.attempts?.slice(-1)?.[0]?.http_status ?? null,
    transient_retry_needed: Boolean(fetch.source_diagnostics?.catalogue?.transient_retry),
    raw_catalogue_groups: fetch.audit?.source_groups ?? fetch.raw_group_count ?? null,
    expanded_dated_sailings: fetch.audit?.expanded_sailings ?? sim?.raw_sailing_count ?? null,
    within_cutoff_excluded: accounting?.within_public_cutoff ?? null,
    current_public_eligible: accounting?.public_eligible_complete ?? null,
    public_incomplete: accounting?.public_incomplete ?? null,
    other_exclusions: accounting?.other_excluded ?? null,
    accounted_total: accounting?.accounted_total ?? null,
    accounting_delta: accounting?.accounting_delta ?? null,
    accounting_exact: accounting?.accounting_exact ?? null,
    duplicate_identities: sim?.metrics?.duplicate_official_identities ?? 0,
    identity_hash: eligibleIdentityHash(eligibleKeys)
  };
}

async function loadLineContext(sb) {
  const line = (await sb("ci_cruise_lines?slug=eq.princess-cruises&select=id,name,slug&limit=1"))[0];
  const ships = await sb(
    `ci_cruise_ships?cruise_line_id=eq.${line.id}&active=eq.true&select=id,name,official_line_ship_id,cruise_line_id`
  );
  const destRows = await sb(
    "destinations?classification_enabled=eq.true&select=id,name,slug,status,classification_enabled"
  );
  return { line, ships, destinations: catalogueDestinations(destRows || []) };
}

async function exactPrincessActive(rootDir) {
  const { count } = await exactCountSupabase(
    rootDir,
    "discovered_cruises",
    `cruise_line_id=eq.${p1c.PRINCESS_LINE_ID}&status=eq.active`
  );
  return count;
}

function loadFreeze() {
  if (!fs.existsSync(FREEZE_PATH)) throw new Error(`Missing freeze: ${FREEZE_PATH}`);
  const freeze = JSON.parse(fs.readFileSync(FREEZE_PATH, "utf8"));
  const integrity = p1c.verifyFreezeIntegrity(freeze);
  if (!integrity.ok) throw new Error(`Freeze integrity failed: ${integrity.reason}`);
  return freeze;
}

async function main() {
  const args = parseArgs(process.argv);
  const startingSha = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
  const sb = createMaintenanceSupabase(root);
  const today = perthCalendarDate();
  const { line, ships, destinations } = await loadLineContext(sb);

  const source1 = await runSourceProbe("source_run_1", today, line, ships, destinations);
  const source2 = await runSourceProbe("source_run_2", today, line, ships, destinations);
  const sourceReproducible =
    source1.ok && source2.ok && source1.identity_hash === source2.identity_hash;

  if (!source1.ok || !source2.ok || !sourceReproducible) {
    console.error(JSON.stringify({ phase: "source_preflight_failed", source1, source2 }, null, 2));
    process.exit(2);
  }

  const fetch = await fetchAllPrincessRawSailings({ today, useCache: false, collectDiagnostics: false });
  const simulation = await simulatePrincessInventory({
    cruiseLine: line,
    ships,
    destinations,
    today,
    collectSourceDiagnostics: false
  });

  const runId = `princess-monday-p1c-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  let freeze = null;

  if (args.writeFreeze || args.apply) {
    const built = await p1c.buildSevenChangeFreeze({
      sb,
      simulation,
      cruiseLine: line,
      runId,
      today
    });
    if (!built.ok) {
      console.error(JSON.stringify({ phase: "freeze_build_failed", built }, null, 2));
      process.exit(3);
    }
    freeze = {
      ...built,
      repository_sha: startingSha,
      source_run_1: source1,
      source_run_2: source2
    };
    fs.mkdirSync(path.dirname(FREEZE_PATH), { recursive: true });
    fs.writeFileSync(FREEZE_PATH, `${JSON.stringify(freeze, null, 2)}\n`);
  }

  if (args.writeFreeze && !args.apply) {
    console.log(JSON.stringify({ phase: "freeze_written", path: FREEZE_PATH, batch_hash: freeze.batch_hash }, null, 2));
    return;
  }

  if (args.apply) {
    if (args.confirm !== p1c.APPLY_CONFIRMATION_TOKEN) {
      throw new Error(`--apply requires --confirm=${p1c.APPLY_CONFIRMATION_TOKEN}`);
    }
    if (String(process.env.PRINCESS_DISCOVERY_WRITE_ENABLED || "").toLowerCase() !== "true") {
      throw new Error("PRINCESS_DISCOVERY_WRITE_ENABLED=true required");
    }
    freeze = freeze || loadFreeze();
    const collateralBefore = await p1c.snapshotPrincessCollateral(sb);
    const activeBefore = await exactPrincessActive(root);
    const csrBefore = await p1c.verifyCsr07hUnchanged(sb);
    const baselineBefore = await findPrincessAcceptedEligibleBaseline(
      sb,
      line.id,
      PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE
    );

    const dbRun = await createMaintenanceRun(sb, {
      cruiseLineId: line.id,
      runId,
      runType: PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
      triggerType: p1c.WRITE_MODE,
      stats: {
        line_slug: "princess-cruises",
        princess_monday_p1c: true,
        batch_hash: freeze.batch_hash,
        max_material_writes: p1c.MAX_MATERIAL_WRITES
      }
    });

    const applyResult = await p1c.applyP1cSevenChangeBatch({
      sb,
      freeze,
      simulation,
      cruiseLine: line,
      today,
      runId,
      runRecordId: dbRun?.id || null
    });

    const touchedIds = (applyResult.stats?.write_details || [])
      .map((d) => d.discovered_cruise_id)
      .filter(Boolean);
    const collateralAfter = await p1c.snapshotPrincessCollateral(sb);
    const collateral = p1c.verifyCollateralImmutability(collateralBefore, collateralAfter, touchedIds);

    const postRows = await sb(
      `discovered_cruises?id=in.(${touchedIds.join(",")})&select=id,cruise_line_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,itinerary,status,official_url,external_key,identity_key,official_sailing_id,raw_extract,match_confidence`
    );
    const rowsById = new Map((postRows || []).map((r) => [r.id, r]));
    const postWrite = p1c.verifyPostWriteSevenChange({ freeze, rowsById });

    const csrAfter = await p1c.verifyCsr07hUnchanged(sb);
    const activeAfter = await exactPrincessActive(root);
    const baselineAfter = await findPrincessAcceptedEligibleBaseline(
      sb,
      line.id,
      PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE
    );

    const reconciliation = await runPrincessWeeklyMaintenance({
      dryRun: true,
      performWrites: false,
      simulateApplyQualityGates: true,
      writeMode: "weekly_maintenance",
      runId: `${runId}-post-reconciliation`,
      supabase: sb,
      collectSourceDiagnostics: false,
      triggerType: "post_p1c_reconciliation"
    });

    const readiness = await evaluatePrincessScheduledApplyReadiness({
      runPrincessWeeklyMaintenance,
      findPrincessAcceptedEligibleBaseline,
      supabase: sb,
      cruiseLineId: line.id,
      runType: PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
      runId: `${runId}-readiness`
    });

    const stats = applyResult.stats || {};
    const pass =
      applyResult.ok &&
      postWrite.ok &&
      collateral.ok &&
      csrAfter.unchanged &&
      (baselineAfter?.stats?.eligible_total ?? baselineAfter?.eligible_total) ===
        (baselineBefore?.stats?.eligible_total ?? baselineBefore?.eligible_total ?? 2061);

    if (dbRun?.id) {
      await finalizeMaintenanceRun(sb, dbRun.id, {
        status: resolveMaintenanceRunStatus({ ok: pass, summary: reconciliation.summary || {} }),
        stats: buildMaintenanceRunStats(reconciliation.summary || {}, {
          princess_monday_p1c: true,
          batch_hash: freeze.batch_hash,
          rollback_manifest_id: applyResult.rollback_manifest_id || null,
          writes: stats
        }),
        errorMessage: pass ? null : applyResult.reason || "p1c_apply_failed"
      });
    }

    const p1bReport = fs.existsSync(P1B_REPORT_PATH)
      ? JSON.parse(fs.readFileSync(P1B_REPORT_PATH, "utf8"))
      : null;

    const report = {
      generated_at: new Date().toISOString(),
      incident: "princess_monday_p1c_seven_change_remediation",
      repository: {
        starting_sha: startingSha,
        tooling_sha: startingSha,
        ending_sha: execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim(),
        p1b_report_sha: p1bReport?.repository?.ending_sha || null,
        p1b_display_sha_note:
          "Use git rev-parse HEAD for authoritative SHA; P1B completion text may differ from committed JSON."
      },
      source_verification: { source_run_1: source1, source_run_2: source2, reproducible: sourceReproducible },
      seven_change_freeze: { path: FREEZE_PATH, batch_hash: freeze.batch_hash, size: freeze.entries.length },
      approved_update_proofs: freeze.proofs?.updates || [],
      approved_insert_proof: freeze.proofs?.insert || null,
      global_lock: applyResult.global_lock || null,
      write_results: {
        attempted: (stats.inserted || 0) + (stats.updated || 0) + (stats.failed || 0),
        inserted: stats.inserted || 0,
        updated: stats.updated || 0,
        failed: stats.failed || 0,
        deleted: 0,
        deactivated: 0,
        write_details: stats.write_details || []
      },
      rollback_manifest_id: applyResult.rollback_manifest_id || null,
      post_write_verification: postWrite,
      collateral_immutability: collateral,
      csr07h: csrAfter,
      princess_active_before: activeBefore,
      princess_active_after: activeAfter,
      post_write_reconciliation: reconciliation.summary || null,
      accepted_baseline: {
        before: baselineBefore?.stats?.eligible_total ?? 2061,
        after: baselineAfter?.stats?.eligible_total ?? null,
        advanced_by_p1c: false
      },
      scheduled_readiness: readiness,
      production_writes: (stats.inserted || 0) + (stats.updated || 0),
      overall_pass: pass,
      safe_to_rerun_failed_monday_workflow: pass && readiness.safe_to_run_real_apply === true
    };

    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    process.exit(pass ? 0 : 4);
  }

  if (args.readinessOnly) {
    const readiness = await evaluatePrincessScheduledApplyReadiness({
      runPrincessWeeklyMaintenance,
      findPrincessAcceptedEligibleBaseline,
      supabase: sb,
      cruiseLineId: line.id,
      runType: PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
      runId: `${runId}-readiness-only`
    });
    console.log(JSON.stringify(readiness, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
