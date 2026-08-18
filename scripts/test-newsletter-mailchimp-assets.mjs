#!/usr/bin/env node
/**
 * Newsletter Mailchimp email-asset pipeline tests.
 * Run: node scripts/test-newsletter-mailchimp-assets.mjs
 *   or: npm run test:newsletter-mailchimp-assets
 */

import { readFileSync } from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import vm from "vm";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const { getMailchimpConfig, hostedFileUrl, publicErrorDetail } = require("../netlify/functions/lib/mailchimp-file-manager.js");
const {
  optimizeEmailAsset,
  PHOTO_MAX_WIDTH,
  MAP_MAX_WIDTH
} = require("../netlify/functions/lib/newsletter-email-optimize.js");
const {
  slugify,
  padNewsletterNumber,
  normalizeSourceUrl,
  isSupabaseStorageUrl,
  parseSupabaseStorageUrl,
  buildGeneratedFilename,
  processNewsletterEmailAssets
} = require("../netlify/functions/lib/newsletter-email-assets.js");

const sharp = require("sharp");

const sandbox = {
  console,
  fetch: async () => {
    throw new Error("Could not reach the Mailchimp image upload service (network disabled in test)");
  },
  AbortController,
  setTimeout,
  clearTimeout,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  Intl,
  Number,
  String,
  Boolean,
  Array,
  Object,
  Math,
  JSON,
  RegExp,
  Error,
  module: { exports: {} },
  exports: {}
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
const context = vm.createContext(sandbox);

function load(rel) {
  const code = readFileSync(path.join(root, rel), "utf8");
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  vm.runInContext(code, context, { filename: rel });
}

load("js/newsletter-mailchimp-assets.js");
const Client = sandbox.NewsletterMailchimpAssets;
assert(Client, "NewsletterMailchimpAssets loaded");

const SUPABASE_HERO =
  "https://example.supabase.co/storage/v1/object/public/cruise-media/ships/explora-ii-hero.jpg?t=1";
const SUPABASE_MAP =
  "https://example.supabase.co/storage/v1/object/public/featured-cruise-route-maps/abc/route-map.png?t=9";
const MAILCHIMP_HERO = "https://mcusercontent.com/101cruise/newsletter-079-explora-ii-hero.jpg";
const MAILCHIMP_MAP = "https://mcusercontent.com/101cruise/newsletter-079-explora-ii-route-map.png";

assert(isSupabaseStorageUrl(SUPABASE_HERO), "detect supabase hero");
assert(isSupabaseStorageUrl(SUPABASE_MAP), "detect supabase route map");
assert(
  !isSupabaseStorageUrl("https://admirable-tiramisu-d4da8a.netlify.app/images/newsletter-includes/wifi.png"),
  "ignore netlify include icons"
);
assert(!isSupabaseStorageUrl(MAILCHIMP_HERO), "ignore mailchimp url");
assert(
  normalizeSourceUrl(SUPABASE_HERO) ===
    "https://example.supabase.co/storage/v1/object/public/cruise-media/ships/explora-ii-hero.jpg",
  "strip cache-bust query"
);
assert(parseSupabaseStorageUrl(SUPABASE_MAP).bucket === "featured-cruise-route-maps", "parse route map bucket");
assert(parseSupabaseStorageUrl(SUPABASE_MAP).objectPath === "abc/route-map.png", "parse route map path");
assert(padNewsletterNumber(79) === "079", "pad newsletter number");
assert(slugify("Explora II") === "explora-ii", "slugify ship name");
assert(
  buildGeneratedFilename({
    newsletterNumber: 79,
    label: "Explora II",
    assetType: "hero",
    checksum: "3f8a2c1b9999",
    extension: "jpg"
  }) === "newsletter-079-explora-ii-hero-3f8a2c1b.jpg",
  "hero filename"
);
assert(
  buildGeneratedFilename({
    newsletterNumber: 79,
    label: "Queen Victoria",
    assetType: "route_map",
    checksum: "aabbccdd",
    extension: "png"
  }) === "newsletter-079-queen-victoria-route-map-aabbccdd.png",
  "route map filename"
);

const sampleHtml = `
<img src="${SUPABASE_HERO.replaceAll("&", "&amp;")}" alt="Explora II">
<img src="${SUPABASE_MAP}">
<img src="${SUPABASE_HERO}">
<img src="https://admirable-tiramisu-d4da8a.netlify.app/images/newsletter-includes/wifi.png" alt="">
`;
const collected = Client.collectSupabaseImageUrls(sampleHtml);
assert(collected.length === 2, `collect unique supabase urls, got ${collected.length}`);
assert(collected.some((url) => url.includes("explora-ii-hero")), "collect hero");
assert(collected.some((url) => url.includes("route-map.png")), "collect route map");

const assets = Client.buildAssetList(sampleHtml, [
  {
    headline: "Mediterranean",
    hero_image_url: SUPABASE_HERO,
    route_map_image_url: SUPABASE_MAP,
    ci_cruise_ships: { name: "Explora II" }
  }
]);
assert(assets.length === 2, "build two assets");
assert(assets.find((row) => row.asset_type === "hero")?.label === "Explora II", "hero label from ship");
assert(assets.find((row) => row.asset_type === "route_map")?.label === "Explora II", "map label from ship");

const rewritten = Client.replaceImageUrls(sampleHtml, [
  { source_url: SUPABASE_HERO, mailchimp_file_url: MAILCHIMP_HERO },
  { source_url: SUPABASE_MAP, mailchimp_file_url: MAILCHIMP_MAP }
]);
assert(!rewritten.includes("supabase.co/storage"), "rewrite removes supabase");
assert(rewritten.includes(MAILCHIMP_HERO), "rewrite inserts mailchimp hero");
assert(rewritten.includes(MAILCHIMP_MAP), "rewrite inserts mailchimp map");
assert(rewritten.includes("newsletter-includes/wifi.png"), "leave netlify include icons");
assert(Client.assertNoSupabaseStorageUrls(rewritten).ok, "rewritten html is clean");
assert(!Client.assertNoSupabaseStorageUrls(sampleHtml).ok, "source html is rejected");

try {
  getMailchimpConfig({});
  throw new Error("expected missing Mailchimp config to throw");
} catch (error) {
  assert(error.code === "mailchimp_not_configured", "missing Mailchimp key fails clearly");
  assert(/MAILCHIMP_API_KEY/.test(error.message), "missing key mentions MAILCHIMP_API_KEY");
}

const cfg = getMailchimpConfig({ MAILCHIMP_API_KEY: "testkey-us21" });
assert(cfg.server === "us21", "datacentre from API key");
assert(cfg.folderName === "101cruise Newsletter Images", "default folder name");
assert(
  hostedFileUrl({ full_size_url: MAILCHIMP_HERO, url: "http://insecure.example/x" }) === MAILCHIMP_HERO,
  "prefer https full_size_url"
);
assert(
  publicErrorDetail("API key abcdefghijklmnop-us21 is invalid", "abcdefghijklmnop-us21").includes("[redacted]"),
  "error detail redacts api key"
);
assert(
  !publicErrorDetail("API key abcdefghijklmnop-us21 is invalid", "abcdefghijklmnop-us21").includes("abcdefghijklmnop-us21"),
  "error detail does not echo api key"
);

const photo = await sharp({
  create: { width: 2560, height: 1440, channels: 3, background: { r: 40, g: 80, b: 120 } }
})
  .jpeg({ quality: 95 })
  .toBuffer();
const photoOut = await optimizeEmailAsset(photo, "hero");
assert(photoOut.extension === "jpg", "photos become jpeg");
assert(photoOut.mimeType === "image/jpeg", "photo mime");
const photoMeta = await sharp(photoOut.buffer).metadata();
assert(photoMeta.width <= PHOTO_MAX_WIDTH, `photo width ${photoMeta.width} <= ${PHOTO_MAX_WIDTH}`);
assert(photoOut.bytes < photo.length, "photo smaller than original");
assert(photoOut.bytes <= 260 * 1024, `photo target size, got ${photoOut.bytes}`);

const map = await sharp({
  create: { width: 2000, height: 1100, channels: 3, background: { r: 255, g: 255, b: 255 } }
})
  .png()
  .toBuffer();
const mapOut = await optimizeEmailAsset(map, "route_map");
const mapMeta = await sharp(mapOut.buffer).metadata();
assert(mapMeta.width <= MAP_MAX_WIDTH, `map width ${mapMeta.width} <= ${MAP_MAX_WIDTH}`);
assert(mapOut.bytes < map.length, "map smaller than original");

const heroBuf = Buffer.from("hero-source-bytes");
const mapBuf = Buffer.from("map-source-bytes");
const store = [];
const uploads = [];
const deps = {
  resolveNewsletter: async () => ({ id: "nl-79", newsletter_number: 79 }),
  downloadSourceBytes: async (url) => ({
    buffer: url.includes("route-map") ? mapBuf : heroBuf,
    sourcePath: url.includes("route-map")
      ? "featured-cruise-route-maps/abc/route-map.png"
      : "cruise-media/ships/hero.jpg"
  }),
  optimizeEmailAsset: async (buffer, type) => ({
    buffer: Buffer.from(`opt-${type}`),
    mimeType: type === "route_map" ? "image/png" : "image/jpeg",
    extension: type === "route_map" ? "png" : "jpg",
    width: 800,
    bytes: 12
  }),
  findOrCreateNewsletterFolder: async () => ({
    id: "folder-1",
    name: "101cruise Newsletter Images",
    created: false
  }),
  uploadFile: async ({ name, folderId }) => {
    uploads.push(name);
    assert(folderId === "folder-1", "upload into shared newsletter folder");
    return {
      id: `file-${uploads.length}`,
      url: `https://mcusercontent.com/101cruise/${name}`,
      name,
      folderId
    };
  },
  loadMappingByChecksum: async () => null,
  upsertMapping: async (row) => {
    store.push(row);
    return row;
  },
  getFile: async () => null
};

const first = await processNewsletterEmailAssets(
  {
    newsletterId: "nl-79",
    newsletterNumber: 79,
    assets: [
      { source_url: SUPABASE_HERO, asset_type: "hero", label: "Explora II" },
      { source_url: SUPABASE_MAP, asset_type: "route_map", label: "Explora II" },
      { source_url: SUPABASE_HERO, asset_type: "hero", label: "Explora II" }
    ]
  },
  deps
);
assert(first.uploaded === 2, `first export uploads unique assets, got ${first.uploaded}`);
assert(first.mappings.length === 2, "unique source URLs only");
assert(first.mappings.filter((row) => row.source_url === SUPABASE_HERO).length === 1, "duplicate hero collapsed");
assert(
  first.mappings.every((row) => row.mailchimp_file_url.startsWith("https://mcusercontent.com/")),
  "mappings are mailchimp urls"
);
assert(uploads.length === 2, "duplicate source uploaded once");
assert(store.length === 2, "two mapping rows stored");
assert(store.every((row) => row.variant_scope === "shared"), "shared across variants");
assert(store.every((row) => row.mailchimp_folder_id === "folder-1"), "folder id stored");

const reuseDeps = {
  ...deps,
  loadMappingByChecksum: async (_id, checksum) => store.find((row) => row.source_checksum === checksum) || null,
  getFile: async (id) => ({
    id,
    full_size_url: store.find((row) => row.mailchimp_file_id === id)?.mailchimp_file_url
  }),
  uploadFile: async () => {
    throw new Error("should not upload again");
  }
};
const second = await processNewsletterEmailAssets(
  {
    newsletterId: "nl-79",
    newsletterNumber: 79,
    assets: [
      { source_url: SUPABASE_HERO, asset_type: "hero", label: "Explora II" },
      { source_url: SUPABASE_MAP, asset_type: "route_map", label: "Explora II" }
    ]
  },
  reuseDeps
);
assert(second.uploaded === 0, "rerun uploads nothing");
assert(second.reused === 2, `rerun reuses mappings, got ${second.reused}`);

try {
  await processNewsletterEmailAssets(
    {
      newsletterId: "nl-79",
      assets: [{ source_url: SUPABASE_HERO, asset_type: "hero", label: "Explora II" }]
    },
    {
      ...deps,
      uploadFile: async () => {
        const err = new Error("Mailchimp API 500");
        err.statusCode = 502;
        throw err;
      }
    }
  );
  throw new Error("expected upload failure to throw");
} catch (error) {
  assert(error.generatedFilename, "upload failure includes generated filename");
  assert(error.httpStatus === 502, "upload failure includes upstream HTTP status");
}

const handlerSrc = readFileSync(path.join(root, "netlify/functions/newsletter-mailchimp-assets.js"), "utf8");
assert(/requireAdmin/.test(handlerSrc), "function requires admin");
assert(/processNewsletterEmailAssets/.test(handlerSrc), "function uses pipeline");
assert(/MAX_ASSETS_PER_INVOCATION = 1/.test(handlerSrc), "function accepts one asset per invocation");
assert(/generated_filename/.test(handlerSrc), "function returns generated filename on errors");
assert(/http_status/.test(handlerSrc), "function returns public HTTP status on errors");

const netlifyToml = readFileSync(path.join(root, "netlify.toml"), "utf8");
assert(
  /\[functions\."newsletter-mailchimp-assets"\][\s\S]*?timeout = 60/.test(netlifyToml),
  "function timeout is 60s for one-asset invocations"
);

const composerSrc = readFileSync(path.join(root, "js/admin-newsletter-composer.js"), "utf8");
assert(composerSrc.includes("prepareExportedHtml"), "composer export uses asset pipeline");
assert(composerSrc.includes("prepared.html"), "composer copies hosted HTML");
assert(composerSrc.includes("onProgress"), "composer shows per-image progress");
assert(composerSrc.includes("Preparing newsletter images"), "composer progress copy names images");
assert(!/clipboard\.writeText\(result\.html/.test(composerSrc), "composer never copies unhosted HTML");

const adminHtml = readFileSync(path.join(root, "admin.html"), "utf8");
assert(adminHtml.includes("js/newsletter-mailchimp-assets.js"), "admin loads asset helper");

const envExample = readFileSync(path.join(root, ".env.example"), "utf8");
assert(/MAILCHIMP_API_KEY/.test(envExample), ".env.example documents MAILCHIMP_API_KEY");

const migration = readFileSync(path.join(root, "supabase/migrations/20260818_newsletter_email_assets.sql"), "utf8");
assert(/CREATE TABLE IF NOT EXISTS public\.newsletter_email_assets/.test(migration), "migration creates mapping table");
assert(/UNIQUE \(newsletter_id, source_checksum\)/.test(migration), "migration unique checksum");
assert(!/DELETE FROM storage/.test(migration), "migration does not delete storage");

load("js/newsletter-typography.js");
load("js/newsletter-cruise-shared.js");
load("js/newsletter-mailchimp-export.js");
const Export = sandbox.NewsletterMailchimpExport;
const Shared = sandbox.NewsletterCruiseShared;

function baseModel(outputMode) {
  return {
    outputMode,
    destinationStrip: "MEDITERRANEAN",
    headline: "Explora II · Western Mediterranean",
    heroImageUrl: SUPABASE_HERO,
    heroImageAlt: "Explora II",
    datesLine: "12 OCT 2026 – 24 OCT 2026",
    nightsShipLine: "12 NIGHTS · EXPLORA JOURNEYS · EXPLORA II",
    portsJoined: "Barcelona, Marseille, Rome",
    description: "A luxury voyage.",
    descriptionParagraphs: ["A luxury voyage."],
    publicSlug: "explora-ii-med",
    routeMapUrl: SUPABASE_MAP,
    routeMapAlt: "Route map",
    inclusionItems: [],
    otherInformation: "",
    pricingModules: Shared.buildPricingModules(
      [{ room_label: "Balcony", brochure_price: 4000, cruise_101_price: 3200, airline_price: 2800 }],
      12,
      { outputMode }
    )
  };
}

const queenHero = "https://example.supabase.co/storage/v1/object/public/cruise-media/ships/queen-victoria-hero.jpg";
const queenMap = "https://example.supabase.co/storage/v1/object/public/featured-cruise-route-maps/qv/route-map.png";

const airline = Export.composeIssueHtml(
  [
    { model: baseModel("airline_staff"), name: "Explora II" },
    {
      model: {
        ...baseModel("airline_staff"),
        headline: "Queen Victoria · Atlantic",
        heroImageUrl: queenHero,
        routeMapUrl: queenMap,
        publicSlug: "queen-victoria-atlantic"
      },
      name: "Queen Victoria"
    }
  ],
  { outputMode: "airline_staff", templateKey: "green-price-cards", newsletterNumber: 79 }
);
const general = Export.composeIssueHtml(
  [
    { model: baseModel("general"), name: "Explora II" },
    {
      model: {
        ...baseModel("general"),
        headline: "Queen Victoria · Atlantic",
        heroImageUrl: queenHero,
        routeMapUrl: queenMap,
        publicSlug: "queen-victoria-atlantic"
      },
      name: "Queen Victoria"
    }
  ],
  { outputMode: "general", templateKey: "green-price-cards", newsletterNumber: 79 }
);
assert(airline.ok && general.ok, "both variants render");
assert(/airline staff price/i.test(airline.html), "airline variant keeps staff prices");
assert(!/airline staff price/i.test(general.html), "general variant omits staff prices");

const airlineAssets = Client.buildAssetList(airline.html, []);
const generalAssets = Client.buildAssetList(general.html, []);
assert(airlineAssets.length === 4, `airline has 4 supabase images, got ${airlineAssets.length}`);
assert(generalAssets.length === 4, `general has 4 supabase images, got ${generalAssets.length}`);
const combinedKeys = new Set(
  [...airlineAssets, ...generalAssets].map((row) => Client.normalizeSourceUrl(row.source_url))
);
assert(combinedKeys.size === 4, "both variants share the same 4 source images");

const hostedMap = airlineAssets.map((row, index) => ({
  source_url: row.source_url,
  mailchimp_file_url: `https://mcusercontent.com/101cruise/asset-${index}.jpg`
}));
const hostedAirline = Client.replaceImageUrls(airline.html, hostedMap);
const hostedGeneral = Client.replaceImageUrls(general.html, hostedMap);
assert(Client.assertNoSupabaseStorageUrls(hostedAirline).ok, "hosted airline html is clean");
assert(Client.assertNoSupabaseStorageUrls(hostedGeneral).ok, "hosted general html is clean");
assert(/mcusercontent\.com/.test(hostedAirline), "airline uses mailchimp hosts");
assert(/mcusercontent\.com/.test(hostedGeneral), "general uses mailchimp hosts");

const failClosed = await Client.prepareExportedHtml({
  html: airline.html,
  newsletterId: "nl-79",
  newsletterNumber: 79
});
assert(failClosed.ok === false, "prepareExportedHtml fails when fetch is unavailable");
assert(failClosed.html === "", "failed prepare does not return supabase html");
assert(/Mailchimp|not configured|could not reach|stopped/i.test(failClosed.error), "failure message is explicit");

assert(Client.MAX_ASSETS_PER_REQUEST === 1, "client sends one asset per Netlify invocation");
assert(
  Client.progressMessage({ current: 3, total: 12 }) === "Preparing newsletter images 3 of 12…",
  "progress copy matches composer"
);
const namedFailure = Client.describeAssetFailure({
  data: {
    error: "Mailchimp upload failed for newsletter-079-explora-ii-hero-3f8a2c1b.jpg: timeout",
    generated_filename: "newsletter-079-explora-ii-hero-3f8a2c1b.jpg",
    http_status: 504
  },
  status: 504,
  index: 9,
  total: 12,
  asset: { label: "Explora II" }
});
assert(/9 of 12/.test(namedFailure), "failure names asset index");
assert(/newsletter-079-explora-ii-hero-3f8a2c1b\.jpg/.test(namedFailure), "failure names generated filename");
assert(/HTTP 504/.test(namedFailure), "failure includes public HTTP status");
assert(/reused on retry/i.test(namedFailure), "failure says completed uploads are reused");
assert(!/MAILCHIMP_API_KEY|eyJ/.test(namedFailure), "failure does not leak secrets");

function twelveSourceUrls() {
  return Array.from({ length: 12 }, (_, index) => {
    const n = String(index + 1).padStart(2, "0");
    const kind = index % 2 === 0 ? "hero" : "route-map";
    const bucket = kind === "hero" ? "cruise-media/ships" : "featured-cruise-route-maps";
    return `https://example.supabase.co/storage/v1/object/public/${bucket}/ship-${n}-${kind}.jpg`;
  });
}

const twelveUrls = twelveSourceUrls();
const twelveHtml = twelveUrls.map((url, index) => `<img src="${url}" alt="ship ${index + 1}">`).join("\n");
assert(Client.collectSupabaseImageUrls(twelveHtml).length === 12, "collects 12 unique supabase images");

const twelveAssets = twelveUrls.map((url, index) => ({
  source_url: url,
  asset_type: index % 2 === 0 ? "hero" : "route_map",
  label: `Ship ${index + 1}`
}));
const twelveUploads = [];
const twelveStore = [];
const twelveFirst = await processNewsletterEmailAssets(
  {
    newsletterId: "nl-79",
    newsletterNumber: 79,
    assets: twelveAssets
  },
  {
    ...deps,
    downloadSourceBytes: async (url) => ({
      buffer: Buffer.from(url),
      sourcePath: url.replace("https://example.supabase.co/storage/v1/object/public/", "")
    }),
    uploadFile: async ({ name, folderId }) => {
      twelveUploads.push(name);
      return {
        id: `file-12-${twelveUploads.length}`,
        url: `https://mcusercontent.com/101cruise/${name}`,
        name,
        folderId
      };
    },
    upsertMapping: async (row) => {
      twelveStore.push(row);
      return row;
    }
  }
);
assert(twelveFirst.uploaded === 12, `server processes 12 unique assets, got ${twelveFirst.uploaded}`);
assert(twelveFirst.mappings.length === 12, "12 mappings returned");
assert(
  twelveFirst.mappings.every((row) => row.mailchimp_file_url.startsWith("https://mcusercontent.com/")),
  "12 mappings are Mailchimp URLs"
);

function mockFetch({ failAt = null, known = new Map(), posts }) {
  return async (_url, opts) => {
    const body = JSON.parse(opts.body);
    posts.push(body);
    assert(Array.isArray(body.assets), "request includes assets array");
    assert(body.assets.length === 1, `one asset per request, got ${body.assets.length}`);
    if (body.assets.length > 1) {
      return {
        ok: false,
        status: 400,
        json: async () => ({
          success: false,
          error: `Send one newsletter image per request (received ${body.assets.length}).`,
          code: "too_many_assets"
        })
      };
    }
    const asset = body.assets[0];
    const index = Number(body.asset_index);
    if (failAt && index === failAt) {
      return {
        ok: false,
        status: 504,
        json: async () => ({
          success: false,
          error: "Gateway timed out while uploading this newsletter image.",
          generated_filename: `newsletter-079-ship-${String(index).padStart(2, "0")}-hero-abcdabcd.jpg`,
          http_status: 504,
          asset_index: index,
          asset_total: body.asset_total
        })
      };
    }
    const existing = known.get(asset.source_url);
    if (existing) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          reused: 1,
          uploaded: 0,
          mappings: [{ ...existing, reused: true, uploaded: false }]
        })
      };
    }
    const mapping = {
      source_url: asset.source_url,
      mailchimp_file_url: `https://mcusercontent.com/101cruise/newsletter-079-asset-${index}.jpg`,
      generated_filename: `newsletter-079-asset-${index}.jpg`,
      reused: false,
      uploaded: true
    };
    known.set(asset.source_url, mapping);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        reused: 0,
        uploaded: 1,
        folder: { id: "folder-1", name: "101cruise Newsletter Images" },
        mappings: [mapping]
      })
    };
  };
}

