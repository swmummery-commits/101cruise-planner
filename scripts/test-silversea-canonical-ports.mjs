#!/usr/bin/env node
/**
 * Silversea Phase 4A canonical port tests.
 *   npm run test:silversea-canonical-ports
 */

import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const {
  PHASE4A_CANONICAL_PORT_CREATES,
  MAX_PHASE4A_CANONICAL_PORTS,
  assertManifestWithinLimit
} = require(path.join(root, "netlify/functions/lib/silversea-canonical-port-batch"));
const { resolveRawPortText, resetPortsCache, loadPortsCatalogue } = require(path.join(
  root,
  "netlify/functions/lib/discovery-departure-port"
));
const { normaliseName } = require(path.join(
  root,
  "netlify/functions/lib/cruise-finder-v2/enrichment/match-entities"
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

test("manifest within 25 port limit", () => {
  assertManifestWithinLimit();
  assert(PHASE4A_CANONICAL_PORT_CREATES.length <= MAX_PHASE4A_CANONICAL_PORTS);
  assert(PHASE4A_CANONICAL_PORT_CREATES.length === 25);
});

test("manifest has unique canonical names", () => {
  const names = PHASE4A_CANONICAL_PORT_CREATES.map((p) => p.canonical_name);
  assert(names.length === new Set(names).size, "duplicate canonical_name");
});

test("manifest has unique match keys by country", () => {
  const keys = PHASE4A_CANONICAL_PORT_CREATES.map((p) =>
    `${normaliseName(p.canonical_name)}|${normaliseName(p.country)}`
  );
  assert(keys.length === new Set(keys).size, "duplicate match key");
});

test("endpoint blockers Manila Mahe Dakar included", () => {
  const names = PHASE4A_CANONICAL_PORT_CREATES.map((p) => p.canonical_name);
  assert(names.includes("Manila"), "Manila");
  assert(names.includes("Mahe"), "Mahe");
  assert(names.includes("Dakar"), "Dakar");
});

test("St John USVI not in manifest", () => {
  const hit = PHASE4A_CANONICAL_PORT_CREATES.find((p) => p.silversea_port_code === "VISJO");
  assert(!hit, "St John USVI must remain unresolved");
});

test("Silversea source names resolve after catalogue load", () => {
  resetPortsCache();
  const ports = loadPortsCatalogue();
  const manila = ports.find((p) => p.canonical_name === "Manila");
  assert(manila, "Manila must exist in CSV after Phase 4A apply");
  for (const spec of ["Manila", "Mahe", "Dakar", "Gustavia, St. Barthelemy", "Nafplion"]) {
    const resolution = resolveRawPortText(spec);
    assert(resolution.status === "resolved", `${spec} -> ${resolution.status}`);
  }
});

test("St John remains unresolved globally", () => {
  resetPortsCache();
  const resolution = resolveRawPortText("St John");
  assert(resolution.status !== "resolved", "St John USVI stays unresolved");
});

test("Bonifacio resolves to Bonifacio not Ajaccio", () => {
  resetPortsCache();
  const resolution = resolveRawPortText("Bonifacio (Corsica)");
  assert(resolution.status === "resolved", resolution.reason || resolution.status);
  assert(resolution.canonicalPortName === "Bonifacio", resolution.canonicalPortName);
});

test("Sorrento and Paros CSV parity with existing Supabase ports", () => {
  resetPortsCache();
  const ports = loadPortsCatalogue();
  for (const name of ["Sorrento", "Paros"]) {
    assert(ports.some((p) => p.canonical_name === name), `${name} must exist in CSV`);
    const resolution = resolveRawPortText(name);
    assert(resolution.status === "resolved" && resolution.canonicalPortName === name, name);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(`${failure.name}: ${failure.error}`);
  process.exit(1);
}
