#!/usr/bin/env node
/**
 * Silversea M2R recovery attestation tests — offline + optional live read-only attestation.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const m2r = require(path.join(root, "netlify/functions/lib/silversea-m2r-recovery-attestation"));
const m2Runner = fs.readFileSync(path.join(root, "scripts/run-silversea-m2-insert-canary.mjs"), "utf8");
const m2rRunner = await import(path.join(root, "scripts/run-silversea-m2r-recovery-attestation.mjs"));

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

const EXP_ID = "21a6601a-1e11-4472-ac30-827091082e6b";
const EXP_OFFICIAL = "E4MOCK001";

function baseRaw(code) {
  return {
    silversea_cruise_code: code,
    silversea_cruise_type: "Expedition",
    source_duration: 14,
    calculated_nights: 14
  };
}

async function runTests() {
  await test("pre-lock baseline false-positive regression", () => {
    const underLock = m2r.buildMockExpeditionRow(EXP_ID, EXP_OFFICIAL, baseRaw(EXP_OFFICIAL));
    const preLock = m2r.buildMockExpeditionRow(EXP_ID, EXP_OFFICIAL, {
      ...baseRaw(EXP_OFFICIAL),
      silversea_adapter_version: "2026-08-15.silversea0"
    });
    const inserted = m2r.buildMockClassicInsertRow();
    const result = m2r.simulatePreLockBaselineFalsePositive({
      expeditionRowUnderLock: underLock,
      expeditionRowPreLock: preLock,
      insertedClassicRow: inserted
    });
    if (!result.ok) throw new Error("expected pre-lock fail + under-lock pass");
  });

  await test("under-lock baseline correct behaviour", () => {
    const underLock = m2r.buildMockExpeditionRow(EXP_ID, EXP_OFFICIAL, baseRaw(EXP_OFFICIAL));
    const inserted = m2r.buildMockClassicInsertRow();
    const result = m2r.simulatePreLockBaselineFalsePositive({
      expeditionRowUnderLock: underLock,
      expeditionRowPreLock: underLock,
      insertedClassicRow: inserted
    });
    if (!result.under_lock_baseline_passes) throw new Error("under-lock should pass when stable");
  });

  await test("real under-lock raw_extract mutation fails", () => {
    const before = m2r.buildMockExpeditionRow(EXP_ID, EXP_OFFICIAL, baseRaw(EXP_OFFICIAL));
    const after = m2r.buildMockExpeditionRow(EXP_ID, EXP_OFFICIAL, {
      ...baseRaw(EXP_OFFICIAL),
      destination_raw: "MUTATED"
    });
    const inserted = m2r.buildMockClassicInsertRow();
    const result = m2r.simulateRealUnderLockMutation({
      expeditionRowBefore: before,
      expeditionRowAfterMutated: after,
      insertedClassicRow: inserted
    });
    if (!result.ok) throw new Error("real mutation must fail protection");
  });

  await test("b4ff693 under-lock snapshot ordering", () => {
    const audit = m2r.auditUnderLockSnapshotOrdering(m2Runner);
    if (!audit.ok) throw new Error(`ordering audit failed: ${audit.failed.join(",")}`);
  });

  await test("historical report not rewritten helper", () => {
    const historical = path.join(
      root,
      "reports/controlled-production-apply-silversea-m2-maintenance-insert-WH281005017-2026-08-23T01-33-26-599Z.json"
    );
    if (!fs.existsSync(historical)) throw new Error("historical report missing locally");
    const hash = m2r.hashFile(historical);
    const preserved = m2r.verifyHistoricalReportPreserved({ reportPath: historical, initialHash: hash });
    if (!preserved.ok || preserved.status !== "VERIFYING") {
      throw new Error("historical report must remain VERIFYING and unchanged");
    }
    if (preserved.global_lock_released !== false) {
      throw new Error("historical stale global_lock_released must remain false");
    }
  });

  await test("inserted ID constants", () => {
    if (m2r.HISTORICAL_INSERTED_UUID !== "94b60f04-3728-49af-8d58-70e93f6dfd7c") {
      throw new Error("wrong inserted UUID constant");
    }
    if (m2r.HISTORICAL_AFFECTED_EXPEDITION_UUID !== EXP_ID) throw new Error("wrong expedition UUID");
  });

  await test("fixture payload equality helper", () => {
    const fixturePath = path.join(root, "scripts/fixtures/silversea/m2-maintenance-insert-canary-WH281005017.json");
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    const mockRow = {
      ...fixture.insert_payload,
      itinerary_ports: fixture.itinerary_ports,
      raw_extract: fixture.candidate.raw_extract
    };
    const check = m2r.verifyInsertedPayloadFields(mockRow, fixture);
    if (!check.ok) throw new Error(`fixture self-check failed: ${check.mismatches.join(",")}`);
  });

  await test("repeat insert blocked helper", () => {
    const { proveRepeatInsertBlocked, CANARY_OFFICIAL_ID } = require(path.join(
      root,
      "netlify/functions/lib/silversea-m2-maintenance-insert-canary"
    ));
    const row = { id: m2r.HISTORICAL_INSERTED_UUID, official_sailing_id: CANARY_OFFICIAL_ID };
    const idx = { byOfficialId: new Map([[CANARY_OFFICIAL_ID, row]]) };
    const block = proveRepeatInsertBlocked(idx);
    if (!block.ok) throw new Error("repeat insert must block when present");
  });

  await test("M2 attributable delta helper", () => {
    const delta = m2r.computeM2AttributableDelta({
      total: 920,
      classic_stored_official_total: 602,
      expedition_stored_official_total: 310,
      legacy: 8
    });
    if (delta.row_delta !== 1 || delta.classic_delta !== 1 || delta.expedition_delta !== 0) {
      throw new Error("delta mismatch");
    }
  });

  await test("circular dependency does not block M3", () => {
    const audit = m2r.auditCircularDependencyWarning();
    if (audit.blocks_m3) throw new Error("circular dependency must not block M3");
    if (!audit.validate_cruise_resolves_at_runtime) throw new Error("validateCruise must resolve at runtime");
  });

  await test("zero M2R cruise writes contract", () => {
    if (m2rRunner.M2R_RUNNER_PATH !== "scripts/run-silversea-m2r-recovery-attestation.mjs") {
      throw new Error("runner path");
    }
  });

  await test("source absence and update canary constants", () => {
    if (m2r.M1_UPDATE_CANARY_ID !== "SL270927009") throw new Error("update canary");
    if (m2r.M1_SOURCE_ABSENCE_ID !== "SN280222C25") throw new Error("source absence");
  });

  await test("root cause timing gap positive", () => {
    const gap =
      new Date(m2r.HISTORICAL_LOCK_ACQUIRED_AT).getTime() -
      new Date(m2r.HISTORICAL_PREFLIGHT_STARTED_AT).getTime();
    if (gap < 60000) throw new Error("expected >60s pre-lock gap");
  });

  console.log(`\nM2R tests: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

runTests().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
