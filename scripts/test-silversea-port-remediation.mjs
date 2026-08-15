#!/usr/bin/env node
/**
 * Silversea Classic port remediation tests.
 *   npm run test:silversea-port-remediation
 */

import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const source = require(path.join(root, "netlify/functions/lib/silversea-discovery-source"));
const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const remediation = require(path.join(root, "netlify/functions/lib/silversea-port-remediation"));
const { resolveRawPortText, resetPortsCache } = require(path.join(
  root,
  "netlify/functions/lib/discovery-departure-port"
));

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    failures.push({ name, error: error.message || String(error) });
    console.log(`✗ ${name} — ${error.message || error}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

test("classifyItineraryStopKind marks Tracy Arm scenic", () => {
  assert(source.classifyItineraryStopKind("Tracy Arm (Alaska)") === "scenic", "expected scenic");
});

test("classifyItineraryStopKind marks Icy Bay scenic", () => {
  assert(source.classifyItineraryStopKind("Icy Bay") === "scenic", "expected scenic");
});

test("classifyItineraryStopKind marks canal transit scenic", () => {
  assert(
    source.classifyItineraryStopKind("Cape Cod Canal Transit (Canal Transit, Massachusetts)") === "scenic",
    "expected scenic"
  );
});

test("classifyItineraryStopKind keeps actual ports as port", () => {
  assert(source.classifyItineraryStopKind("Moorea Island") === "port", "expected port");
});

test("Moorea Island alias resolves", () => {
  resetPortsCache();
  const resolution = resolveRawPortText("Moorea Island");
  assert(resolution.status === "resolved", resolution.reason || resolution.status);
  assert(resolution.canonicalPortName === "Moorea", resolution.canonicalPortName);
});

test("St. John's alias resolves to Antigua", () => {
  resetPortsCache();
  const resolution = resolveRawPortText("St. John's");
  assert(resolution.status === "resolved", resolution.reason || resolution.status);
  assert(resolution.canonicalPortName === "St Johns Antigua", resolution.canonicalPortName);
});

test("Bayonne NJ alias resolves to New York", () => {
  resetPortsCache();
  const resolution = resolveRawPortText("Bayonne, New Jersey");
  assert(resolution.status === "resolved", resolution.reason || resolution.status);
  assert(resolution.canonicalPortName === "New York", resolution.canonicalPortName);
});

test("Giardini Naxos alias resolves to Messina", () => {
  resetPortsCache();
  const resolution = resolveRawPortText("Giardini Naxos (Sicily)");
  assert(resolution.status === "resolved", resolution.reason || resolution.status);
  assert(resolution.canonicalPortName === "Messina", resolution.canonicalPortName);
});

test("Silversea adapter Kochi alias resolves to Kochi Japan", () => {
  resetPortsCache();
  const resolution = adapter.resolveSilverseaPort("Kochi", "silversea_gatsby_itinerary");
  assert(resolution.status === "resolved", resolution.reason || resolution.status);
  assert(resolution.canonicalPortName === "Kochi Japan", resolution.canonicalPortName);
});

test("Silversea adapter Vik alias resolves to Vik Norway", () => {
  resetPortsCache();
  const resolution = adapter.resolveSilverseaPort("Vik", "silversea_gatsby_itinerary");
  assert(resolution.status === "resolved", resolution.reason || resolution.status);
  assert(resolution.canonicalPortName === "Vik Norway", resolution.canonicalPortName);
});

test("Hubbard Glacier resolves as catalogue port", () => {
  resetPortsCache();
  const resolution = resolveRawPortText("Hubbard Glacier");
  assert(resolution.status === "resolved", resolution.reason || resolution.status);
  assert(resolution.canonicalPortName === "Hubbard Glacier", resolution.canonicalPortName);
});

test("Panama Canal Transit alias resolves", () => {
  resetPortsCache();
  const resolution = resolveRawPortText("Panama Canal Transit");
  assert(resolution.status === "resolved", resolution.reason || resolution.status);
  assert(resolution.canonicalPortName === "Panama Canal Gatun Lake", resolution.canonicalPortName);
});

test("Motu Taha'a alias resolves to Raiatea", () => {
  resetPortsCache();
  const resolution = resolveRawPortText("Motu Taha'a");
  assert(resolution.status === "resolved", resolution.reason || resolution.status);
  assert(resolution.canonicalPortName === "Raiatea", resolution.canonicalPortName);
});

test("ambiguous St John USVI remains unresolved globally", () => {
  resetPortsCache();
  const resolution = resolveRawPortText("St John");
  assert(resolution.status !== "resolved", "St John USVI should stay unresolved without new canonical port");
});

test("non-port classifier recognises Suez Canal Transit", () => {
  assert(remediation.isNonPortScenicItineraryLabel("Suez Canal Transit"), "expected scenic label");
});

test("approved manifest has no duplicate canonical targets", () => {
  const names = remediation.APPROVED_CATALOGUE_ALIAS_WRITES.map((row) => row.canonical_name);
  assert(names.length === new Set(names).size, "duplicate canonical_name in manifest");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(`${failure.name}: ${failure.error}`);
  process.exit(1);
}
