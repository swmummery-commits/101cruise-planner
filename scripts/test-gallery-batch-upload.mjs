/**
 * Offline tests for strict secondary ship-gallery batch selection & guards.
 * No network. No credentials. No uploads.
 */

import assert from "node:assert/strict";
import {
  buildStrictGalleryBatch,
  isRoomTypeImage,
  isNearDuplicatePair,
  inferGalleryRole,
  inspectLocalShipGallery,
  planGalleryFailureRollback,
  MAX_GALLERY_PER_SHIP
} from "./lib/local-ship-image-audit/gallery-batch-upload.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const heroShips = new Map([
  [
    "ship-a",
    {
      ship_id: "ship-a",
      ship_name: "Caribbean Princess",
      cruise_line_id: "line-a",
      cruise_line_name: "Princess Cruises",
      hero_content_hash: "hero-hash-a",
      hero_source_pathname: "/x/Princess/Caribbean Princess/hero.jpg",
      hero_public_url: "https://example.test/hero-a.jpg",
      hero_file_size_bytes: 500000,
      hero_dimensions: "2000x1200"
    }
  ],
  [
    "ship-b",
    {
      ship_id: "ship-b",
      ship_name: "Celebrity Beyond",
      cruise_line_id: "line-b",
      cruise_line_name: "Celebrity Cruises",
      hero_content_hash: "hero-hash-b",
      hero_source_pathname: "/x/Celebrity/Beyond/hero.jpg",
      hero_public_url: "https://example.test/hero-b.jpg",
      hero_file_size_bytes: 400000,
      hero_dimensions: "1800x1000"
    }
  ]
]);

const galleryCandidates = [
  {
    ship_id: "ship-a",
    ship_name: "Caribbean Princess",
    cruise_line_id: "line-a",
    cruise_line_name: "Princess Cruises",
    match_class: "exact_match",
    quality_class: "suitable_secondary_gallery",
    score: 60,
    width: 1600,
    height: 900,
    file_size_bytes: 200000,
    absolute_path: "/x/Princess/Caribbean Princess/caribbean-princess-pool-deck.jpg",
    content_hash: "g1",
    media_status: "new_candidate"
  },
  {
    ship_id: "ship-a",
    ship_name: "Caribbean Princess",
    cruise_line_id: "line-a",
    cruise_line_name: "Princess Cruises",
    match_class: "exact_match",
    quality_class: "suitable_secondary_gallery",
    score: 58,
    width: 1600,
    height: 900,
    file_size_bytes: 210000,
    absolute_path: "/x/Princess/Caribbean Princess/caribbean-princess-atrium.jpg",
    content_hash: "g2",
    media_status: "new_candidate"
  },
  {
    ship_id: "ship-a",
    ship_name: "Caribbean Princess",
    cruise_line_id: "line-a",
    cruise_line_name: "Princess Cruises",
    match_class: "exact_match",
    quality_class: "suitable_secondary_gallery",
    score: 57,
    width: 1600,
    height: 900,
    file_size_bytes: 220000,
    absolute_path: "/x/Princess/Caribbean Princess/caribbean-princess-exterior-aft.jpg",
    content_hash: "g3",
    media_status: "new_candidate"
  },
  {
    ship_id: "ship-a",
    ship_name: "Caribbean Princess",
    cruise_line_id: "line-a",
    cruise_line_name: "Princess Cruises",
    match_class: "exact_match",
    quality_class: "suitable_secondary_gallery",
    score: 56,
    width: 1600,
    height: 900,
    file_size_bytes: 230000,
    absolute_path: "/x/Princess/Caribbean Princess/caribbean-princess-exterior-bow.jpg",
    content_hash: "g4",
    media_status: "new_candidate"
  },
  // Room — must exclude
  {
    ship_id: "ship-a",
    ship_name: "Caribbean Princess",
    cruise_line_id: "line-a",
    cruise_line_name: "Princess Cruises",
    match_class: "exact_match",
    quality_class: "suitable_secondary_gallery",
    score: 90,
    width: 1600,
    height: 900,
    file_size_bytes: 100000,
    absolute_path: "/x/Princess/Caribbean Princess/AOV_WVO_HORIZON_STATEROOM_HERO_1.jpg",
    content_hash: "room1",
    media_status: "new_candidate"
  },
  // Ambiguous folder match
  {
    ship_id: "ship-a",
    ship_name: "Caribbean Princess",
    match_class: "ambiguous",
    quality_class: "suitable_secondary_gallery",
    score: 80,
    width: 1600,
    height: 900,
    file_size_bytes: 100000,
    absolute_path: "/x/Princess/Caribbean Princess/ambig.jpg",
    content_hash: "amb1",
    media_status: "new_candidate"
  },
  // Cruise-line loose hero
  {
    ship_id: "ship-b",
    ship_name: "Celebrity Beyond",
    cruise_line_id: "line-b",
    cruise_line_name: "Celebrity Cruises",
    match_class: "exact_match",
    quality_class: "suitable_secondary_gallery",
    score: 70,
    width: 1600,
    height: 900,
    file_size_bytes: 100000,
    absolute_path: "/x/Celebrity X/Hero Images/beyond-line.jpg",
    content_hash: "line1",
    media_status: "new_candidate"
  },
  // Duplicate of hero hash
  {
    ship_id: "ship-b",
    ship_name: "Celebrity Beyond",
    cruise_line_id: "line-b",
    cruise_line_name: "Celebrity Cruises",
    match_class: "exact_match",
    quality_class: "suitable_secondary_gallery",
    score: 70,
    width: 1800,
    height: 1000,
    file_size_bytes: 400000,
    absolute_path: "/x/Celebrity/Beyond/hero-copy.jpg",
    content_hash: "hero-hash-b",
    media_status: "new_candidate"
  },
  // Ship not in hero batches → held for later
  {
    ship_id: "ship-z",
    ship_name: "Other Ship",
    cruise_line_name: "Other",
    match_class: "exact_match",
    quality_class: "suitable_secondary_gallery",
    score: 70,
    width: 1600,
    height: 900,
    file_size_bytes: 100000,
    absolute_path: "/x/Other/Ship/photo.jpg",
    content_hash: "other1",
    media_status: "new_candidate"
  },
  // Valid for Beyond
  {
    ship_id: "ship-b",
    ship_name: "Celebrity Beyond",
    cruise_line_id: "line-b",
    cruise_line_name: "Celebrity Cruises",
    match_class: "safe_normalised_match",
    quality_class: "suitable_secondary_gallery",
    score: 55,
    width: 1400,
    height: 800,
    file_size_bytes: 150000,
    absolute_path: "/x/Celebrity X/Beyond (2022)/Celebrity-Beyond-pool.jpg",
    content_hash: "beyond-g1",
    media_status: "new_candidate"
  }
];

