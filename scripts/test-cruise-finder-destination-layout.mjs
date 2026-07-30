#!/usr/bin/env node
/**
 * Cruise Finder destination page — mobile overflow checks.
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 8795;

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  let rel = urlPath === "/cruise-destination" ? "/public-tools/cruise-finder/destination.html" : urlPath;
  const filePath = path.join(root, rel.replace(/^\//, ""));
  if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": contentType(filePath) });
  fs.createReadStream(filePath).pipe(res);
});

async function assertLayout(page, width, query) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`http://127.0.0.1:${port}/cruise-destination?${query}`, {
    waitUntil: "load",
    timeout: 90000
  });
  await page.waitForSelector('[id="101cruise-cruise-destination"][data-dx-media-ready="true"] .dx-page', {
    timeout: 120000
  });
  const metrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  assert.ok(
    metrics.scrollWidth <= metrics.clientWidth,
    `${width}px: scrollWidth ${metrics.scrollWidth} > clientWidth ${metrics.clientWidth}`
  );
  return metrics;
}

await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
const browser = await chromium.launch();
const page = await browser.newPage();
const query = "destination=caribbean&tm=month&m=11&mk=excellent";
const measured = [];
for (const width of [390, 375, 320]) {
  measured.push(await assertLayout(page, width, query));
}
await browser.close();
server.close();
console.log("test-cruise-finder-destination-layout: ok");
for (const m of measured) {
  console.log(`clientWidth=${m.clientWidth} scrollWidth=${m.scrollWidth}`);
}
