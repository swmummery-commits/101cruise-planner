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
const { html } = require("../js/brand-loading.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const markup = html({ large: true, className: "portal-loading-spinner" });
assert(/brand-loading-boxes--large/.test(markup), "large variant");
assert(/portal-loading-spinner/.test(markup), "extra class");
assert((markup.match(/<span><\/span>/g) || []).length === 4, "four boxes");

const inline = html({ inline: true });
assert(/brand-loading-boxes--inline/.test(inline), "inline variant");

const css = readFileSync(path.join(root, "css/brand-loading.css"), "utf8");
assert(/brand-loading-box-flash/.test(css), "box flash keyframes");
assert(/#8dd9bf/.test(css), "brand green");
assert(/\.research-spinner/.test(css), "admin research spinner mapped");
assert(/\.deck-plans-busy-spinner/.test(css), "deck plans spinner mapped");
assert(/\.cf-search-loading-boxes/.test(css), "cruise-finder loading mapped");

const indexHtml = readFileSync(path.join(root, "index.html"), "utf8");
const adminHtml = readFileSync(path.join(root, "admin.html"), "utf8");
assert(indexHtml.includes("brand-loading.css") && indexHtml.includes("brand-loading.js"), "portal loads shared assets");
assert(adminHtml.includes("brand-loading.css") && adminHtml.includes("brand-loading.js"), "admin loads shared assets");

console.log("test-brand-loading: ok");