const knownMappings = new Map();
const firstPosts = [];
sandbox.fetch = mockFetch({ failAt: 9, known: knownMappings, posts: firstPosts });
const progress = [];
const partial = await Client.prepareExportedHtml({
  html: twelveHtml,
  newsletterId: "nl-79",
  newsletterNumber: 79,
  onProgress(event) {
    progress.push(event.message);
  }
});
assert(partial.ok === false, "export stops when one image of 12 fails");
assert(partial.html === "", "failed 12-asset export does not return HTML");
assert(firstPosts.length === 9, `stopped after the failed image, got ${firstPosts.length} posts`);
assert(firstPosts.every((body) => body.assets.length === 1), "every post is a single asset");
assert(/9 of 12/.test(partial.error), "partial failure names 9 of 12");
assert(/HTTP 504/.test(partial.error), "partial failure includes HTTP 504");
assert(/newsletter-079-ship-09-hero-abcdabcd\.jpg/.test(partial.error), "partial failure includes generated filename");
assert(progress.some((msg) => msg.includes("1 of 12")), "progress starts at 1 of 12");
assert(progress.some((msg) => msg.includes("9 of 12")), "progress reaches the failed image");

const retryPosts = [];
sandbox.fetch = mockFetch({ known: knownMappings, posts: retryPosts });
const retryProgress = [];
const retry = await Client.prepareExportedHtml({
  html: twelveHtml,
  newsletterId: "nl-79",
  newsletterNumber: 79,
  onProgress(event) {
    retryProgress.push(event);
  }
});
assert(retry.ok === true, "retry after partial completion succeeds");
assert(retry.mappings.length === 12, "retry returns 12 mappings");
assert(retry.reused === 8, `retry reuses the 8 completed images, got ${retry.reused}`);
assert(retry.uploaded === 4, `retry uploads the remaining 4 images, got ${retry.uploaded}`);
assert(retryPosts.length === 12, "retry still visits every unique image so the server can reuse mappings");
assert(Client.assertNoSupabaseStorageUrls(retry.html).ok, "successful 12-asset HTML has zero Supabase URLs");
assert(!/supabase\.(co|in)\/storage/.test(retry.html), "successful HTML string has no supabase storage hosts");
assert((retry.html.match(/mcusercontent\.com/g) || []).length >= 12, "successful HTML uses Mailchimp hosts");
assert(
  retryProgress.some((event) => /Reused an existing Mailchimp file/.test(event.message)),
  "retry progress notes reused files"
);

const variantKnown = new Map();
const variantPosts = [];
sandbox.fetch = mockFetch({ known: variantKnown, posts: variantPosts });
const airlineHosted = await Client.prepareExportedHtml({
  html: airline.html,
  newsletterId: "nl-79",
  newsletterNumber: 79
});
const generalHosted = await Client.prepareExportedHtml({
  html: general.html,
  newsletterId: "nl-79",
  newsletterNumber: 79
});
assert(airlineHosted.ok && generalHosted.ok, "both variants export after mappings exist");
assert(airlineHosted.uploaded === 4 && airlineHosted.reused === 0, "airline variant uploads the shared image set once");
assert(generalHosted.reused === 4 && generalHosted.uploaded === 0, "general variant reuses the same mappings");
assert(Client.assertNoSupabaseStorageUrls(airlineHosted.html).ok, "airline success HTML is clean");
assert(Client.assertNoSupabaseStorageUrls(generalHosted.html).ok, "general success HTML is clean");
assert(variantPosts.every((body) => body.assets.length === 1), "variant exports also send one image per request");

sandbox.fetch = async () => {
  throw new Error("Could not reach the Mailchimp image upload service (network disabled in test)");
};

console.log("ok: newsletter mailchimp asset pipeline");
