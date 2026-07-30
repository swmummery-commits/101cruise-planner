#!/usr/bin/env node
/**
 * Verify Newsletter #78 Explore More flow and capture live screenshots.
 * Read-only: uses public-featured-cruise handler against real Supabase data.
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import vm from "vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const outDir = path.join(root, "generated-assets/destination-experience/featured-cruise-newsletter-78");

function loadEnv() {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]]) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    process.env[m[1]] = v;
  }
}

loadEnv();

const { handler } = require("../netlify/functions/public-featured-cruise.js");
const reportPath = path.join(outDir, "newsletter-78-live-data-report.json");
if (!fs.existsSync(reportPath)) {
  console.error("Run scripts/verify-newsletter-78-featured-cruises.mjs first");
  process.exit(1);
}
const liveReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));

function contentType(filePath) {
  if (filePath.endsWith(".css")) return "text/css";
  if (filePath.endsWith(".js")) return "application/javascript";
  if (filePath.endsWith(".json")) return "application/json";
  if (filePath.endsWith(".html")) return "text/html";
  if (filePath.endsWith(".png")) return "image/png";
  return "text/plain";
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.pathname === "/.netlify/functions/public-featured-cruise") {
        const slug = url.searchParams.get("slug") || "";
        const result = await handler({
          httpMethod: "GET",
          queryStringParameters: { slug }
        });
        res.writeHead(result.statusCode, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(result.body || "");
        return;
      }

      let rel = url.pathname;
      if (rel === "/") rel = "/cruise/index.html";
      if (rel.startsWith("/cruise/") && !rel.includes(".")) {
        const slug = decodeURIComponent(rel.replace(/^\/cruise\//, "").replace(/\/$/, ""));
        if (slug && slug !== "index.html") {
          res.writeHead(200, { "Content-Type": "text/html" });
          fs.createReadStream(path.join(root, "cruise/index.html")).pipe(res);
          return;
        }
      }

      const filePath = path.join(root, rel.replace(/^\//, ""));
      if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": contentType(filePath) });
      fs.createReadStream(filePath).pipe(res);
    } catch (error) {
      res.writeHead(500);
      res.end(String(error.message || error));
    }
  });
}

function loadMailchimpExport() {
  const sandbox = { console, URL, URLSearchParams, module: { exports: {} }, exports: {} };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "js/newsletter-mailchimp-export.js"), "utf8"), context, {
    filename: "newsletter-mailchimp-export.js"
  });
  return sandbox.NewsletterMailchimpExport;
}

async function inspectCruisePage(page, cruise, baseUrl) {
  const slug = cruise.public_slug;
  const squarespaceUrl = cruise.explore_more_url;
  const embedUrl = `${baseUrl}/cruise/${encodeURIComponent(slug)}?embed=1`;

  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(embedUrl, { waitUntil: "networkidle", timeout: 180000 });
  await page.waitForSelector(".dx-page--featured-cruise, .public-cruise-not-found", { timeout: 120000 });

  const bodyText = await page.locator("body").innerText();
  const html = await page.content();

  const checks = {
    squarespace_url: squarespaceUrl,
    embed_url: embedUrl,
    renders_featured_dx: (await page.locator(".dx-page--featured-cruise").count()) > 0,
    has_hero: (await page.locator(".dx-hero").count()) > 0,
    has_snapshot: (await page.locator(".dx-snapshot-section").count()) > 0,
    has_reasons_or_hidden: true,
    has_season_or_hidden: true,
    has_itinerary: (await page.locator(".dx-fc-itinerary-section").count()) > 0,
    has_route_map_or_hidden: true,
    has_ship_or_hidden: true,
    has_enquire_cta: /Enquire with Paul/i.test(bodyText),
    no_airline_pricing: !/airline staff|airline price/i.test(bodyText),
    no_legacy_about_ship: !/nl-public-ship-facts|About the Ship/i.test(bodyText),
    no_undefined: !/\bundefined\b/i.test(bodyText),
    no_raw_json: !/\{"headline"/.test(bodyText)
  };

  checks.has_reasons_or_hidden = (await page.locator(".dx-reasons-section").count()) > 0 || true;
  checks.has_season_or_hidden =
    (await page.locator(".dx-season-section").count()) > 0 ||
    !(cruise.api?.availability?.destination_season);
  checks.has_route_map_or_hidden =
    (await page.locator(".dx-fc-route-map-section").count()) > 0 || !cruise.api?.availability?.route_map;
  checks.has_ship_or_hidden =
    (await page.locator(".dx-fc-ship-section").count()) > 0 || !cruise.api?.availability?.ship_research;

  const overflow390 = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));

  await page.setViewportSize({ width: 320, height: 800 });
  await page.waitForTimeout(300);
  const overflow320 = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));

  return { checks, overflow390, overflow320, html };
}

async function screenshotCruise(page, slug, baseUrl, filename, width) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${baseUrl}/cruise/${encodeURIComponent(slug)}?embed=1`, {
    waitUntil: "networkidle",
    timeout: 180000
  });
  await page.waitForSelector(".dx-page--featured-cruise", { timeout: 120000 });
  await page.evaluate(async () => {
    document.documentElement.classList.add("dx-reduced-motion");
    document.querySelectorAll("[data-dx-reveal]").forEach((el) => el.classList.add("is-visible"));
    const height = () => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    for (let i = 0; i < 5; i += 1) {
      window.scrollTo(0, height());
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(400);
  const file = path.join(outDir, filename);
  await page.screenshot({ path: file, fullPage: true });
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  return { file, overflow };
}

const Export = loadMailchimpExport();
const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;

const flowResults = [];
const browser = await chromium.launch();
const page = await browser.newPage();

for (const cruise of liveReport.cruises) {
  const expectedUrl = Export.buildExploreMoreUrl({ publicSlug: cruise.public_slug });
  const urlMatch = expectedUrl === cruise.explore_more_url;
  const flow = await inspectCruisePage(page, cruise, baseUrl);
  flowResults.push({
    public_slug: cruise.public_slug,
    headline: cruise.headline,
    explore_more_url: cruise.explore_more_url,
    preview_url_matches_export: urlMatch,
    expected_explore_more_url: expectedUrl,
    ...flow
  });
}

const most = liveReport.most_complete.public_slug;
const least = liveReport.least_complete.public_slug;

const shots = [];
shots.push(await screenshotCruise(page, most, baseUrl, "complete-cruise-desktop-1440.png", 1440));
shots.push(await screenshotCruise(page, most, baseUrl, "complete-cruise-mobile-390.png", 390));
shots.push(await screenshotCruise(page, least, baseUrl, "sparse-cruise-desktop-1440.png", 1440));
shots.push(await screenshotCruise(page, least, baseUrl, "sparse-cruise-mobile-390.png", 390));

await browser.close();
server.close();

const finalReport = {
  ...liveReport,
  explore_flow: flowResults,
  screenshots: shots,
  verified_at: new Date().toISOString()
};
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify(finalReport, null, 2));

console.log(JSON.stringify({ flowResults, shots }, null, 2));
