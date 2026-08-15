#!/usr/bin/env node
/**
 * Silversea Phase 4D port remediation tests.
 *   npm run test:silversea-phase4d-ports
 */

import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const {
  PHASE4D_CANONICAL_PORT_CREATES,
  PHASE4D_EXISTING_PORT_ALIASES,
  PHASE4D_SILVERSEA_ADAPTER_ALIASES,
  MAX_PHASE4D_CANONICAL_PORTS,
  assertPhase4dManifestWithinLimit
} = require(path.join(root, "netlify/functions/lib/silversea-phase4d-port-batch"));
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

test("Phase 4D manifest within 25 new canonical limit", () => {
  assertPhase4dManifestWithinLimit();
  assert(PHASE4D_CANONICAL_PORT_CREATES.length <= MAX_PHASE4D_CANONICAL_PORTS);
  assert(PHASE4D_CANONICAL_PORT_CREATES.length === 25);
});

test("Phase 4D manifest has unique canonical names", () => {
  const names = PHASE4D_CANONICAL_PORT_CREATES.map((p) => p.canonical_name);
  assert(names.length === new Set(names).size, "duplicate canonical_name");
});

test("Great Exuma distinct from generic Bahamas", () => {
  const g = PHASE4D_CANONICAL_PORT_CREATES.find((p) => p.canonical_name === "Great Exuma");
  assert(g?.country === "Bahamas", "Great Exuma is Bahamas");
  assert(g?.silversea_port_code === "BSEXU");
});

test("Spanish Town is Virgin Gorda BVI not Jamaica", () => {
  const s = PHASE4D_CANONICAL_PORT_CREATES.find((p) => p.canonical_name === "Spanish Town Virgin Gorda");
  assert(s?.country_code === "VG", "VGSPS is BVI");
});

test("Porto Santo Madeira distinct from Porto Santo Stefano Italy", () => {
  const p = PHASE4D_CANONICAL_PORT_CREATES.find((p) => p.canonical_name === "Porto Santo Madeira");
  assert(p?.country === "Portugal");
  const it = loadPortsCatalogue().find((row) => row.canonical_name === "Porto Santo Stefano");
  assert(it?.country === "Italy");
});

test("Douglas Isle of Man is specific harbour not island region", () => {
  const d = PHASE4D_CANONICAL_PORT_CREATES.find((p) => p.canonical_name === "Douglas Isle of Man");
  assert(d?.city === "Douglas");
});

test("Newcastle AUNTL via Silversea adapter to Newcastle Australia", () => {
  resetPortsCache();
  const viaAdapter = adapter.resolveSilverseaPort("Newcastle", "silversea_itinerary");
  assert(viaAdapter.canonicalPortName === "Newcastle Australia", viaAdapter.canonicalPortName || "adapter");
  const global = resolveRawPortText("Newcastle");
  assert(global.status !== "resolved" || global.canonicalPortName === "Newcastle upon Tyne" || global.status === "ambiguous");
});

test("Albany Western Australia alias resolves to Albany Australia", () => {
  resetPortsCache();
  const r = resolveRawPortText("Albany (Western Australia)");
  assert(r.status === "resolved" && r.canonicalPortName === "Albany Australia");
});

test("Phase 4D high-impact ports resolve after catalogue load", () => {
  resetPortsCache();
  for (const spec of [
    "St Peter Port",
    "Aalborg",
    "Exuma Island",
    "Amalfi",
    "Spanish Town",
    "K'Gari (formerly Fraser Island)"
  ]) {
    const resolution = adapter.resolveSilverseaPort(spec, "silversea_itinerary");
    assert(resolution.status === "resolved", `${spec} -> ${resolution.status}`);
  }
});

test("Phase 4C and 4A ports still resolve", () => {
  resetPortsCache();
  for (const spec of ["Honfleur", "Patmos", "St John"]) {
    const resolution = adapter.resolveSilverseaPort(spec, "silversea_itinerary");
    assert(resolution.status === "resolved", spec);
  }
});

test("Silversea Newcastle adapter registered", () => {
  assert(SILVERSEA_ADAPTER_PORT_ALIASES.newcastle === "Newcastle Australia");
});

test("No duplicate Phase 4D vs prior phase canonical names", () => {
  const phase4c = require(path.join(root, "netlify/functions/lib/silversea-phase4c-port-batch"));
  const prior = [
    ...phase4c.PHASE4C_CANONICAL_PORT_CREATES.map((p) => p.canonical_name),
    ...require(path.join(root, "netlify/functions/lib/silversea-phase4b-port-batch")).PHASE4B_CANONICAL_PORT_CREATES.map(
      (p) => p.canonical_name
    )
  ];
  for (const spec of PHASE4D_CANONICAL_PORT_CREATES) {
    assert(!prior.includes(spec.canonical_name), `duplicate: ${spec.canonical_name}`);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(`${failure.name}: ${failure.error}`);
  process.exit(1);
}
