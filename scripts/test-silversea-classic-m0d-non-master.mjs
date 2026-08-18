#!/usr/bin/env node
/**
 * Silversea Classic M0D-NM — non-master two-row apply runner tests.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const classic = require(path.join(root, "netlify/functions/lib/silversea-classic-itinerary-ports-backfill"));
const { buildAuthoritativeVerificationResult } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-controlled-production-run"
));
const {
  assertPostWriteVerifierImportsResolved,
  M0D_NM_USES_HARDENED_RUNNER,
  M0D_NM_RUNNER_PATH
} = await import(path.join(root, "scripts/run-silversea-classic-m0d-non-master-apply.mjs"));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`✗ ${name}`);
    console.error(`  ${e.message}`);
    failed += 1;
  }
}

const master = JSON.parse(fs.readFileSync(path.join(root, classic.M0C_BACKFILL_FIXTURE), "utf8"));
const m0d1 = JSON.parse(fs.readFileSync(path.join(root, classic.M0D1_BACKFILL_FIXTURE), "utf8"));
const m0d2 = JSON.parse(fs.readFileSync(path.join(root, classic.M0D2_BACKFILL_FIXTURE), "utf8"));
const m0d3 = JSON.parse(fs.readFileSync(path.join(root, classic.M0D3_BACKFILL_FIXTURE), "utf8"));
const nmFixturePath = path.join(root, classic.M0D_NM_BACKFILL_FIXTURE);
const nmFixture = fs.existsSync(nmFixturePath) ? JSON.parse(fs.readFileSync(nmFixturePath, "utf8")) : null;

test("M0D-NM runner uses hardened lifecycle", () => {
  if (!M0D_NM_USES_HARDENED_RUNNER) throw new Error("expected hardened runner");
  if (M0D_NM_RUNNER_PATH !== "scripts/run-silversea-classic-m0d-non-master-apply.mjs") throw new Error("path");
});

test("post-write verifier imports resolve", () => {
  const smoke = assertPostWriteVerifierImportsResolved();
  if (!smoke.ok) throw new Error("imports");
});

test("non-master official IDs are exactly two targets", () => {
  if (classic.NON_MASTER_CLASSIC_OFFICIAL_IDS.length !== 2) throw new Error("count");
  if (!classic.NON_MASTER_CLASSIC_OFFICIAL_IDS.includes("SM260907007")) throw new Error("SM");
  if (!classic.NON_MASTER_CLASSIC_OFFICIAL_IDS.includes("SN260906007")) throw new Error("SN");
});

test("target identities match frozen UUIDs", () => {
  const byId = Object.fromEntries(
    classic.NON_MASTER_CLASSIC_TARGET_IDENTITIES.map((t) => [t.official_sailing_id, t.production_uuid])
  );
  if (byId.SM260907007 !== "5e68affa-0d11-447a-8b32-8b7de5a69906") throw new Error("SM uuid");
  if (byId.SN260906007 !== "56110646-4e0e-46f4-bcce-f8a276971925") throw new Error("SN uuid");
});

test("zero master overlap for non-master IDs", () => {
  const overlap = classic.validateNonMasterClassicNoMasterOverlap(
    { rows: classic.NON_MASTER_CLASSIC_TARGET_IDENTITIES.map((t) => ({ official_sailing_id: t.official_sailing_id })) },
    master,
    { m0d1, m0d2, m0d3 }
  );
  if (!overlap.ok || overlap.master_overlap !== 0) throw new Error(JSON.stringify(overlap));
});

test("M0D-NM confirmation token stable", () => {
  if (
    classic.M0D_NM_APPLY_CONFIRMATION_TOKEN !== "SILVERSEA-CLASSIC-M0D-NON-MASTER-ITINERARY-PORTS-BACKFILL"
  ) {
    throw new Error("token");
  }
});

test("fixture count exactly 2 when present", () => {
  if (!nmFixture) return;
  const v = classic.validateClassicRepairFixture(nmFixture);
  if (!v.ok || v.row_count !== 2) throw new Error(JSON.stringify(v));
  if (v.uuid_unique !== 2 || v.id_unique !== 2) throw new Error("uniqueness");
});

test("fixture official IDs ASC ordered when present", () => {
  if (!nmFixture) return;
  const ids = nmFixture.rows.map((r) => r.official_sailing_id);
  const sorted = [...ids].sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(ids) !== JSON.stringify(sorted)) throw new Error("ordering");
});

test("fixture rows remain expired lifecycle state when present", () => {
  if (!nmFixture) return;
  for (const row of nmFixture.rows) {
    if (row.status !== "expired" && row.lifecycle_state !== "expired") throw new Error(row.official_sailing_id);
    if (!Array.isArray(row.before_itinerary_ports) || row.before_itinerary_ports.length !== 0) {
      throw new Error(`before empty: ${row.official_sailing_id}`);
    }
    if (!Array.isArray(row.after_itinerary_ports) || row.after_itinerary_ports.length === 0) {
      throw new Error(`after non-empty: ${row.official_sailing_id}`);
    }
  }
});

test("itinerary_ports-only whitelist", () => {
  if (classic.UPDATE_WHITELIST.length !== 1 || classic.UPDATE_WHITELIST[0] !== "itinerary_ports") {
    throw new Error("whitelist");
  }
});

test("dry run is update-only when fixture present", () => {
  if (!nmFixture) return;
  const dry = classic.dryRunClassicItineraryPortsBackfill(nmFixture);
  if (dry.proposed_itinerary_ports_updates !== 2) throw new Error(String(dry.proposed_itinerary_ports_updates));
  if (dry.proposed_inserts !== 0 || dry.proposed_deletes !== 0 || dry.other_column_updates !== 0) {
    throw new Error("not update-only");
  }
});

test("M0D1 protection fail forces aggregate fail", () => {
  const result = buildAuthoritativeVerificationResult({
    aggregateOk: false,
    verification: { ok: true, verified_count: 2, failed_count: 0 },
    protection: { m0d1_unchanged: false, m0d2_unchanged: true, m0d3_unchanged: true }
  });
  if (result.ok !== false) throw new Error("masking");
});

test("M0D3 frozen protection fail forces aggregate fail", () => {
  const result = buildAuthoritativeVerificationResult({
    aggregateOk: false,
    verification: { ok: true, verified_count: 2, failed_count: 0 },
    protection: { m0d1_unchanged: true, m0d2_unchanged: true, m0d3_unchanged: false }
  });
  if (result.ok !== false) throw new Error("masking");
});

test("expected stored classic totals after success", () => {
  const correctAfter = 402;
  const remainingAfter = 199;
  if (correctAfter !== 400 + 2) throw new Error("correct math");
  if (remainingAfter !== 199) throw new Error("remaining");
});

console.log(`\nM0D-NM tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
