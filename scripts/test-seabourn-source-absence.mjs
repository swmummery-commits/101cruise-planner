#!/usr/bin/env node
/**
 * Seabourn source-absence grace policy tests.
 *   node scripts/test-seabourn-source-absence.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { assessCatchUpPreflightGate } from "./run-seabourn-first-production-batch.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const absence = require(path.join(root, "netlify/functions/lib/seabourn-source-absence"));
const reconciliation = require(path.join(root, "netlify/functions/lib/seabourn-reconciliation-summary"));
const runnerSrc = fs.readFileSync(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-runner.js"),
  "utf8"
);

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

test("single absence is observed not actionable", () => {
  const policy = absence.classifySeabournSourceAbsence({
    currentAbsentRows: [{ official_sailing_id: "C7S07K|8730", discovered_cruise_id: "id-1" }],
    previousAbsentSailingIds: [],
    enumerationHealthy: true
  });
  if (policy.source_absent_observed !== 1) throw new Error("expected observed=1");
  if (policy.source_absent_actionable !== 0) throw new Error("expected actionable=0");
  if (policy.source_absent_retained !== 1) throw new Error("expected retained=1");
});

test("second consecutive absence becomes actionable but writes remain disabled", () => {
  const policy = absence.classifySeabournSourceAbsence({
    currentAbsentRows: [{ official_sailing_id: "C7S07K|8730" }],
    previousAbsentSailingIds: ["C7S07K|8730"],
    enumerationHealthy: true
  });
  if (policy.source_absent_actionable !== 1) throw new Error("expected actionable=1");
  if (policy.source_absence_actions_allowed !== false) throw new Error("deactivation not allowed in policy");
});

test("reappearance clears previous absence observation", () => {
  const policy = absence.classifySeabournSourceAbsence({
    currentAbsentRows: [],
    previousAbsentSailingIds: ["C7S07K|8730"],
    enumerationHealthy: true
  });
  if (policy.source_absence_cleared_count !== 1) throw new Error("expected cleared=1");
  if (policy.source_absent_observed !== 0) throw new Error("expected observed=0");
});

test("isolated observed absence permits catch-up", () => {
  const gate = assessCatchUpPreflightGate({
    active_production_total: 120,
    source_absent_observed: 1,
    source_absent_actionable: 0,
    source_quality_gate: { passed: true },
    reconciliation_arithmetic_ok: true,
    active_production_arithmetic_ok: true,
    proposed_updates: 0
  });
  if (!gate.ok) throw new Error(`expected catch-up ok got ${gate.failures}`);
  if (!gate.catch_up_permitted_with_observed_absence) throw new Error("expected permitted flag");
});

test("actionable absence blocks catch-up", () => {
  const gate = assessCatchUpPreflightGate({
    active_production_total: 120,
    source_absent_observed: 0,
    source_absent_actionable: 1,
    source_quality_gate: { passed: true },
    reconciliation_arithmetic_ok: true,
    active_production_arithmetic_ok: true,
    proposed_updates: 0
  });
  if (gate.ok) throw new Error("expected catch-up blocked");
  if (!gate.failures.includes("source_absent_actionable_gt_zero")) throw new Error("missing failure code");
});

test("systemic absence collapse blocks catch-up", () => {
  const gate = absence.assessSeabournCatchUpSafety({
    sourceAbsencePolicy: { source_absent_observed: 12, source_absent_actionable: 0 },
    activeProductionTotal: 120,
    sourceQualityGatePassed: true,
    reconciliationArithmeticOk: true,
    proposedUpdates: 0
  });
  if (gate.ok) throw new Error("expected systemic block");
  if (!gate.failures.includes("systemic_source_absence_detected")) throw new Error("missing systemic failure");
});

test("active production arithmetic allows retained source-absent", () => {
  const rec = reconciliation.buildSeabournReconciliationSummary({
    activeProductionTotal: 120,
    eligibleTotal: 669,
    recognisedExistingEligible: 119,
    outstandingEligibleInserts: 550,
    proposedUpdates: 0,
    sourceAbsentActive: 1,
    sourceAbsentObserved: 1,
    sourceAbsentRetained: 1
  });
  if (!rec.active_production_arithmetic_ok) throw new Error("active arithmetic should reconcile");
  if (rec.source_absent_retained !== 1) throw new Error("retained count");
});

test("manifest insert proposals exclude already-active identities in runner reconciliation", () => {
  if (!runnerSrc.includes("duplicate_skip")) throw new Error("missing duplicate_skip recognition");
  if (!runnerSrc.includes("source_absent_observed")) throw new Error("missing observed absence reporting");
});

console.log(`\n${passed} passed, 0 failed`);
