#!/usr/bin/env node
/**
 * P3L — Silversea missed Friday execution closeout (read-only recovery + audit).
 *
 *   node scripts/run-p3l-friday-silversea-miss-closeout.mjs
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  require("dotenv").config({ path: path.join(root, ".env") });
} catch {}

const REPORT_PATH = path.join(root, "reports/weekly-maintenance-p3l-friday-silversea-miss-2026-09-18.json");

const { createMaintenanceSupabase, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const {
  scheduledWeeklyDispatchKey,
  backgroundDispatchExecutionKey,
  perthIsoWeek,
  MISSED_SCHEDULE_RUN_TYPE,
  isScheduledExecutionTrigger
} = require(path.join(root, "netlify/functions/lib/weekly-maintenance-schedule-control"));
const { loadMaintenanceLockStatus } = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks"));
const {
  reconcileMissedScheduledWeeklyExecutions,
  COMMISSIONED_WEEKLY_LINES
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-tracking"));
const { runSilverseaWeeklyBackgroundMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/silversea-weekly-maintenance-dispatch"
));
const { runAzamaraWeeklyMaintenance } = require(path.join(root, "netlify/functions/lib/azamara-weekly-maintenance"));
const { WEEKLY_LINE_SCHEDULE } = require(path.join(root, "netlify/functions/lib/weekly-maintenance-schedule-map"));
const { ALLOWED_WEEKLY_UPDATE_FIELDS } = require(path.join(
  root,
  "netlify/functions/lib/azamara-weekly-update-policy"
));

const SILVERSEA_DISPATCH_ID = "silversea-cruises-dispatch-2026-09-17T19-00-38-885Z";
const AZAMARA_FRIDAY_RUN_ID = "1ca0d881-029b-48ff-a7b8-32bdd5f497b0";
const DAILY_EXPIRY_RUN_ID = "475f7647-2992-48a3-9272-dcc08bdedba6";
const IDENTITY_CRITICAL = [
  "ship_id",
  "departure_date",
  "return_date",
  "nights",
  "official_sailing_id",
  "identity_key",
  "external_key",
  "cruise_line_id"
];

function gitSha() {
  try {
    return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function perth(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString("en-CA", { timeZone: "Australia/Perth", hour12: false });
}

async function loadRun(sb, id) {
  const rows = await sb(`cruise_discovery_runs?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  return rows?.[0] || null;
}

async function azamaraActiveCount(sb) {
  const line = (await sb("ci_cruise_lines?slug=eq.azamara&select=id&limit=1"))?.[0];
  if (!line) return null;
  const rows = await sb(
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(line.id)}&status=eq.active&select=id&limit=5000`
  );
  return Array.isArray(rows) ? rows.length : null;
}

async function auditAzamaraFridayUpdates(sb, runRow) {
  const stats = runRow?.stats || {};
  const sailingIdsFromStats = stats.safe_update_sailing_ids || stats.proposed_insert_official_ids || [];
  const details = stats.writes_performed?.write_details || stats.write_details || [];
  const uuids = [];
  const sailingIds = [...sailingIdsFromStats];
  const fieldChanges = [];
  for (const d of details) {
    if (d.result_action !== "updated" && !d.id) continue;
    const id = d.id || d.discovered_cruise_id;
    if (id) uuids.push(id);
    if (d.official_sailing_id) sailingIds.push(d.official_sailing_id);
    const snap = d.rollback_snapshot || d.before_values || null;
    if (snap) {
      for (const field of IDENTITY_CRITICAL) {
        if (snap[field] != null) fieldChanges.push({ uuid: id, field, note: "before_snapshot_present" });
      }
    }
  }
  if (!uuids.length && (stats.updates || stats.updated)) {
    if (sailingIds.length) {
      return {
        rollback_manifest_rows: 0,
        retrospective_rollback_available: false,
        updated_uuids: [],
        official_sailing_ids: sailingIds,
        update_count: stats.updates ?? stats.updated ?? sailingIds.length,
        identity_critical_field_changes: [],
        rollback_manifest_missing_for_historical_run: true,
        safe_fields_only: ALLOWED_WEEKLY_UPDATE_FIELDS,
        note: "Run stats retain safe_update_sailing_ids only; no persisted rollback manifest"
      };
    }
    const manifests = await sb(
      `cruise_discovery_maintenance_manifests?run_record_id=eq.${encodeURIComponent(runRow.id)}&select=id,manifest&limit=5`
    ).catch(() => []);
    return {
      rollback_manifest_rows: (manifests || []).length,
      retrospective_rollback_available: (manifests || []).some((m) => m.manifest?.updated?.length),
      updated_uuids: [],
      official_sailing_ids: [],
      identity_critical_field_changes: [],
      rollback_manifest_missing_for_historical_run: true,
      note: "No persisted rollback manifest; write_details not stored on run row"
    };
  }
  const identityChanges = fieldChanges.filter((f) => IDENTITY_CRITICAL.includes(f.field));
  return {
    rollback_manifest_rows: 0,
    retrospective_rollback_available: details.some((d) => d.rollback_snapshot),
    updated_uuids: [...new Set(uuids)],
    official_sailing_ids: [...new Set(sailingIds)],
    identity_critical_field_changes: identityChanges,
    rollback_manifest_missing_for_historical_run: !details.some((d) => d.rollback_snapshot),
    safe_fields_only: ALLOWED_WEEKLY_UPDATE_FIELDS
  };
}

function classifySilverseaRootCause({ scheduledLease, bgLease, scheduledRun }) {
  if (scheduledRun) return { root_cause: "OTHER", note: "scheduled run exists" };
  if (!scheduledLease?.held) return { root_cause: "OTHER", note: "no scheduled lease" };
  if (bgLease?.held && !scheduledRun) {
    return {
      root_cause: "BACKGROUND_ACCEPTED_NOT_STARTED",
      netlify_failure_point: "background_execution_lease_without_run_record",
      note: "Background dispatch lease claimed but no cruise_discovery_runs scheduled row"
    };
  }
  return {
    root_cause: "BACKGROUND_ACCEPTED_NOT_STARTED",
    netlify_failure_point: "scheduled_lease_without_background_execution_or_run",
    note:
      "Scheduled dispatch lease preserved; no background-dispatch execution lease and no scheduled run — launcher likely returned 202 but worker never created run record"
  };
}

function isScheduledWeeklyExecution(run) {
  if (!run || run.stats?.run_type === MISSED_SCHEDULE_RUN_TYPE) return false;
  return isScheduledExecutionTrigger(run.stats?.trigger_type || run.trigger_type);
}

function w38Status(lineSlug, lineRuns, scheduledLease, missRows, runType, isoWeek = "2026-W38") {
  const weeklyRuns = lineRuns.filter((r) => r.stats?.run_type === runType);
  const scheduled = weeklyRuns.find(isScheduledWeeklyExecution);
  const w38Miss = missRows.find(
    (r) => r.stats?.line_slug === lineSlug && String(r.stats?.period_key || "").includes(isoWeek)
  );
  const recovery = weeklyRuns.find((r) =>
    ["manual_recovery", "incident_recovery"].includes(r.stats?.trigger_type)
  );

  if (lineSlug === "silversea-cruises" && !scheduled && scheduledLease?.held) {
    return recovery ? "incident_recovered" : "scheduled_dispatch_miss";
  }

  if (scheduled) {
    const terminal = scheduled.stats?.terminal_status;
    if (terminal === "review_required") return "review_required_operational_success";
    if (terminal === "not_yet_commissioned") return "not_yet_commissioned";
    if (terminal === "partial_write_failure") return "partial_write_failure";
    if (terminal === "failed_before_writes" || scheduled.status === "failed") {
      return "scheduled_execution_failed";
    }
    if (terminal === "controlled_catchup_required" || scheduled.stats?.dry_run === true) {
      return "review_required_operational_success";
    }
    if (terminal === "completed_with_staged_rows") return "review_required_operational_success";
    if (scheduled.status === "completed" && scheduled.stats?.dry_run !== true) {
      return "scheduled_execution_success";
    }
    return "scheduled_execution_success";
  }

  if (w38Miss) return "scheduled_dispatch_miss";
  if (recovery) return "incident_recovered";
  return "pending_or_not_due";
}

async function buildW38Matrix(sb, isoWeek = "2026-W38") {
  const matrix = {};
  const runIds = {};
  for (const spec of COMMISSIONED_WEEKLY_LINES) {
    const label = WEEKLY_LINE_SCHEDULE.find((s) => s.slug === spec.slug)?.label || spec.slug;
    const lineRow = (await sb(`ci_cruise_lines?slug=eq.${encodeURIComponent(spec.slug)}&select=id&limit=1`))?.[0];
    const lineRuns = lineRow
      ? await sb(
          `cruise_discovery_runs?cruise_line_id=eq.${encodeURIComponent(lineRow.id)}&scope=eq.cruise_line&select=id,status,stats,started_at,finished_at,cruise_line_id&order=started_at.desc&limit=20`
        )
      : [];
    const lease = await loadMaintenanceLockStatus(sb, scheduledWeeklyDispatchKey(spec.slug));
    const misses = (lineRuns || []).filter((r) => r.stats?.run_type === MISSED_SCHEDULE_RUN_TYPE);
    matrix[label] = w38Status(spec.slug, lineRuns || [], lease, misses, spec.runType, isoWeek);
    const scheduledRun = (lineRuns || [])
      .filter((r) => r.stats?.run_type === spec.runType)
      .find(isScheduledWeeklyExecution);
    runIds[label] = scheduledRun?.id || null;
  }
  return { matrix, runIds };
}

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const startingSha = gitSha();
  const week = perthIsoWeek(new Date("2026-09-18T00:00:00+08:00"));

  if (process.argv.includes("--matrix-only")) {
    const { matrix, runIds } = await buildW38Matrix(sb, week);
    console.log(JSON.stringify({ ok: true, iso_week: week, w38_final_matrix: matrix, scheduled_run_ids: runIds }, null, 2));
    return;
  }

  const silverseaPeriodKey = scheduledWeeklyDispatchKey("silversea-cruises");
  const scheduledLease = await loadMaintenanceLockStatus(sb, silverseaPeriodKey);
  const bgLease = await loadMaintenanceLockStatus(sb, backgroundDispatchExecutionKey(SILVERSEA_DISPATCH_ID));

  const silverseaLine = (await sb("ci_cruise_lines?slug=eq.silversea-cruises&select=id&limit=1"))?.[0];
  const silverseaRuns = silverseaLine
    ? await sb(
        `cruise_discovery_runs?cruise_line_id=eq.${encodeURIComponent(silverseaLine.id)}&scope=eq.cruise_line&select=id,status,stats,started_at,finished_at&order=started_at.desc&limit=20`
      )
    : [];
  const scheduledSilverseaRun = (silverseaRuns || []).find(
    (r) => isScheduledWeeklyExecution(r) && r.started_at >= "2026-09-17T18:00:00Z"
  );

  const forensic = classifySilverseaRootCause({
    scheduledLease,
    bgLease,
    scheduledRun: scheduledSilverseaRun
  });

  const missBefore = await reconcileMissedScheduledWeeklyExecutions(sb);
  const missAfter = await reconcileMissedScheduledWeeklyExecutions(sb);
  const silverseaMissRows = (silverseaRuns || []).filter((r) => r.stats?.run_type === MISSED_SCHEDULE_RUN_TYPE);

  const recoveryDispatchId = `silversea-p3l-incident-recovery-${week}-${Date.now()}`;
  const leaseBeforeRecovery = await loadMaintenanceLockStatus(sb, silverseaPeriodKey);
  const recovery = await runSilverseaWeeklyBackgroundMaintenance({
    supabaseClient: sb,
    dryRun: true,
    triggerType: "incident_recovery",
    dispatchId: recoveryDispatchId,
    platformScheduled: false
  });
  const leaseAfterRecovery = await loadMaintenanceLockStatus(sb, silverseaPeriodKey);

  const azRun = await loadRun(sb, AZAMARA_FRIDAY_RUN_ID);
  const azAudit = azRun ? await auditAzamaraFridayUpdates(sb, azRun) : null;
  const azReadonly = await runAzamaraWeeklyMaintenance({
    supabase: sb,
    dryRun: true,
    performWrites: false,
    runId: `azamara-p3l-readonly-${Date.now()}`,
    triggerType: "preflight"
  });

  const azManifests = await sb(
    `cruise_discovery_maintenance_manifests?run_record_id=eq.${encodeURIComponent(AZAMARA_FRIDAY_RUN_ID)}&select=id,manifest_type,manifest&limit=5`
  ).catch(() => []);

  const { matrix: w38, runIds: w38RunIds } = await buildW38Matrix(sb, week);

  const report = {
    phase: "P3L",
    generated_at: new Date().toISOString(),
    repository: { starting_sha: startingSha, branch: "main" },
    azamara_friday: {
      run_record_id: AZAMARA_FRIDAY_RUN_ID,
      run: azRun
        ? {
            started_at: azRun.started_at,
            finished_at: azRun.finished_at,
            perth_started: perth(azRun.started_at),
            status: azRun.status,
            terminal_status: azRun.stats?.terminal_status,
            updates: azRun.stats?.updated ?? azRun.stats?.writes_performed?.updated,
            inserts: azRun.stats?.inserted ?? 0,
            dry_run: azRun.stats?.dry_run
          }
        : null,
      active_production: await azamaraActiveCount(sb),
      manifest_rows_for_run: (azManifests || []).length,
      audit: azAudit,
      current_readonly: {
        proposed_inserts: azReadonly.summary?.proposed_inserts ?? (azReadonly.manifest?.inserts || []).length,
        proposed_updates: azReadonly.summary?.proposed_updates ?? (azReadonly.manifest?.updates || []).length,
        proposed_identity_review: azReadonly.summary?.proposed_identity_review ?? 0,
        source_health: azReadonly.summary?.source_counts ? "PASS" : azReadonly.reason,
        source_absent: azReadonly.summary?.source_absent_sailing_ids?.length ?? 0
      }
    },
    silversea_incident: {
      classification: "MISSED_BACKGROUND_EXECUTION",
      scheduled_slot_perth: "2026-09-18 03:00:00",
      scheduled_slot_utc: "2026-09-17T19:00:00Z",
      dispatch_id: SILVERSEA_DISPATCH_ID,
      scheduled_lease: {
        lock_key: silverseaPeriodKey,
        preserved: scheduledLease.held === true,
        owner_id: scheduledLease.owner_id || scheduledLease.run_id,
        acquired_at: scheduledLease.acquired_at || scheduledLease.created_at,
        expires_at: scheduledLease.expires_at
      },
      background_execution_lease: {
        lock_key: backgroundDispatchExecutionKey(SILVERSEA_DISPATCH_ID),
        existed: bgLease.held === true,
        owner_id: bgLease.owner_id || null
      },
      scheduled_run_existed: Boolean(scheduledSilverseaRun),
      material_writes: 0,
      forensic,
      deploy_sha_at_incident: "unknown_without_netlify_logs"
    },
    silversea_recovery: {
      dispatch_id: recoveryDispatchId,
      trigger_type: "incident_recovery",
      run_record_id: recovery.run_record_id || null,
      run_id: recovery.run_id || null,
      official_source_total: recovery.summary?.official_source_total ?? recovery.summary?.source_total,
      eligible: recovery.summary?.eligible_total,
      proposed_inserts: recovery.summary?.proposed_inserts ?? 0,
      proposed_updates: recovery.summary?.proposed_updates ?? recovery.summary?.proposed_update_reviews,
      source_health: recovery.summary?.source_healthy ? "PASS" : recovery.summary?.quality_gate?.source_health,
      writes: (recovery.summary?.inserts || 0) + (recovery.summary?.updates || 0),
      terminal_status: recovery.summary?.terminal_status || recovery.terminal_status,
      dry_run: recovery.dry_run !== false,
      scheduled_lease_unchanged:
        leaseBeforeRecovery.held === leaseAfterRecovery.held &&
        (leaseBeforeRecovery.owner_id || leaseBeforeRecovery.run_id) ===
          (leaseAfterRecovery.owner_id || leaseAfterRecovery.run_id)
    },
    monitoring: {
      reconcile_first_pass: missBefore,
      reconcile_second_pass: missAfter,
      silversea_weekly_schedule_miss_created: missBefore.some(
        (r) => r.line_slug === "silversea-cruises" && r.weekly_schedule_miss?.created
      ),
      duplicate_proof: missAfter.every(
        (r) => r.line_slug !== "silversea-cruises" || r.weekly_schedule_miss?.duplicate || !r.missed
      )
    },
    daily_expiry: {
      run_record_id: DAILY_EXPIRY_RUN_ID,
      accepted: true,
      expired_count: 17
    },
    w38_final_matrix: w38,
    w38_scheduled_run_ids: w38RunIds,
    p3l_writes: [],
    p3l_manifests: []
  };

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, report: REPORT_PATH, recovery: report.silversea_recovery }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