assert.equal(isRoomTypeImage(galleryCandidates[4]), true);

const batch = buildStrictGalleryBatch({
  galleryCandidates,
  heroCandidates: [],
  heroShips
});

assert.ok(batch.image_count <= heroShips.size * MAX_GALLERY_PER_SHIP);
assert.ok(batch.per_ship.every((s) => s.count <= 3), "max three per ship");
assert.ok(
  !batch.approved.some((a) => /stateroom/i.test(a.absolute_path)),
  "rooms excluded"
);
assert.ok(
  !batch.approved.some((a) => /Hero Images/i.test(a.absolute_path)),
  "line heroes excluded"
);
assert.ok(
  !batch.approved.some((a) => a.content_hash === "hero-hash-b"),
  "hero duplicates excluded"
);
assert.ok(
  batch.excluded.some((e) => e.exclude_reason === "room_type_image"),
  "room exclude reason"
);
assert.ok(
  batch.excluded.some((e) => e.exclude_reason === "match_class_not_exact_or_safe"),
  "ambiguous excluded"
);
assert.ok(
  batch.excluded.some((e) => e.exclude_reason === "cruise_line_loose_hero_image"),
  "line hero excluded"
);
assert.ok(
  batch.excluded.some((e) => e.exclude_reason === "duplicate_of_batch_hero"),
  "hero hash excluded"
);
assert.ok(
  batch.held_for_later.some((h) => h.hold_reason === "ship_not_in_hero_batches_1_2"),
  "non-batch ships held"
);

const shipA = batch.approved.filter((a) => a.ship_id === "ship-a");
assert.ok(shipA.length <= 3);
assert.ok(shipA.length >= 2, "ship-a should get diversified gallery");
assert.ok(
  new Set(shipA.map((s) => s.intended_gallery_role)).size >= 2,
  "role variety for ship-a"
);

// Near-identical selection limited
assert.equal(
  isNearDuplicatePair(
    { content_hash: "a", width: 100, height: 50, file_size_bytes: 1000, filename: "x.jpg" },
    { content_hash: "a", width: 100, height: 50, file_size_bytes: 1000, filename: "x.jpg" }
  ),
  true
);

// Gallery inspect: never default / never hero
const inspected = inspectLocalShipGallery(
  {
    ship_id: "ship-a",
    ship_name: "Caribbean Princess",
    cruise_line_id: "line-a",
    cruise_line_name: "Princess Cruises",
    absolute_path: "/x/Princess/Caribbean Princess/pool.jpg",
    display_order: 1,
    intended_gallery_role: "deck_pool"
  },
  PNG_1X1,
  { supabaseUrl: "https://xikbibxyinttllxamgao.supabase.co" }
);
assert.equal(inspected.media_library_values.is_default, false);
assert.equal(inspected.media_library_values.media_type, "ship");
assert.equal(
  inspected.media_library_values.import_source,
  "external_brand_imaging_gallery_batch_1"
);
assert.ok(inspected.media_library_values.title.includes("gallery"));
assert.ok(!/hero$/i.test(inspected.media_library_values.title));

// Failure rollback touches only batch-created records
const rb = planGalleryFailureRollback({
  storageCreated: true,
  mediaLibraryId: "new-media",
  storagePath: "ships/ship-a/abc-pool.jpg",
  preExistingMediaIds: ["old-media"],
  preExistingStoragePaths: ["ships/ship-a/old-hero.jpg"]
});
assert.equal(rb.leaves_preexisting_untouched, true);
assert.equal(rb.would_touch_preexisting_media, false);
assert.equal(rb.would_touch_preexisting_storage, false);
assert.ok(rb.actions.some((a) => a.type === "delete_media_library" && a.id === "new-media"));
assert.ok(rb.actions.some((a) => a.type === "delete_storage"));

assert.equal(inferGalleryRole({ absolute_path: "/x/ship/pool-deck.jpg" }), "deck_pool");
assert.equal(inferGalleryRole({ absolute_path: "/x/ship/main-atrium.jpg" }), "interior_public");

console.log("OK: gallery-batch-upload selection and guard checks passed");
