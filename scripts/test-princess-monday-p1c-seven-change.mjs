#!/usr/bin/env node
/**
 * Princess Monday P1C seven-change remediation tests.
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const p1c = require(path.join(root, "netlify/functions/lib/princess-monday-p1c-seven-change"));
const updatePolicy = require(path.join(root, "netlify/functions/lib/princess-weekly-update-policy"));
const quality = require(path.join(root, "netlify/functions/lib/princess-weekly-quality"));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${passed}. ${name}`);
}

const baseProduction = {
  official_sailing_id: "SBR17A|MJ|2027-01-06",
  external_key: "ext1",
  identity_key: "id1",
  ship_id: "ship1",
  destination_id: "dest1",
  departure_date: "2027-01-06",
  return_date: "2027-01-23",
  nights: 17,
  departure_port: "Buenos Aires",
  status: "active",
  official_url: "https://example.com/a",
  itinerary: "Antarctica & South America",
  raw_extract: { princess_itinerary_name: "Antarctica & South America" }
};

test("approved set exactly 7 identities", () => {
  const set = p1c.approvedOfficialIdSet();
  if (set.size !== 7) throw new Error(`expected 7 got ${set.size}`);
});

test("eighth identity rejected", () => {
  const r = p1c.rejectEighthIdentity("UNKNOWN|XX|2099-01-01");
  if (r.ok) throw new Error("eighth identity must be rejected");
});

test("approved update field list exactly itinerary", () => {
  const candidate = {
    ...baseProduction,
    itinerary: "Antarctica & Patagonia",
    raw_extract: { princess_itinerary_name: "Antarctica & Patagonia" }
  };
  const diff = p1c.diffAllowedUpdate(baseProduction, candidate);
  if (!diff.ok) throw new Error(JSON.stringify(diff));
  if (diff.changed_fields.join(",") !== "itinerary") throw new Error("only itinerary");
});

test("ship change blocks", () => {
  const candidate = { ...baseProduction, ship_id: "other", itinerary: "Antarctica & Patagonia" };
  const diff = p1c.diffAllowedUpdate(baseProduction, candidate);
  if (diff.ok) throw new Error("ship change must block");
});

test("departure change blocks", () => {
  const candidate = { ...baseProduction, departure_date: "2027-01-07", itinerary: "Antarctica & Patagonia" };
  if (p1c.diffAllowedUpdate(baseProduction, candidate).ok) throw new Error("departure must block");
});

test("return change blocks", () => {
  const candidate = { ...baseProduction, return_date: "2027-01-24", itinerary: "Antarctica & Patagonia" };
  if (p1c.diffAllowedUpdate(baseProduction, candidate).ok) throw new Error("return must block");
});

test("nights change blocks", () => {
  const candidate = { ...baseProduction, nights: 16, itinerary: "Antarctica & Patagonia" };
  if (p1c.diffAllowedUpdate(baseProduction, candidate).ok) throw new Error("nights must block");
});

test("destination change blocks", () => {
  const candidate = { ...baseProduction, destination_id: "x", itinerary: "Antarctica & Patagonia" };
  if (p1c.diffAllowedUpdate(baseProduction, candidate).ok) throw new Error("destination must block");
});

test("departure-port change blocks", () => {
  const candidate = { ...baseProduction, departure_port: "Other", itinerary: "Antarctica & Patagonia" };
  if (p1c.diffAllowedUpdate(baseProduction, candidate).ok) throw new Error("port must block");
});

test("external_key change blocks", () => {
  const candidate = { ...baseProduction, external_key: "other", itinerary: "Antarctica & Patagonia" };
  if (p1c.diffAllowedUpdate(baseProduction, candidate).ok) throw new Error("external must block");
});

test("identity_key change blocks", () => {
  const candidate = { ...baseProduction, identity_key: "other", itinerary: "Antarctica & Patagonia" };
  if (p1c.diffAllowedUpdate(baseProduction, candidate).ok) throw new Error("identity must block");
});

test("official ID change blocks via eighth identity guard", () => {
  if (p1c.assertApprovedIdentity("OTHER|MJ|2027-01-06")) throw new Error("unapproved id");
});

test("official URL change blocks", () => {
  const candidate = { ...baseProduction, official_url: "https://other", itinerary: "Antarctica & Patagonia" };
  if (p1c.diffAllowedUpdate(baseProduction, candidate).ok) throw new Error("url must block");
});

test("max material writes = 7", () => {
  if (p1c.MAX_MATERIAL_WRITES !== 7) throw new Error("max writes must be 7");
});

test("insert and update counts", () => {
  if (p1c.EXPECTED_INSERTS !== 1 || p1c.EXPECTED_UPDATES !== 6) throw new Error("count mismatch");
});

test("freeze integrity rejects wrong size", () => {
  const r = p1c.verifyFreezeIntegrity({ batch_size: 8, entries: [], batch_hash: "x" });
  if (r.ok) throw new Error("must reject wrong size");
});

test("generic high-risk itinerary still requires review in weekly policy", () => {
  const action = updatePolicy.refinePrincessProposedActionForWeekly(
    "update_exact_legacy_match",
    baseProduction,
    { ...baseProduction, itinerary: "New Name" }
  );
  if (action !== "update_identity_review_required") throw new Error("weekly policy must still review");
});

test("20% safeguard unchanged", () => {
  const expansion = quality.evaluatePrincessEligibleExpansionAnomaly({
    currentEligible: 2485,
    previousEligible: 2061,
    proposedInserts: 0
  });
  if (expansion.passed) throw new Error("20% safeguard must hold");
});

test("weekly 30-write cap unchanged", () => {
  if (quality.PRINCESS_WEEKLY_WRITE_CAP !== 30) throw new Error("30 cap must hold");
});

test("post-write protected-field immutability helper", () => {
  const freeze = {
    entries: [
      {
        kind: "update",
        official_sailing_id: baseProduction.official_sailing_id,
        discovered_cruise_id: "uuid-1",
        production_before: p1c.pickCanonicalFields(baseProduction),
        approved_after: { ...p1c.pickCanonicalFields(baseProduction), itinerary: "Antarctica & Patagonia" }
      }
    ]
  };
  const row = {
    id: "uuid-1",
    ...baseProduction,
    itinerary: "Antarctica & Patagonia"
  };
  const v = p1c.verifyPostWriteSevenChange({ freeze, rowsById: new Map([["uuid-1", row]]) });
  if (!v.ok) throw new Error(JSON.stringify(v.issues));
});

test("collateral immutability helper", () => {
  const before = {
    rows: [
      { id: "a", official_sailing_id: "A", itinerary: "X", ship_id: "1", destination_id: "d", departure_date: "2027-01-01", return_date: "2027-01-08", nights: 7, departure_port: "P", status: "active", official_url: "u", external_key: "e", identity_key: "i", match_confidence: "high" },
      { id: "b", official_sailing_id: "B", itinerary: "Y", ship_id: "1", destination_id: "d", departure_date: "2027-01-01", return_date: "2027-01-08", nights: 7, departure_port: "P", status: "active", official_url: "u", external_key: "e2", identity_key: "i2", match_confidence: "high" }
    ]
  };
  const after = { rows: [...before.rows] };
  const r = p1c.verifyCollateralImmutability(before, after, new Set(["a"]));
  if (!r.ok) throw new Error("untouched row must be immutable");
});

test("P1C write mode token present", () => {
  if (p1c.APPLY_CONFIRMATION_TOKEN !== "PRINCESS-MONDAY-P1C-SEVEN-CHANGE-REMEDIATION") {
    throw new Error("confirmation token mismatch");
  }
});

console.log(`\ntest-princess-monday-p1c-seven-change: ${passed} passed`);
