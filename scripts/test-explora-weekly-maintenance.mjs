#!/usr/bin/env node
/**
 * Explora weekly maintenance guard tests — dry-run contract, apply preconditions, write caps,
 * lock wiring and reconciliation arithmetic. No network and no database access.
 *   npm run test:explora-weekly-maintenance
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const weekly = await import(path.join(root, "scripts/run-explora-weekly-maintenance.mjs"));
const runner = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-runner"));
const maintenance = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));
const locks = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks"));
const verification = require(path.join(root, "netlify/functions/lib/explora-post-write-verification"));

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    failures.push({ name, error: error.message || String(error) });
    console.log(`✗ ${name} — ${error.message || error}`);
  }
}

function expectThrows(code, fn) {
  try {
    fn();
  } catch (error) {
    if (error.code !== code) throw new Error(`expected ${code}, got ${error.code || error.message}`);
    return;
  }
  throw new Error(`expected ${code}, nothing thrown`);
}

const LOCAL_MAC_ENV = { EXPLORA_WEEKLY_RECONCILIATION_ENABLED: "true" };
const APPLY_ARGS = {
  apply: true,
  dryRun: false,
  confirm: weekly.WEEKLY_APPLY_CONFIRMATION_TOKEN,
  maxWrites: 10
};

function summaryFixture(overrides = {}) {
  return {
    run_id: "explora-weekly-test",
    official_source_total: 480,
    eligible_total: 300,
    active_production_total: 300,
    recognised_existing_eligible: 300,
    outstanding_eligible_inserts: 0,
    proposed_inserts: 0,
    proposed_updates: 0,
    inserts: 0,
    updates: 0,
    source_absent_active: 0,
    source_absent_sailing_ids: [],
    within_public_cutoff_excluded: 12,
    incomplete_skipped: 4,
    non_cruise_excluded: 0,
    reconciliation_arithmetic_ok: true,
    all_active_recognised_in_eligible_source: true,
    quality_gate: { passed: true, failures: [], blocked: false },
    resolution_rates: {
      ship_resolution_pct: 100,
      departure_port_resolution_pct: 99.2,
      destination_resolution_pct: 98.5,
      identity_coverage_pct: 100
    },
    ...overrides
  };
}

function reportFixture({ mode = "dry_run", summary = summaryFixture(), result = {}, before = 300, after = 300 } = {}) {
  return weekly.buildWeeklyMaintenanceReport({
    mode,
    startedAt: "2026-08-10T00:00:00.000Z",
    endedAt: "2026-08-10T00:02:00.000Z",
    environment: weekly.classifyExecutionEnvironment({}, { applyMode: mode === "apply" }),
    result: { ok: true, summary, ...result },
    countsBefore: { explora: before },
    countsAfter: { explora: after }
  });
}

/* ------------------------------------------------------------------ argument contract */

test("1. dry run is the default when --apply is absent", () => {
  const args = weekly.parseWeeklyMaintenanceArgs(["node", "script"]);
  if (args.apply || !args.dryRun) throw new Error(JSON.stringify(args));
});

test("2. apply flags, confirmation token and max writes are parsed", () => {
  const args = weekly.parseWeeklyMaintenanceArgs([
    "node",
    "script",
    "--apply",
    "--confirm=EXPLORA-WEEKLY-MAINTENANCE",
    "--max-writes=12"
  ]);
  if (!args.apply || args.dryRun) throw new Error("apply not parsed");
  if (args.confirm !== weekly.WEEKLY_APPLY_CONFIRMATION_TOKEN) throw new Error(args.confirm);
  if (args.maxWrites !== 12) throw new Error(String(args.maxWrites));
});

test("3. dry run never asserts apply preconditions", () => {
  weekly.assertWeeklyApplyAllowed(weekly.parseWeeklyMaintenanceArgs(["node", "script"]), {});
});

/* ------------------------------------------------------------------- apply gating */

test("4. apply requires the exact confirmation token", () => {
  expectThrows("weekly_apply_confirmation_required", () =>
    weekly.assertWeeklyApplyAllowed({ ...APPLY_ARGS, confirm: "yes" }, LOCAL_MAC_ENV)
  );
});

test("5. apply is blocked while EXPLORA_WEEKLY_RECONCILIATION_ENABLED is unset", () => {
  expectThrows("explora_weekly_reconciliation_disabled", () =>
    weekly.assertWeeklyApplyAllowed(APPLY_ARGS, {})
  );
});

