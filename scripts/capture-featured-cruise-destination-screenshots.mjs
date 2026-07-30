#!/usr/bin/env node
/**
 * Capture Featured Cruise Destination Experience screenshots from local fixtures.
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "generated-assets/destination-experience/featured-cruise-v1");
const fixturesDir = path.join(root, "scripts/fixtures");

fs.mkdirSync(outDir, { recursive: true });

function contentType(filePath) {
  if (filePath.endsWith(".css")) return "text/css";
  if (filePath.endsWith(".js")) return "application/javascript";
  if (filePath.endsWith(".json")) return "application/json";
  if (filePath.endsWith(".html")) return "text/html";
  if (filePath.endsWith(".png")) return "image/png";
  return "text/plain";
}

function createServer() {
  return http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const rel = urlPath === "/" ? "/scripts/fixtures/featured-cruise-review.html" : urlPath;
    const filePath = path.join(root, rel.replace(/^\//, ""));
    if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function preparePage(page) {
  await page.evaluate(async () => {
    document.documentElement.classList.add("dx-reduced-motion");
    document.querySelectorAll("[data-dx-reveal]").forEach((el) => el.classList.add("is-visible"));
    const height = () => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    for (let i = 0; i < 6; i += 1) {
      window.scrollTo(0, height());
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(500);
}

function buildGapReport(cruise, label) {
  const gaps = [];
  if (!cruise.research?.destination_full) gaps.push("destination research");
  if (!cruise.research?.ship_full) gaps.push("published ship research");
  if (!cruise.route_map?.url) gaps.push("route map");
  for (const stop of cruise.itinerary?.stops || []) {
    if (!stop.is_sea_day && !stop.image) gaps.push(`port image: ${stop.name}`);
  }
  const tip =
    cruise.research?.ship_full?.pauls_tip || cruise.research?.destination_full?.pauls_tip || "";
  if (!tip) gaps.push("public-safe Paul's Tip");
  const missingShipFields = [];
  for (const field of ["guests", "crew", "decks", "restaurants", "spa"]) {
    if ((cruise.research?.ship_facts || {})[field] == null) missingShipFields.push(field);
  }
  return { label, slug: cruise.public_slug, headline: cruise.headline, gaps, missingShipFields };
}

const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;

const jobs = [
  { fixture: "sirena", label: "sirena-barcelona-istanbul", file: "featured-cruise-sirena-payload.json" },
  { fixture: "sparse", label: "sparse-cruise", file: "featured-cruise-sparse-payload.json" }
];

const gapReports = jobs.map((job) =>
  buildGapReport(JSON.parse(fs.readFileSync(path.join(fixturesDir, job.file), "utf8")), job.label)
);

const browser = await chromium.launch();
const page = await browser.newPage();
const results = [];

for (const job of jobs) {
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${baseUrl}/scripts/fixtures/featured-cruise-review.html?fixture=${job.fixture}`, {
      waitUntil: "networkidle",
      timeout: 120000
    });
    await page.waitForSelector(".dx-page--featured-cruise", { timeout: 120000 });
    await preparePage(page);
    const suffix = width >= 768 ? "desktop" : "mobile";
    const file = path.join(outDir, `${job.label}-${suffix}-${width}.png`);
    await page.screenshot({ path: file, fullPage: true });
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth
    }));
    results.push({ file, width, overflow, fixture: job.fixture });
  }
}

await browser.close();
server.close();

const reportPath = path.join(outDir, "data-gap-report.json");
fs.writeFileSync(
  reportPath,
  JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      note: "Review fixtures based on Newsletter #77 Sirena contract; live slug barcelona-istanbul returned 404 from current Supabase.",
      gapReports,
      results
    },
    null,
    2
  )
);

console.log("Screenshots written to", outDir);
results.forEach((row) => {
  console.log(`${path.basename(row.file)} overflow ${row.overflow.scrollWidth}/${row.overflow.clientWidth}`);
});
