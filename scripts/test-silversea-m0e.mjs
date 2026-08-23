#!/usr/bin/env node
/**
 * Silversea M0E — read-only audit offline/static tests.
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const {
  auditFutureInsertPersistence,
  auditAggregateVerifierSafety,
  auditWriterCoverage,
  M0E_RUNNER_PATH
} = await import(path.join(root, "scripts/run-silversea-m0e-audit.mjs"));

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

test("M0E runner path stable", () => {
  if (M0E_RUNNER_PATH !== "scripts/run-silversea-m0e-audit.mjs") throw new Error("path");
});

test("future INSERT persistence proof", () => {
  const r = auditFutureInsertPersistence();
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
});

test("aggregate verifier cannot mask failure", () => {
  const r = auditAggregateVerifierSafety();
  if (!r.ok) throw new Error("aggregate");
});

test("Silversea-relevant writers use global lock", () => {
  const r = auditWriterCoverage();
  if (!r.ok || r.unlocked_relevant_count !== 0) throw new Error(JSON.stringify(r));
});

console.log(`\nM0E tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
