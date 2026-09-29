#!/usr/bin/env node
/**
 * Princess P3O commissioning tests: idempotent writes, parity gate, single scheduler.
 *   node scripts/test-princess-p3o-commissioning.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const idempotent = require(path.join(root, "netlify/functions/lib/princess-idempotent-write"));
const remap = require(path.join(root, "netlify/functions/lib/princess-official-id-remap"));
const parity = require(path.join(root, "netlify/functions/lib/princess-source-parity"));
const accounting = require(path.join(root, "netlify/functions/lib/weekly-maintenance-write-accounting"));
const outcome = require(path.join(root, "netlify/functions/lib/princess-weekly-outcome"));
const recon = require(path.join(root, "netlify/functions/lib/princess-reconciliation-summary"));
const rollback = require(path.join(root, "netlify/functions/lib/princess-weekly-rollback-manifest"));
const control = require(path.join(root, "netlify/functions/lib/weekly-maintenance-schedule-control"));
const stale = require(path.join(root, "netlify/functions/lib/weekly-maintenance-stale-runs"));
const scheduleMap = require(path.join(root, "netlify/functions/lib/weekly-maintenance-schedule-map"));
const cutoff = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const lanes = require(path.join(root, "netlify/functions/lib/princess-weekly-lanes"));

const applyWorkflow = fs.readFileSync(
  path.join(root, ".github/workflows/princess-weekly-maintenance-apply.yml"),
  "utf8"
);
const netlifyToml = fs.readFileSync(path.join(root, "netlify.toml"), "utf8");
const runnerSrc = fs.readFileSync(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-runner.js"),
  "utf8"
);
const writesSrc = fs.readFileSync(
  path.join(root, "netlify/functions/lib/princess-discovery-writes.js"),
  "utf8"
);

let passed = 0;
function test(name, fn) {
  const result = fn();
  if (result && typeof result.then === "function") {
    return result.then(() => {
      passed += 1;
      console.log(`✓ ${name}`);
    });
  }
  passed += 1;
  console.log(`✓ ${name}`);
}

const currentItinerary = {
  id: "4773d53f-b7e1-43cc-9da2-4351fdd937cb",
  official_sailing_id: "IAL20A|RP|2028-04-01",
  itinerary: "Hawaii & South Pacific Crossing",
  status: "active",
  ship_id: "ship-rp",
  destination_id: "dest-pacific",
  departure_date: "2028-04-01",
  return_date: "2028-04-21",
  nights: 20,
  departure_port: "Los Angeles"
};

const currentRemap = {
  id: "56e9cd80-d512-40e3-9681-1e45827162ee",
  official_sailing_id: "SBV15A|MJ|2026-12-07",
  itinerary: "Cape Horn & Glaciers of Patagonia",
  status: "active",
  ship_id: "ship-mj",
  destination_id: "dest-sa",
  departure_date: "2026-12-07",
  return_date: "2026-12-22",
  nights: 15,
  departure_port: "Buenos Aires"
};

await test("already-applied itinerary retry is IDEMPOTENT_ALREADY_APPLIED", () => {
  const verdict = idempotent.classifyPrincessPlannedWriteAgainstCurrent({
    currentRow: currentItinerary,
    frozenTarget: { ...currentItinerary, itinerary: "Hawaii & South Pacific Crossing" },
    plannedAction: "update_safe_metadata_allowed"
  });
  if (verdict.classification !== "IDEMPOTENT_ALREADY_APPLIED") throw new Error(verdict.classification);
  if (verdict.attempted_mutation !== 0) throw new Error("attempted_mutation");
  if (verdict.failed_write !== 0) throw new Error("failed_write");
  if (verdict.idempotent_skip !== 1) throw new Error("idempotent_skip");
});

await test("already-applied remap retry is IDEMPOTENT_ALREADY_APPLIED", () => {
  const verdict = idempotent.classifyPrincessPlannedWriteAgainstCurrent({
    currentRow: currentRemap,
    frozenTarget: {
      official_sailing_id: "SBV15A|MJ|2026-12-07",
      ship_id: currentRemap.ship_id,
      destination_id: currentRemap.destination_id,
      departure_date: currentRemap.departure_date,
      return_date: currentRemap.return_date,
      nights: currentRemap.nights,
      departure_port: currentRemap.departure_port
    },
    plannedAction: "remap_official_id_allowed"
  });
  if (verdict.classification !== "IDEMPOTENT_ALREADY_APPLIED") throw new Error(verdict.classification);
  if (verdict.failed_write !== 0) throw new Error("failed_write");
});

await test("applyPrincessOfficialIdRemap does not mutate an already remapped UUID", async () => {
  let patched = false;
  const sb = async () => {
    patched = true;
    throw new Error("must not PATCH already-applied remap");
  };
  const result = await remap.applyPrincessOfficialIdRemap(sb, {
    existingRow: currentRemap,
    insert: { ...currentRemap, official_sailing_id: "SBV15A|MJ|2026-12-07" },
    cruiseLineId: "line"
  });
  if (!result.ok || result.idempotent !== true) throw new Error(JSON.stringify(result));
  if (result.result_action !== "idempotent_already_applied") throw new Error(result.result_action);
  if (patched) throw new Error("replacement write issued");
});

await test("planned vs material vs idempotent accounting", () => {
  const stats = idempotent.princessWriteAccountingFromStats({
    inserted: 0,
    updated: 8,
    failed: 0,
    idempotent_skips: 2,
    planned_targets: 10
  });
  if (stats.planned_targets !== 10) throw new Error("planned");
  if (stats.material_writes !== 8) throw new Error("material");
  if (stats.idempotent_skips !== 2) throw new Error("skips");
  if (stats.failed_writes !== 0) throw new Error("failed");
  if (stats.attempted_mutations !== 8) throw new Error("attempts include skips");
  const flat = accounting.flattenWeeklyWriteStats({
    inserts: 0,
    updates: 8,
    failed_writes: 0,
    idempotent_skips: 2,
    write_attempts: 8
  });
  if (flat.failed_writes !== 0) throw new Error("flat failed");
  if (flat.idempotent_skips !== 2) throw new Error("flat skips");
  if (flat.committed_material_writes !== 8) throw new Error("flat committed");
  const terminal = accounting.resolveWeeklyTerminalStatus({
    ok: true,
    summary: { inserts: 0, updates: 8, failed_writes: 0, idempotent_skips: 2 }
  });
  if (terminal !== "completed") throw new Error(terminal);
});

await test("8 writes + 2 already-applied is COMPLETED not partial_write_failure", () => {
  const resolved = outcome.resolvePrincessWeeklyOutcome({
    sourceHealthy: true,
    sourceAccountingExact: true,
    canonicalAccountingExact: true,
    unexplainedCount: 0,
    safeLaneProcessed: true,
    reviewCount: 0,
    writesVerified: true,
    writeFailure: false,
    partialWrite: false
  });
  if (resolved.outcome !== "completed") throw new Error(resolved.outcome);
  if (resolved.infrastructure_failure) throw new Error("must not be infrastructure failure");
});

await test("deterministic remaps are counted in eligible arithmetic", () => {
  const summary = recon.buildPrincessReconciliationSummary({
    activeProductionTotal: 1951,
    eligibleTotal: 1941,
    recognisedExistingEligible: 1928,
    outstandingEligibleInserts: 0,
    proposedUpdates: 13,
    proposedIdentityReviewUpdates: 0,
    sourceAbsentActive: 10,
    otherExplainedNonEligibleActive: 13
  });
  if (!summary.reconciliation_arithmetic_ok) throw new Error("1941 != 1928+13");
  if (summary.unexplained_active_ok !== true) throw new Error("unexplained");
});

await test("rollback manifest excludes idempotent targets from mutations", () => {
  const completed = rollback.completePrincessRollbackManifestWithWriteResult(
    {
      inserted: [],
      updated: [
        { official_sailing_id: "A", discovered_cruise_id: "1", before_values: { itinerary: "old" } },
        { official_sailing_id: "B", discovered_cruise_id: "2", before_values: { itinerary: "old" } }
      ]
    },
    {
      stats: {
        write_details: [
          { princess_sailing_id: "A", discovered_cruise_id: "1", after_values: { itinerary: "new" } },
          {
            princess_sailing_id: "B",
            discovered_cruise_id: "2",
            result_action: "idempotent_already_applied",
            idempotent_skip: true
          }
        ]
      }
    }
  );
  if (completed.updated.length !== 1) throw new Error(`updated ${completed.updated.length}`);
  if (completed.already_applied.length !== 1) throw new Error("already_applied missing");
  if (completed.updated[0].official_sailing_id !== "A") throw new Error("kept mutation");
  if (completed.already_applied[0].before_values != null) throw new Error("fake rollback entry");
});

await test("write path reloads UUID before mutation", () => {
  if (!writesSrc.includes("reloadPrincessDiscoveredCruise")) throw new Error("reload missing");
  if (!writesSrc.includes("IDEMPOTENT_ALREADY_APPLIED")) throw new Error("idempotent gate missing");
  if (!runnerSrc.includes("idempotent_skips")) throw new Error("runner skips missing");
  if (!runnerSrc.includes("remapOnlyEligibleCount")) throw new Error("remap arithmetic missing");
});

await test("Netlify/Mac source parity fails on unexplained IDs", () => {
  const compared = parity.comparePrincessSourceFreezes(
    {
      eligible_official_ids: ["A", "B"],
      snapshot_id: "h1",
      eligible_total: 2,
      resolution_rates: {
        identity_coverage_pct: 100,
        ship_resolution_pct: 100,
        departure_port_resolution_pct: 100,
        destination_resolution_pct: 100,
        duplicate_official_identities: 0
      }
    },
    {
      eligible_official_ids: ["A", "C"],
      snapshot_id: "h2",
      eligible_total: 2,
      resolution_rates: {
        identity_coverage_pct: 100,
        ship_resolution_pct: 100,
        departure_port_resolution_pct: 100,
        destination_resolution_pct: 100,
        duplicate_official_identities: 0
      }
    }
  );
  if (compared.pass) throw new Error("must fail");
  if (!compared.mac_only_eligible_ids.includes("B")) throw new Error("mac-only");
  if (!compared.netlify_only_eligible_ids.includes("C")) throw new Error("netlify-only");
});

await test("identical source freezes pass parity", () => {
  const freeze = {
    eligible_official_ids: ["A", "B"],
    official_group_ids: ["G1"],
    snapshot_id: "same",
    eligible_total: 2,
    resolution_rates: {
      identity_coverage_pct: 100,
      ship_resolution_pct: 100,
      departure_port_resolution_pct: 100,
      destination_resolution_pct: 100,
      duplicate_official_identities: 0
    }
  };
  const compared = parity.comparePrincessSourceFreezes(freeze, freeze);
  if (!compared.pass) throw new Error(JSON.stringify(compared));
});

await test("single scheduler owner remains exactly one", () => {
  const princessTomlBlock =
    netlifyToml.match(/\[functions\."princess-weekly-maintenance-cron"\][\s\S]*?(?=\n\[functions\.|$)/)?.[0] ||
    "";
  const scheduledInToml = /^\s*schedule\s*=/m.test(princessTomlBlock);
  const githubScheduled = /schedule:[\s\S]*cron: "0 21 \* \* 0"/.test(applyWorkflow);
  const owners = [scheduledInToml && "netlify", githubScheduled && "github"].filter(Boolean);
  if (owners.length !== 1) throw new Error(`scheduler owners: ${owners.join(",") || "none"}`);
  if (owners[0] !== "netlify") throw new Error("P3P cutover must leave Netlify as the scheduler");
});

await test("parity/rehearsal must not use Monday scheduled lease", () => {
  const key = control.weeklyNamespacedDispatchKey(
    "princess-cruises",
    "princess-p3o-netlify-parity-test",
    "parity_test"
  );
  if (key.endsWith(":scheduled")) throw new Error(key);
  if (!key.includes("parity_test")) throw new Error(key);
});

await test("Princess missed schedule uses shared claimed-lease detector", () => {
  const periodKey = control.scheduledWeeklyDispatchKey("princess-cruises", new Date("2026-09-28T00:00:00Z"));
  const missed = control.detectClaimedLeaseWithoutExecution({
    lease: { held: true, acquired_at: "2026-09-27T21:00:00Z" },
    scheduledPeriodKey: periodKey,
    weeklyRuns: [],
    now: new Date("2026-09-27T22:00:00Z"),
    graceMs: 15 * 60 * 1000
  });
  if (missed.missed !== true) throw new Error(JSON.stringify(missed));
  const present = control.detectClaimedLeaseWithoutExecution({
    lease: { held: true, acquired_at: "2026-09-27T21:00:00Z" },
    scheduledPeriodKey: periodKey,
    weeklyRuns: [{ id: "run-1", stats: { trigger_type: "scheduled", run_type: "princess_weekly_maintenance" } }],
    now: new Date("2026-09-27T22:00:00Z")
  });
  if (present.missed !== false) throw new Error("false miss");
});

await test("Princess is covered by shared stale-run watchdog", () => {
  const slugs = stale.STALE_SWEEP_LINES.map((row) => row.slug);
  if (!slugs.includes("princess-cruises")) throw new Error("princess missing from stale watchdog");
});

await test("21-day cutoff and write cap unchanged", () => {
  if (cutoff.PUBLIC_BOOKING_CUTOFF_DAYS !== 21) throw new Error("cutoff");
  if (lanes.PRINCESS_WEEKLY_WRITE_CAP !== 30) throw new Error("cap");
  const princess = scheduleMap.WEEKLY_LINE_SCHEDULE.find((row) => row.slug === "princess-cruises");
  if (princess.perth_hour !== 5 || princess.cron_utc !== "0 21 * * 0") {
    throw new Error("business timing changed");
  }
});

await test("artifact upload remains non-authoritative", () => {
  if (!/Upload apply report artifact[\s\S]*continue-on-error: true/.test(applyWorkflow)) {
    throw new Error("artifact continue-on-error missing");
  }
});

console.log(`\n${passed} Princess P3O commissioning tests passed`);
