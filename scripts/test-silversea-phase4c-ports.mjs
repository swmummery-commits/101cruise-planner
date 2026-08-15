#!/usr/bin/env node
/**
 * Silversea Phase 4C port remediation tests.
 *   npm run test:silversea-phase4c-ports
 */

import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const {
  PHASE4C_CANONICAL_PORT_CREATES,
  PHASE4C_EXISTING_PORT_ALIASES,
  PHASE4C_SILVERSEA_ADAPTER_ALIASES,
  MAX_PHASE4C_CANONICAL_PORTS,
  assertPhase4cManifestWithinLimit
} = require(path.join(root, "netlify/functions/lib/silversea-phase4c-port-batch"));
const { resolveRawPortText, resetPortsCache, loadPortsCatalogue } = require(path.join(
  root,
  "netlify/functions/lib/discovery-departure-port"
));
const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const { SILVERSEA_ADAPTER_PORT_ALIASES } = require(path.join(
  root,
  "netlify/functions/lib/silversea-port-remediation"
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

test("Phase 4C manifest within 25 new canonical limit", () => {
  assertPhase4cManifestWithinLimit();
  assert(PHASE4C_CANONICAL_PORT_CREATES.length <= MAX_PHASE4C_CANONICAL_PORTS);
  assert(PHASE4C_CANONICAL_PORT_CREATES.length === 25);
});

test("Phase 4C manifest has unique canonical names", () => {
  const names = PHASE4C_CANONICAL_PORT_CREATES.map((p) => p.canonical_name);
  assert(names.length === new Set(names).size, "duplicate canonical_name");
});

test("VISJO maps to St John USVI via Silversea adapter", () => {
  resetPortsCache();
  const viaAdapter = adapter.resolveSilverseaPort("St John", "silversea_itinerary");
  assert(viaAdapter.status === "resolved", viaAdapter.status || "resolved");
  assert(viaAdapter.canonicalPortName === "St John USVI", viaAdapter.canonicalPortName);
});

test("Bare St John remains unresolved globally", () => {
  resetPortsCache();
  const resolution = resolveRawPortText("St John");
  assert(resolution.status !== "resolved", "global ambiguity preserved");
});

test("VISJO not mapped to St Thomas or St Johns Antigua", () => {
  resetPortsCache();
  const viaAdapter = adapter.resolveSilverseaPort("St John", "silversea_itinerary");
  assert(viaAdapter.canonicalPortName !== "St Thomas", "not St Thomas");
  assert(viaAdapter.canonicalPortName !== "St Johns Antigua", "not Antigua");
});

test("Falmouth Cornwall distinct from Falmouth Jamaica", () => {
  const f = PHASE4C_CANONICAL_PORT_CREATES.find((p) => p.canonical_name === "Falmouth Cornwall");
  assert(f?.country === "United Kingdom", "Falmouth Cornwall is UK");
  resetPortsCache();
  const jm = resolveRawPortText("Falmouth Jamaica");
  assert(jm.status === "resolved" && jm.canonicalPortName === "Falmouth Jamaica", "Jamaica unchanged");
});

test("Silversea St John adapter alias registered", () => {
  assert(SILVERSEA_ADAPTER_PORT_ALIASES["st john"] === "St John USVI");
});

test("Phase 4C high-impact ports resolve after catalogue load", () => {
  resetPortsCache();
  for (const spec of [
    "Honfleur",
    "Deshaies",
    "Molde (Romsdal)",
    "Santander",
    "Ystad",
    "Portoferraio (Elba)",
    "Cruz Bay"
  ]) {
    const resolution = resolveRawPortText(spec);
    assert(resolution.status === "resolved", `${spec} -> ${resolution.status}`);
  }
});

test("Phase 4B ports still resolve", () => {
  resetPortsCache();
  for (const spec of ["Patmos", "Saint Tropez", "Sete", "Porto Mahon", "Ha Long Bay"]) {
    const resolution = resolveRawPortText(spec);
    assert(resolution.status === "resolved", `${spec} -> ${resolution.status}`);
  }
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

test("Phase 4C adapter mappings documented in manifest", () => {
  assert(PHASE4C_SILVERSEA_ADAPTER_ALIASES.length === 1);
  assert(PHASE4C_SILVERSEA_ADAPTER_ALIASES[0].silversea_port_code === "VISJO");
});

test("No duplicate Phase 4C vs Phase 4B canonical names", () => {
  const phase4b = require(path.join(root, "netlify/functions/lib/silversea-phase4b-port-batch"));
  const bNames = new Set(phase4b.PHASE4B_CANONICAL_PORT_CREATES.map((p) => p.canonical_name));
  for (const spec of PHASE4C_CANONICAL_PORT_CREATES) {
    assert(!bNames.has(spec.canonical_name), `duplicate with 4B: ${spec.canonical_name}`);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(`${failure.name}: ${failure.error}`);
  process.exit(1);
}
