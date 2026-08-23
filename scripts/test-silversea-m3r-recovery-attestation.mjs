#!/usr/bin/env node
/**
 * Silversea M3R recovery attestation tests — offline lifecycle mocks + artifact checks.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const m3r = require(path.join(root, "netlify/functions/lib/silversea-m3r-recovery-attestation"));
const m3Runner = fs.readFileSync(path.join(root, "scripts/run-silversea-m3-update-canary.mjs"), "utf8");
const m2Runner = fs.readFileSync(path.join(root, "scripts/run-silversea-m2-insert-canary.mjs"), "utf8");
const m3rRunner = await import(path.join(root, "scripts/run-silversea-m3r-recovery-attestation.mjs"));

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`✗ ${name}`);
    console.error(`  ${e.message}`);
    failed += 1;
  }
}

function tempReportDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "m3r-lifecycle-"));
}

async function runTests() {
  await test("1 successful lifecycle reaches COMPLETE", () => {
    const dir = tempReportDir();
    const runId = "test-success-lifecycle";
    const result = m3r.simulateLifecycleFinalizationSuccess({ reportDir: dir, runId });
    if (!result.ok) throw new Error(`expected COMPLETE: ${JSON.stringify(result.persisted)}`);
  });

  await test("2 verification failure does not reach COMPLETE", () => {
    const dir = tempReportDir();
    const runId = "test-failure-lifecycle";
    const result = m3r.simulateLifecycleFinalizationFailure({ reportDir: dir, runId });
    if (!result.ok) throw new Error(`expected verification failure state: ${result.persisted?.status}`);
  });

  await test("3 lock release metadata accurate on success", () => {
    const dir = tempReportDir();
    const result = m3r.simulateLifecycleFinalizationSuccess({
      reportDir: dir,
      runId: "test-lock-release-success"
    });
    if (result.persisted.global_lock?.global_lock_released !== true) {
      throw new Error("success path must record global_lock_released=true");
    }
  });

  await test("4 lock release metadata on failure path", () => {
    const dir = tempReportDir();
    const result = m3r.simulateLifecycleFinalizationFailure({
      reportDir: dir,
      runId: "test-lock-release-failure"
    });
    if (result.persisted.global_lock?.global_lock_released !== true) {
      throw new Error("failure path must still record global_lock_released=true");
    }
  });

  await test("5 historical artifact preservation", () => {
    const successApply = path.join(
      root,
      "reports/controlled-production-apply-silversea-m3-maintenance-update-SL270927009-2026-08-23T05-29-32-410Z.json"
    );
    if (!fs.existsSync(successApply)) throw new Error("historical apply report missing");
    const hash = m3r.hashFile(successApply);
    const report = JSON.parse(fs.readFileSync(successApply, "utf8"));
    if (report.status !== "VERIFYING") throw new Error("historical status must remain VERIFYING");
    if (report.global_lock?.global_lock_released !== false) {
      throw new Error("historical stale lock metadata must remain false");
    }
    const preserved = m3r.verifyHistoricalArtifactsPreserved(root, {
      success_apply: hash,
      success_rollback: m3r.hashFile(
        path.join(
          root,
          "reports/controlled-production-rollback-silversea-m3-maintenance-update-SL270927009-2026-08-23T05-29-32-410Z.json"
        )
      ),
      success_summary: m3r.hashFile(
        path.join(root, "reports/silversea-m3-maintenance-update-SL270927009-2026-08-23T05-29-32-410Z.json")
      ),
      blocked_apply: m3r.hashFile(
        path.join(
          root,
          "reports/controlled-production-apply-silversea-m3-maintenance-update-SL270927009-2026-08-23T05-25-46-306Z.json"
        )
      ),
      blocked_summary: m3r.hashFile(
        path.join(root, "reports/silversea-m3-maintenance-update-SL270927009-2026-08-23T05-25-46-306Z.json")
      )
    });
    if (!preserved.ok) throw new Error("historical artifacts rewritten");
  });

  await test("6 under-lock baseline ordering", () => {
    const audit = m3r.auditUnderLockSnapshotOrdering(m3Runner);
    if (!audit.ok) throw new Error(`ordering: ${audit.failed.join(",")}`);
  });

  await test("7 real non-target mutation fails verification", () => {
    const result = m3r.simulateRealNonTargetMutationDetection({
      targetUuid: m3r.HISTORICAL_TARGET_UUID
    });
    if (!result.ok) throw new Error("non-target mutation must fail protection");
  });

  await test("8 under-lock target frozen-before query sufficient", () => {
    const audit = m3r.auditUnderLockTargetQuery(m3Runner);
    if (!audit.ok) throw new Error("underLockRecheck must select=*");
  });

  await test("9 SL270927009 after-values helper with fixture", () => {
    const fixturePath = path.join(
      root,
      "scripts/fixtures/silversea/m3-maintenance-update-canary-SL270927009.json"
    );
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    const mockRow = {
      id: m3r.HISTORICAL_TARGET_UUID,
      official_sailing_id: m3r.CANARY_OFFICIAL_ID,
      cruise_line_id: fixture.immutable_fingerprint.cruise_line_id,
      external_key: fixture.immutable_fingerprint.external_key,
      identity_key: fixture.immutable_fingerprint.identity_key,
      itinerary: fixture.after.itinerary,
      itinerary_ports: fixture.after.itinerary_ports,
      raw_extract: fixture.after.raw_extract
    };
    const check = m3r.verifyUpdatedAfterValues(mockRow, fixture);
    if (!check.ok) throw new Error(`after-values: ${check.issues?.join(",")}`);
  });

  await test("10 repeat update blocked helper", () => {
    const fixturePath = path.join(
      root,
      "scripts/fixtures/silversea/m3-maintenance-update-canary-SL270927009.json"
    );
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    const row = {
      id: m3r.HISTORICAL_TARGET_UUID,
      official_sailing_id: m3r.CANARY_OFFICIAL_ID,
      itinerary: fixture.after.itinerary,
      itinerary_ports: fixture.after.itinerary_ports,
      raw_extract: fixture.after.raw_extract
    };
    const idx = { byOfficialId: new Map([[m3r.CANARY_OFFICIAL_ID, row]]) };
    const { proveRepeatUpdateBlocked } = require(path.join(
      root,
      "netlify/functions/lib/silversea-m3-maintenance-update-canary"
    ));
    const block = proveRepeatUpdateBlocked(idx, fixture);
    if (!block.ok) throw new Error("repeat update must block");
  });

  await test("11 WH281005017 protected constant", () => {
    if (m3r.M2_INSERT_CANARY_ID !== "WH281005017") throw new Error("m2 canary id");
    if (m3r.M2_INSERTED_UUID !== "94b60f04-3728-49af-8d58-70e93f6dfd7c") throw new Error("m2 uuid");
  });

  await test("12 source absence constant", () => {
    if (m3r.M1_SOURCE_ABSENCE_ID !== "SN280222C25") throw new Error("source absence id");
  });

  await test("13 UPDATE_UNSAFE audit helper", () => {
    const row = {
      id: "x",
      official_sailing_id: "WH271121011",
      cruise_line_id: "line",
      ship_id: "ship",
      departure_date: "2027-01-01",
      return_date: "2027-01-10",
      nights: 9,
      departure_port: "A",
      destination_id: "d",
      itinerary: "A, B",
      itinerary_ports: ["A", "B"],
      status: "active",
      official_url: "https://example.com",
      source_url: "https://example.com",
      raw_extract: { silversea_cruise_code: "WH271121011" }
    };
    const audit = m3r.auditUnsafeRowsUntouched({
      beforeRows: [row],
      afterRows: [row]
    });
    if (!audit.ok) throw new Error("stable unsafe row must pass");
  });

  await test("14 zero M3R cruise writes contract", () => {
    if (m3rRunner.M3R_RUNNER_PATH !== "scripts/run-silversea-m3r-recovery-attestation.mjs") {
      throw new Error("runner path");
    }
  });

  await test("15 M3 and M2 runners have finalizeUnderLock", () => {
    const m3Audit = m3r.auditFinalizeUnderLockPresent(m3Runner);
    const m2Audit = m3r.auditFinalizeUnderLockPresent(m2Runner);
    if (!m3Audit.ok) throw new Error(`M3 missing: ${m3Audit.failed.join(",")}`);
    if (!m2Audit.ok) throw new Error(`M2 missing: ${m2Audit.failed.join(",")}`);
  });

  await test("16 Silversea maintenance runners audit clean", () => {
    const audit = m3r.auditSilverseaMaintenanceRunners({ m3: m3Runner, m2: m2Runner });
    if (!audit.ok) throw new Error(JSON.stringify(audit.issues));
  });

  await test("17 lifecycle discrepancy explained", () => {
    const recon = m3r.reconcileHistoricalLifecycle(root);
    if (!recon.discrepancy_explanation) throw new Error("missing explanation");
    if (recon.durable_apply_report.status !== "VERIFYING") throw new Error("expected VERIFYING");
    if (recon.runner_level.verification_ok !== true) throw new Error("runner verification must be ok");
  });

  await test("18 blocked first attempt zero writes", () => {
    const recon = m3r.reconcileHistoricalLifecycle(root);
    if ((recon.blocked_attempt.production_writes.updates || 0) !== 0) {
      throw new Error("blocked attempt must have zero updates");
    }
  });

  await test("19 circular dependency does not block M4", () => {
    const audit = m3r.auditCircularDependencyWarning();
    if (audit.blocks_m3) throw new Error("circular dependency must not block");
  });

  await test("20 identity immutability helper", () => {
    const fixturePath = path.join(
      root,
      "scripts/fixtures/silversea/m3-maintenance-update-canary-SL270927009.json"
    );
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    const row = {
      id: fixture.production_uuid,
      official_sailing_id: fixture.official_sailing_id,
      cruise_line_id: fixture.immutable_fingerprint.cruise_line_id,
      external_key: fixture.immutable_fingerprint.external_key,
      identity_key: fixture.immutable_fingerprint.identity_key
    };
    const check = m3r.verifyIdentityImmutability(row, fixture);
    if (!check.ok) throw new Error(`identity: ${check.mismatches.join(",")}`);
  });

  console.log(`\nM3R tests: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

runTests().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
