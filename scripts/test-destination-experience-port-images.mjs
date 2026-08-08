/**
 * Destination Experience — catalogue port image alias resolution.
 *
 * Run: node scripts/test-destination-experience-port-images.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const {
  indexPortsCatalogue,
  lookupCataloguePort,
  nameKeysForLookup
} = require(path.join(root, "netlify/functions/lib/port-image-finder/resolve-public.js"));

const catalogueRows = [
  {
    canonical_name: "Barcelona",
    display_name: "Barcelona",
    city: "Barcelona",
    country: "Spain",
    aliases: [],
    hero_media_id: "media-barcelona",
    image_status: "AUTO_APPROVED"
  },
  {
    canonical_name: "Civitavecchia",
    display_name: "Civitavecchia (Rome)",
    city: "Civitavecchia",
    country: "Italy",
    aliases: ["Rome"],
    hero_media_id: "media-civitavecchia",
    image_status: "AUTO_APPROVED"
  },
  {
    canonical_name: "Santorini",
    display_name: "Santorini",
    city: "Santorini",
    country: "Greece",
    aliases: [],
    hero_media_id: "media-santorini",
    image_status: "AUTO_APPROVED"
  },
  {
    canonical_name: "Piraeus",
    display_name: "Piraeus (Athens)",
    city: "Piraeus",
    country: "Greece",
    aliases: ["Athens"],
    hero_media_id: "media-piraeus",
    image_status: "AUTO_APPROVED"
  },
  {
    canonical_name: "Dubrovnik",
    display_name: "Dubrovnik",
    city: "Dubrovnik",
    country: "Croatia",
    aliases: [],
    hero_media_id: "media-dubrovnik",
    image_status: "AUTO_APPROVED"
  },
  {
    canonical_name: "Ravenna",
    display_name: "Ravenna (Venice)",
    city: "Ravenna",
    country: "Italy",
    aliases: ["Venice"],
    hero_media_id: "media-ravenna",
    image_status: "AUTO_APPROVED"
  }
];

const index = indexPortsCatalogue(catalogueRows);

const cases = [
  { label: "Barcelona", expect: "Barcelona", media: "media-barcelona" },
  { label: "Rome (Civitavecchia)", expect: "Civitavecchia", media: "media-civitavecchia" },
  { label: "Santorini", expect: "Santorini", media: "media-santorini" },
  { label: "Athens (Piraeus)", expect: "Piraeus", media: "media-piraeus" },
  { label: "Dubrovnik", expect: "Dubrovnik", media: "media-dubrovnik" },
  { label: "Venice / Ravenna", expect: "Ravenna", media: "media-ravenna" },
  { label: "Mystery Port", expect: null, media: null }
];

for (const row of cases) {
  const hit = lookupCataloguePort(row.label, index);
  const resolved = hit?.canonical_name || null;
  const media = hit?.hero_media_id || null;
  console.log(
    [
      row.label,
      `resolved=${resolved || "—"}`,
      `image=${media ? "yes" : "no"}`,
      media ? `source=ports_catalogue/${media}` : "render=name-only"
    ].join(" | ")
  );
  if (row.expect) {
    assert.equal(resolved, row.expect, `${row.label} should resolve to ${row.expect}`);
    assert.equal(media, row.media, `${row.label} media id`);
  } else {
    assert.equal(hit, null, `${row.label} should not resolve`);
  }
}

assert(nameKeysForLookup("Rome (Civitavecchia)").includes("civitavecchia"), "paren alias keys generated");
assert(nameKeysForLookup("Venice / Ravenna").includes("ravenna"), "slash alias keys generated");

console.log("test-destination-experience-port-images: ok");
