#!/usr/bin/env node
import assert from "assert";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const {
  findDuplicateCanonicalPorts,
  isSuspiciousCanonicalPortName,
  assertCanonicalPortNameAllowed
} = require(path.join(root, "scripts/lib/port-canonical-integrity.cjs"));

assert.throws(() => assertCanonicalPortNameAllowed("April 2028"), /year_or_date/);
assert.throws(() => assertCanonicalPortNameAllowed("At Sea"), /itinerary_label/);
assert.doesNotThrow(() => assertCanonicalPortNameAllowed("Sydney"));
assert.doesNotThrow(() => assertCanonicalPortNameAllowed("Port Chalmers"));

const dupes = findDuplicateCanonicalPorts([
  { id: "1", canonical_name: "Miami", country: "Florida", match_key: "miami|florida" },
  { id: "2", canonical_name: "Miami", country: "United States", match_key: "miami|united states" }
]);
assert.equal(dupes.length, 1, "same canonical name different country flagged");

const legit = findDuplicateCanonicalPorts([
  { id: "1", canonical_name: "Sydney", country: "Australia", match_key: "sydney|australia" },
  { id: "2", canonical_name: "Sydney Nova Scotia", country: "Canada", match_key: "sydney nova scotia|canada" }
]);
assert.equal(legit.length, 0, "legitimate same-name ports in different countries are not duplicates");

assert.equal(isSuspiciousCanonicalPortName("April 2028").reason, "year_or_date");

console.log("test-ports-catalogue-integrity: ok");
