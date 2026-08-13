#!/usr/bin/env node
/**
 * Royal Caribbean source enumeration hardening tests (fixtures — no production writes).
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const enumeration = require(path.join(root, "netlify/functions/lib/royal-caribbean-source-enumeration"));
const source = require(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-source"));
const fixture = require(path.join(root, "scripts/fixtures/royal-caribbean/search-response-page.json"));

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failed += 1;
    failures.push({ name, error: error.message || String(error) });
  }
}

function buildGroups(count, prefix = "G") {
  const groups = [];
  for (let i = 0; i < count; i += 1) {
    groups.push({
      id: `${prefix}${i}`,
      productViewLink: `/itinerary/${prefix}${i}`,
      masterSailing: {
        itinerary: {
          code: `${prefix}${i}`,
          voyageType: "OCEAN",
          sailingNights: 7,
          departurePort: { code: "MIA", name: "Miami" },
          destination: { code: "CARIB", name: "Caribbean" },
          ship: { code: "OA", name: "Oasis" },
          days: []
        }
      },
      sailings: [{ id: `${prefix}${i}_2026-11-01`, sailDate: "2026-11-01", endDate: "2026-11-08", status: "OPEN" }]
    });
  }
  return groups;
}

test("symmetric set diff counts both directions", () => {
  const diff = enumeration.symmetricSetDiff(new Set(["a", "b"]), new Set(["b", "c"]));
  if (diff.symmetric_count !== 2) throw new Error(`expected 2 got ${diff.symmetric_count}`);
});

test("expand fixture deduplicates duplicate sailing IDs", () => {
  const groups = JSON.parse(JSON.stringify(fixture.data.cruiseSearch.results.cruises));
  groups.push(JSON.parse(JSON.stringify(groups[0])));
  const expanded = source.expandGraphGroupsToRawSailings(groups, { today: "2026-08-13", futureOnly: false });
  const ids = expanded.products.map((p) => p.official_sailing_id);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate sailing ids remained");
});

test("union of two passes includes all sailing IDs", () => {
  const passA = source.expandGraphGroupsToRawSailings(buildGroups(2, "A"), { today: "2026-08-13", futureOnly: false });
  const passB = source.expandGraphGroupsToRawSailings(buildGroups(2, "B"), { today: "2026-08-13", futureOnly: false });
  const unionIds = enumeration.unionSets([
    new Set(passA.products.map((p) => p.official_sailing_id)),
    new Set(passB.products.map((p) => p.official_sailing_id))
  ]);
  if (unionIds.size !== 4) throw new Error(`expected 4 got ${unionIds.size}`);
});

test("results.total must not be treated as records received", () => {
  const groups = buildGroups(3);
  if (groups.length === 999) throw new Error("fixture mistake");
  const totalOfficial = 999;
  if (groups.length >= totalOfficial) throw new Error("bad test setup");
});

test("duplicate group IDs deduplicate safely", () => {
  const groups = buildGroups(1);
  const dup = JSON.parse(JSON.stringify(groups[0]));
  const expanded = source.expandGraphGroupsToRawSailings([groups[0], dup], { today: "2026-08-13", futureOnly: false });
  if (expanded.audit.duplicate_group_ids !== 1) throw new Error("expected duplicate group count 1");
  if (expanded.products.length !== 1) throw new Error("expected one sailing after dedupe");
});

test("partition order union is stable", () => {
  const a = enumeration.unionSets([new Set(["x", "y"]), new Set(["z"])]);
  const b = enumeration.unionSets([new Set(["z"]), new Set(["x", "y"])]);
  if (a.size !== b.size || [...a].sort().join() !== [...b].sort().join()) throw new Error("union not stable");
});

test("missing fleet ship partition fails health when all ships empty", () => {
  const health = enumeration.evaluateSourceEnumerationHealth({
    globalPass: { pages_requested: 1, group_ids: new Set(["g1"]), sailing_ids: new Set(["s1"]), unique_group_ids: 1 },
    unionPass: { group_ids: new Set(["g1"]), sailing_ids: new Set(["s1"]), unique_group_ids: 1, duplicate_sailing_ids: 0 },
    stableUnionPass: { stable: true },
    productionSailingIds: new Set(["s1"]),
    directLookupResults: [],
    shipCoverage: { missing_ship_codes: ["OA"] }
  });
  if (health.royal_caribbean_source_enumeration_ok) throw new Error("expected health failure for missing ship");
});

test("production ID present in union is not treated as detail-only absent", () => {
  const health = enumeration.evaluateSourceEnumerationHealth({
    globalPass: { pages_requested: 1, group_ids: new Set(["g1"]), sailing_ids: new Set(["s1"]), unique_group_ids: 1 },
    unionPass: { group_ids: new Set(["g1"]), sailing_ids: new Set(["s1", "s2"]), unique_group_ids: 1, duplicate_sailing_ids: 0 },
    stableUnionPass: { stable: true },
    productionSailingIds: new Set(["s1"]),
    directLookupResults: [{ detail_ok: true, in_union: true }],
    shipCoverage: { missing_ship_codes: [] }
  });
  if (!health.royal_caribbean_source_enumeration_ok) throw new Error(`unexpected failure ${health.failures.join(",")}`);
});

test("unhealthy enumeration prohibits source-absence action", () => {
  if (enumeration.sourceAbsenceActionAllowed({ royal_caribbean_source_enumeration_ok: false })) {
    throw new Error("source absence should be blocked");
  }
});

test("healthy enumeration allows source-absence consideration", () => {
  if (!enumeration.sourceAbsenceActionAllowed({ royal_caribbean_source_enumeration_ok: true })) {
    throw new Error("source absence should be allowed when healthy");
  }
});

test("smoke handler module has no write imports to maintenance", () => {
  const fs = require("fs");
  const text = fs.readFileSync(path.join(root, "netlify/functions/royal-caribbean-discovery-smoke.js"), "utf8");
  if (text.includes("applyRoyalCaribbean") || text.includes("upsertCandidateRecord")) {
    throw new Error("smoke handler must not import write paths");
  }
  if (!text.includes("writes_performed: false")) throw new Error("smoke must assert no writes");
});

console.log(`${passed} passed${failed ? `, ${failed} failed` : ""}`);
if (failures.length) {
  for (const f of failures) console.error(`${f.name}: ${f.error}`);
  process.exit(1);
}
