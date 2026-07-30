#!/usr/bin/env node
/**
 * Capture Cruise Finder destination integration screenshots.
 */
import { chromium } from "playwright";
import { createServer } from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "generated-assets/destination-experience/cruise-finder-integration");
const port = 8790 + Math.floor(Math.random() * 20);

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
  let rel = urlPath;
  if (urlPath === "/cruise-destination") {
    rel = "/public-tools/cruise-finder/destination.html";
  } else if (urlPath === "/") {
    rel = "/public-tools/cruise-finder/destination.html";
  }
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
  await page.goto(`http://127.0.0.1:${port}/cruise-destination?${query}`, {
    waitUntil: "load",
    timeout: 90000
  });
  await page.waitForSelector('[id="101cruise-cruise-destination"][data-dx-media-ready="true"] .dx-page', {
    timeout: 120000
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
  });
  await page.waitForTimeout(400);
}

await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
const browser = await chromium.launch();
const page = await browser.newPage();

const jobs = [
  [1440, "destination=caribbean&tm=month&m=11&mk=excellent", "desktop-caribbean-result.png"],
  [390, "destination=caribbean&tm=month&m=11&mk=excellent", "mobile-caribbean-result.png"],
  [1440, "destination=japan&tm=flexible&mk=worth", "desktop-second-destination.png"],
  [390, "destination=japan&tm=flexible&mk=worth", "mobile-second-destination.png"]
];

for (const [width, query, name] of jobs) {
  await page.setViewportSize({ width, height: 900 });
  await preparePage(page, query);
  const outfile = path.join(outDir, name);
  await page.screenshot({ path: outfile, fullPage: true, timeout: 90000 });
  const metrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    portCards: document.querySelectorAll(".dx-port-card").length,
    lineCards: document.querySelectorAll(".dx-line-card").length
  }));
  console.log("wrote", outfile, metrics);
}

await browser.close();
server.close();
console.log("screenshot pack ready:", outDir);
