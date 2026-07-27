/**
 * Unit tests for ship gallery media filtering helpers.
 * Run: node scripts/test-ship-gallery.mjs
 */

import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  isLogoMedia,
  isDefaultHeroDuplicate,
  filterShipGalleryMedia
} = require("../netlify/functions/lib/ship-gallery-media.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const HERO = "https://cdn.example.com/ships/hero.jpg";

const rows = [
  {
    id: "1",
    title: "At sea",
    alt_text: "Ship at sea",
    public_url: "https://cdn.example.com/ships/1.jpg",
    media_type: "ship",
    ship_id: "ship-1",
    cruise_line_id: null,
    tags: ["exterior"],
    is_default: false,
    is_active: true
  },
  {
    id: "2",
    title: "Line logo",
    alt_text: "Logo",
    public_url: "https://cdn.example.com/lines/logo.png",
    media_type: "cruise_line",
    ship_id: null,
    cruise_line_id: "line-1",
    tags: ["logo"],
    is_default: false,
    is_active: true
  },
  {
    id: "3",
    title: "Default hero duplicate",
    alt_text: "Hero",
    public_url: HERO,
    media_type: "ship",
    ship_id: "ship-1",
    cruise_line_id: null,
    tags: [],
    is_default: true,
    is_active: true
  },
  {
    id: "4",
    title: "Pool deck",
    alt_text: "Pool",
    public_url: "https://cdn.example.com/ships/4.jpg",
    media_type: "ship",
    ship_id: "ship-1",
    cruise_line_id: null,
    tags: ["deck"],
    is_default: false,
    is_active: true
  },
  {
    id: "5",
    title: "Inactive",
    alt_text: "Inactive",
    public_url: "https://cdn.example.com/ships/5.jpg",
    media_type: "ship",
    ship_id: "ship-1",
    cruise_line_id: null,
    tags: [],
    is_default: false,
    is_active: false
  }
];

assert(isLogoMedia(rows[1]) === true, "line logo media excluded");
assert(isLogoMedia(rows[0]) === false, "ship photo is not logo");

assert(isDefaultHeroDuplicate(rows[2], HERO) === true, "default hero duplicate detected");
assert(isDefaultHeroDuplicate(rows[0], HERO) === false, "non-hero url kept");

const filtered = filterShipGalleryMedia(rows, { heroUrl: HERO, limit: 8 });
assert(filtered.length === 2, "filters logos, hero duplicate, and inactive rows");
assert(
  filtered.every((item) => item.url && item.id && "alt" in item && "title" in item),
  "mapped response shape"
);
assert(!filtered.some((item) => item.url === HERO), "hero duplicate removed");
assert(filtered[0].id === "1" && filtered[1].id === "4", "expected gallery items remain");

const limited = filterShipGalleryMedia(rows, { heroUrl: HERO, limit: 1 });
assert(limited.length === 1, "limit respected");

console.log("test-ship-gallery: ok");