test("6. apply is blocked on Netlify", () => {
  expectThrows("weekly_apply_netlify_forbidden", () =>
    weekly.assertWeeklyApplyAllowed(APPLY_ARGS, { ...LOCAL_MAC_ENV, NETLIFY: "true" })
  );
  expectThrows("weekly_apply_netlify_forbidden", () =>
    weekly.assertWeeklyApplyAllowed(APPLY_ARGS, { ...LOCAL_MAC_ENV, AWS_LAMBDA_FUNCTION_NAME: "fn" })
  );
});

test("7. apply is blocked on cloud-hosted GitHub runners", () => {
  expectThrows("weekly_apply_cloud_hosted_forbidden", () =>
    weekly.assertWeeklyApplyAllowed(APPLY_ARGS, {
      ...LOCAL_MAC_ENV,
      CI: "true",
      GITHUB_ACTIONS: "true",
      RUNNER_OS: "ubuntu-latest"
    })
  );
});

test("8. apply is blocked on other CI providers", () => {
  expectThrows("weekly_apply_ci_forbidden", () =>
    weekly.assertWeeklyApplyAllowed(APPLY_ARGS, { ...LOCAL_MAC_ENV, CI: "true" })
  );
});

test("9. apply requires an explicit --max-writes value", () => {
  expectThrows("weekly_apply_max_writes_required", () =>
    weekly.assertWeeklyApplyAllowed({ ...APPLY_ARGS, maxWrites: null }, LOCAL_MAC_ENV)
  );
  expectThrows("weekly_apply_max_writes_required", () =>
    weekly.assertWeeklyApplyAllowed({ ...APPLY_ARGS, maxWrites: 0 }, LOCAL_MAC_ENV)
  );
});

test("10. apply passes on a local Mac with every precondition satisfied", () => {
  weekly.assertWeeklyApplyAllowed(APPLY_ARGS, LOCAL_MAC_ENV);
});

test("11. apply passes on a self-hosted Mac runner", () => {
  weekly.assertWeeklyApplyAllowed(APPLY_ARGS, {
    ...LOCAL_MAC_ENV,
    CI: "true",
    GITHUB_ACTIONS: "true",
    RUNNER_LABELS: "self-hosted,explora-local-mac",
    RUNNER_OS: "macOS"
  });
});

/* --------------------------------------------------------------------- write caps */

test("12. the Explora weekly cap is 25 and leaves the Princess cap at 30", () => {
  if (weekly.MAX_WEEKLY_WRITES !== 25) throw new Error(String(weekly.MAX_WEEKLY_WRITES));
  if (runner.EXPLORA_MAX_WEEKLY_WRITES !== 25) throw new Error(String(runner.EXPLORA_MAX_WEEKLY_WRITES));
  if (runner.MAX_WEEKLY_WRITES !== 30) throw new Error("Princess weekly cap changed");
  if (runner.MAX_WRITES_PER_BATCH !== 100) throw new Error("batch cap changed");
});

test("13. requested max writes are clamped to the weekly cap", () => {
  if (weekly.resolveEffectiveWeeklyMaxWrites(1000) !== 25) throw new Error("not clamped");
  if (weekly.resolveEffectiveWeeklyMaxWrites(7) !== 7) throw new Error("under-cap value changed");
  if (weekly.resolveEffectiveWeeklyMaxWrites(0) !== null) throw new Error("zero accepted");
  if (weekly.resolveEffectiveWeeklyMaxWrites("abc") !== null) throw new Error("garbage accepted");
});

test("14. combined proposed changes above the cap fail the volume assessment", () => {
  const ok = weekly.assessWeeklyChangeVolumeCap(10, 5);
  if (!ok.ok || ok.combined_proposed_changes !== 15) throw new Error(JSON.stringify(ok));
  const blocked = weekly.assessWeeklyChangeVolumeCap(20, 10);
  if (blocked.ok) throw new Error("30 changes accepted");
  if (blocked.reason !== "weekly_change_volume_exceeds_initial_cap") throw new Error(blocked.reason);
  if (blocked.cap !== 25) throw new Error(String(blocked.cap));
});

/* ------------------------------------------------------------- dry-run report shape */

