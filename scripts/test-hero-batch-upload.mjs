/**
 * Offline tests for strict external ship-hero batch selection.
 * No network. No credentials. No uploads.
 */

import assert from "node:assert/strict";
import { buildStrictHeroBatch } from "./lib/local-ship-image-audit/hero-batch-upload.js";

const sample = [
  {
    ship_id: "1",
    ship_name: "Caribbean Princess",
    cruise_line_name: "Princess Cruises",
    match_class: "exact_match",
    has_canonical_hero: false,
    recommendation: "clear_single_candidate",
    file_size_bytes: 1000,
    absolute_path: "/x/Princess/Caribbean Princess/princess-cruises-caribbean-princess-ship-scaled.jpg"
  },
  {
    ship_id: "2",
    ship_name: "Celebrity Beyond",
    cruise_line_name: "Celebrity Cruises",
    match_class: "exact_match",
    has_canonical_hero: false,
    recommendation: "Steve_selection_required",
    file_size_bytes: 1000,
    absolute_path: "/x/Celebrity X/Beyond/beyond.jpg"
  },
  {
    ship_id: "3",
    ship_name: "Scenic Eclipse II",
    cruise_line_name: "Scenic",
    match_class: "exact_match",
    has_canonical_hero: false,
    recommendation: "clear_single_candidate",
    file_size_bytes: 1000,
    absolute_path: "/x/Scenic/Eclipse II/Scenic-Eclipse-Heli-Hero-image.jpg"
  },
  {
    ship_id: "4",
    ship_name: "Brilliant Lady",
    cruise_line_name: "Virgin Voyages",
    match_class: "exact_match",
    has_canonical_hero: false,
    recommendation: "clear_single_candidate",
    file_size_bytes: 1000,
    absolute_path: "/x/Virgin/Brilliant Lady/valiant-lady-round-about-tentacles.jpg"
  }
];

const batch = buildStrictHeroBatch(sample);
assert.equal(batch.count, 1);
assert.equal(batch.approved[0].ship_name, "Caribbean Princess");
assert.equal(batch.excluded.length, 3);
assert.ok(batch.excluded.some((e) => e.exclude_reason === "steve_selection_required"));
assert.ok(batch.excluded.some((e) => e.exclude_reason === "scenic_eclipse_identity_risk"));
assert.ok(
  batch.excluded.some((e) => e.exclude_reason === "filename_branded_as_different_ship_valiant_lady")
);

console.log("OK: hero-batch-upload selection checks passed");
