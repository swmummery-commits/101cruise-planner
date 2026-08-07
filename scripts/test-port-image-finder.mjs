#!/usr/bin/env node
/**
 * Port Image Finder — unit/smoke tests (no live API calls except optional wikimedia mock).
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
  return require(path.join(root, rel));
}

const { buildPortImageQueries, searchIdentityName, regionIsCompatible } = loadCjs(
  "netlify/functions/lib/port-image-finder/queries.js"
);
const {
  scorePortImageCandidate,
  pickBestCandidate,
  statusForCandidate,
  statusForScores,
  isVesselPrimarySubject,
  licenseIsUsable,
  destinationSpecificityScores,
  genericImageryPenalty,
  GEO_AUTO_MIN,
  SUIT_AUTO_MIN
} = loadCjs("netlify/functions/lib/port-image-finder/scoring.js");
const { hasConflictingLocation } = loadCjs("netlify/functions/lib/port-image-finder/country-match.js");
const {
  indexPortsCatalogue,
  lookupCataloguePort,
  resolveCatalogueMediaIds
} = loadCjs("netlify/functions/lib/port-image-finder/resolve-public.js");
const {
  canOverwritePortImage,
  approveReviewedPortImage,
  assertCandidateApplicable,
  __resetDownloadThrottleForTests
} = loadCjs("netlify/functions/lib/port-image-finder/apply.js");
const { portImageFallback, applyDestinationImageFallbacks } = loadCjs(
  "netlify/functions/lib/destination-image-fallbacks.js"
);
const {
  __resetWikimediaClientForTests
} = loadCjs("netlify/functions/lib/port-image-finder/sources/wikimedia-client.js");

const fnSrc = read("netlify/functions/port-image-finder.js");
const catalogueFnSrc = read("netlify/functions/ports-catalogue.js");
const adminSrc = read("js/admin-ports-catalogue.js");
const publicDestSrc = read("netlify/functions/public-destination.js");
const researchSrc = read("netlify/functions/lib/research-public.js");
const braveSrc = read("netlify/functions/lib/brave-search.js");
const migrationSrc = read("supabase/migrations/20260807_ports_image_finder.sql");

// --- Query generation & deduplication ---
const civitQueries = buildPortImageQueries({
  canonical_name: "Civitavecchia",
  city: "Civitavecchia",
  country: "Italy",
  country_code: "IT"
});
assert(civitQueries.length >= 3 && civitQueries.length <= 4, "generates a small high-quality query set");
assert(civitQueries.some((q) => /civitavecchia/i.test(q) && /italy/i.test(q)), "includes country context");
assert(civitQueries.some((q) => /harbour|waterfront|cruise port/i.test(q)), "includes destination suffixes");
const civitKeys = civitQueries.map((q) => q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());
assert(new Set(civitKeys).size === civitKeys.length, "queries are deduplicated");

// Port Chalmers retains port-specific search identity
const portChalmersPort = {
  canonical_name: "Port Chalmers",
  city: "Dunedin",
  country: "New Zealand",
  country_code: "NZ",
  region: "Otago",
  aliases: ["Dunedin", "Port Chalmers Dunedin"]
};
assert(searchIdentityName(portChalmersPort) === "Port Chalmers", "search identity keeps Port Chalmers wording");
const chalmersQueries = buildPortImageQueries(portChalmersPort);
assert(chalmersQueries.every((q) => /port chalmers/i.test(q)), "queries retain Port Chalmers identity");
assert(!chalmersQueries.some((q) => /^dunedin new zealand/i.test(q) && !/port chalmers/i.test(q)), "does not collapse to Dunedin-only");

// Victoria BC — malformed Alaska region excluded from queries
const victoriaBc = {
  canonical_name: "Victoria BC",
  city: "Victoria",
  country: "Canada",
  country_code: "CA",
  region: "Alaska"
};
assert(!regionIsCompatible("CA", "Alaska"), "Alaska region incompatible with Canada port");
const victoriaFixed = { ...victoriaBc, region: "British Columbia" };
const victoriaQueries = buildPortImageQueries(victoriaFixed);
assert(!victoriaQueries.some((q) => /alaska/i.test(q)), "Victoria BC queries exclude erroneous Alaska");

// --- Ambiguous port false-positive protection ---
const albanyAu = {
  canonical_name: "Albany",
  country: "Australia",
  country_code: "AU",
  region: "Western Australia"
};
assert(hasConflictingLocation("Albany New York harbour waterfront", albanyAu), "rejects Albany NY for Albany WA");
assert(!hasConflictingLocation("Albany Western Australia harbour", albanyAu), "accepts Albany WA context");

const newcastleAu = {
  canonical_name: "Newcastle",
  country: "Australia",
  country_code: "AU",
  region: "New South Wales"
};
assert(hasConflictingLocation("Newcastle upon Tyne UK harbour", newcastleAu), "rejects Newcastle UK for Newcastle NSW");
assert(!hasConflictingLocation("Newcastle New South Wales harbour", newcastleAu), "accepts Newcastle NSW");

// --- Geographic vs suitability scoring ---
const shipDominated = scorePortImageCandidate(
  {
    provider: "wikimedia",
    title: "Celebrity Solstice cruise ship at Civitavecchia",
    description: "Passenger ship in port",
    url: "https://upload.wikimedia.org/w/example-ship.jpg",
    width: 1600,
    height: 900,
    license: "CC BY-SA 4.0"
  },
  { canonical_name: "Civitavecchia", country: "Italy", country_code: "IT" }
);
const harbourScene = scorePortImageCandidate(
  {
    provider: "wikimedia",
    title: "Civitavecchia Italy harbour waterfront panorama",
    description: "Port town and harbour view",
    url: "https://upload.wikimedia.org/w/example-harbour.jpg",
    width: 1600,
    height: 900,
    license: "CC BY-SA 4.0"
  },
  { canonical_name: "Civitavecchia", country: "Italy", country_code: "IT" }
);

assert(shipDominated.geographic >= 50, "ship photo may still match geography");
assert(shipDominated.suitability < harbourScene.suitability, "ship-dominated image has lower suitability");
assert(shipDominated.confidence < harbourScene.confidence, "overall confidence separates geo from suitability");
assert(statusForCandidate({ ...shipDominated, candidate: { provider: "wikimedia", license: "CC BY-SA 4.0" } }) !== "AUTO_APPROVED", "ship-dominated Wikimedia does not auto-approve on geo alone");
assert(
  statusForCandidate({ ...harbourScene, candidate: { provider: "wikimedia", license: "CC BY-SA 4.0" } }) === "AUTO_APPROVED" ||
    statusForCandidate({ ...harbourScene, candidate: { provider: "wikimedia", license: "CC BY-SA 4.0" } }) === "NEEDS_REVIEW",
  "harbour imagery can reach review or auto-approve"
);

const cavour = scorePortImageCandidate(
  {
    provider: "wikimedia",
    title: "Cavour (550) - Civitavecchia harbour, Italy - June 2011.jpg",
    url: "https://upload.wikimedia.org/w/example.jpg",
    width: 1280,
    height: 853,
    license: "CC BY 2.0"
  },
  { canonical_name: "Civitavecchia", country: "Italy", country_code: "IT" }
);
assert(cavour.vesselPrimary, "Cavour naval title is vessel-primary");
assert(
  statusForCandidate({ ...cavour, candidate: { provider: "wikimedia", license: "CC BY 2.0" } }) !== "AUTO_APPROVED",
  "Cavour naval vessel is not AUTO_APPROVED"
);

const harbourPanorama = scorePortImageCandidate(
  {
    provider: "wikimedia",
    title: "Civitavecchia outher harbour - panoramio.jpg",
    url: "https://upload.wikimedia.org/w/harbour.jpg",
    width: 1280,
    height: 854,
    license: "CC BY-SA 3.0"
  },
  { canonical_name: "Civitavecchia", country: "Italy", country_code: "IT" }
);
assert(!harbourPanorama.vesselPrimary, "harbour panorama is destination-primary");
assert(harbourPanorama.suitability > cavour.suitability, "harbour panorama outranks Cavour on suitability");

const civitRanked = pickBestCandidate(
  [
    {
      provider: "wikimedia",
      title: "Cavour (550) - Civitavecchia harbour, Italy - June 2011.jpg",
      url: "https://upload.wikimedia.org/w/a.jpg",
      width: 1280,
      height: 853,
      license: "CC BY 2.0"
    },
    {
      provider: "wikimedia",
      title: "Civitavecchia outher harbour - panoramio.jpg",
      url: "https://upload.wikimedia.org/w/b.jpg",
      width: 1280,
      height: 854,
      license: "CC BY-SA 3.0"
    }
  ],
  { canonical_name: "Civitavecchia", country: "Italy", country_code: "IT" }
);
assert(/outher harbour|panoramio/i.test(civitRanked[0]?.candidate?.title || ""), "harbour panorama ranks above Cavour");

assert(isVesselPrimarySubject({ title: "Celebrity Solstice at Port Chalmers" }).vesselPrimary, "named cruise ship at port");
assert(!isVesselPrimarySubject({ title: "Port Chalmers harbour with cruise ships" }).vesselPrimary, "harbour with ships OK");

// Confidence 100 is exceptional — geo high + low suit caps overall
const geoOnly = { geographic: 100, suitability: 55, confidence: 0, license: "CC BY 2.0" };
const overallGeoOnly = scorePortImageCandidate(
  { provider: "wikimedia", title: "Civitavecchia cruise ship", url: "https://x/a.jpg", width: 1200, height: 800, license: "CC BY 2.0" },
  { canonical_name: "Civitavecchia", country: "Italy", country_code: "IT" }
);
assert(overallGeoOnly.confidence <= 72, "100 geo with low suitability does not yield misleading perfect score");
assert(statusForScores(overallGeoOnly, "wikimedia") !== "AUTO_APPROVED", "geo-only high match stays out of auto-approve");

assert(GEO_AUTO_MIN >= 75 && SUIT_AUTO_MIN >= 70, "auto-approve thresholds require strong geo and suitability");

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
      title: "Victoria British Columbia cruise port harbour waterfront",
      url: "https://upload.wikimedia.org/w/vic-bc.jpg",
      width: 1400,
      height: 900,
      license: "CC BY 2.0"
    }
  ],
  { canonical_name: "Victoria BC", country: "Canada", country_code: "CA", region: "British Columbia" }
);
assert(/british columbia|harbour|waterfront/i.test(ranked[0]?.candidate?.title || ""), "prefers BC Victoria harbour imagery");

// --- Destination name weighting (Ísafjörður harbour vs generic Iceland road) ---
const isafjordurPort = {
  canonical_name: "Ísafjörður",
  city: "Ísafjörður",
  country: "Iceland",
  country_code: "IS"
};
const isafHarbour = scorePortImageCandidate(
  {
    provider: "wikimedia",
    title: "Ísafjörður harbour 2017.jpg",
    url: "https://upload.wikimedia.org/w/isaf-harbour.jpg",
    width: 1400,
    height: 900,
    license: "CC BY-SA 4.0"
  },
  isafjordurPort
);
const isafRoad = scorePortImageCandidate(
  {
    provider: "wikimedia",
    title: "Road 61, Iceland",
    url: "https://upload.wikimedia.org/w/road61.jpg",
    width: 1600,
    height: 900,
    license: "CC BY-SA 4.0"
  },
  isafjordurPort
);
assert(isafHarbour.geographic > isafRoad.geographic, "destination harbour outranks generic Iceland road on geo");
assert(
  pickBestCandidate(
    [
      { provider: "wikimedia", title: "Road 61, Iceland", url: "https://x/a.jpg", width: 1600, height: 900, license: "CC BY-SA 4.0" },
      { provider: "wikimedia", title: "Ísafjörður harbour 2017.jpg", url: "https://x/b.jpg", width: 1400, height: 900, license: "CC BY-SA 4.0" }
    ],
    isafjordurPort
  )[0]?.candidate?.title.includes("harbour"),
  "harbour image ranks first for Ísafjörður"
);

// --- Generic country imagery penalty ---
const mykonosPort = { canonical_name: "Mykonos", city: "Mykonos", country: "Greece", country_code: "GR" };
const mykonosHarbour = scorePortImageCandidate(
  { provider: "wikimedia", title: "Mykonos harbour waterfront", url: "https://x/m.jpg", width: 1200, height: 800, license: "CC BY 2.0" },
  mykonosPort
);
const greekIslands = scorePortImageCandidate(
  { provider: "wikimedia", title: "Greek islands coastline", url: "https://x/g.jpg", width: 1200, height: 800, license: "CC BY 2.0" },
  mykonosPort
);
assert(mykonosHarbour.geographic > greekIslands.geographic, "Mykonos harbour outranks generic Greek islands");
assert(genericImageryPenalty({ title: "Greek islands coastline" }, mykonosPort) > 0, "generic region-only title penalised");

// --- Brave unlicensed cannot auto-apply ---
const unlicensedBrave = {
  provider: "brave",
  title: "Singapore Marina Bay skyline",
  url: "https://cdn.example.com/sg.jpg",
  width: 1200,
  height: 800
};
assert(!licenseIsUsable(unlicensedBrave), "Brave without licence is not usable");
assert.throws(
  () => assertCandidateApplicable(unlicensedBrave, { imageStatus: "AUTO_APPROVED" }),
  /Brave images cannot be applied/
);
const braveScores = scorePortImageCandidate(unlicensedBrave, {
  canonical_name: "Singapore",
  country: "Singapore",
  country_code: "SG"
});
assert(statusForCandidate({ ...braveScores, candidate: unlicensedBrave }) !== "AUTO_APPROVED", "unlicensed Brave never AUTO_APPROVED");

const licensedWiki = {
  provider: "wikimedia",
  title: "Singapore harbour waterfront",
  url: "https://upload.wikimedia.org/w/sg.jpg",
  width: 1400,
  height: 900,
  license: "CC BY 2.0"
};
const braveVsWiki = pickBestCandidate([unlicensedBrave, licensedWiki], {
  canonical_name: "Singapore",
  country: "Singapore",
  country_code: "SG"
});
assert(String(braveVsWiki[0]?.candidate?.provider).toLowerCase() === "wikimedia", "licensed Wikimedia ranks above unlicensed Brave");

// --- NEEDS_REVIEW remains non-public; approval → MANUAL ---
const needsReviewPort = { id: "port-mykonos-test", canonical_name: "Mykonos", hero_media_id: "media-review", image_status: "NEEDS_REVIEW" };
const publicIndex = indexPortsCatalogue([needsReviewPort]);
assert(!lookupCataloguePort("Mykonos", publicIndex), "NEEDS_REVIEW is not public");
const manualPort = { ...needsReviewPort, image_status: "MANUAL" };
const publicIndexManual = indexPortsCatalogue([manualPort]);
assert(lookupCataloguePort("Mykonos", publicIndexManual)?.hero_media_id === "media-review", "MANUAL is public");

let approvePatch = null;
const mockSupabase = {
  fetchRest: async (path, options) => {
    if (options?.method === "PATCH") {
      approvePatch = options.body;
      return [{ ...needsReviewPort, ...options.body }];
    }
    throw new Error("unexpected");
  }
};
const approved = await approveReviewedPortImage(mockSupabase, needsReviewPort);
assert(approved.approved_existing === true, "approval reuses existing media");
assert(approvePatch.image_status === "MANUAL", "approval sets MANUAL status");
assert(!canOverwritePortImage({ image_status: "MANUAL", hero_media_id: "abc" }), "manual image cannot be overwritten");

// --- Batch matching uses canonical/alias-aware resolution ---
const sydneyPort = {
  canonical_name: "Sydney",
  city: "Sydney",
  country: "Australia",
  country_code: "AU",
  region: "New South Wales"
};
assert(destinationSpecificityScores({ title: "Sydney Harbour Bridge panorama" }, sydneyPort).titleHit, "Sydney name in title detected");

// --- Manual image protection ---
assert(!canOverwritePortImage({ image_status: "MANUAL", hero_media_id: "abc" }), "manual image cannot be overwritten");
assert(canOverwritePortImage({ image_status: "NO_IMAGE", hero_media_id: null }), "missing image can be enriched");

// --- Public catalogue resolution ---
const catalogue = indexPortsCatalogue([
  { canonical_name: "Wellington", country: "New Zealand", hero_media_id: "media-1", image_status: "AUTO_APPROVED" }
]);
assert(lookupCataloguePort("Wellington", catalogue)?.hero_media_id === "media-1", "catalogue lookup by port name");

// --- Country fallback disabled ---
assert(portImageFallback("alaska", "juneau", "Juneau") === null, "port country fallback disabled");
const page = applyDestinationImageFallbacks({ slug: "alaska", name: "Alaska", hero: null, ports: [] });
assert(!page.ports?.length, "destination fallback does not inject port images");

// --- Destination page data — no placeholder when missing ---
const sandbox = { window: {}, globalThis: null, console };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.runInNewContext(read("js/destination-page-data.js"), sandbox, { filename: "destination-page-data.js" });
const resolved = sandbox.DestinationPageData.resolvePortImage({ name: "Juneau", mediaId: null, media: null });
assert(resolved.url === "", "missing port image returns empty url");
assert(resolved.source === "none", "missing port image source is none");

// --- Wikimedia client 429 retry (mock) ---
__resetWikimediaClientForTests();
let fetchCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  fetchCalls += 1;
  if (fetchCalls === 1) {
    return {
      ok: false,
      status: 429,
      headers: { get: (h) => (h.toLowerCase() === "retry-after" ? "1" : null) }
    };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ query: { pages: {} } })
  };
};
try {
  const { searchWikimediaCommons } = loadCjs("netlify/functions/lib/port-image-finder/sources/wikimedia-client.js");
  await searchWikimediaCommons("Test harbour query", { limit: 5 });
  assert(fetchCalls >= 2, "429 triggers retry");
} finally {
  globalThis.fetch = originalFetch;
  __resetWikimediaClientForTests();
}

// --- Server-side wiring ---
assert(/port-image-finder/.test(adminSrc), "admin calls port-image-finder function");
assert(!/BRAVE_SEARCH_API_KEY/.test(adminSrc), "admin UI does not reference Brave API key");
assert(/resolveCatalogueMediaIds/.test(publicDestSrc), "public destination resolves catalogue port images");
assert(/resolveCatalogueMediaIds/.test(researchSrc), "featured cruise itinerary uses catalogue port images");
assert(/function braveImageSearch/.test(braveSrc), "brave image search helper exists");
assert(/action === "find_candidates"/.test(fnSrc), "port-image-finder supports find_candidates");
assert(/action === "approve_reviewed"/.test(fnSrc), "port-image-finder supports approve_reviewed");
assert(/action === "bulk_missing"/.test(fnSrc), "port-image-finder supports bulk_missing");
assert(/approveReviewedPortImage/.test(adminSrc), "admin UI supports approving NEEDS_REVIEW images");
assert(/Approve for Explore/.test(adminSrc), "admin shows explicit approval action");
assert(/image_status/.test(migrationSrc), "migration adds image_status");
assert(/isMissingImageSchemaError/.test(catalogueFnSrc), "ports catalogue tolerates missing image schema");
assert(/isVesselPrimarySubject/.test(read("netlify/functions/lib/port-image-finder/scoring.js")), "scoring exports vessel-primary detection");

let queried = "";
await resolveCatalogueMediaIds(async (path) => {
  queried = path;
  return [{ canonical_name: "Napier", hero_media_id: "m-napier", image_status: "AUTO_APPROVED" }];
}, ["Napier"]);
assert(queried.includes("ports?"), "catalogue resolver queries ports table");
assert(queried.includes("hero_media_id"), "catalogue resolver filters by hero_media_id");

console.log("test-port-image-finder: ok");
