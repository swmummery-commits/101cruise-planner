#!/usr/bin/env node
/**
 * Capture Destination Experience V5 full-page review screenshots via Playwright.
 * HOLD DEPLOY — local artifacts only (generated-assets is gitignored).
 */
import { chromium } from "playwright";
import { createServer } from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "generated-assets/destination-experience/caribbean-v5");
const port = 8788 + Math.floor(Math.random() * 100);
const cruiseQuery = "slug=caribbean&timing=cruise&start=2026-11-17&end=2026-11-27";

fs.mkdirSync(outDir, { recursive: true });

function contentType(filePath) {
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const rel = urlPath === "/" ? "/destination-experience.html" : urlPath;
  const filePath = path.join(root, rel.replace(/^\//, ""));
  if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": contentType(filePath) });
  fs.createReadStream(filePath).pipe(res);
});

async function preparePage(page, query) {
  await page.goto(`http://127.0.0.1:${port}/destination-experience.html?${query}`, {
    waitUntil: "load",
    timeout: 60000
  });
  await page.waitForSelector('#destination-experience-app[data-dx-media-ready="true"] .dx-page', {
    timeout: 90000
  });
  await page.evaluate(async () => {
    document.documentElement.classList.add("dx-reduced-motion");
    document.querySelectorAll("[data-dx-reveal]").forEach((el) => el.classList.add("is-visible"));
    const height = () => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    for (let i = 0; i < 8; i += 1) {
      window.scrollTo(0, height());
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    window.scrollTo(0, 0);
    await Promise.all(
      Array.from(document.querySelectorAll("[data-dx-dest-image], [data-dx-line-logo]")).map((img) => {
        if (img.complete && img.naturalWidth > 0) {
          return typeof img.decode === "function" ? img.decode().catch(() => {}) : Promise.resolve();
        }
        return new Promise((resolve) => {
          img.addEventListener("load", resolve, { once: true });
          img.addEventListener("error", resolve, { once: true });
        });
      })
    );
  });
  await page.waitForTimeout(400);
}

await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
const browser = await chromium.launch();
const page = await browser.newPage();

const jobs = [
  [390, "slug=caribbean", "mobile-general-full-page.png"],
  [390, cruiseQuery, "mobile-exact-cruise-full-page.png"],
  [768, cruiseQuery, "tablet-exact-cruise-full-page.png"],
  [1440, cruiseQuery, "desktop-exact-cruise-full-page.png"]
];

for (const [width, query, name] of jobs) {
  await page.setViewportSize({ width, height: 900 });
  await preparePage(page, query);
  const outfile = path.join(outDir, name);
  await page.screenshot({ path: outfile, fullPage: true, timeout: 60000 });
  const size = fs.statSync(outfile).size;
  const metrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    destImages: Array.from(document.querySelectorAll("[data-dx-dest-image]")).map((img) => ({
      role: img.getAttribute("data-dx-dest-image"),
      ok: img.complete && img.naturalWidth > 0
    })),
    portCount: document.querySelectorAll(".dx-port-card").length,
    lineCards: document.querySelectorAll(".dx-line-card").length
  }));
  console.log("wrote", outfile, size, metrics);
}

await browser.close();
server.close();
console.log("screenshot pack ready:", outDir);
