/**
 * Tests for Squarespace parent-viewport bridge + portal loading overlay.
 * Run: node scripts/test-portal-loading.mjs
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import vm from "vm";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const {
  computeParentVisibleGeometry,
  resolveOverlayBox,
  isAllowedParentOrigin,
  isAllowedChildOrigin,
  CHILD_ORIGIN,
  PARENT_ORIGINS,
  MSG
} = require("../js/portal-parent-viewport.js");

const srcLoading = readFileSync(path.join(root, "js/portal-loading.js"), "utf8");
const srcEmbed = readFileSync(path.join(root, "js/portal-squarespace-embed.js"), "utf8");
const srcHeight = readFileSync(path.join(root, "js/portal-height.js"), "utf8");
const srcPlanner = readFileSync(path.join(root, "js/planner.js"), "utf8");
const css = readFileSync(path.join(root, "css/planner.css"), "utf8");
const embedHtml = readFileSync(path.join(root, "squarespace-my-cruise-embed.html"), "utf8");
const indexHtml = readFileSync(path.join(root, "index.html"), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function loadPortalLoading() {
  const sandbox = {
    globalThis: {},
    window: {
      parent: { postMessage() {} },
      addEventListener() {},
      innerHeight: 900,
      visualViewport: { height: 900 },
      scrollX: 0,
      scrollY: 120,
      pageXOffset: 0,
      pageYOffset: 120,
      scrollTo() {},
      matchMedia: () => ({ matches: false })
    },
    document: {
      documentElement: { style: {}, classList: { add() {}, remove() {}, toggle() {} } },
      body: {
        style: {},
        classList: { add() {}, remove() {} },
        appendChild() {}
      },
      createElement: () => ({
        style: {},
        classList: { add() {}, remove() {}, toggle() {} },
        setAttribute() {},
        querySelector: () => ({ textContent: "" })
      })
    }
  };
  sandbox.window.parent !== sandbox.window;
  Object.defineProperty(sandbox.window, "parent", {
    value: { postMessage() {} }
  });
  // Load bridge then loading
  vm.runInNewContext(
    readFileSync(path.join(root, "js/portal-parent-viewport.js"), "utf8"),
    sandbox,
    { filename: "portal-parent-viewport.js" }
  );
  sandbox.globalThis = sandbox;
  sandbox.PortalParentViewport = sandbox.PortalParentViewport;
  vm.runInNewContext(srcLoading, sandbox, { filename: "portal-loading.js" });
  return sandbox.PortalLoading;
}

// --- Parent geometry cases ---
{
  // iframe starts below page header (top positive)
  const g = computeParentVisibleGeometry({ top: 200, height: 1600, width: 1000 }, 900, 1200);
  assert(g.visibleTop === 0, "below header: visibleTop 0");
  assert(g.visibleHeight === 700, "below header: visibleHeight = parentH - top");
  assert(g.iframeHeight === 1600, "iframeHeight preserved");
  assert(g.parentViewportHeight === 900, "parentViewportHeight preserved");
}

{
  // iframe partly above viewport (scrolled)
  const g = computeParentVisibleGeometry({ top: -400, height: 1600, width: 1000 }, 900, 1200);
  assert(g.visibleTop === 400, "partly above: visibleTop = -top");
  assert(g.visibleHeight === 900, "partly above: full parent height visible in iframe");
}

{
  // near iframe footer
  const g = computeParentVisibleGeometry({ top: -1400, height: 1600, width: 1000 }, 900, 1200);
  assert(g.visibleTop === 1400, "footer: visibleTop near end");
  assert(g.visibleHeight === 200, "footer: remaining visible height");
}

{
  // fully visible iframe shorter than parent
  const g = computeParentVisibleGeometry({ top: 50, height: 700, width: 1000 }, 900, 1200);
  assert(g.visibleTop === 0, "fully visible: top 0");
  assert(g.visibleHeight === 700, "fully visible: full iframe height");
}

{
  // fully off-screen below
  const g = computeParentVisibleGeometry({ top: 1200, height: 1600, width: 1000 }, 900, 1200);
  assert(g.visibleHeight === 0, "off-screen below: visibleHeight 0");
  assert(g.visibleTop === 0, "off-screen below: visibleTop 0");
}

{
  // fully off-screen above
  const g = computeParentVisibleGeometry({ top: -2000, height: 1600, width: 1000 }, 900, 1200);
  assert(g.visibleHeight === 0, "off-screen above: visibleHeight 0");
}

// --- Child uses parent geometry ---
{
  const box = resolveOverlayBox(
    { visibleTop: 420, visibleHeight: 880 },
    1600
  );
  assert(box.mode === "parent", "valid parent geometry mode");
  assert(box.top === 420, "overlay top = visibleTop");
  assert(box.height === 880, "overlay height = visibleHeight");
}

{
  const box = resolveOverlayBox(null, 900);
  assert(box.mode === "direct", "direct Netlify fallback");
  assert(box.top === 0 && box.height === 900, "fallback top 0 / innerHeight");
}

{
  // visibleHeight 0 → treat as missing, fallback
  const box = resolveOverlayBox({ visibleTop: 100, visibleHeight: 0 }, 800);
  assert(box.mode === "direct", "zero visibleHeight falls back");
}

// --- Origin validation ---
assert(isAllowedChildOrigin(CHILD_ORIGIN), "child origin allowed");
assert(!isAllowedChildOrigin("https://evil.example"), "evil child rejected");
assert(isAllowedParentOrigin("https://www.101cruise.com.au"), "www parent allowed");
assert(isAllowedParentOrigin("https://101cruise.com.au"), "apex parent allowed");
assert(!isAllowedParentOrigin("https://evil.example"), "evil parent rejected");
assert(PARENT_ORIGINS.length === 2, "exactly two parent origins");

// --- Heuristics removed ---
assert(!/screen\.availHeight/.test(srcLoading.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "")), "screen.availHeight heuristic removed");
assert(!/\blastPointerY\b|\bpointerdown\b|\banchorCenterY\b|\bcomputeOverlayBand\b/.test(srcLoading), "pointer/band heuristics removed");
assert(!/postMessage\([^,]+,\s*"\*"\)/.test(srcLoading), "loading does not postMessage *");
assert(srcLoading.includes("Hang tight! Just getting your info."), "canonical portal loading message");
assert(!/Just getting the info for you/.test(srcLoading), "legacy loading copy removed");
assert(!/postMessage\([^,]+,\s*"\*"\)/.test(srcHeight), "height does not postMessage *");
assert(!/postMessage\([^,]+,\s*"\*"\)/.test(srcPlanner), "planner does not postMessage *");

// --- Height listener / embed wiring ---
assert(srcEmbed.includes(MSG.HEIGHT) || srcEmbed.includes("101cruise-my-cruise-height"), "embed listens for height");
assert(srcEmbed.includes("applyIframeHeight") || srcEmbed.includes("style.height"), "embed updates iframe height");
assert(srcEmbed.includes("allowIframeScroll"), "embed keeps iframe scrollable as a fallback");
assert(!srcEmbed.includes('setAttribute("scrolling", "no")'), "embed does not disable iframe scrolling");
assert(srcEmbed.includes("scheduleViewport") || srcEmbed.includes("postViewport"), "height change triggers viewport");
assert(srcHeight.includes("101cruise-my-cruise-height"), "child posts height");
assert(srcHeight.includes("ResizeObserver"), "height uses ResizeObserver");
assert(srcPlanner.includes("PortalHeight.start"), "planner starts PortalHeight");
assert(indexHtml.includes("portal-height.js"), "index loads portal-height");
assert(indexHtml.includes("portal-parent-viewport.js"), "index loads parent viewport helpers");
assert(embedHtml.includes("portal-squarespace-embed.js"), "Squarespace snippet loads embed bridge");
assert(embedHtml.includes('id="101cruise-my-cruise"'), "iframe id preserved");

// --- Parent scroll lock ---
assert(srcEmbed.includes("lockParentScroll") && srcEmbed.includes("unlockParentScroll"), "parent scroll lock present");
assert(srcEmbed.includes("savedScrollY"), "parent preserves scroll");
assert(srcEmbed.includes("101cruise-portal-loading-state"), "parent listens for loading state");
assert(srcLoading.includes("101cruise-portal-loading-state"), "child posts loading state");
assert(srcLoading.includes("notifyParentLoading(true)") || srcLoading.includes("active: true") || srcLoading.includes("active: Boolean(active)"), "child notifies active");

// --- Reference counting messages ---
assert(/parentLoadingNotified/.test(srcLoading), "child reference-safe parent notify");
assert(/if \(active && parentLoadingNotified\) return/.test(srcLoading), "active only on first start");
assert(/if \(!active && !parentLoadingNotified\) return/.test(srcLoading), "inactive only after final");

// --- CSS ---
assert(/portal-loading-overlay--parent-viewport/.test(css), "parent geometry CSS class");
assert(/place-items:\s*center/.test(css), "panel centred");
assert(/2147483000/.test(css), "high z-index");

// --- Runtime helper via PortalLoading.__test__ ---
{
  const PortalLoading = loadPortalLoading();
  const box = PortalLoading.__test__.resolveOverlayBox(
    { visibleTop: 300, visibleHeight: 600 },
    1600
  );
  assert(box.top === 300 && box.height === 600, "PortalLoading uses parent box");
  assert(PortalLoading.__test__.isAllowedParentOrigin("https://www.101cruise.com.au"), "origin helper");
  assert(!PortalLoading.__test__.isAllowedParentOrigin("https://attacker.test"), "rejects bad origin");
}

// --- Unrelated systems ---
assert(!/fully_paid|instalment|itinerary|ship-gallery|hero_image|booking_reference/i.test(srcLoading), "loading unchanged domains");
assert(!/fully_paid|instalment|itinerary|ship-gallery/i.test(srcHeight), "height unchanged domains");
assert(!/fully_paid|instalment|itinerary|ship-gallery/i.test(srcEmbed), "embed unchanged domains");

console.log("test-portal-loading: ok");
