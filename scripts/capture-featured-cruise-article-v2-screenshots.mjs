#!/usr/bin/env node
/**
 * Capture Featured Cruise Article V2 inside a Squarespace-style iframe harness.
 * Read-only: fetches live public-featured-cruise payloads over GET.
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const outDir = path.join(root, "generated-assets/featured-cruise-article-v2");
const PRODUCTION = "https://admirable-tiramisu-d4da8a.netlify.app";

const REVIEWS = [
  {
    key: "sirena",
    slug: "sail-through-ancient-empires-spectacular-coastlines-and-timeless-mediterranean-t",
    label: "Oceania Sirena"
  },
  {
    key: "apex",
    slug: "cross-the-atlantic-in-style",
    label: "Celebrity Apex"
  },
  {
    key: "voyager",
    slug: "explore-sun-drenched-islands-ancient-civilisations-and-turquoise-coastlines-on-t",
    label: "Regent Voyager"
  }
];

const MEASUREMENTS = {
  desktopIframe: 760,
  tabletIframe: 737,
  narrowIframe: 600,
  mobile390Iframe: 343,
  mobile320Iframe: 282
};

function contentType(filePath) {
  if (filePath.endsWith(".css")) return "text/css";
  if (filePath.endsWith(".js")) return "application/javascript";
  if (filePath.endsWith(".json")) return "application/json";
  if (filePath.endsWith(".html")) return "text/html";
  if (filePath.endsWith(".png")) return "image/png";
  return "text/plain";
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname.startsWith("/.netlify/functions/public-featured-cruise")) {
        const upstream = `${PRODUCTION}${url.pathname}${url.search}`;
        try {
          const response = await fetch(upstream, { headers: { Accept: "application/json" } });
          const body = await response.text();
          res.writeHead(response.status, { "Content-Type": "application/json" });
          res.end(body);
        } catch (error) {
          res.writeHead(502);
          res.end(JSON.stringify({ error: String(error.message || error) }));
        }
        return;
      }
      let filePath = path.join(root, decodeURIComponent(url.pathname));
      if (url.pathname === "/" || url.pathname === "") {
        filePath = path.join(root, "cruise/index.html");
      } else if (url.pathname.startsWith("/cruise/") && !path.extname(url.pathname)) {
        filePath = path.join(root, "cruise/index.html");
      }
      if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": contentType(filePath) });
      res.end(fs.readFileSync(filePath));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function fetchLiveCruise(slug) {
  const response = await fetch(`${PRODUCTION}/.netlify/functions/public-featured-cruise?slug=${encodeURIComponent(slug)}`);
  const payload = await response.json();
  if (!response.ok || !payload.cruise) {
    throw new Error(`Could not load live cruise ${slug}: HTTP ${response.status}`);
  }
  delete payload.cruise.pricing;
  return payload.cruise;
}

function harnessHtml({ iframeWidth, iframeSrc, canvasWidth, title }) {
  const sidePad = Math.max(0, Math.round((canvasWidth - iframeWidth) / 2));
  return `<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { margin:0; background:#ffffff; font-family:Helvetica,Arial,sans-serif; }
  .sq-page { width:${canvasWidth}px; margin:0 auto; padding:24px ${sidePad}px 40px; box-sizing:border-box; }
  .sq-heading { font-size:14px; color:#666; margin:0 0 12px; text-align:center; }
  .sq-wrap { width:100%; max-width:${iframeWidth}px; margin:0 auto; }
  iframe { display:block; width:100%; height:1200px; border:0; background:#fff; }
</style></head>
<body><div class="sq-page"><p class="sq-heading">Squarespace-style canvas ${canvasWidth}px · iframe ${iframeWidth}px</p>
<div class="sq-wrap"><iframe src="${iframeSrc}"></iframe></div></div></body></html>`;
}

async function waitForArticle(page) {
  await page.waitForSelector(".fca-article", { timeout: 90000 });
  await page.waitForFunction(() => !(document.body.innerText || "").includes("Loading cruise"), { timeout: 90000 }).catch(() => null);
  await page.waitForTimeout(1200);
}

async function metrics(page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    hasFeaturedDx: !!document.querySelector(".dx-page--featured-cruise"),
    hasArticle: !!document.querySelector(".fca-article"),
    duplicatedEditorial: (() => {
      const intro = document.querySelector(".fca-hero-intro")?.textContent?.trim() || "";
      const paras = [...document.querySelectorAll(".fca-editorial-body p, .fca-editorial-full p")]
        .map((p) => p.textContent.trim())
        .filter(Boolean);
      return intro && paras.some((p) => p.startsWith(intro.slice(0, 40)));
    })()
  }));
}

fs.mkdirSync(outDir, { recursive: true });
const server = await startServer();
const address = server.address();
const base = `http://127.0.0.1:${address.port}`;
const report = { generated_at: new Date().toISOString(), measurements: MEASUREMENTS, cruises: [] };

try {
  for (const review of REVIEWS) {
    const cruise = await fetchLiveCruise(review.slug);
    const entry = {
      key: review.key,
      label: review.label,
      slug: review.slug,
      headline: cruise.headline,
      sparse: {
        destination_research: Boolean(cruise.research?.destination_full),
        ship_research: Boolean(cruise.research?.ship_full),
        ship_facts: Boolean(cruise.research?.ship_facts),
        route_map: Boolean(cruise.route_map?.url)
      },
      metrics: {}
    };

    const browser = await chromium.launch({ headless: true });
    const desktopPage = await browser.newPage({ viewport: { width: MEASUREMENTS.desktopIframe + 40, height: 1400 } });
    await desktopPage.goto(`${base}/cruise/${review.slug}?embed=1&article=v2`, { waitUntil: "domcontentloaded" });
    await waitForArticle(desktopPage);
    await desktopPage.screenshot({ path: path.join(outDir, `${review.key}-actual-embed-desktop.png`), fullPage: true });
    entry.metrics.desktop = await metrics(desktopPage);
    await desktopPage.close();

    const mobilePage = await browser.newPage({ viewport: { width: MEASUREMENTS.mobile390Iframe + 24, height: 1600 } });
    await mobilePage.goto(`${base}/cruise/${review.slug}?embed=1&article=v2`, { waitUntil: "domcontentloaded" });
    await waitForArticle(mobilePage);
    await mobilePage.screenshot({ path: path.join(outDir, `${review.key}-actual-embed-mobile-390.png`), fullPage: true });
    entry.metrics.mobile390 = await metrics(mobilePage);
    await mobilePage.close();

    const canvasPage = await browser.newPage({ viewport: { width: 1440, height: 1600 } });
    const canvasHtml = harnessHtml({
      iframeWidth: MEASUREMENTS.desktopIframe,
      iframeSrc: `${base}/cruise/${review.slug}?embed=1&article=v2`,
      canvasWidth: 1440,
      title: `${review.label} Squarespace canvas`
    });
    const canvasPath = path.join(outDir, `${review.key}-squarespace-canvas.html`);
    fs.writeFileSync(canvasPath, canvasHtml);
    await canvasPage.goto(`file://${canvasPath}`, { waitUntil: "domcontentloaded" });
    await canvasPage.waitForTimeout(3000);
    await canvasPage.screenshot({
      path: path.join(outDir, `${review.key}-squarespace-canvas-1440.png`),
      fullPage: true
    });
    await canvasPage.close();

    const overflowPage = await browser.newPage({ viewport: { width: 320, height: 1600 } });
    await overflowPage.goto(`${base}/cruise/${review.slug}?embed=1&article=v2`, { waitUntil: "domcontentloaded" });
    await waitForArticle(overflowPage);
    entry.metrics.mobile320 = await metrics(overflowPage);
    await overflowPage.close();

    await browser.close();
    report.cruises.push(entry);
  }

  fs.writeFileSync(path.join(outDir, "article-v2-data-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  server.close();
}
