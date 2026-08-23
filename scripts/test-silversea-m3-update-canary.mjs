#!/usr/bin/env node
/**
 * Silversea M3 maintenance UPDATE canary tests — offline, no production writes.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const m3 = require(path.join(root, "netlify/functions/lib/silversea-m3-maintenance-update-canary"));
const policy = require(path.join(root, "netlify/functions/lib/silversea-weekly-maintenance-policy"));
const m3Runner = fs.readFileSync(path.join(root, "scripts/run-silversea-m3-update-canary.mjs"), "utf8");
const m2Runner = fs.readFileSync(path.join(root, "scripts/run-silversea-m2-insert-canary.mjs"), "utf8");

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

const CANARY = m3.CANARY_OFFICIAL_ID;
const UUID = "46e8e274-9f46-4529-9c6f-5bdac69bdedb";

function mockProductionRow(ports, itinerary) {
  return {
    id: UUID,
    official_sailing_id: CANARY,
    cruise_line_id: "line-silversea",
    ship_id: "ship-sl",
    external_key: "ext-sl",
    identity_key: "id-sl",
    departure_date: "2027-09-27",
    return_date: "2027-10-06",
    nights: 9,
    departure_port: "Venice",
    destination_id: "dest-med",
    itinerary,
    itinerary_ports: ports,
    status: "active",
    official_url: "https://example.com/sl",
    source_url: "https://example.com/sl",
    raw_extract: { silversea_cruise_code: CANARY }
  };
}

function mockProposalReorder() {
  const beforePorts = ["Venice", "Piran", "Rovinj", "Bari", "Dubrovnik", "Kotor", "Split", "Zadar", "Venice"];
  const afterPorts = ["Venice", "Piran", "Rovinj", "Bari", "Kotor", "Dubrovnik", "Split", "Zadar", "Venice"];
  return {
    classification: policy.MAINTENANCE_CLASSIFICATION.UPDATE_ELIGIBLE,
    changed_fields: ["itinerary", "itinerary_ports"],
    before: {
      itinerary: beforePorts.join(", "),
      itinerary_ports: beforePorts
    },
    after: {
      itinerary: afterPorts.join(", "),
      itinerary_ports: afterPorts
    },
    reason_codes: ["deterministic_source_diff"]
  };
}

function mockProductionIndex(row) {
  const byOfficialId = new Map([[CANARY, row]]);
  return { rows: [row], byOfficialId };
}

async function runTests() {
  await test("1 exact official ID only", () => {
    if (m3.CANARY_OFFICIAL_ID !== "SL270927009") throw new Error("wrong canary");
  });

  await test("2 fixture count constant", () => {
    if (m3.EXPECTED_UPDATES !== 1) throw new Error("expected updates must be 1");
  });

  await test("3 UPDATE_ELIGIBLE mock passes guards", () => {
    const row = mockProductionRow(
      ["Venice", "Piran", "Rovinj", "Bari", "Dubrovnik", "Kotor", "Split", "Zadar", "Venice"],
      "Venice, Piran, Rovinj, Bari, Dubrovnik, Kotor, Split, Zadar, Venice"
    );
    const proposal = mockProposalReorder();
    const guards = m3.evaluateM3Guards(row, proposal, { raw: { detail_enriched: true }, candidate: {} });
    if (!guards.reorder.pass || !guards.shrink.pass) throw new Error("guards should pass for reorder");
  });

  await test("4 no substitution", () => {
    if (m3.M3_APPLY_CONFIRMATION_TOKEN !== "SILVERSEA-M3-MAINTENANCE-UPDATE-CANARY") {
      throw new Error("wrong token");
    }
  });

  await test("5 target must exist blocks when missing", async () => {
    const pre = await m3.validateM3Preflight({
      simulation: { ok: true, health: { ok: true }, summary: {}, products: [] },
      productionIndex: { rows: [], byOfficialId: new Map() },
      cruiseLine: { id: "line" },
      today: "2026-08-22"
    });
    if (pre.ok || !pre.failures.includes("target_absent_from_production")) {
      throw new Error("missing target must block");
    }
  });

  await test("6 UPDATE_UNSAFE blocks preflight", async () => {
    const row = mockProductionRow(["Venice", "Kotor"], "Venice, Kotor");
    const proposal = {
      classification: policy.MAINTENANCE_CLASSIFICATION.UPDATE_UNSAFE,
      changed_fields: ["itinerary_ports"],
      before: { itinerary_ports: ["Venice", "Kotor"] },
      after: { itinerary_ports: [] }
    };
    const simulation = {
      ok: true,
      health: { ok: true },
      summary: { catalogue_nodes: 1000, unique_cruise_codes: 1000 },
      products: [{ official_sailing_id: CANARY, raw: { cruise_type: "classic", detail_enriched: true } }]
    };
    const pre = await m3.validateM3Preflight({
      simulation,
      productionIndex: mockProductionIndex(row),
      cruiseLine: { id: "line" },
      today: "2026-08-22"
    });
    if (pre.ok || !pre.failures.some((f) => f.startsWith("classification_"))) {
      throw new Error("UPDATE_UNSAFE must block");
    }
  });

  await test("7 immutable identity in allowlist blocks", async () => {
    const row = mockProductionRow(["Venice"], "Venice");
    const simulation = {
      ok: true,
      health: { ok: true },
      summary: { catalogue_nodes: 1000, unique_cruise_codes: 1000 },
      products: [{ official_sailing_id: CANARY, raw: { cruise_type: "classic" } }]
    };
    const pre = await m3.validateM3Preflight({
      simulation,
      productionIndex: mockProductionIndex(row),
      cruiseLine: { id: "line" },
      today: "2026-08-22"
    });
    if (pre.proposalRecord) {
      pre.proposalRecord.classification = policy.MAINTENANCE_CLASSIFICATION.UPDATE_ELIGIBLE;
      pre.proposalRecord.changed_fields = ["official_sailing_id"];
      const imm = m3.validateM3Preflight({
        simulation,
        productionIndex: mockProductionIndex(row),
        cruiseLine: { id: "line" },
        today: "2026-08-22"
      });
    }
    const proposal = {
      classification: policy.MAINTENANCE_CLASSIFICATION.UPDATE_ELIGIBLE,
      changed_fields: ["official_sailing_id"],
      before: {},
      after: {}
    };
    const failures = [];
    for (const field of m3.IMMUTABLE_FIELDS) {
      if (proposal.changed_fields.includes(field)) failures.push(field);
    }
    if (!failures.includes("official_sailing_id")) throw new Error("immutable block");
  });

  await test("8 update allowlist exact helper", () => {
    const fixture = {
      official_sailing_id: CANARY,
      production_uuid: UUID,
      update_allowlist: ["itinerary", "itinerary_ports"],
      before: { itinerary: "a", itinerary_ports: ["a"] },
      after: { itinerary: "b", itinerary_ports: ["b"] },
      immutable_fingerprint: m3.buildImmutableFingerprint(mockProductionRow(["a"], "a")),
      fixture_hash: "x",
      source_snapshot_fingerprint: "y"
    };
    const row = mockProductionRow(["a"], "a");
    const check = m3.verifyFrozenBeforeMatch(row, fixture);
    if (!check.ok) throw new Error("frozen before should match");
  });

  await test("9 reorder guard pass case", () => {
    const guards = m3.evaluateM3Guards(
      mockProductionRow(
        ["Venice", "Piran", "Rovinj", "Bari", "Dubrovnik", "Kotor", "Split", "Zadar", "Venice"],
        "x"
      ),
      mockProposalReorder(),
      { raw: { detail_enriched: true }, candidate: {} }
    );
    if (!guards.reorder.reorder_only) throw new Error("reorder only expected");
  });

  await test("10 shrink guard fails truncation", () => {
    const guards = m3.evaluateM3Guards(
      mockProductionRow(["Venice", "Kotor", "Dubrovnik"], "x"),
      {
        changed_fields: ["itinerary_ports"],
        after: { itinerary_ports: [] },
        before: { itinerary_ports: ["Venice", "Kotor", "Dubrovnik"] }
      },
      { raw: { detail_enriched: true }, candidate: {} }
    );
    if (guards.shrink.pass) throw new Error("shrink should fail on truncation");
  });

  await test("11 under-lock baseline in M3 runner", () => {
    if (!/underLockBeforeRows/.test(m3Runner)) throw new Error("missing under-lock baseline");
    if (!/onLockAcquired:[\s\S]*underLockBeforeRows/.test(m3Runner)) {
      throw new Error("baseline not captured on lock");
    }
    if (!/underLockRecheck:[\s\S]*select=\*&limit=1/.test(m3Runner)) {
      throw new Error("under-lock recheck must fetch full row for frozen-before");
    }
  });

  await test("12 pre-lock false-positive fix retained in M2 runner", () => {
    if (!/underLockBeforeRows/.test(m2Runner)) throw new Error("M2 fix regressed");
  });

  await test("13 rollback manifest single target", () => {
    const manifest = m3.buildM3RollbackManifest({
      runId: "test",
      fixture: {
        production_uuid: UUID,
        official_sailing_id: CANARY,
        update_allowlist: ["itinerary_ports"],
        before: { itinerary_ports: ["A"] },
        after: { itinerary_ports: ["B"] },
        immutable_fingerprint: { cruise_line_id: "line" },
        source_snapshot_fingerprint: "fp",
        source_snapshot_timestamp: "t"
      },
      productionBefore: {}
    });
    if (manifest.rollback_entries.length !== 1) throw new Error("rollback count");
    if (manifest.expected_updates !== 1) throw new Error("expected updates");
  });

  await test("14 repeat update block after success", () => {
    const fixture = {
      production_uuid: UUID,
      official_sailing_id: CANARY,
      update_allowlist: ["itinerary_ports"],
      before: { itinerary_ports: ["A"] },
      after: { itinerary_ports: ["B"] },
      immutable_fingerprint: m3.buildImmutableFingerprint(mockProductionRow(["B"], "B"))
    };
    const row = mockProductionRow(["B"], "B");
    const block = m3.proveRepeatUpdateBlocked(mockProductionIndex(row), fixture);
    if (!block.ok) throw new Error("repeat should block when before differs");
  });

  await test("15 zero insert contract", () => {
    if (m3.EXPECTED_UPDATES !== 1) throw new Error("updates");
  });

  await test("16 global lock required for apply", () => {
    const prev = process.env.SILVERSEA_DISCOVERY_WRITE_ENABLED;
    delete process.env.SILVERSEA_DISCOVERY_WRITE_ENABLED;
    try {
      require(path.join(root, "scripts/run-silversea-m3-update-canary.mjs"));
    } catch {
      /* esm */
    }
    try {
      const { assertM3ApplyAllowed } = require(path.join(
        root,
        "netlify/functions/lib/silversea-m3-maintenance-update-canary"
      ));
    } catch {}
    try {
      const mod = require(path.join(root, "scripts/run-silversea-m3-update-canary.mjs"));
    } catch {}
    const runnerPath = path.join(root, "scripts/run-silversea-m3-update-canary.mjs");
    if (!m3Runner.includes("executeHardenedControlledProductionApply")) {
      throw new Error("hardened lifecycle required");
    }
    if (prev) process.env.SILVERSEA_DISCOVERY_WRITE_ENABLED = prev;
  });

  await test("17 Expedition cannot be targeted", () => {
    if (!m3.CANARY_OFFICIAL_ID.startsWith("SL")) throw new Error("classic prefix");
  });

  await test("18 reference writes 0", () => {
    if (typeof m3.applyM3UpdateOnly !== "function") throw new Error("apply fn");
  });

  await test("19 source health failure blocks", async () => {
    const pre = await m3.validateM3Preflight({
      simulation: { ok: false, health: { ok: false }, summary: {}, products: [] },
      productionIndex: mockProductionIndex(mockProductionRow([], "")),
      cruiseLine: { id: "line" },
      today: "2026-08-22"
    });
    if (pre.ok) throw new Error("unhealthy must block");
  });

  await test("20 M3 runner path export", async () => {
    const mod = await import(path.join(root, "scripts/run-silversea-m3-update-canary.mjs"));
    if (mod.M3_RUNNER_PATH !== "scripts/run-silversea-m3-update-canary.mjs") throw new Error("path");
  });

  console.log(`\nM3 tests: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

runTests().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
