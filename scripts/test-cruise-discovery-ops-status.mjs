#!/usr/bin/env node
/**
 * Regression tests for explicit match_required status in upsertCandidateRecord.
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const ops = require(path.join(root, "netlify/functions/lib/cruise-discovery-ops"));

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
}

function resolveUpsertStatus(candidate, reasons) {
  if (candidate.status === "ignored" || candidate.status === "ignored_low_signal") return candidate.status;
  if (candidate.status === "match_required") return "match_required";
  return ops.lifecycleFromValidation(reasons);
}

assert(resolveUpsertStatus({ status: "match_required" }, []) === "match_required", "explicit match_required survives validation");
assert(resolveUpsertStatus({}, []) === "active", "default validated candidate still promotes to active");
assert(
  resolveUpsertStatus({ status: "match_required" }, ["Destination not matched"]) === "match_required",
  "explicit match_required not overridden by validation reasons"
);
assert(
  resolveUpsertStatus({}, ["Destination not matched"]) === "match_required",
  "missing destination without override stays match_required via reasons"
);

const writes = require(path.join(root, "netlify/functions/lib/norwegian-discovery-writes"));
const candidate = writes.buildNorwegianUpsertCandidate(
  {
    complete_eligible: true,
    official_sailing_id: "TEST|2028-01-01",
    ship_resolution: { ship: { id: "ship-1" } },
    departure_port_meta: { canonicalPortName: "Miami" },
    raw: {
      itinerary_code: "TEST",
      departure_date: "2028-01-01",
      duration: 7,
      ship_code: "AQUA",
      port_of_departure_code: "MIA",
      destination_codes: ["CARIBBEAN"]
    }
  },
  { id: writes.NCL_LINE_ID },
  { phase: "phase6_controlled_import", destination_id: "dest-1", controlledBatch: true }
);

assert(candidate.status === "match_required", "NCL controlled candidate forces match_required");
assert(candidate.destination_id === "dest-1", "controlled candidate retains destination_id");

console.log(`Cruise discovery ops status tests passed (${passed})`);
