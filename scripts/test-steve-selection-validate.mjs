/**
 * Offline tests for Steve hero-selection validation (batch 2).
 */

import assert from "node:assert/strict";
import {
  pathBelongsToShipFolder,
  validateSteveHeroSelections
} from "./lib/local-ship-image-audit/steve-selection-validate.js";

assert.equal(
  pathBelongsToShipFolder(
    "/Volumes/x/BRAND IMAGING/Celebrity X/Beyond (2022)/a.jpg",
    "Celebrity Beyond"
  ),
  true
);
assert.equal(
  pathBelongsToShipFolder(
    "/Volumes/x/BRAND IMAGING/Princess/Caribbean Princess/a.jpg",
    "Caribbean Princess"
  ),
  true
);
assert.equal(
  pathBelongsToShipFolder(
    "/Volumes/x/BRAND IMAGING/Virgin/Brilliant Lady/valiant.jpg",
    "Resilient Lady"
  ),
  false
);

const empty = validateSteveHeroSelections({ ship_count: 0, ships: [] });
assert.equal(empty.blocked, true);
assert.equal(empty.ship_count, 0);

console.log("OK: steve-selection-validate checks passed");
