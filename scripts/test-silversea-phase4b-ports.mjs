#!/usr/bin/env node
/**
 * Silversea Phase 4B port remediation tests.
 *   npm run test:silversea-phase4b-ports
 */

import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const {
  PHASE4B_CANONICAL_PORT_CREATES,
  PHASE4B_EXISTING_PORT_ALIASES,
  MAX_PHASE4B_CANONICAL_PORTS,
  assertPhase4bManifestWithinLimit
} = require(path.join(root, "netlify/functions/lib/silversea-phase4b-port-batch"));
const { resolveRawPortText, resetPortsCache, loadPortsCatalogue } = require(path.join(
  root,
  "netlify/functions/lib/discovery-departure-port"
));
const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const { SILVERSEA_ADAPTER_PORT_ALIASES } = require(path.join(
  root,
  "netlify/functions/lib/silversea-port-remediation"
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

test("Phase 4B manifest within 25 new canonical limit", () => {
  assertPhase4bManifestWithinLimit();
  assert(PHASE4B_CANONICAL_PORT_CREATES.length <= MAX_PHASE4B_CANONICAL_PORTS);
  assert(PHASE4B_CANONICAL_PORT_CREATES.length === 25);
});

test("Phase 4B manifest has unique canonical names", () => {
  const names = PHASE4B_CANONICAL_PORT_CREATES.map((p) => p.canonical_name);
  assert(names.length === new Set(names).size, "duplicate canonical_name");
});

test("St John VISJO not in Phase 4B manifest", () => {
  const hit = [...PHASE4B_CANONICAL_PORT_CREATES, ...PHASE4B_EXISTING_PORT_ALIASES].find(
    (p) => p.silversea_port_code === "VISJO" || p.silversea_source_name === "St John"
  );
  assert(!hit, "St John USVI must remain unresolved");
});

test("Gallipoli is Italy not Turkey in manifest", () => {
  const g = PHASE4B_CANONICAL_PORT_CREATES.find((p) => p.canonical_name === "Gallipoli");
  assert(g?.country === "Italy", "Gallipoli must be Apulia Italy");
});

test("Miyako Iwate distinct from Miyakojima", () => {
  const m = PHASE4B_CANONICAL_PORT_CREATES.find((p) => p.canonical_name === "Miyako Iwate");
  assert(m, "Miyako Iwate required");
  assert(m.silversea_port_code === "JPMYW", "JPMYW code");
});

test("Silversea Vik adapter alias maps to Vik Norway", () => {
  assert(SILVERSEA_ADAPTER_PORT_ALIASES.vik === "Vik Norway");
  resetPortsCache();
  const viaAdapter = adapter.resolveSilverseaPort("Vik", "silversea_itinerary");
  assert(viaAdapter.canonicalPortName === "Vik Norway", viaAdapter.status || "Vik Norway");
});

test("Phase 4B high-impact ports resolve after catalogue load", () => {
  resetPortsCache();
  for (const spec of ["Patmos", "Saint Tropez", "Sete", "Naxos", "Porto Mahon", "Ha Long Bay"]) {
    const resolution = resolveRawPortText(spec);
    assert(resolution.status === "resolved", `${spec} -> ${resolution.status}`);
  }
});

test("St John remains unresolved globally", () => {
  resetPortsCache();
  const resolution = resolveRawPortText("St John");
  assert(resolution.status !== "resolved", "St John USVI stays unresolved");
});

test("Phase 4A ports still resolve", () => {
  resetPortsCache();
  const ports = loadPortsCatalogue();
  assert(ports.some((p) => p.canonical_name === "Manila"), "Manila");
  assert(ports.some((p) => p.canonical_name === "Bonifacio"), "Bonifacio");
  for (const spec of ["Manila", "Gustavia, St. Barthelemy", "Bonifacio (Corsica)"]) {
    const resolution = resolveRawPortText(spec);
    assert(resolution.status === "resolved", spec);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(`${failure.name}: ${failure.error}`);
  process.exit(1);
}
