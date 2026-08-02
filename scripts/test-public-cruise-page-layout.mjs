#!/usr/bin/env node
/**
 * Public dynamic cruise page layout — typography, width and public-mode ship grids.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

const articleCss = read("css/featured-cruise-article.css");
const publicCss = read("css/public-cruise.css");
const shipCss = read("css/ci-ship-presentation.css");
const mailchimpJs = read("js/newsletter-mailchimp-export.js");
const newsletterPreviewJs = read("js/newsletter-preview.js");
const cruiseHtml = read("cruise/index.html");

assert.match(articleCss, /--fca-max:\s*1080px/, "public article uses widened max width");
assert.doesNotMatch(articleCss, /--fca-max:\s*760px/, "old narrow email width removed");
assert.match(articleCss, /font-weight:\s*500/, "section headings use medium weight");
assert.match(articleCss, /Helvetica,\s*Arial,\s*sans-serif/, "public sans-serif stack");
assert.doesNotMatch(articleCss, /Georgia/, "article css avoids Georgia");
assert.match(articleCss, /line-height:\s*1\.65/, "editorial line-height");
assert.match(articleCss, /--fca-prose-max/, "readable prose max width");
assert.match(articleCss, /fca-port-card--photo/, "itinerary supports optional port photos");
assert.match(articleCss, /\.fca-itinerary-grid[\s\S]*repeat\(3,\s*minmax\(0,\s*1fr\)\)/, "itinerary 3-col desktop");

assert.match(publicCss, /--public-cruise-max:\s*1080px/, "public shell max width");
assert.match(read("js/public-cruise.js"), /101cruise-public-cruise-height/, "height postMessage retained");

assert.match(shipCss, /\[data-ci-ship-mode="public"\][\s\S]*repeat\(5,\s*minmax\(0,\s*1fr\)\)/, "public stats 5-col");
assert.match(shipCss, /\[data-ci-ship-mode="public"\][\s\S]*ship-glance-metrics[\s\S]*repeat\(5/, "public glance counts 5-col");
assert.match(shipCss, /\[data-ci-ship-mode="public"\][\s\S]*ship-info-grid[\s\S]*repeat\(3/, "public specs 3-col desktop");
assert.match(shipCss, /\[data-ci-ship-mode="public"\][\s\S]*deckplans divider specialty/, "public experiences side-by-side");
assert.match(shipCss, /a\.ship-deck-button:visited/, "deck plan link styled not browser default");
assert.match(shipCss, /#111111/, "deck button dark text");

const beforePublicSection = shipCss.split("/* Public Featured Cruise page integration")[0];
assert.match(beforePublicSection, /\.ship-summary-grid[\s\S]*repeat\(5,\s*minmax\(0,\s*1fr\)\)/, "portal summary grid unchanged");
assert.doesNotMatch(beforePublicSection, /\[data-ci-ship-mode="public"\]/, "portal block has no public-mode rules");

assert.match(newsletterPreviewJs, /NEWSLETTER_CRUISE_SECTIONS[\s\S]*DISCLAIMER/, "newsletter sections unchanged");
assert.doesNotMatch(
  newsletterPreviewJs.match(/NEWSLETTER_CRUISE_SECTIONS\s*=\s*\[[\s\S]*?\];/)?.[0] || "",
  /ABOUT_SHIP/,
  "newsletter email excludes ship info block"
);
assert.doesNotMatch(mailchimpJs, /data-ci-ship-mode|CiShipPresentation/, "mailchimp export unchanged");

assert.match(cruiseHtml, /featured-cruise-article-v2-3/, "cache bust for article css");
assert.match(cruiseHtml, /20260803b/, "cache bust for ship css");

console.log("test-public-cruise-page-layout.mjs: all checks passed");
