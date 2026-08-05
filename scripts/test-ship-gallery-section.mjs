/**
 * Offline tests for Client Portal ship gallery section rendering.
 * Run: node scripts/test-ship-gallery-section.mjs
 *
 * Fixtures mirror production gallery counts:
 * Queen Victoria (1), Caribbean Princess (2), Celebrity Beyond (3), Silver Muse (0).
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
  renderShipGallerySection
} = require("../js/ship-gallery-section.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const HERO = "https://cdn.example.com/ships/hero.jpg";

const FIXTURES = {
  "Queen Victoria": {
    heroUrl: HERO,
    images: [
      {
        url: "https://cdn.example.com/ships/queen-victoria-gallery-01.jpg",
        title: "Queen Victoria gallery 01",
        alt: "Queen Victoria gallery photo"
      }
    ]
  },
  "Caribbean Princess": {
    heroUrl: HERO,
    images: [
      {
        url: "https://cdn.example.com/ships/caribbean-princess-gallery-01.jpg",
        title: "Caribbean Princess gallery 01",
        alt: "Caribbean Princess gallery photo"
      },
      {
        url: "https://cdn.example.com/ships/caribbean-princess-gallery-02.jpg",
        title: "Caribbean Princess gallery 02",
        alt: "Caribbean Princess gallery photo"
      }
    ]
  },
  "Celebrity Beyond": {
    heroUrl: HERO,
    images: [
      {
        url: "https://cdn.example.com/ships/beyond-gallery-01.jpg",
        title: "Celebrity Beyond gallery 01",
        alt: "Celebrity Beyond gallery photo"
      },
      {
        url: "https://cdn.example.com/ships/beyond-gallery-02.jpg",
        title: "Celebrity Beyond gallery 02",
        alt: "Celebrity Beyond gallery photo"
      },
      {
        url: "https://cdn.example.com/ships/beyond-gallery-03.jpg",
        title: "Celebrity Beyond gallery 03",
        alt: "Celebrity Beyond gallery photo"
      }
    ]
  },
  "Silver Muse": {
    heroUrl: HERO,
    images: []
  }
};

// Zero images — Silver Muse
{
  const html = renderShipGallerySection(FIXTURES["Silver Muse"].images, {
    heroUrl: FIXTURES["Silver Muse"].heroUrl
  });
  assert(html === "", "zero images returns no gallery section");
  assert(!/Explore your ship/.test(html), "zero images has no heading");
  assert(!/dashboard-ship-gallery-track/.test(html), "zero images has no track");
}

// One image — Queen Victoria
{
  const html = renderShipGallerySection(FIXTURES["Queen Victoria"].images, {
    heroUrl: FIXTURES["Queen Victoria"].heroUrl
  });
  assert(/Explore your ship/.test(html), "one image renders section heading");
  assert(/dashboard-ship-gallery--single/.test(html), "one image uses single layout");
  assert(/queen-victoria-gallery-01\.jpg/.test(html), "one image renders the image url");
  assert(/alt="Queen Victoria gallery photo"/.test(html), "one image keeps alt text");
  assert(!/dashboard-ship-gallery-track/.test(html), "one image does not render carousel track");
  assert(!/carousel|gallery-prev|gallery-next|aria-controls/.test(html), "one image has no nav controls");
  assert((html.match(/data-gallery-index="/g) || []).length === 1, "one image has one clickable item");
}

// Two images — Caribbean Princess
{
  const html = renderShipGallerySection(FIXTURES["Caribbean Princess"].images, {
    heroUrl: FIXTURES["Caribbean Princess"].heroUrl
  });
  assert(/dashboard-ship-gallery-track/.test(html), "two images retain track layout");
  assert(!/dashboard-ship-gallery--single/.test(html), "two images are not single layout");
  assert((html.match(/data-gallery-index="/g) || []).length === 2, "two images render two items");
  assert(/caribbean-princess-gallery-01\.jpg/.test(html), "two images include first url");
  assert(/caribbean-princess-gallery-02\.jpg/.test(html), "two images include second url");
}

// Three images — Celebrity Beyond
{
  const html = renderShipGallerySection(FIXTURES["Celebrity Beyond"].images, {
    heroUrl: FIXTURES["Celebrity Beyond"].heroUrl
  });
  assert(/dashboard-ship-gallery-track/.test(html), "three images retain track layout");
  assert((html.match(/data-gallery-index="/g) || []).length === 3, "three images render three items");
  assert(!/dashboard-ship-gallery--single/.test(html), "three images are not single layout");
}

// Hero URL excluded if accidentally present
{
  const html = renderShipGallerySection(
    [
      { url: HERO, title: "Hero leak", alt: "Hero" },
      {
        url: "https://cdn.example.com/ships/ok.jpg",
        title: "Ok",
        alt: "Ok photo"
      }
    ],
    { heroUrl: HERO }
  );
  assert(!html.includes(HERO), "hero url excluded from gallery markup");
  assert(/dashboard-ship-gallery--single/.test(html), "remaining single image uses single layout");
  assert(/ok\.jpg/.test(html), "non-hero image remains");
}

// Invalid / blank URLs ignored
{
  const normalised = normaliseShipGalleryImages([
    { url: "", title: "blank" },
    { url: "   ", title: "spaces" },
    { public_url: null, title: "null" },
    { url: "https://cdn.example.com/ships/valid.jpg", title: "Valid", alt: "Valid" }
  ]);
  assert(normalised.length === 1, "blank urls ignored");
  assert(normalised[0].url.includes("valid.jpg"), "valid url kept");

  const html = renderShipGallerySection([
    { url: "" },
    { url: null },
    { url: "https://cdn.example.com/ships/valid.jpg", alt: "Valid" }
  ]);
  assert(/valid\.jpg/.test(html), "render keeps valid url only");
  assert(/dashboard-ship-gallery--single/.test(html), "one valid image → single layout");
}

// Planner wiring: threshold no longer requires 2 images
{
  const planner = readFileSync(path.join(root, "js/planner.js"), "utf8");
  assert(!/list\.length\s*<\s*2\s*return\s*""/.test(planner), "old <2 gate removed");
  assert(/renderShipGallerySection\(shipGalleryImages,\s*mainShipImage\)/.test(planner), "hero passed into render");
  assert(/ShipGallerySection\.render/.test(planner), "shared helper used");

  const indexHtml = readFileSync(path.join(root, "index.html"), "utf8");
  assert(/ship-gallery-section\.js/.test(indexHtml), "helper script loaded");

  const css = readFileSync(path.join(root, "css/planner.css"), "utf8");
  assert(/dashboard-ship-gallery--single/.test(css), "single-image styles present");
  assert(/dashboard-ship-gallery-item--single/.test(css), "single item styles present");
  assert(/\.dashboard-ship-gallery-lightbox\[hidden\]/.test(css), "hidden lightbox forced off-screen");
  assert(/\.dashboard-ship-gallery-lightbox:not\(\[hidden\]\)/.test(css), "visible lightbox uses grid layout");
}

// Lightbox markup starts hidden
{
  const html = renderShipGallerySection(FIXTURES["Queen Victoria"].images, {
    heroUrl: FIXTURES["Queen Victoria"].heroUrl
  });
  assert(/id="shipGalleryLightbox"\s+hidden/.test(html), "lightbox includes hidden attribute");
  assert(/aria-hidden="true"/.test(html), "lightbox marked aria-hidden when closed");
}

// No financial / itinerary / booking behaviour in this module
{
  const src = readFileSync(path.join(root, "js/ship-gallery-section.js"), "utf8");
  assert(!/fully_paid|instalment|booking_reference|itinerary|payment/i.test(src), "no finance/booking/itinerary logic");
}

// Ship page gallery renderer
{
  const { renderShipPageGallerySection: renderPageGallery } = require("../js/ship-gallery-section.js");
  const html = renderPageGallery(
    [{ url: "https://cdn.example.com/ships/edge-01.jpg", alt: "Deck" }],
    { heroUrl: HERO, shipName: "Celebrity Edge" }
  );
  assert(/More photos of Celebrity Edge/.test(html), "ship page heading uses ship name");
  assert(/ship-page-gallery-grid/.test(html), "ship page uses compact grid");
  assert(!/Explore your ship/.test(html), "ship page does not reuse dashboard heading");
}

console.log("test-ship-gallery-section: ok");