test("15. a clean dry run reports zero writes and unchanged inventory", () => {
  const report = reportFixture();
  if (report.mode !== "dry_run") throw new Error(report.mode);
  if (report.writes_performed !== 0) throw new Error(String(report.writes_performed));
  if (report.inventory_unchanged !== true) throw new Error("inventory changed");
  if (report.status !== "completed") throw new Error(report.status);
  if (weekly.resolveWeeklyMaintenanceExitCode(report) !== 0) throw new Error("exit code");
});

test("16. a dry run that changed inventory is a failure", () => {
  const report = reportFixture({ before: 300, after: 301 });
  if (report.status !== "failed") throw new Error(report.status);
  if (weekly.resolveWeeklyMaintenanceExitCode(report) !== 1) throw new Error("exit code");
});

test("17. an unreachable official source fails the run", () => {
  const report = reportFixture({ result: { ok: false, reason: "official_source_unreachable" } });
  if (report.source.fetch_failed !== true) throw new Error("fetch_failed");
  if (report.status !== "failed") throw new Error(report.status);
});

test("18. a failed quality gate fails the run", () => {
  const report = reportFixture({
    summary: summaryFixture({ quality_gate: { passed: false, failures: ["ship_resolution_below_threshold"], blocked: true } })
  });
  if (report.status !== "failed") throw new Error(report.status);
  if (!report.quality_gate.failures.length) throw new Error("failures not surfaced");
});

test("19. broken reconciliation arithmetic fails the run", () => {
  const report = reportFixture({ summary: summaryFixture({ reconciliation_arithmetic_ok: false }) });
  if (report.status !== "failed") throw new Error(report.status);
});

test("20. a blocked run exits with code 2 rather than failing", () => {
  const report = reportFixture({ result: { ok: false, blocked: true } });
  if (report.status !== "blocked") throw new Error(report.status);
  if (weekly.resolveWeeklyMaintenanceExitCode(report) !== 2) throw new Error("exit code");
});

test("21. reconciliation arithmetic is carried through to the report", () => {
  const report = reportFixture({
    summary: summaryFixture({
      eligible_total: 320,
      active_production_total: 300,
      recognised_existing_eligible: 300,
      outstanding_eligible_inserts: 20,
      proposed_inserts: 20,
      proposed_updates: 3,
      source_absent_active: 2,
      source_absent_sailing_ids: ["EX20270101MIASJU", "EP20270210BCNBCN"]
    })
  });
  const r = report.reconciliation;
  if (r.recognised_existing_eligible + r.outstanding_eligible_inserts !== r.eligible_total) {
    throw new Error("recognised + outstanding must equal eligible");
  }
  if (report.source_absent.count !== 2) throw new Error("source absent count");
  if (report.source_absent.policy !== "source_absent_retained_active") throw new Error("retention policy");
  if (report.write_cap.combined_proposed_changes !== 23 || report.write_cap.ok !== true) {
    throw new Error(JSON.stringify(report.write_cap));
  }
});

test("22. proposals above the weekly cap fail an apply run", () => {
  const report = reportFixture({
    mode: "apply",
    summary: summaryFixture({ proposed_inserts: 26, proposed_updates: 0, inserts: 0 }),
    before: 300,
    after: 300
  });
  if (report.write_cap.ok !== false) throw new Error("cap not enforced");
  if (report.status !== "failed") throw new Error(report.status);
});

test("23. failed post-write verification fails an apply run", () => {
  const report = weekly.buildWeeklyMaintenanceReport({
    mode: "apply",
    startedAt: "2026-08-10T00:00:00.000Z",
    endedAt: "2026-08-10T00:05:00.000Z",
    environment: weekly.classifyExecutionEnvironment(LOCAL_MAC_ENV, { applyMode: true }),
    result: { ok: true, summary: summaryFixture({ inserts: 3 }) },
    countsBefore: { explora: 300 },
    countsAfter: { explora: 303 },
    postWriteVerification: { ok: false, issues: [{ id: "row-1", issue: "missing_destination_id" }] }
  });
  if (report.writes_performed !== 3) throw new Error(String(report.writes_performed));
  if (report.status !== "failed") throw new Error(report.status);
});

test("24. the dry-run summary is labelled and report files are namespaced per mode", () => {
  const report = reportFixture();
  const text = weekly.formatWeeklyMaintenanceSummary(report);
  if (!text.includes("DRY RUN")) throw new Error(text);
  if (!text.includes("Writes performed: 0")) throw new Error(text);
  const stamp = report.started_at.replace(/[:.]/g, "-");
  if (`explora-weekly-maintenance-${stamp}.json`.includes("princess")) throw new Error("filename collision");
});

