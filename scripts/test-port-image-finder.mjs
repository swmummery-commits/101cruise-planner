#!/usr/bin/env node
/**
 * Port Image Finder — unit/smoke tests (no live API calls).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { createRequire } from "node:module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(pathToFileURL(path.join(root, "package.json")));

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function loadCjs(rel) {
  return createRequire(pathToFileURL(path.join(root, rel)))(path.join(root, rel));
}

const { buildPortImageQueries } = loadCjs("netlify/functions/lib/port-image-finder/queries.js");
const { scorePortImageCandidate, pickBestCandidate, AUTO_APPROVE_THRESHOLD } = loadCjs(
  "netlify/functions/lib/port-image-finder/scoring.js"
);
const { hasConflictingLocation } = loadCjs("netlify/functions/lib/port-image-finder/country-match.js");
const {
  indexPortsCatalogue,
  lookupCataloguePort,
  resolveCatalogueMediaIds
} = loadCjs("netlify/functions/lib/port-image-finder/resolve-public.js");
const { canOverwritePortImage } = loadCjs("netlify/functions/lib/port-image-finder/apply.js");
const { portImageFallback, applyDestinationImageFallbacks } = loadCjs(
  "netlify/functions/lib/destination-image-fallbacks.js"
);

const fnSrc = read("netlify/functions/port-image-finder.js");
const adminSrc = read("js/admin-ports-catalogue.js");
const publicDestSrc = read("netlify/functions/public-destination.js");
const researchSrc = read("netlify/functions/lib/research-public.js");
const braveSrc = read("netlify/functions/lib/brave-search.js");
const destPageDataSrc = read("js/destination-page-data.js");
const migrationSrc = read("supabase/migrations/20260808_ports_image_finder.sql");

// Query generation
const civitQueries = buildPortImageQueries({
  canonical_name: "Civitavecchia",
  city: "Civitavecchia",
  country: "Italy",
  country_code: "IT"
});
assert(civitQueries.length >= 3, "generates multiple query variants");
assert(civitQueries.some((q) => /civitavecchia/i.test(q) && /italy/i.test(q)), "includes country context");
assert(civitQueries.some((q) => /cruise port|harbour|waterfront/i.test(q)), "includes port suffix variants");

// Ambiguous port false-positive protection
const albanyAu = {
  canonical_name: "Albany",
  country: "Australia",
  country_code: "AU",
  region: "Western Australia"
};
assert(
  hasConflictingLocation("Albany New York harbour waterfront", albanyAu),
  "rejects Albany NY for Albany WA port"
);
assert(
  !hasConflictingLocation("Albany Western Australia harbour", albanyAu),
  "accepts Albany WA context"
);

const newcastleAu = {
  canonical_name: "Newcastle",
  country: "Australia",
  country_code: "AU",
  region: "New South Wales"
};
assert(
  hasConflictingLocation("Newcastle upon Tyne UK harbour", newcastleAu),
  "rejects Newcastle UK for Newcastle NSW"
);

// Scoring prefers Wikimedia with port context
const portChalmers = {
  canonical_name: "Port Chalmers",
  city: "Port Chalmers",
  country: "New Zealand",
  country_code: "NZ",
  region: "Otago"
};
const goodWiki = scorePortImageCandidate(
  {
    provider: "wikimedia",
    title: "Port Chalmers cruise port Otago New Zealand harbour",
    url: "https://upload.wikimedia.org/w/example.jpg",
    width: 1600,
    height: 900,
    license: "CC BY-SA 4.0"
  },
  portChalmers
);
const badBrave = scorePortImageCandidate(
  {
    provider: "brave",
    title: "Albany New York skyline",
    url: "https://cdn.example.com/albany.jpg",
    width: 1200,
    height: 800
  },
  albanyAu
);
assert(goodWiki.confidence >= AUTO_APPROVE_THRESHOLD - 10, "strong Wikimedia port match scores high");
assert(badBrave.rejected || badBrave.confidence < goodWiki.confidence, "conflicting brave result scores lower");

const ranked = pickBestCandidate(
  [
    {
      provider: "brave",
      title: "Victoria Australia harbour",
      url: "https://cdn.example.com/vic.jpg",
      width: 1200,
      height: 800
    },
    {
      provider: "wikimedia",
      title: "Victoria British Columbia cruise port harbour",
      url: "https://upload.wikimedia.org/w/vic-bc.jpg",
      width: 1400,
      height: 900,
      license: "CC BY 2.0"
    }
  ],
  { canonical_name: "Victoria", country: "Canada", country_code: "CA", region: "British Columbia" }
);
assert(/british columbia|bc/i.test(ranked[0]?.candidate?.title || ""), "prefers BC Victoria over Australia");

// Manual image protection
assert(!canOverwritePortImage({ image_status: "MANUAL", hero_media_id: "abc" }), "manual image cannot be overwritten");
assert(canOverwritePortImage({ image_status: "NO_IMAGE", hero_media_id: null }), "missing image can be enriched");

// Public catalogue resolution
const catalogue = indexPortsCatalogue([
  {
    canonical_name: "Wellington",
    country: "New Zealand",
    hero_media_id: "media-1",
    image_status: "AUTO_APPROVED"
  }
]);
const hit = lookupCataloguePort("Wellington", catalogue);
assert(hit?.hero_media_id === "media-1", "catalogue lookup by port name");

// Country fallback disabled for ports
assert(portImageFallback("alaska", "juneau", "Juneau") === null, "port country fallback disabled");
const page = applyDestinationImageFallbacks({ slug: "alaska", name: "Alaska", hero: null, ports: [] });
assert(!page.ports?.length, "destination fallback does not inject port images");

// Destination page data — no placeholder when missing
const sandbox = { window: {}, globalThis: null, console };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.runInNewContext(read("js/destination-page-data.js"), sandbox, { filename: "destination-page-data.js" });
const resolved = sandbox.DestinationPageData.resolvePortImage({ name: "Juneau", mediaId: null, media: null });
assert(resolved.url === "", "missing port image returns empty url");
assert(resolved.source === "none", "missing port image source is none");

const withImage = sandbox.DestinationPageData.resolvePortImage({
  name: "Juneau",
  mediaId: "id-1",
  media: { url: "https://cdn.example.com/juneau.jpg", alt: "Juneau" }
});
assert(withImage.url.includes("juneau"), "port-specific image used when present");

// Server-side wiring
assert(/port-image-finder/.test(adminSrc), "admin calls port-image-finder function");
assert(!/BRAVE_SEARCH_API_KEY/.test(adminSrc), "admin UI does not reference Brave API key");
assert(/resolveCatalogueMediaIds/.test(publicDestSrc), "public destination resolves catalogue port images");
assert(/resolveCatalogueMediaIds/.test(researchSrc), "featured cruise itinerary uses catalogue port images");
assert(/function braveImageSearch/.test(braveSrc), "brave image search helper exists");
assert(/action === "find_candidates"/.test(fnSrc), "port-image-finder supports find_candidates");
assert(/action === "bulk_missing"/.test(fnSrc), "port-image-finder supports bulk_missing");
assert(/image_status/.test(migrationSrc), "migration adds image_status");

// resolveCatalogueMediaIds uses server-side fetch only (mock)
let queried = "";
await resolveCatalogueMediaIds(async (path) => {
  queried = path;
  return [
    {
      canonical_name: "Napier",
      hero_media_id: "m-napier",
      image_status: "AUTO_APPROVED"
    }
  ];
}, ["Napier"]);
assert(queried.includes("ports?"), "catalogue resolver queries ports table");
assert(queried.includes("hero_media_id"), "catalogue resolver filters by hero_media_id");

console.log("test-port-image-finder: ok");
