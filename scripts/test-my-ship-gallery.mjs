/**
 * My Ship page supplementary gallery tests.
 * Run: node scripts/test-my-ship-gallery.mjs
 */

import { createRequire } from "module";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const {
  normaliseShipGalleryImages,
  renderShipPageGallerySection
} = require("../js/ship-gallery-section.js");

const { filterShipGalleryMedia } = require("../netlify/functions/lib/ship-gallery-media.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const HERO = "https://cdn.example.com/ships/edge-hero.jpg";
const SHIP_NAME = "Celebrity Edge";

const SHIP_A_ROWS = [
  {
    id: "a1",
    title: "Pool deck",
    alt_text: "Pool deck at sea",
    public_url: "https://cdn.example.com/ships/edge-01.jpg",
    media_type: "ship",
    ship_id: "ship-a",
    tags: [],
    is_default: false,
    is_active: true
  },
  {
    id: "a2",
    title: "Hero duplicate",
    alt_text: "Hero",
    public_url: HERO,
    media_type: "ship",
    ship_id: "ship-a",
    tags: [],
    is_default: false,
    is_active: true
  },
  {
    id: "a3",
    title: "Duplicate url",
    alt_text: "Dup",
    public_url: "https://cdn.example.com/ships/edge-01.jpg",
    media_type: "ship",
    ship_id: "ship-a",
    tags: [],
    is_default: false,
    is_active: true
  }
];

const SHIP_B_ROW = {
  id: "b1",
  title: "Other ship",
  alt_text: "Other",
  public_url: "https://cdn.example.com/ships/other.jpg",
  media_type: "ship",
  ship_id: "ship-b",
  tags: [],
  is_default: false,
  is_active: true
};

// 1. Ship with additional images displays gallery + heading
{
  const html = renderShipPageGallerySection(
    [{ url: "https://cdn.example.com/ships/edge-01.jpg", alt: "Pool deck at sea" }],
    { heroUrl: HERO, shipName: SHIP_NAME }
  );
  assert(/ship-page-gallery/.test(html), "gallery section rendered");
  assert(/More photos of Celebrity Edge/.test(html), "heading includes ship name");
  assert(/ship-page-gallery-grid/.test(html), "compact grid layout used");
}

// 2. Hero image excluded
{
  const list = normaliseShipGalleryImages(
    [
      { url: HERO, alt: "Hero leak" },
      { url: "https://cdn.example.com/ships/edge-01.jpg", alt: "Extra" }
    ],
    { heroUrl: HERO, shipName: SHIP_NAME, defaultAlt: `${SHIP_NAME} additional ship photo` }
  );
  assert(list.length === 1, "hero url excluded");
  assert(!list.some((row) => row.url === HERO), "hero not in normalised list");
}

// 3. Duplicate image records removed
{
  const filtered = filterShipGalleryMedia(SHIP_A_ROWS, { heroUrl: HERO, limit: 8 });
  assert(filtered.length === 1, "duplicate urls and hero removed for same ship");
  assert(filtered[0].url.includes("edge-01.jpg"), "first unique image kept");

  const normalised = normaliseShipGalleryImages(
    [
      { url: "https://cdn.example.com/ships/x.jpg", alt: "One" },
      { url: "https://cdn.example.com/ships/x.jpg", alt: "Dup" }
    ],
    { heroUrl: HERO, limit: 8 }
  );
  assert(normalised.length === 1, "client dedupes repeated urls");
}

// 4. Gallery limited to 8 images
{
  const many = Array.from({ length: 12 }, (_, index) => ({
    url: `https://cdn.example.com/ships/edge-${index + 1}.jpg`,
    alt: `Photo ${index + 1}`
  }));
  const list = normaliseShipGalleryImages(many, { heroUrl: HERO, limit: 8 });
  assert(list.length === 8, "eight image cap enforced");

  const limitedRows = Array.from({ length: 12 }, (_, index) => ({
    id: String(index),
    title: `Photo ${index}`,
    alt_text: `Photo ${index}`,
    public_url: `https://cdn.example.com/ships/server-${index}.jpg`,
    media_type: "ship",
    ship_id: "ship-a",
    tags: [],
    is_default: false,
    is_active: true
  }));
  assert(filterShipGalleryMedia(limitedRows, { heroUrl: HERO, limit: 8 }).length === 8, "server limit enforced");
}

// 5. No additional images → no gallery markup
{
  const html = renderShipPageGallerySection([], { heroUrl: HERO, shipName: SHIP_NAME });
  assert(html === "", "empty gallery returns nothing");
  assert(!/More photos of/.test(html), "no heading without images");
}

// 6. Media associated by stable ship ID at API layer (not name/filename matching)
{
  const shipGalleryJs = readFileSync(path.join(root, "netlify/functions/ship-gallery.js"), "utf8");
  assert(/ship_id=eq\.\$\{encodeURIComponent\(/.test(shipGalleryJs), "gallery API queries media_library by ship_id");
  assert(/resolveCruiseShip/.test(shipGalleryJs), "booked ship name resolves to CI ship id first");
  assert(SHIP_B_ROW.ship_id !== SHIP_A_ROWS[0].ship_id, "fixture ships use distinct ids");
}

// 7. Invalid / missing URLs skipped
{
  const html = renderShipPageGallerySection(
    [{ url: "" }, { url: null }, { url: "https://cdn.example.com/ships/valid.jpg", alt: "Valid" }],
    { heroUrl: HERO, shipName: SHIP_NAME }
  );
  assert(/valid\.jpg/.test(html), "valid url rendered");
  assert((html.match(/data-gallery-index="/g) || []).length === 1, "invalid urls skipped");
  assert(/onerror=/.test(html), "broken image handler present");
}

// 8. Correct ship name in heading + alt fallback
{
  const html = renderShipPageGallerySection(
    [{ url: "https://cdn.example.com/ships/edge-01.jpg" }],
    { heroUrl: HERO, shipName: SHIP_NAME }
  );
  assert(/More photos of Celebrity Edge/.test(html), "heading uses ship name");
  assert(/Celebrity Edge additional ship photo/.test(html), "default alt fallback used");
}

// 9. Planner wiring — renderTheShip still works and loads gallery
{
  const planner = readFileSync(path.join(root, "js/planner.js"), "utf8");
  assert(/async function renderTheShip\(\)/.test(planner), "renderTheShip retained");
  assert(/CiShipPresentation\.renderPresentationHtml/.test(planner), "presentation html retained");
  assert(/loadShipGalleryImages\(/.test(planner), "gallery fetch wired");
  assert(/renderShipPageGallerySection\(galleryImages/.test(planner), "ship page gallery render wired");
  assert(/bindShipGalleryInteractions\(galleryList\)/.test(planner), "lightbox interactions wired");
}

// 10. Responsive layout styles without horizontal overflow helpers
{
  const css = readFileSync(path.join(root, "css/ci-ship-presentation.css"), "utf8");
  assert(/\.ship-page-gallery-grid/.test(css), "gallery grid styles present");
  assert(/grid-template-columns: repeat\(4/.test(css), "desktop four-column grid");
  assert(/max-width: 980px[\s\S]*repeat\(3/.test(css), "tablet three-column grid");
  assert(/max-width: 760px[\s\S]*repeat\(2/.test(css), "mobile two-column grid");
  assert(/max-width: 360px[\s\S]*minmax\(0, 1fr\)/.test(css), "very narrow single column");
  assert(/\.ship-page-gallery-grid[\s\S]*width: 100%/.test(css), "gallery grid stays within content width");
}

// Stylesheet must load directly — mid-file @import in planner.css is ignored by browsers
{
  const indexHtml = readFileSync(path.join(root, "index.html"), "utf8");
  assert(/ci-ship-presentation\.css/.test(indexHtml), "index.html links ship presentation css directly");
}

console.log("test-my-ship-gallery: ok");
