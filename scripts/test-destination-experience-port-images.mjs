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
  nameKeysForLookup,
  resolvePublicPortHeroMedia
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

const ambiguousCatalogue = [
  {
    canonical_name: "Sydney Nova Scotia",
    display_name: "Sydney, Nova Scotia, Canada",
    city: "Sydney",
    country: "Canada",
    country_code: "CA",
    aliases: ["Sydney"],
    hero_media_id: "media-sydney-ns",
    image_status: "AUTO_APPROVED"
  },
  {
    canonical_name: "Sydney",
    display_name: "Sydney, Australia",
    city: "Sydney",
    country: "Australia",
    country_code: "AU",
    aliases: [],
    hero_media_id: "media-sydney-au",
    image_status: "MANUAL"
  }
];
const ambiguousIndex = indexPortsCatalogue(ambiguousCatalogue);
const sydneyHit = lookupCataloguePort("Sydney", ambiguousIndex, ambiguousCatalogue);
assert.equal(sydneyHit?.canonical_name, "Sydney", "plain Sydney resolves to Australia, not Nova Scotia");
assert.equal(sydneyHit?.hero_media_id, "media-sydney-au", "plain Sydney uses approved Australia hero");

const legacyPortRow = {
  name: "Sydney",
  hero_media_id: "media-destination-old"
};
const catalogueMap = new Map([["sydney", "media-sydney-au"]]);
const resolvedHero = resolvePublicPortHeroMedia(legacyPortRow, catalogueMap);
assert.equal(resolvedHero.hero_media_id, "media-sydney-au", "canonical ports hero overrides destination_ports legacy");
assert.equal(resolvedHero.source, "ports_catalogue", "canonical source recorded");
assert.equal(resolvedHero.legacy_hero_media_id, "media-destination-old", "legacy id preserved for audit");

const legacyOnly = resolvePublicPortHeroMedia(
  { name: "Obscure Port", hero_media_id: "media-legacy-only" },
  new Map()
);
assert.equal(legacyOnly.hero_media_id, "media-legacy-only", "legacy destination_ports hero kept when no canonical image");
assert.equal(legacyOnly.source, "destination_ports_legacy", "legacy fallback source");

console.log("test-destination-experience-port-images: ok");
