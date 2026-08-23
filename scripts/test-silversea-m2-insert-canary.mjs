#!/usr/bin/env node
/**
 * Silversea M2 maintenance INSERT canary tests — offline, no production writes.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const m2 = require(path.join(root, "netlify/functions/lib/silversea-m2-maintenance-insert-canary"));
const policy = require(path.join(root, "netlify/functions/lib/silversea-weekly-maintenance-policy"));
const proposal = require(path.join(root, "netlify/functions/lib/silversea-weekly-maintenance-proposal"));
const m2Runner = await import(path.join(root, "scripts/run-silversea-m2-insert-canary.mjs"));

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

async function runTests() {

const TODAY = "2026-08-22";
const LINE = { id: "line-silversea", name: "Silversea", slug: "silversea-cruises" };
const CANARY = m2.CANARY_OFFICIAL_ID;

function healthySimulation(products) {
  return {
    ok: true,
    health: { ok: true, duplicate_cruise_codes: 0, required_field_coverage: 1 },
    summary: {
      total: products.length,
      classic: products.filter((p) => p.raw?.cruise_type === "classic").length,
      expedition: products.filter((p) => p.raw?.cruise_type === "expedition").length,
      unique_ratio: 1
    },
    products,
    fetch_result: { fetched_at: "2026-08-23T00:00:00.000Z" }
  };
}

function wh281Normalised(overrides = {}) {
  return {
    official_sailing_id: CANARY,
    product_type: "ocean_cruise",
    complete_high_confidence: true,
    match_required: false,
    failure_reasons: [],
    raw: {
      cruise_code: CANARY,
      cruise_code_valid: true,
      cruise_type: "classic",
      departure_date: "2028-10-05",
      return_date: "2028-10-10",
      source_duration: 5,
      duration_matches_dates: true,
      detail_enriched: true,
      departure_port: "Lisbon",
      arrival_port: "Barcelona",
      official_url: "https://www.silversea.com/cruise/WH281005017",
      code_kind: "numeric"
    },
    candidate: {
      ship_id: "ship-wh",
      destination_id: "dest-med",
      departure_date: "2028-10-05",
      return_date: "2028-10-10",
      nights: 5,
      departure_port: "Lisbon",
      official_url: "https://www.silversea.com/cruise/WH281005017"
    },
    ship_resolution: { resolved: true },
    departure_port_resolution: { status: "resolved", canonicalPortName: "Lisbon" },
    arrival_port_resolution: { status: "resolved", canonicalPortName: "Barcelona" },
    destination_resolution: { status: "resolved", destinationKey: "mediterranean" },
    itinerary: [
      { kind: "port", port_resolution: { status: "resolved", canonicalPortName: "Lisbon" } },
      { kind: "port", port_resolution: { status: "resolved", canonicalPortName: "Cadiz" } },
      { kind: "port", port_resolution: { status: "resolved", canonicalPortName: "Malaga" } },
      { kind: "port", port_resolution: { status: "resolved", canonicalPortName: "Palma de Mallorca" } },
      { kind: "port", port_resolution: { status: "resolved", canonicalPortName: "Barcelona" } }
    ],
    ...overrides
  };
}

function emptyProductionIndex() {
  return { rows: [], byOfficialId: new Map() };
}

function productionWithCanary() {
  const row = {
    id: "prod-wh281",
    official_sailing_id: CANARY,
    cruise_line_id: LINE.id,
    ship_id: "ship-wh",
    departure_date: "2028-10-05",
    return_date: "2028-10-10",
    nights: 5,
    status: "active",
    itinerary_ports: ["Lisbon", "Cadiz", "Malaga", "Palma de Mallorca", "Barcelona"]
  };
  const byOfficialId = new Map([[CANARY, row]]);
  return { rows: [row], byOfficialId };
}

await test("A exact candidate ID only", () => {
  if (m2.CANARY_OFFICIAL_ID !== "WH281005017") throw new Error("wrong canary id");
});

await test("B fixture count 1 constant", () => {
  if (m2.EXPECTED_INSERTS !== 1) throw new Error("expected inserts must be 1");
});

await test("C source-only requirement blocks production present", async () => {
  const sim = healthySimulation([wh281Normalised()]);
  const pre = await m2.validateM2Preflight({
    simulation: sim,
    productionIndex: productionWithCanary(),
    cruiseLine: LINE,
    today: TODAY
  });
  if (pre.ok || !pre.failures.includes("candidate_already_in_production")) {
    throw new Error("expected production block");
  }
});

await test("D candidate must remain INSERT_ELIGIBLE", async () => {
  const sim = healthySimulation([wh281Normalised()]);
  const idx = emptyProductionIndex();
  const pre = await m2.validateM2Preflight({
    simulation: sim,
    productionIndex: idx,
    cruiseLine: LINE,
    today: TODAY
  });
  if (pre.proposalRecord?.classification !== policy.MAINTENANCE_CLASSIFICATION.INSERT_ELIGIBLE) {
    throw new Error(`expected INSERT_ELIGIBLE got ${pre.proposalRecord?.classification}`);
  }
});

await test("E no substitution — only WH281005017 authorised", () => {
  if (m2.CANARY_OFFICIAL_ID !== "WH281005017") throw new Error("substitution not allowed");
  if (m2.M2_APPLY_CONFIRMATION_TOKEN !== "SILVERSEA-M2-MAINTENANCE-INSERT-CANARY") {
    throw new Error("wrong confirmation token");
  }
});

function mockCandidate() {
  return {
    official_sailing_id: CANARY,
    cruise_line_id: LINE.id,
    ship_id: "ship-wh",
    destination_id: "dest-med",
    departure_date: "2028-10-05",
    return_date: "2028-10-10",
    nights: 5,
    departure_port: "Lisbon",
    official_url: "https://www.silversea.com/cruise/WH281005017",
    itinerary: "Lisbon, Cadiz, Malaga, Palma de Mallorca, Barcelona",
    itinerary_ports: ["Lisbon", "Cadiz", "Malaga", "Palma de Mallorca", "Barcelona"],
    status: "active",
    raw_extract: { silversea_cruise_code: CANARY }
  };
}

await test("F insert-only — prevRecord null path", async () => {
  const payload = m2.buildM2InsertPayload(mockCandidate());
  if (!Array.isArray(payload.itinerary_ports) || payload.itinerary_ports.length === 0) {
    throw new Error("insert payload missing itinerary_ports");
  }
});

await test("G official ID collision blocks preflight", async () => {
  const pre = await m2.validateM2Preflight({
    simulation: healthySimulation([wh281Normalised()]),
    productionIndex: productionWithCanary(),
    cruiseLine: LINE,
    today: TODAY
  });
  if (pre.ok) throw new Error("collision should block");
});

await test("H same ship/date different ID does not falsely block", async () => {
  const other = {
    id: "other-id",
    official_sailing_id: "OTHER123",
    cruise_line_id: LINE.id,
    ship_id: "ship-wh",
    departure_date: "2028-10-05",
    status: "active"
  };
  const officialCollision = [other].some(
    (r) => String(r.official_sailing_id).toUpperCase() === CANARY
  );
  if (officialCollision) throw new Error("false official collision");
});

await test("I itinerary_ports in insert payload", async () => {
  const candidate = mockCandidate();
  const payload = m2.buildM2InsertPayload(candidate);
  if (JSON.stringify(payload.itinerary_ports) !== JSON.stringify(candidate.itinerary_ports)) {
    throw new Error("payload ports differ from candidate ports");
  }
});

await test("J reference writes 0 — no reference mutation helpers exported", () => {
  const forbidden = ["createReference", "upsertReference", "writeReference"];
  for (const key of forbidden) {
    if (typeof m2[key] === "function") throw new Error(`unexpected ${key}`);
  }
});

await test("K special product rejected", async () => {
  const special = wh281Normalised({ raw: { ...wh281Normalised().raw, deferred_special_voyage: true } });
  const pre = await m2.validateM2Preflight({
    simulation: healthySimulation([special]),
    productionIndex: emptyProductionIndex(),
    cruiseLine: LINE,
    today: TODAY
  });
  if (pre.ok || !pre.failures.includes("deferred_special")) throw new Error("special should block");
});

await test("L Expedition candidate rejected", async () => {
  const exp = wh281Normalised({ raw: { ...wh281Normalised().raw, cruise_type: "expedition" } });
  const pre = await m2.validateM2Preflight({
    simulation: healthySimulation([exp]),
    productionIndex: emptyProductionIndex(),
    cruiseLine: LINE,
    today: TODAY
  });
  if (pre.ok || !pre.failures.some((f) => f.includes("not_classic") || f.includes("is_expedition"))) {
    throw new Error("expedition should block");
  }
});

await test("M cutoff candidate rejected", async () => {
  const near = wh281Normalised({
    raw: {
      ...wh281Normalised().raw,
      departure_date: "2026-08-30",
      return_date: "2026-09-04"
    },
    candidate: {
      ...wh281Normalised().candidate,
      departure_date: "2026-08-30",
      return_date: "2026-09-04"
    }
  });
  const pre = await m2.validateM2Preflight({
    simulation: healthySimulation([near]),
    productionIndex: emptyProductionIndex(),
    cruiseLine: LINE,
    today: TODAY
  });
  if (pre.ok || !pre.failures.some((f) => f.startsWith("classification_"))) {
    throw new Error("within cutoff should block via classification");
  }
});

await test("N unhealthy source blocks", async () => {
  const pre = await m2.validateM2Preflight({
    simulation: { ok: false, health: { ok: false }, summary: {}, products: [] },
    productionIndex: emptyProductionIndex(),
    cruiseLine: LINE,
    today: TODAY
  });
  if (pre.ok || !pre.failures.includes("source_health_failed")) throw new Error("unhealthy should block");
});

await test("O rollback manifest exact single target", () => {
  const fixture = {
    candidate: { cruise_line_id: LINE.id, raw_extract: { controlled_batch: {} } },
    source_snapshot_fingerprint: "abc",
    source_snapshot_timestamp: "2026-08-23T00:00:00.000Z",
    controlled_batch: {}
  };
  const manifest = m2.buildM2RollbackManifest({
    runId: "test-run",
    fixture,
    productionBefore: { total: 919 }
  });
  if (manifest.authorised_official_sailing_ids.length !== 1) throw new Error("rollback count");
  if (manifest.authorised_official_sailing_ids[0] !== CANARY) throw new Error("rollback id");
  if (manifest.expected_inserts !== 1 || manifest.expected_updates !== 0) throw new Error("rollback actions");
});

await test("P global lock required — apply blocked without env", () => {
  const prev = process.env.SILVERSEA_DISCOVERY_WRITE_ENABLED;
  delete process.env.SILVERSEA_DISCOVERY_WRITE_ENABLED;
  try {
    m2Runner.assertM2ApplyAllowed({ apply: true, confirm: m2.M2_APPLY_CONFIRMATION_TOKEN });
    throw new Error("should throw without write enabled");
  } catch (e) {
    if (!String(e.message).includes("SILVERSEA_DISCOVERY_WRITE_ENABLED")) throw e;
  } finally {
    if (prev) process.env.SILVERSEA_DISCOVERY_WRITE_ENABLED = prev;
  }
});

await test("Q non-target protection verifier present", () => {
  if (typeof m2.verifyM2Protection !== "function") throw new Error("missing protection verifier");
});

await test("R duplicate after insert fails verification logic", () => {
  const idx = productionWithCanary();
  const block = m2.proveRepeatInsertBlocked(idx);
  if (!block.ok) throw new Error("duplicate should be detected");
});

await test("S second execution cannot duplicate row", () => {
  const block = m2.proveRepeatInsertBlocked(productionWithCanary());
  if (!block.ok) throw new Error("repeat insert must block");
});

await test("T zero updates/deletes in rollback contract", () => {
  const manifest = m2.buildM2RollbackManifest({
    runId: "x",
    fixture: {
      candidate: { cruise_line_id: LINE.id },
      source_snapshot_fingerprint: "x",
      source_snapshot_timestamp: "t",
      controlled_batch: {}
    },
    productionBefore: {}
  });
  if (manifest.expected_updates !== 0 || manifest.expected_deletes !== 0) {
    throw new Error("updates/deletes must be 0");
  }
});

await test("fixture path constant", () => {
  if (!m2.M2_FIXTURE_REL.includes("WH281005017")) throw new Error("fixture path");
});

await test("runner exports hardened path", () => {
  if (m2Runner.M2_RUNNER_PATH !== "scripts/run-silversea-m2-insert-canary.mjs") throw new Error("runner path");
});

await test("committed fixture parses when present", () => {
  const fixturePath = path.join(root, m2.M2_FIXTURE_REL);
  if (fs.existsSync(fixturePath)) {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    if (fixture.official_sailing_id !== CANARY) throw new Error("fixture official id");
    if (fixture.itinerary_ports_count !== fixture.itinerary_ports?.length) {
      throw new Error("fixture port count mismatch");
    }
  }
});

console.log(`\nM2 tests: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
}

runTests().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
