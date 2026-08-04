/**
 * Shared brand loading indicator tests.
 * Run: node scripts/test-brand-loading.mjs
 */

import { createRequire } from "module";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const { html, panelHtml, play, stop, BOX_COUNT, CANONICAL_MESSAGE } = require("../js/brand-loading.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(BOX_COUNT === 9, "nine box count");
assert(CANONICAL_MESSAGE === "Hang tight! Just getting your info.", "canonical loading message");
const { SAVING_MESSAGE } = require("../js/brand-loading.js");
assert(SAVING_MESSAGE === "Hang tight! Saving your info.", "saving message");
assert(typeof panelHtml === "function", "panelHtml API");
const panel = panelHtml();
assert(/brand-loading-panel/.test(panel), "panel wrapper");
assert(/Hang tight! Just getting your info\./.test(panel), "panel message");
assert(typeof play === "function" && typeof stop === "function", "play/stop API");

const markup = html({ large: true, className: "portal-loading-spinner" });
assert(/brand-loading-boxes--large/.test(markup), "large variant");
assert(/portal-loading-spinner/.test(markup), "extra class");
assert((markup.match(/<span><\/span>/g) || []).length === 9, "nine boxes");

const inline = html({ inline: true });
assert(/brand-loading-boxes--inline/.test(inline), "inline variant");

const css = readFileSync(path.join(root, "css/brand-loading.css"), "utf8");
assert(/\.is-on/.test(css), "flash on state");
assert(/#f80020/i.test(css), "logo red");
assert(/grid-template-columns:\s*repeat\(3/.test(css), "3x3 grid columns");
assert(/font-weight:\s*400/.test(css), "loading message normal weight");

const src = readFileSync(path.join(root, "js/brand-loading.js"), "utf8");
assert(/buildSequence/.test(src), "random sequence builder");
assert(/MutationObserver/.test(src), "auto-binds inserted indicators");

const indexHtml = readFileSync(path.join(root, "index.html"), "utf8");
const adminHtml = readFileSync(path.join(root, "admin.html"), "utf8");
const adminLoading = readFileSync(path.join(root, "js/admin-loading.js"), "utf8");
assert(indexHtml.includes("brand-loading.css") && indexHtml.includes("brand-loading.js"), "portal loads shared assets");
assert(adminHtml.includes("brand-loading.css") && adminHtml.includes("brand-loading.js"), "admin loads shared assets");
assert(adminLoading.includes("Hang tight! Saving your info."), "admin loading uses saving message");

console.log("test-brand-loading: ok");
