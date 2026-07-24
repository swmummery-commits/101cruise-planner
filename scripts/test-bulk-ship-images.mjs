/**
 * Offline tests for bulk ship-image matching / ZIP planning (Sprint 16D).
 * Does not touch Supabase.
 */

import { createRequire } from "module";
import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const JSZip = require("jszip");
const matching = require("../netlify/functions/lib/bulk-ship-images/matching.js");
const { loadZip, listZipPaths } = require("../netlify/functions/lib/bulk-ship-images/zip.js");
const { buildSingleLinePlan, enrichPlanWithBytes } = require("../netlify/functions/lib/bulk-ship-images/plan.js");
const { readImageDimensions } = require("../netlify/functions/lib/bulk-ship-images/image-dims.js");

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, "../tmp/bulk-ship-images-fixtures");

// 1×1 PNG
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function buildFixtureZip() {
  mkdirSync(fixtureDir, { recursive: true });
  const zip = new JSZip();
  zip.file("Discovery Princess/deck.jpg", TINY_PNG);
  zip.file("Discovery Princess/hero.jpg", TINY_PNG);
  zip.file("Royal Princess/image-01.png", TINY_PNG);
  zip.file("Unknown Vessel/photo.webp", TINY_PNG);
  zip.file("Discovery Princess/notes.pdf", Buffer.from("%PDF-1.4"));
  zip.file("__MACOSX/Discovery Princess/._deck.jpg", Buffer.from("meta"));
  zip.file("Discovery Princess/.DS_Store", Buffer.from("store"));
  zip.file("../evil/hack.jpg", TINY_PNG); // should be rejected when listed
  const out = join(fixtureDir, "princess-single-line.zip");
  // Build a clean zip without traversal for happy-path fixture
  const clean = new JSZip();
  clean.file("Discovery Princess/deck.jpg", TINY_PNG);
  clean.file("Discovery Princess/hero.jpg", TINY_PNG);
  clean.file("Royal Princess/image-01.png", TINY_PNG);
  clean.file("Unknown Vessel/photo.webp", TINY_PNG);
  clean.file("Discovery Princess/notes.pdf", Buffer.from("%PDF-1.4"));
  clean.file("__MACOSX/Discovery Princess/._deck.jpg", Buffer.from("meta"));
  clean.file("Discovery Princess/.DS_Store", Buffer.from("store"));
  const buf = await clean.generateAsync({ type: "nodebuffer" });
  writeFileSync(out, buf);
  return out;
}

async function main() {
  let passed = 0;
  const ships = [
    { id: "ship-discovery", name: "Discovery Princess", cruise_line_id: "line-1", hero_image_url: "https://example.com/existing-hero.jpg" },
    { id: "ship-royal", name: "Royal Princess", cruise_line_id: "line-1", hero_image_url: null }
  ];
  const aliases = [
    { ship_id: "ship-discovery", raw_alias: "Discovery", normalised_alias: "discovery" }
  ];
  const line = { id: "line-1", name: "Princess Cruises", slug: "princess-cruises" };

  // Path traversal
  let threw = false;
  try {
    matching.assertSafeZipPath("../evil/x.jpg");
  } catch (e) {
    threw = e.code === "path_traversal";
  }
  assert(threw, "path traversal should reject");
  passed += 1;

  // Match exact + alias
  assert(matching.matchShipFolder("Discovery Princess", ships, aliases)?.via === "exact_name", "exact match");
  assert(matching.matchShipFolder("Discovery", ships, aliases)?.via === "alias", "alias match");
  assert(matching.matchShipFolder("No Such Ship", ships, aliases) === null, "unmatched");
  passed += 3;

  // Dimensions
  const dims = readImageDimensions(TINY_PNG);
  assert(dims.width === 1 && dims.height === 1, "png dims");
  passed += 1;

  // Hero names
  assert(matching.classifyEntry("Ship/hero.jpg").isHeroCandidate === true, "hero candidate");
  assert(matching.classifyEntry("Ship/deck.jpg").isHeroCandidate === false, "non-hero");
  passed += 2;

  const zipPath = await buildFixtureZip();
  const zipBuf = readFileSync(zipPath);
  const zip = await loadZip(zipBuf);
  const paths = listZipPaths(zip);
  const plan = buildSingleLinePlan({
    entryPaths: paths,
    cruiseLine: line,
    ships,
    aliases,
    existingHashesByShip: new Map()
  });

  assert(plan.matched_ships.some((m) => m.ship_id === "ship-discovery"), "discovery matched");
  assert(plan.matched_ships.some((m) => m.ship_id === "ship-royal"), "royal matched");
  assert(plan.unmatched_ship_folders.some((u) => u.folder === "Unknown Vessel"), "unknown unmatched");
  assert(plan.unsupported_files.some((u) => String(u.path).endsWith(".pdf")), "pdf unsupported");
  assert(plan.ignored_files.length >= 1, "macos/ds_store ignored");
  assert(plan.proposed_heroes.some((h) => h.filename === "hero.jpg"), "hero proposed");
  const discoveryHero = plan.matched_ships.find((m) => m.ship_id === "ship-discovery");
  assert(discoveryHero.has_hero === true, "existing hero preserved flag");
  passed += 7;

  // Enrich with bytes — duplicate detection
  const hash = matching.sha256Hex(TINY_PNG);
  const existing = new Map([["ship-royal", new Set([hash])]]);
  const fileRecords = [
    {
      zip_path: "Royal Princess/image-01.png",
      filename: "image-01.png",
      ship_id: "ship-royal",
      ship_name: "Royal Princess",
      cruise_line_id: "line-1",
      buffer: TINY_PNG,
      mime_type: "image/png",
      is_hero_candidate: false
    },
    {
      zip_path: "Discovery Princess/deck.jpg",
      filename: "deck.jpg",
      ship_id: "ship-discovery",
      ship_name: "Discovery Princess",
      cruise_line_id: "line-1",
      buffer: TINY_PNG,
      mime_type: "image/jpeg",
      is_hero_candidate: false
    }
  ];
  const enriched = enrichPlanWithBytes({ ...plan, proposed_uploads: [] }, fileRecords, existing);
  assert(enriched.duplicate_candidates.length === 1, "duplicate detected for royal");
  assert(enriched.proposed_uploads.length === 1, "one new upload");
  assert(enriched.proposed_uploads[0].storage_path.includes(hash.slice(0, 12)), "content-addressed path");
  passed += 3;

  // Repeat identical content → same hash
  const hash2 = matching.sha256Hex(TINY_PNG);
  assert(hash === hash2, "hash stable");
  passed += 1;

  console.log(`PASS ${passed} checks`);
  console.log(`Fixture ZIP: ${zipPath}`);
  console.log(
    JSON.stringify(
      {
        dry_run_summary: {
          matched: plan.matched_ships.map((m) => m.ship_name),
          unmatched: plan.unmatched_ship_folders.map((u) => u.folder),
          unsupported: plan.unsupported_files.length,
          ignored: plan.ignored_files.length,
          proposed_heroes: plan.proposed_heroes.map((h) => h.filename),
          duplicate_on_enrich: enriched.duplicate_candidates.length,
          proposed_uploads_on_enrich: enriched.proposed_uploads.length
        }
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("FAIL", error);
  process.exit(1);
});
