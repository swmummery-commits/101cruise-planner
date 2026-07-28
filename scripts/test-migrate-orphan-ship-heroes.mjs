/**
 * Offline tests for orphan ship-hero migration planner.
 * Run: node scripts/test-migrate-orphan-ship-heroes.mjs
 */

import { createRequire } from "module";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const {
  classifyShipHeroGaps,
  migrateOneShipHero,
  sniffMime,
  buildStoragePath
} = require("../netlify/functions/lib/migrate-orphan-ship-heroes.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  let passed = 0;

  const ships = [
    {
      id: "ship-orphan",
      name: "Norwegian Encore",
      hero_image_url: "https://example.com/storage/v1/object/public/ship-images/a/encore.png",
      cruise_line_id: "line-1"
    },
    {
      id: "ship-ok",
      name: "Enchanted Princess",
      hero_image_url: "https://example.com/cruise-media/ships/ok/hero.jpg",
      cruise_line_id: "line-2"
    },
    {
      id: "ship-mismatch",
      name: "Insignia",
      hero_image_url: "https://example.com/cruise-media/ships/m/live.jpg",
      cruise_line_id: "line-3"
    },
    {
      id: "ship-mismatch-match",
      name: "Nautica",
      hero_image_url: "https://example.com/cruise-media/ships/n/live.jpg",
      cruise_line_id: "line-3"
    }
  ];

  const mediaByShip = new Map([
    ["ship-orphan", []],
    [
      "ship-ok",
      [
        {
          id: "m-ok",
          public_url: "https://example.com/cruise-media/ships/ok/hero.jpg",
          is_default: true
        }
      ]
    ],
    [
      "ship-mismatch",
      [
        {
          id: "m-old",
          public_url: "https://example.com/cruise-media/ships/m/old.jpg",
          is_default: true
        }
      ]
    ],
    [
      "ship-mismatch-match",
      [
        {
          id: "m-default",
          public_url: "https://example.com/cruise-media/ships/n/old.jpg",
          is_default: true
        },
        {
          id: "m-live",
          public_url: "https://example.com/cruise-media/ships/n/live.jpg",
          is_default: false
        }
      ]
    ]
  ]);

  const { orphans, mismatches } = classifyShipHeroGaps(ships, mediaByShip);
  assert(orphans.length === 1 && orphans[0].ship_id === "ship-orphan", "one orphan");
  assert(mismatches.length === 2, "two mismatches");
  assert(
    mismatches.find((m) => m.ship_id === "ship-mismatch-match")?.matching_media_id === "m-live",
    "matching media detected"
  );
  assert(
    mismatches.find((m) => m.ship_id === "ship-mismatch")?.matching_media_id == null,
    "no matching media"
  );
  passed += 1;

  // Tiny PNG
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  assert(sniffMime(png) === "image/png", "png sniff");
  assert(/ships\/ship-orphan\//.test(buildStoragePath("ship-orphan", "abc123def456", "x.png")), "path");
  passed += 1;

  // Dry-run copy
  const dry = await migrateOneShipHero({
    item: orphans[0],
    fetchBytes: async () => png,
    uploadBytes: async () => {
      throw new Error("should not upload in dry-run");
    },
    insertMedia: async () => {
      throw new Error("should not insert in dry-run");
    },
    setShipHero: async () => {
      throw new Error("should not set hero in dry-run");
    },
    supabaseUrl: "https://example.supabase.co",
    dryRun: true
  });
  assert(dry.dry_run === true && dry.action === "copy_and_register", "dry copy");
  passed += 1;

  // Promote existing
  const promoteItem = mismatches.find((m) => m.ship_id === "ship-mismatch-match");
  let promoted = null;
  const promote = await migrateOneShipHero({
    item: promoteItem,
    fetchBytes: async () => png,
    uploadBytes: async () => {},
    insertMedia: async () => ({}),
    setShipHero: async (id) => {
      promoted = id;
      return { success: true };
    },
    supabaseUrl: "https://example.supabase.co",
    dryRun: false
  });
  assert(promote.action === "promote_existing_media", "promote action");
  assert(promoted === "m-live", "promoted live media");
  passed += 1;

  // Apply copy path
  const uploaded = [];
  const inserted = [];
  const setIds = [];
  const applied = await migrateOneShipHero({
    item: orphans[0],
    fetchBytes: async () => png,
    uploadBytes: async (p, bytes, mime) => {
      uploaded.push({ p, bytes: bytes.length, mime });
    },
    insertMedia: async (row) => {
      inserted.push(row);
      return { id: "new-media", ...row };
    },
    setShipHero: async (id) => {
      setIds.push(id);
      return { success: true };
    },
    supabaseUrl: "https://example.supabase.co",
    dryRun: false
  });
  assert(uploaded.length === 1 && uploaded[0].mime === "image/png", "uploaded");
  assert(inserted[0].ship_id === "ship-orphan" && inserted[0].media_type === "ship", "inserted");
  assert(setIds[0] === "new-media", "set as hero");
  assert(applied.previous_hero_image_url.includes("ship-images"), "kept previous url");
  passed += 1;

  // UI / server guards
  const admin = readFileSync(path.join(root, "js/admin.js"), "utf8");
  assert(/Choose from Media Library/.test(admin), "ship hero uses Media Library");
  assert(/openCiShipHeroMediaPicker/.test(admin), "picker opener");
  assert(/set_ship_hero/.test(admin), "uses set_ship_hero action");
  assert(/Ship heroes are managed in Media Library/.test(admin), "helper copy");
  const shipField = admin.match(/if \(isShip\) \{[\s\S]*?return `/);
  assert(shipField, "ship branch");
  assert(!/uploadCiMediaFile\(event, '\$\{esc\(inputId\)\}'/.test(shipField[0] + ""), "branch exists");
  // Ship-specific render must not offer legacy Upload Image label
  const shipRender = admin.slice(admin.indexOf("// Ship heroes are owned by Media Library"), admin.indexOf("return `\n    <div class=\"ci-media-field\" data-media-kind=\"${esc(kind)}\">"));
  assert(/Choose from Media Library/.test(shipRender), "ship render has ML choose");
  assert(!/Upload Image/.test(shipRender), "ship render has no Upload Image");
  const ciUpload = readFileSync(path.join(root, "netlify/functions/ci-media-upload.js"), "utf8");
  assert(/Media Library/.test(ciUpload) && /410/.test(ciUpload), "ci-media-upload blocks ship");
  passed += 1;

  console.log(`test-migrate-orphan-ship-heroes: ${passed} groups ok`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
