#!/usr/bin/env node
/**
 * P3L — Silversea read-only dispatch + missed schedule + Azamara rollback manifest.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const silverseaBg = fs.readFileSync(
  path.join(root, "netlify/functions/silversea-weekly-maintenance-background.js"),
  "utf8"
);
const silverseaDispatch = require(path.join(root, "netlify/functions/lib/silversea-weekly-maintenance-dispatch"));
const tracking = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-tracking"));
const schedule = require(path.join(root, "netlify/functions/lib/weekly-maintenance-schedule-control"));
const cron = fs.readFileSync(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-cron.js"), "utf8");
const azamaraMaint = fs.readFileSync(path.join(root, "netlify/functions/lib/azamara-weekly-maintenance.js"), "utf8");
const azamaraRollback = require(path.join(root, "netlify/functions/lib/azamara-weekly-rollback-manifest"));
const { ALLOWED_WEEKLY_UPDATE_FIELDS } = require(path.join(
  root,
  "netlify/functions/lib/azamara-weekly-update-policy"
));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`✗ ${name} — ${e.message || e}`);
  }
}

test("Silversea background does not use authorised_scheduled_maintenance for performWrites", () => {
  if (/authorised_scheduled_maintenance === true \|\| dryRun === false/.test(silverseaBg)) {
    throw new Error("dangerous override still present");
  }
  if (!/platformScheduled: body\.authorised_scheduled_maintenance === true/.test(silverseaBg)) {
    throw new Error("platformScheduled provenance missing");
  }
});

test("resolvePerformWrites false when write flag disabled", () => {
  const env = { SILVERSEA_WEEKLY_RECONCILIATION_ENABLED: "true", SILVERSEA_DISCOVERY_WRITE_ENABLED: "false" };
  if (silverseaDispatch.resolvePerformWrites({}, env) !== false) throw new Error("expected false dry");
  if (silverseaDispatch.resolveDryRun({}, env) !== true) throw new Error("expected dryRun true");
});

test("resolvePerformWrites true only with explicit apply + both flags", () => {
  const env = { SILVERSEA_WEEKLY_RECONCILIATION_ENABLED: "true", SILVERSEA_DISCOVERY_WRITE_ENABLED: "true" };
  if (silverseaDispatch.resolvePerformWrites({ dry_run: false }, env) !== true) throw new Error("apply blocked");
  if (silverseaDispatch.resolvePerformWrites({ authorised_scheduled_maintenance: true }, env) !== false) {
    throw new Error("schedule must not override");
  }
});

test("reconcileMissedScheduledWeeklyExecutions exported", () => {
  if (typeof tracking.reconcileMissedScheduledWeeklyExecutions !== "function") throw new Error("missing");
});

test("daily expiry invokes missed schedule reconcile", () => {
  if (!cron.includes("reconcileMissedScheduledWeeklyExecutions")) throw new Error("not wired");
});

test("claimed lease without execution fixture", () => {
  const now = Date.parse("2026-09-18T06:35:00+08:00");
  const missed = schedule.detectClaimedLeaseWithoutExecution({
    lease: { held: true, acquired_at: "2026-09-17T19:00:41.006Z", owner_id: "silversea-cruises-dispatch-test" },
    scheduledPeriodKey: "silversea-cruises:2026-W38:scheduled",
    weeklyRuns: [],
    now: new Date(now),
    graceMs: schedule.MISSED_SCHEDULE_GRACE_MS
  });
  if (!missed.missed) throw new Error(JSON.stringify(missed));
  if (missed.reason !== "claimed_lease_without_scheduled_execution") throw new Error(missed.reason);
});

test("Azamara pre-apply rollback manifest builder", () => {
  const manifest = azamaraRollback.buildAzamaraPreApplyRollbackManifest({
    manifest: {
      updates: [
        {
          official_sailing_id: "AZ123",
          existing_record_id: "uuid-1",
          existing_snapshot: { official_url: "https://old", raw_extract: {} },
          candidate: { official_url: "https://new", raw_extract: { title: "x" }, cruise_line_id: "line" }
        }
      ]
    },
    runId: "test-run",
    runRecordId: "rec-1",
    cruiseLineId: "line",
    lineSlug: "azamara",
    triggerType: "scheduled"
  });
  if (manifest.updated.length !== 1) throw new Error("updated count");
  if (!manifest.updated[0].planned_safe_patch?.official_url) throw new Error("patch missing");
  if (!manifest.manifest_hash) throw new Error("hash missing");
});

test("Azamara weekly persists rollback before apply", () => {
  if (!azamaraMaint.includes("persistAzamaraPreApplyRollbackManifest")) throw new Error("not wired");
  if (!azamaraMaint.includes("rollback_manifest_persist_failed")) throw new Error("fail-closed missing");
});

test("Azamara safe update fields exclude identity-critical", () => {
  const critical = ["ship_id", "departure_date", "official_sailing_id", "identity_key"];
  for (const f of critical) {
    if (ALLOWED_WEEKLY_UPDATE_FIELDS.includes(f)) throw new Error(`${f} in allowlist`);
  }
});

console.log(`\nP3L tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
