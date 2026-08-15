/**
 * Viewport scroll helper tests.
 * Run: node scripts/test-viewport-scroll.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

const src = read("js/viewport-scroll.js");
const adminJs = read("js/admin.js");
const adminHtml = read("admin.html");
const indexHtml = read("index.html");
const adminEmbed = read("js/admin-squarespace-embed.js");
const portalEmbed = read("js/portal-squarespace-embed.js");
const brandCss = read("css/brand-loading.css");
const adminCss = read("css/admin.css");

const sandbox = {
  globalThis: {},
  window: {},
  document: {
    scrollingElement: { scrollTop: 0, scrollTo() {} },
    documentElement: { scrollTop: 0, scrollTo() {} },
    body: { scrollTop: 0, scrollTo() {} },
    querySelector() {
      return null;
    },
    getElementById() {
      return null;
    }
  },
  history: { scrollRestoration: "auto" },
  location: { hash: "" },
  requestAnimationFrame(fn) {
    fn();
    return 1;
  },
  scrollTo() {},
  parent: null
};
sandbox.window = sandbox.globalThis;
sandbox.globalThis.window = sandbox.window;
sandbox.globalThis.document = sandbox.document;
sandbox.globalThis.history = sandbox.history;
sandbox.globalThis.location = sandbox.location;
sandbox.globalThis.requestAnimationFrame = sandbox.requestAnimationFrame;
sandbox.globalThis.scrollTo = sandbox.scrollTo;

vm.runInNewContext(src, sandbox, { filename: "viewport-scroll.js" });

const ViewportScroll = sandbox.globalThis.ViewportScroll || sandbox.ViewportScroll;
assert(ViewportScroll, "ViewportScroll global exists");
assert(typeof ViewportScroll.scheduleScrollToTop === "function");
assert(typeof ViewportScroll.scheduleScrollToElement === "function");
assert(typeof ViewportScroll.scrollToElement === "function");
assert(typeof ViewportScroll.hasExplicitHashTarget === "function");
assert.equal(ViewportScroll.MSG_SCROLL_TO, "101cruise-scroll-to");
assert(typeof ViewportScroll.autoScrollFromClientY === "function", "edge auto-scroll helper");
assert(typeof ViewportScroll.getVisibleBounds === "function", "visible bounds helper");
assert.equal(ViewportScroll.autoScrollFromClientY(400), 0, "no auto-scroll in the middle of the viewport");
assert(ViewportScroll.autoScrollFromClientY(8) < 0, "auto-scrolls up near the top edge");
assert(ViewportScroll.autoScrollFromClientY(792) > 0, "auto-scrolls down near the bottom edge");
assert.equal(ViewportScroll.hasExplicitHashTarget(), false);
sandbox.location.hash = "#section";
assert.equal(ViewportScroll.hasExplicitHashTarget(), false, "missing hash target does not block scroll");

assert(adminJs.includes("scheduleAdminViewportToTop"), "admin defines scroll helper");
assert(adminJs.includes("ViewportScroll?.scheduleScrollToElement"), "packing save restores scroll to saved item");
assert(adminJs.includes("window.renderAdmin = renderAdmin"), "renderAdmin exposed on window");
assert(adminHtml.includes("viewport-scroll.js"), "admin.html loads viewport-scroll");
assert(indexHtml.includes("viewport-scroll.js"), "index.html loads viewport-scroll");
assert(adminEmbed.includes("101cruise-scroll-top"), "admin embed handles scroll-top message");
assert(adminEmbed.includes("101cruise-scroll-to"), "admin embed handles scroll-to message");
assert(portalEmbed.includes("101cruise-scroll-top"), "portal embed handles scroll-top message");
assert(/font-weight:\s*400/.test(brandCss), "brand loading message normal weight");
assert(/admin-loading-message[\s\S]*?font-weight:\s*400/.test(adminCss), "admin overlay message normal weight");

console.log("test-viewport-scroll: ok");