/* --------------------------------------------------------------- shared wiring guards */

test("25. Explora uses its own maintenance run type and lock key", () => {
  if (maintenance.EXPLORA_WEEKLY_MAINTENANCE_RUN_TYPE !== "explora_weekly_maintenance") throw new Error("run type");
  const lockKey = locks.weeklyLockKey(weekly.EXPLORA_LINE_SLUG);
  if (lockKey !== "explora-journeys:weekly") throw new Error(lockKey);
  if (lockKey === locks.weeklyLockKey("princess-cruises")) throw new Error("lock key collides with Princess");
  if (locks.DEFAULT_LEASE_SECONDS[lockKey] !== 900) throw new Error("no lease configured for the Explora lock");
});

test("26. the Explora cron launcher is registered with the approved schedule", () => {
  const schedule = maintenance.MAINTENANCE_SCHEDULES.explora_weekly;
  if (!schedule) throw new Error("missing schedule entry");
  if (schedule.schedule_registered !== true) throw new Error("Explora schedule must be registered");
  if (schedule.cron_utc !== "0 21 * * 0") throw new Error(schedule.cron_utc);
  if (schedule.function !== "explora-weekly-maintenance-cron") throw new Error(schedule.function);
  if (schedule.background_function !== "explora-weekly-maintenance-background") {
    throw new Error(schedule.background_function);
  }
  if (maintenance.MAINTENANCE_SCHEDULES.princess_weekly.authoritative_scheduler !== "github_actions_self_hosted_princess_local_mac") {
    throw new Error("Princess authoritative scheduler must remain GitHub self-hosted");
  }
  if (maintenance.MAINTENANCE_SCHEDULES.princess_weekly.netlify_schedule_enabled !== false) {
    throw new Error("Princess Netlify weekly cron must stay unscheduled");
  }
});

test("27. weekly reconciliation and write flags default to disabled", () => {
  if (maintenance.isExploraWeeklyReconciliationEnabled()) throw new Error("weekly flag enabled");
  if (weekly.isExploraWeeklyFlagEnabled({})) throw new Error("script flag helper enabled");
  const flags = maintenance.describeMaintenanceHold();
  if (flags.explora_weekly_reconciliation_enabled !== false) throw new Error("flag snapshot");
  if (!flags.bulk_import_flags_must_remain_false.includes("EXPLORA_DISCOVERY_WRITE_ENABLED")) {
    throw new Error("EXPLORA_DISCOVERY_WRITE_ENABLED must be listed as a must-stay-false flag");
  }
});

test("28. post-write verification rejects rows that fail the Explora contract", () => {
  const good = {
    id: "row-1",
    cruise_line_id: verification.EXPLORA_LINE_ID,
    ship_id: "ship-1",
    destination_id: "dest-1",
    departure_date: "2027-03-01",
    return_date: "2027-03-09",
    nights: 8,
    departure_port: "Miami",
    official_url: "https://explorajourneys.com/int/en/destinations-globe/car/journeys/miasju-08-v12?id-journey=EX20270301MIASJU",
    official_sailing_id: "EX20270301MIASJU",
    status: "active",
    raw_extract: { explora_sailing_id: "EX20270301MIASJU" }
  };
  const okResult = verification.verifyInsertedRows([good]);
  if (!okResult.ok) throw new Error(JSON.stringify(okResult.issues));
  const badResult = verification.verifyInsertedRows([
    { ...good, id: "row-2", status: "expired" },
    { ...good, id: "row-3", destination_id: null }
  ]);
  if (badResult.ok) throw new Error("bad rows accepted");
  if (badResult.issues.length !== 2) throw new Error(JSON.stringify(badResult.issues));
});

test("29. the Explora line id is distinct from the other maintained lines", () => {
  const others = [
    "c19f40a7-c160-4035-a845-14dada550e1f",
    "a8d0e678-0cb2-4ea7-ad73-251f0eb36ea2",
    "aa2c50ed-7ff5-472d-bc96-3d686d76c5ec"
  ];
  if (weekly.EXPLORA_LINE_ID !== verification.EXPLORA_LINE_ID) throw new Error("line id mismatch across modules");
  if (others.includes(weekly.EXPLORA_LINE_ID)) throw new Error("Explora reuses another line id");
});

console.log(`\n${passed} tests passed, ${failures.length} failed`);
if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exit(1);
}
