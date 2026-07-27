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
const { html, play, stop, BOX_COUNT } = require("../js/brand-loading.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(BOX_COUNT === 16, "sixteen box count");
assert(typeof play === "function" && typeof stop === "function", "play/stop API");

const markup = html({ large: true, className: "portal-loading-spinner" });
assert(/brand-loading-boxes--large/.test(markup), "large variant");
assert(/portal-loading-spinner/.test(markup), "extra class");
assert((markup.match(/<span><\/span>/g) || []).length === 16, "sixteen boxes");

const inline = html({ inline: true });
assert(/brand-loading-boxes--inline/.test(inline), "inline variant");

const css = readFileSync(path.join(root, "css/brand-loading.css"), "utf8");
assert(/\.is-on/.test(css), "flash on state");
assert(/#8dd9bf/.test(css), "brand green");
assert(/grid-template-columns:\s*repeat\(4/.test(css), "4x4 grid columns");
assert(/grid-template-rows:\s*repeat\(4/.test(css), "4x4 grid rows");

const src = readFileSync(path.join(root, "js/brand-loading.js"), "utf8");
assert(/buildSequence/.test(src), "random sequence builder");
assert(/MutationObserver/.test(src), "auto-binds inserted indicators");

const indexHtml = readFileSync(path.join(root, "index.html"), "utf8");
const adminHtml = readFileSync(path.join(root, "admin.html"), "utf8");
assert(indexHtml.includes("brand-loading.css") && indexHtml.includes("brand-loading.js"), "portal loads shared assets");
assert(adminHtml.includes("brand-loading.css") && adminHtml.includes("brand-loading.js"), "admin loads shared assets");

console.log("test-brand-loading: ok");
