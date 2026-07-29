/**
 * Newsletter Featured Cruise hero image selection + Media Library picker.
 * Run: node scripts/test-newsletter-hero-picker.mjs
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const adminSrc = readFileSync(path.join(root, "js/admin.js"), "utf8");
const mediaSrc = readFileSync(path.join(root, "js/admin-media-library.js"), "utf8");
const loadingSrc = readFileSync(path.join(root, "js/admin-loading.js"), "utf8");
const brandSrc = readFileSync(path.join(root, "js/brand-loading.js"), "utf8");
const resolverSrc = readFileSync(path.join(root, "js/media-resolver.js"), "utf8");
const adminHtml = readFileSync(path.join(root, "admin.html"), "utf8");
const adminCss = readFileSync(path.join(root, "css/admin.css"), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function extractFunction(src, name) {
  const patterns = [`async function ${name}(`, `function ${name}(`];
  let start = -1;
  for (const p of patterns) {
    start = src.indexOf(p);
    if (start >= 0) break;
  }
  assert(start >= 0, `missing ${name}`);
  const sigEnd = src.indexOf(")", start);
  assert(sigEnd > start, `missing signature end for ${name}`);
  let i = src.indexOf("{", sigEnd);
  assert(i > sigEnd, `missing body for ${name}`);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`extract failed ${name}`);
}

// --- Static wiring ---
{
  assert(/admin-loading\.js/.test(adminHtml), "admin.html loads AdminLoading");
  assert(/AdminLoading\.withLoading/.test(adminSrc), "hero actions use AdminLoading");
  assert(/Finding the ship image/.test(adminSrc), "default hero loading message");
  assert(/Opening the Media Library/.test(adminSrc), "picker opening message");
  assert(/Default ship image selected/.test(adminSrc), "default success copy");
  assert(/No default ship image is currently available for this ship/.test(adminSrc), "missing default copy");
  assert(/Hero image selected/.test(adminSrc), "picker selection copy");
  assert(/resolveFeaturedCanonicalShip/.test(adminSrc), "canonical ship resolver used");
  assert(/featuredHeroDefaultBusy/.test(adminSrc), "duplicate-click guard");
  assert(!/supabase\.co/.test(extractFunction(adminSrc, "setFeaturedHeroDefaultShip")), "no supabase urls in default handler");
}

{
  const defaultFn = extractFunction(adminSrc, "setFeaturedHeroDefaultShip");
  assert(/featuredHeroDefaultBusy/.test(defaultFn), "busy flag on default click");
  assert(/AdminLoading\.withLoading/.test(defaultFn), "overlay on default click");
  assert(/findShipDefault|MediaResolver/.test(defaultFn), "resolves media library ship default");
  assert(/hero_image_url/.test(defaultFn), "falls back to CI hero url");
  assert(!/\.from\(|\.update\(|\.upsert\(|mediaApi\(|saveFeatured/.test(defaultFn), "no automatic database save");
  assert(/finally/.test(defaultFn), "always settles busy/overlay path");
}

{
  const pickerFn = extractFunction(adminSrc, "openFeaturedHeroMediaPicker");
  assert(/AdminLoading\.withLoading/.test(pickerFn), "overlay when opening picker");
  assert(/Opening the Media Library/.test(pickerFn), "opening message");
  assert(/resolveFeaturedCanonicalShip/.test(pickerFn), "passes resolved ship context");
}

{
  assert(/media-picker-card/.test(mediaSrc), "card-based picker layout");
  assert(/media-picker-loading/.test(mediaSrc), "single loading region");
  assert(/refreshPickerResultsOnly/.test(mediaSrc), "search refreshes results only");
  assert(/id="media-picker-search"/.test(mediaSrc), "stable search id");
  assert(/id="media-picker-results"/.test(mediaSrc), "stable results mount");
  assert(/Never float unrelated|unrelated ship defaults/.test(mediaSrc), "recommended filter comment/guard");
  assert(/pickerLoading/.test(mediaSrc), "picker loading flag");
  assert(/grid-template-columns:\s*repeat\(3/.test(adminCss), "3-column desktop grid");
  assert(/admin-loading-overlay/.test(adminCss), "admin overlay styles");
  assert(!/media-picker-layout/.test(adminCss) || !/minmax\(120px/.test(adminCss), "old compressed thumb grid removed");
}

// --- Runtime: AdminLoading + BrandLoading ---
{
  const sandbox = {
    window: {},
    globalThis: {},
    document: {
      body: {
        appendChild() {},
        classList: { toggle() {} }
      },
      createElement() {
        return {
          id: "",
          className: "",
          setAttribute() {},
          classList: { add() {}, toggle() {} },
          querySelector() {
            return { textContent: "", hidden: true };
          },
          innerHTML: ""
        };
      }
    },
    setTimeout,
    clearTimeout,
    Math,
    Date,
    Map,
    BrandLoading: null
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(brandSrc, sandbox);
  vm.runInNewContext(loadingSrc, sandbox);
  assert(sandbox.AdminLoading?.withLoading, "AdminLoading exported");
  assert(/brand-loading-boxes/.test(sandbox.BrandLoading.html({ large: true })), "nine-square html");
}

// --- Runtime: picker filtering ---
{
  const sandbox = {
    window: {},
    globalThis: {},
    document: undefined,
    setTimeout,
    clearTimeout,
    console
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.BrandLoading = {
    html: () => '<span class="brand-loading-boxes"></span>',
    scan() {}
  };
  vm.runInNewContext(mediaSrc, sandbox);
  const api = sandbox.MediaLibraryAdmin;
  assert(api?.__test__?.pickerCandidateRows, "pickerCandidateRows test export");

  const sirenaId = "ship-sirena";
  const starId = "ship-ncl-star";
  const items = [
    {
      id: "m-star",
      title: "NCL Star at sea",
      media_type: "ship",
      ship_id: starId,
      is_default: true,
      is_active: true,
      public_url: "https://example.com/star.jpg",
      ci_cruise_ships: { name: "Norwegian Star" },
      ci_cruise_lines: { name: "Norwegian Cruise Line" }
    },
    {
      id: "m-sirena",
      title: "Sirena hero",
      media_type: "ship",
      ship_id: sirenaId,
      is_default: true,
      is_active: true,
      public_url: "https://example.com/sirena.jpg",
      alt_text: "Oceania Sirena",
      ci_cruise_ships: { name: "Sirena" },
      ci_cruise_lines: { name: "Oceania Cruises" }
    },
    {
      id: "m-sirena-gal",
      title: "Sirena gallery",
      media_type: "ship",
      ship_id: sirenaId,
      is_default: false,
      is_active: true,
      public_url: "https://example.com/sirena-g.jpg",
      ci_cruise_ships: { name: "Sirena" }
    },
    {
      id: "m-bcn",
      title: "Barcelona harbour",
      media_type: "destination",
      destination_name: "Barcelona",
      is_default: true,
      is_active: true,
      public_url: "https://example.com/bcn.jpg"
    },
    {
      id: "m-unrelated-dest",
      title: "Alaska",
      media_type: "destination",
      destination_name: "Alaska",
      is_default: true,
      is_active: true,
      public_url: "https://example.com/ak.jpg"
    }
  ];

  const opts = {
    shipId: sirenaId,
    cruiseLineId: "line-oceania",
    selectedId: null,
    destinationHints: ["Barcelona", "Istanbul"]
  };

  const recommended = api.__test__.pickerCandidateRows(items, opts, "recommended", "");
  assert(
    recommended.every((r) => r.ship_id === sirenaId || r.destination_name === "Barcelona"),
    "Recommended only current ship/destination"
  );
  assert(
    !recommended.some((r) => r.id === "m-star"),
    "Norwegian Star excluded from Sirena recommended"
  );
  assert(recommended[0].id === "m-sirena", "ship default first among recommended");

  const currentShip = api.__test__.pickerCandidateRows(items, opts, "current_ship", "");
  assert(currentShip.length === 2, "Current Ship only Sirena media");
  assert(currentShip.every((r) => r.ship_id === sirenaId), "Current Ship ship_id filter");
  assert(currentShip[0].is_default === true, "default hero first on Current Ship");
  assert(!currentShip.some((r) => r.id === "m-star"), "Star excluded from Current Ship");

  const noShip = api.__test__.pickerCandidateRows(items, { ...opts, shipId: "" }, "recommended", "");
  assert(
    !noShip.some((r) => r.ship_id === starId),
    "without ship id, unrelated defaults still excluded from recommended"
  );
  assert(noShip.every((r) => r.destination_name === "Barcelona"), "destination-only recommended");

  // Search finds across tabs (not trapped in Recommended / Ships chip)
  api.__test__.setMediaItemsForTest(items);
  api.__test__.setPickerOptionsForTest(opts);
  api.__test__.setPickerFilterForTest("recommended");
  api.__test__.setPickerSearchForTest("Alaska");
  const searchedOutsideRecommended = api.__test__.pickerCandidateRows();
  assert(
    searchedOutsideRecommended.some((r) => r.id === "m-unrelated-dest"),
    "search finds destination images even when Recommended chip is active"
  );

  api.__test__.setPickerFilterForTest("ships");
  api.__test__.setPickerSearchForTest("Sirena hero");
  const searched = api.__test__.pickerCandidateRows();
  assert(searched.length === 1 && searched[0].id === "m-sirena", "search phrase filters grid");
  assert(api.__test__.getPickerState().pickerFilter === "ships", "tab preserved while searching");
}

// --- Runtime: canonical ship resolver (extracted) ---
{
  const ships = [
    {
      id: "sirena",
      name: "Sirena",
      cruise_line_id: "oceania",
      hero_image_url: null
    },
    {
      id: "star",
      name: "Norwegian Star",
      cruise_line_id: "ncl",
      hero_image_url: "https://example.com/star.jpg"
    }
  ];
  const fnSrc = extractFunction(adminSrc, "resolveFeaturedCanonicalShip");
  const sandbox = {
    ciCruiseShips: ships,
    featuredFormDraft: null
  };
  // eslint-disable-next-line no-new-func
  const resolve = vm.runInNewContext(`${fnSrc}; resolveFeaturedCanonicalShip`, sandbox);
  const ok = resolve({ cruise_line_id: "oceania", cruise_ship_id: "sirena" });
  assert(ok.ship?.id === "sirena", "Sirena resolves within Oceania");
  const mismatch = resolve({ cruise_line_id: "oceania", cruise_ship_id: "star" });
  assert(mismatch.ship == null && mismatch.error === "line_mismatch", "rejects cross-line ship id");
  const byName = resolve({ cruise_line_id: "oceania", ship_name: "Sirena" });
  assert(byName.ship?.id === "sirena", "name+line resolves Sirena");
  const starGuess = resolve({ cruise_line_id: "oceania", ship_name: "Star" });
  assert(starGuess.ship == null, "does not guess NCL Star for Oceania");
}

// --- Runtime: default hero uses MediaResolver ship default (no cross-ship) ---
{
  const sandbox = { module: { exports: {} }, exports: {}, window: {}, global: {}, console };
  sandbox.global = sandbox;
  vm.runInNewContext(resolverSrc + "\n;this.MediaResolver = module.exports || window.MediaResolver;", sandbox);
  const MediaResolver = sandbox.MediaResolver || sandbox.module.exports;
  assert(MediaResolver?.findShipDefault, "MediaResolver available");
  const mediaList = [
    {
      id: "m1",
      media_type: "ship",
      ship_id: "sirena",
      is_default: true,
      is_active: true,
      public_url: "https://example.com/s.jpg",
      alt_text: "Sirena"
    },
    {
      id: "m2",
      media_type: "ship",
      ship_id: "star",
      is_default: true,
      is_active: true,
      public_url: "https://example.com/star.jpg"
    }
  ];
  assert(MediaResolver.findShipDefault(mediaList, "sirena")?.id === "m1", "findShipDefault returns Sirena only");
  assert(MediaResolver.findShipDefault(mediaList, "missing") == null, "missing ship has no default");
}

// --- setPickerSearch does not full-render ---
{
  const setSearch = mediaSrc.match(/setPickerSearch\(value\) \{[\s\S]*?\n    \},/);
  assert(setSearch, "setPickerSearch found");
  assert(!/renderAdmin\(\)/.test(setSearch[0]), "picker search does not full-render admin");
  assert(/refreshPickerResultsOnly/.test(setSearch[0]), "picker search refreshes results only");
}

// --- Loading region cleared after load/failure ---
{
  assert(/pickerLoading = false/.test(mediaSrc), "pickerLoading cleared");
  assert(/media-picker-loading/.test(mediaSrc), "loading region markup exists");
  assert(/We couldn’t load the Media Library/.test(mediaSrc), "load failure message");
  assert(!/media-picker-thumb/.test(mediaSrc), "legacy compressed thumbs removed");
}

// --- Social pack not in this branch tip files changed expectation ---
{
  assert(!/social-pack-generator|Social Pack Generator/.test(adminSrc), "admin.js has no social pack");
  assert(!/social-pack/.test(mediaSrc), "media library has no social pack");
}

console.log("test-newsletter-hero-picker: ok");
