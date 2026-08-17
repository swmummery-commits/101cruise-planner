#!/usr/bin/env node
/**
 * Princess Incident P3 — frozen payload integrity tests.
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const fp = require(path.join(root, "netlify/functions/lib/princess-frozen-payload"));
const { buildPrincessUpsertCandidate } = require(path.join(
  root,
  "netlify/functions/lib/princess-discovery-writes"
));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${passed}. ${name}`);
}

const sampleRow = {
  product_type: "cruise",
  complete_high_confidence: true,
  raw: { itinerary_id: "TST01A", ship_code: "RP", departure_date: "2027-06-01" },
  candidate: {
    ship_id: "e3924ab7-4c90-4eac-9b4a-72505d877580",
    destination_id: "835ad9b0-4e95-468e-b93b-cc9587dd713a",
    departure_date: "2027-06-01",
    return_date: "2027-06-08",
    nights: 7,
    departure_port: "Sydney",
    itinerary: "Test",
    official_url: "https://www.princess.com/cruise-search/details?voyagecode=tst01a"
  },
  destination_resolution: { destinationKey: "australia-new-zealand" },
  ship_resolution: { method: "official_line_ship_id" }
};
const cruiseLine = { id: "c19f40a7-c160-4035-a845-14dada550e1f" };

test("canonical write payload includes external_key", () => {
  const c = buildPrincessUpsertCandidate(sampleRow, cruiseLine);
  if (!c?.external_key) throw new Error("missing external_key");
});

test("canonical write payload includes identity_key", () => {
  const c = buildPrincessUpsertCandidate(sampleRow, cruiseLine);
  if (!c?.identity_key) throw new Error("missing identity_key");
});

test("valid P3 candidate cannot freeze with null external_key", () => {
  const fc = fp.buildFrozenCandidateFromProductRow(sampleRow, cruiseLine);
  const v = fp.validateFrozenCandidateKeys(fc);
  if (!v.ok || !fc.write_payload.external_key) throw new Error("should have external_key");
});

test("live payload exact match passes", () => {
  const live = buildPrincessUpsertCandidate(sampleRow, cruiseLine);
  const frozen = fp.buildFrozenCandidateFromProductRow(sampleRow, cruiseLine);
  const cmp = fp.comparePrincessLiveCandidateToFreeze({ liveCandidate: live, frozenCandidate: frozen });
  if (!cmp.ok) throw new Error(JSON.stringify(cmp.field_differences));
});

test("ship drift blocks", () => {
  const live = buildPrincessUpsertCandidate(sampleRow, cruiseLine);
  const frozen = fp.buildFrozenCandidateFromProductRow(sampleRow, cruiseLine);
  const drifted = { ...live, ship_id: "00000000-0000-0000-0000-000000000001" };
  const cmp = fp.comparePrincessLiveCandidateToFreeze({ liveCandidate: drifted, frozenCandidate: frozen });
  if (cmp.ok) throw new Error("ship drift should block");
});

test("30-row batch accepted", () => {
  fp.assertBatchSizeWithinCap(30);
});

test("31-row batch rejected", () => {
  let threw = false;
  try {
    fp.assertBatchSizeWithinCap(31);
  } catch (e) {
    threw = e.code === "p3_batch_size_exceeds_cap";
  }
  if (!threw) throw new Error("31 should reject");
});

test("final 12-row batch accepted", () => {
  fp.assertBatchSizeWithinCap(12);
});

test("batch hash drift blocks", () => {
  const a = fp.buildFrozenCandidateFromProductRow(sampleRow, cruiseLine);
  const b = fp.buildFrozenCandidateFromProductRow(
    { ...sampleRow, candidate: { ...sampleRow.candidate, nights: 8 } },
    cruiseLine
  );
  const h1 = fp.hashPrincessFrozenBatch([a]);
  const h2 = fp.hashPrincessFrozenBatch([b]);
  if (h1 === h2) throw new Error("hash should differ");
});

console.log(`\ntest-princess-incident-p3: ${passed} passed`);
