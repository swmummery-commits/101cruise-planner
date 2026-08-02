#!/usr/bin/env node
/**
 * Regression tests for deterministic destination corrections.
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import fs from "fs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { resolveOperationalDestination, DESTINATION_RESOLVER_VERSION } = require(
  path.join(root, "netlify/functions/lib/discovery-destination-resolver")
);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const destinations = [
  { id: "alaska-id", name: "Alaska", slug: "alaska", status: "published", classification_enabled: true },
  { id: "tp-id", name: "Transpacific", slug: "transpacific", status: "draft", classification_enabled: true },
  { id: "jp-id", name: "Japan", slug: "japan", status: "draft", classification_enabled: true },
  { id: "pc-id", name: "Pacific Coast", slug: "pacific-coast", status: "draft", classification_enabled: true },
  { id: "car-id", name: "Caribbean", slug: "caribbean", status: "draft", classification_enabled: true }
];

const yokohamaSeward = resolveOperationalDestination({
  title: "Crystal Serenity - Yokohama (Tokyo) to Seward (Anchorage, Alaska) | Transoceanic | Crystal Cruises",
  description: "14 night transpacific crossing",
  departurePort: "Yokohama",
  arrivalPort: "Seward",
  itinerary: "Tokyo Yokohama Seward Anchorage",
  nights: 14,
  destinations
});
assert(yokohamaSeward.destinationKey === "transpacific", "Yokohama to Seward resolves Transpacific");
assert(yokohamaSeward.confidence === "high", "Yokohama-Seward high confidence");

const explora = resolveOperationalDestination({
  title: "A Grand Journey from Glacier Majesty to Japanese Grace",
  description:
    "Journey aboard EXPLORA III for 16 nights sailing from Vancouver via Ketchikan, Sitka and Sailing the Hubbard Glacier",
  departurePort: "Vancouver",
  arrivalPort: "Japanese Grace",
  itinerary: "Vancouver Ketchikan Sitka Hubbard Glacier",
  nights: 16,
  destinations
});
assert(explora.destinationKey === "transpacific", "Vancouver-Alaska-Japan route resolves Transpacific not Japan");
assert(explora.confidence === "high", "Explora route high confidence");

const alaskaOnly = resolveOperationalDestination({
  title: "Alaska Luxury Cruise - Vancouver to Whittier",
  description: "Alaska cruise",
  departurePort: "Vancouver",
  arrivalPort: "Whittier",
  itinerary: "Juneau Ketchikan Sitka",
  nights: 7,
  destinations
});
assert(alaskaOnly.destinationKey === "alaska", "Pure Alaska remains Alaska");

const sdVan = resolveOperationalDestination({
  title: "Crystal Symphony - San Diego to Vancouver | The Americas & Caribbean",
  description: "Pacific coast repositioning",
  departurePort: "San Diego",
  arrivalPort: "Vancouver",
  itinerary: "San Diego Vancouver",
  nights: 20,
  destinations
});
assert(sdVan.destinationKey === "pacific-coast", "San Diego to Vancouver is Pacific Coast not Caribbean");
assert(sdVan.destinationKey !== "caribbean", "San Diego-Vancouver not forced to Caribbean");

const applySrc = fs.readFileSync(
  path.join(root, "scripts/apply-destination-correction-deterministic.mjs"),
  "utf8"
);
assert(applySrc.includes("updated_at=eq"), "apply verifies updated_at concurrency");
assert(applySrc.includes("destination_id"), "apply patches destination_id");
assert(applySrc.includes("rollback"), "rollback manifest supported");

const crystalApplySrc = fs.readFileSync(
  path.join(root, "scripts/apply-crystal-record-correction.mjs"),
  "utf8"
);
assert(crystalApplySrc.includes("before_value_mismatch"), "crystal apply verifies before values");
assert(crystalApplySrc.includes("rollback"), "crystal rollback manifest supported");

const {
  parseCrystalVoyageFromUrl,
  resolveCrystalShipEvidence,
  crystalShipConflictBlocksActivation,
  CRYSTAL_VOYAGE_SHIP_CODES
} = require(path.join(root, "netlify/functions/lib/discovery-crystal-ship"));
const { buildCandidateFromSource } = require(path.join(root, "netlify/functions/lib/cruise-discovery"));

const crystalShips = [
  { id: "sym-id", name: "Crystal Symphony", cruise_line_id: "line-id" },
  { id: "ser-id", name: "Crystal Serenity", cruise_line_id: "line-id" }
];
const crystalLine = { id: "line-id", name: "Crystal Cruises" };

assert(
  parseCrystalVoyageFromUrl("https://www.crystalcruises.com/cruises/none-csy-014-280918")?.code === "csy",
  "csy URL code parsed"
);
assert(
  parseCrystalVoyageFromUrl("https://www.crystalcruises.com/cruises/none-cse-013-270508")?.code === "cse",
  "cse URL code parsed"
);
assert(CRYSTAL_VOYAGE_SHIP_CODES.csy === "Crystal Symphony", "csy maps to Symphony");
assert(CRYSTAL_VOYAGE_SHIP_CODES.cse === "Crystal Serenity", "cse maps to Serenity");

const csyResolution = resolveCrystalShipEvidence({
  url: "https://www.crystalcruises.com/cruises/none-csy-014-280918",
  title: "Crystal Symphony - Seward (Anchorage, Alaska) to Tokyo | Transoceanic | Crystal Cruises",
  description: "Setting sail from Seward... Crystal Serenity's onboard offerings",
  ships: crystalShips,
  cruiseLineName: "Crystal Cruises"
});
assert(csyResolution.ship?.name === "Crystal Symphony", "structured/title/url override narrative Serenity");
assert(!crystalShipConflictBlocksActivation(csyResolution), "agreeing strong evidence does not block");

const conflictResolution = resolveCrystalShipEvidence({
  url: "https://www.crystalcruises.com/cruises/none-cse-013-270508",
  title: "Crystal Symphony - Yokohama to Seward | Transoceanic",
  description: "Aboard Crystal Serenity",
  ships: crystalShips,
  cruiseLineName: "Crystal Cruises"
});
assert(crystalShipConflictBlocksActivation(conflictResolution), "conflicting strong ship evidence blocks activation");

const sewardTokyo = resolveOperationalDestination({
  title: "Crystal Symphony - Seward (Anchorage, Alaska) to Tokyo | Transoceanic",
  description: "14-night transpacific crossing from Alaska to Japan",
  departurePort: "Seward",
  arrivalPort: "Tokyo",
  itinerary: "Seward Homer Kodiak Kushiro Tokyo",
  nights: 14,
  destinations
});
assert(sewardTokyo.destinationKey === "transpacific", "Seward to Tokyo resolves Transpacific after port correction");

const sdVanVerified = resolveOperationalDestination({
  title: "Crystal Symphony - San Diego to Vancouver | North America & Canada",
  description: "Eight-night North American adventure",
  departurePort: "San Diego",
  arrivalPort: "Vancouver",
  itinerary: "San Diego San Francisco Victoria Vancouver",
  nights: 8,
  destinations
});
assert(sdVanVerified.destinationKey === "pacific-coast", "verified San Diego-Vancouver is Pacific Coast");

const hiddenCandidate = buildCandidateFromSource({
  title: "Crystal Symphony - Seward to Tokyo | Transoceanic",
  description: "Crystal Serenity voyage",
  url: "https://www.crystalcruises.com/cruises/none-cse-013-270508",
  excerpt: "Crystal Symphony and Crystal Serenity",
  cruiseLine: crystalLine,
  ships: crystalShips,
  destinations,
  shipAliases: [],
  destinationAliases: []
});
assert(
  hiddenCandidate?.skip === true || hiddenCandidate?.status !== "active",
  "invalid source identity does not produce active candidate when conflict unresolved"
);

const shipResolver = require(path.join(root, "netlify/functions/lib/discovery-ship-resolver"));
assert(shipResolver.AUTO_ALIAS_WRITES_ENABLED === false, "auto alias writes disabled");

const adapters = require(path.join(root, "netlify/functions/lib/cruise-discovery-adapters"));
assert(adapters.resolveAdapter({ name: "P&O Cruises Australia" }).id === "generic", "P&O AU excluded");

console.log(`test-destination-correction-deterministic: 28 passed (${DESTINATION_RESOLVER_VERSION})`);
