/**
 * Tests for portal-loading overlay viewport positioning + scroll lock.
 * Run: node scripts/test-portal-loading.mjs
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const src = readFileSync(path.join(root, "js/portal-loading.js"), "utf8");
const css = readFileSync(path.join(root, "css/planner.css"), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function loadPortalLoading() {
  const sandbox = { globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox, { filename: "portal-loading.js" });
  return sandbox.PortalLoading;
}

const PortalLoading = loadPortalLoading();
const helpers = PortalLoading.__test__;
assert(helpers && helpers.computeOverlayBand, "test helpers exported");

// CSS: fixed viewport overlay — no inset/bottom stretch
{
  const block = css.match(/\.portal-loading-overlay\s*\{[\s\S]*?\n\}/);
  assert(block, "overlay CSS block exists");
  assert(/position:\s*fixed/.test(block[0]), "overlay is position fixed");
  assert(/top:\s*0/.test(block[0]), "overlay top 0");
  assert(/left:\s*0/.test(block[0]), "overlay left 0");
  assert(/right:\s*0/.test(block[0]), "overlay right 0");
  assert(/width:\s*100%/.test(block[0]), "overlay width 100%");
  assert(/height:\s*100vh/.test(block[0]), "overlay uses 100vh fallback");
  assert(/height:\s*100dvh/.test(block[0]), "overlay uses 100dvh where supported");
  assert(/place-items:\s*center/.test(block[0]), "panel centred with grid place-items");
  assert(!/inset:\s*0/.test(block[0]), "inset 0 removed (avoids document-height stretch)");
  assert(!/bottom:\s*0/.test(block[0]), "bottom 0 absent (avoids document-height stretch)");
  assert(/z-index:\s*2147483000/.test(block[0]), "high z-index within iframe");
  assert(!/scrollHeight|margin-top\s*:[^;]*document|translateY\([^)]*scroll/i.test(block[0]), "no document-height translate hacks");
}

assert(/html\.portal-loading-active/.test(css), "scroll-lock CSS class present");
assert(/overflow:\s*hidden !important/.test(css.match(/html\.portal-loading-active[\s\S]*?overscroll-behavior/)?.[0] || css), "scroll lock hides overflow");

// Viewport height resolver: tall iframe capped; normal viewport preserved
{
  const tall = helpers.resolveViewportHeight({
    visualViewportHeight: 4200,
    innerHeight: 4200,
    screenAvailHeight: 900
  });
  assert(tall <= 960 && tall >= 240, "tall iframe uses capped viewport height not document height");

  const normal = helpers.resolveViewportHeight({
    visualViewportHeight: 800,
    innerHeight: 800,
    screenAvailHeight: 900
  });
  assert(normal === 800, "normal viewport height preserved");
}

// Band placement: top / mid / footer of a tall document
{
  const viewport = { innerHeight: 5000, screenAvailHeight: 900, documentHeight: 5000 };
  const topBand = helpers.computeOverlayBand({ ...viewport, anchorCenterY: 80 });
  assert(topBand.top === 0, "top-of-page load keeps band at top");
  assert(topBand.height <= 960, "top band uses viewport height");

  const midBand = helpers.computeOverlayBand({ ...viewport, anchorCenterY: 2500 });
  assert(midBand.top > 1000, "mid-page load places band halfway down");
  assert(midBand.top + midBand.height / 2 >= 2400 && midBand.top + midBand.height / 2 <= 2600, "mid band centres on anchor");
  assert(midBand.height === topBand.height, "band height stable across page");

  const footBand = helpers.computeOverlayBand({ ...viewport, anchorCenterY: 4900 });
  assert(footBand.top + footBand.height === 5000, "footer load pins band to document end");
  assert(footBand.top > 3500, "footer band is near bottom, not document centre alone");

  const noAnchor = helpers.computeOverlayBand({ ...viewport });
  assert(noAnchor.top === 0, "without anchor, default to top viewport band");
}

// Tall document must not centre panel at document midpoint by default
{
  const band = helpers.computeOverlayBand({
    innerHeight: 6000,
    screenAvailHeight: 800,
    documentHeight: 6000
  });
  assert(band.top === 0, "tall embed default is top band, not mid-document");
  assert(band.height < 2000, "tall embed band is viewport-sized, not document-sized");
}

// Source: scroll lock + restore paths
assert(/function lockScroll\(/.test(src), "lockScroll exists");
assert(/function unlockScroll\(/.test(src), "unlockScroll exists");
assert(/savedScrollX/.test(src) && /savedScrollY/.test(src), "scroll position preserved");
assert(/window\.scrollTo\(savedScrollX,\s*savedScrollY\)/.test(src), "scroll position restored");
assert(!/scrollTo\(\s*0\s*,\s*0\s*\)/.test(src), "does not force scrollTop to zero");
assert(/portal-loading-active/.test(src), "applies scroll-lock class");
assert(/overflow\s*=\s*"hidden"/.test(src), "locks overflow while active");

// Concurrent ops + delay + a11y + reduced motion retained
assert(/const refs = new Map\(\)/.test(src), "reference counting map exists");
assert(/activeCount/.test(src), "global activeCount reference tracking exists");
assert(/delayMs\)\s*:\s*250/.test(src), "withLoading default delay is 250ms");
assert(/setTimeout\(startUi,\s*delayMs\)/.test(src), "delayed appearance retained");
assert(/aria-live="polite"/.test(src), "aria-live retained");
assert(/prefers-reduced-motion/.test(src), "reduced-motion retained");
assert(/portal-loading-reduced-motion/.test(src), "reduced-motion class retained");
assert(/function fail\(/.test(src), "fail helper retained");
assert(/2500/.test(src), "fail auto-hide retained");
assert(/show\(token,\s*\{\s*button:\s*button/.test(src), "withLoading anchors to button");

// Geometry must not use document-centred absolute hacks
assert(!/marginTop\s*=/.test(src), "no margin-top positioning");
assert(!/scrollHeight\s*\//.test(src), "no scrollHeight division centering");
assert(/applyOverlayGeometry/.test(src), "geometry applicator present");

// Unrelated systems untouched by this module
assert(!/fully_paid|instalment|itinerary|ship-gallery|hero_image|booking_reference/i.test(src), "no finance/itinerary/gallery/booking logic");

console.log("test-portal-loading: ok");
