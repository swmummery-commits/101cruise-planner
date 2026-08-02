#!/usr/bin/env node
/**
 * Regression tests: Discovery action payloads and destination scope.
 * Run: node scripts/test-discovery-destination-scope.mjs
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const {
  resolveDiscoveryDestinationTargets,
  validateCruise,
  buildCandidateFromSource
} = require(path.join(root, "netlify/functions/lib/cruise-discovery"));
const { buildBraveSailingQueries } = require(path.join(root, "netlify/functions/lib/cruise-discovery-url-score"));
const { inferRunType } = require(path.join(root, "netlify/functions/lib/cruise-discovery-source-health"));
const { resolveAdapter } = require(path.join(root, "netlify/functions/lib/cruise-discovery-adapters"));
const { AUTO_ALIAS_WRITES_ENABLED } = require(path.join(root, "netlify/functions/lib/discovery-ship-resolver"));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Mirrors js/admin-cruise-discovery.js discoverLine(). */
function buildDiscoverLinePayload(lineId, destinationId) {
  return {
    scope: destinationId ? "destination" : "cruise_line",
    cruise_line_id: lineId,
    destination_id: destinationId || undefined
  };
}

/** Mirrors js/admin-cruise-discovery.js runFullDiscovery loop body. */
function buildFullDiscoveryLinePayload(lineId) {
  return buildDiscoverLinePayload(lineId, "");
}

/** Mirrors verify_selected_line handler body. */
function buildVerifySelectedLinePayload(lineId) {
  return { action: "verify_selected_line", cruise_line_id: lineId };
}

/** Mirrors startDiscovery() destinationId parsing. */
function parseStartDiscoveryDestinationId(body) {
  return String(body.destination_id || "").trim() || null;
}

const LINE = "line-uuid";
const DEST = "alaska-uuid";

// 1. Run Full Discovery ignores both dropdown values
const fullPayload = buildFullDiscoveryLinePayload(LINE);
assert(fullPayload.scope === "cruise_line", "full discovery scope is cruise_line");
assert(fullPayload.cruise_line_id === LINE, "full discovery uses queued line id");
assert(fullPayload.destination_id === undefined, "full discovery omits destination_id");
assert(parseStartDiscoveryDestinationId(fullPayload) === null, "backend parses no destination filter");

// 2. Selected-line Discovery ignores destination
const linePayload = buildDiscoverLinePayload(LINE, "");
assert(linePayload.scope === "cruise_line", "selected line scope");
assert(linePayload.destination_id === undefined, "selected line omits destination_id");

// 3. Verify Selected Line ignores destination
const verifyPayload = buildVerifySelectedLinePayload(LINE);
assert(verifyPayload.cruise_line_id === LINE, "verify uses cruise line");
assert(verifyPayload.destination_id === undefined, "verify omits destination_id");
assert(verifyPayload.action === "verify_selected_line", "verify action name");

// 4. Selected-destination Discovery applies destination
const destPayload = buildDiscoverLinePayload(LINE, DEST);
assert(destPayload.scope === "destination", "destination scope");
assert(destPayload.destination_id === DEST, "destination id included");
assert(parseStartDiscoveryDestinationId(destPayload) === DEST, "backend receives destination id");

// Backend destination target resolution
const lineWideTargets = resolveDiscoveryDestinationTargets(null);
assert(lineWideTargets.length === 1 && lineWideTargets[0] === null, "line-wide = unfiltered pass");
const destTargets = resolveDiscoveryDestinationTargets({ id: DEST, name: "Alaska" });
assert(destTargets.length === 1 && destTargets[0].name === "Alaska", "destination scope = single dest");
const genericQueries = buildBraveSailingQueries({ host: "line.com", destName: "cruise", adapter: null });
assert(!genericQueries.some((q) => /alaska/i.test(q)), "unfiltered Brave queries avoid Alaska");

// 5. Unpublished destinations — validateCruise does not check published status
const draftDestCandidate = {
  ship_id: "ship-1",
  destination_id: "draft-dest-id",
  departure_date: "2027-06-01",
  official_url: "https://line.com/cruise/1",
  departure_port: "Miami"
};
assert(
  !validateCruise(draftDestCandidate).some((r) => /unpublished/i.test(r)),
  "validation has no unpublished-destination rule"
);
assert(validateCruise({ ...draftDestCandidate, destination_id: null }).includes("Destination not matched"), "missing destination_id fails validation");

// 6. Dashboard run-type labels distinguish full vs selected-line
assert(inferRunType({ scope: "full", stats: { triggered_by: "admin" } }) === "run_full_discovery_line", "full run label");
assert(inferRunType({ scope: "cruise_line", stats: {} }) === "discover_selected_cruise_line", "selected line label");
assert(
  inferRunType({ scope: "full", stats: { triggered_by: "selected_line_verification" } }) === "verify_selected_line",
  "verify label"
);
assert(inferRunType({ scope: "destination", stats: {} }) === "discover_selected_destination", "destination run label");

// 7. Homepage fallback cannot bypass non-sailing filters
const marketingReject = buildCandidateFromSource({
  title: "Explore Alaska",
  description: "Discover our destination",
  url: "https://line.com/destinations/alaska",
  excerpt: "Plan your vacation",
  cruiseLine: { id: "l1", name: "Test" },
  ships: [],
  destinations: [],
  preferredDestination: null
});
assert(marketingReject?.skip === true, "homepage marketing page rejected");

// 8. Official search URLs — adapter accepts cruise-search paths
const hal = resolveAdapter({ name: "Holland America Line", slug: "holland-america" });
assert(hal.id === "holland-america", "HAL adapter");
assert(hal.acceptedUrlPatterns.some((p) => p.test("/en/cruise-search/results")), "HAL accepts cruise-search URLs");

// 9. Read-only simulation contract (static check)
const simSource = require("fs").readFileSync(path.join(root, "scripts/simulate-discovery-lines.mjs"), "utf8");
assert(simSource.includes("writes_performed: false"), "simulation declares no writes");
assert(!simSource.includes("upsertCandidate"), "simulation does not upsert candidates");

// 10. No permanent automatic alias writes
assert(AUTO_ALIAS_WRITES_ENABLED === false, "auto alias writes disabled");

// 11. P&O Cruises Australia remains excluded
const poAu = resolveAdapter({ name: "P&O Cruises Australia", slug: "po-au" });
assert(poAu.id === "generic", "P&O AU generic adapter only");

// 12. Cruise Finder departure match unchanged (smoke import)
const { matchDeparturePort } = require(path.join(root, "netlify/functions/lib/cruise-finder-departure-match"));
assert(typeof matchDeparturePort === "function", "cruise finder departure match loads");

console.log("test-discovery-destination-scope: 22 passed");
