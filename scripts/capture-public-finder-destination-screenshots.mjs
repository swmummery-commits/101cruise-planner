#!/usr/bin/env node
/**
 * Capture public Cruise Finder → destination route screenshots (production).
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "generated-assets/destination-experience/live-route-fix");
const FINDER_URL = "https://www.101cruise.com.au/cruise-finder";

fs.mkdirSync(outDir, { recursive: true });

async function completeFinder(page, timing) {
  await page.goto(FINDER_URL, { waitUntil: "networkidle", timeout: 120000 });
  await page.click(`button[data-timing="${timing.mode}"]`);
  if (timing.mode === "month") {
    await page.selectOption('select[data-field="month"]', timing.month);
    await page.selectOption('select[data-field="year"]', timing.year);
  }
  if (timing.mode === "flexible") {
    /* no extra fields */
  }
  await page.click('button[data-duration="6-8"]');
  await page.click('button[data-departure="sydney"]');
  await page.click('button[data-style="beaches"]');
  await page.click('button[data-budget="no_budget"]');
  await page.waitForSelector("[data-explore]", { timeout: 30000 });
}

async function openDestination(page, destId) {
  const btn = page.locator(`[data-explore="${destId}"]`);
  await btn.scrollIntoViewIfNeeded();
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle", timeout: 120000 }),
    btn.click()
  ]);
  await page.waitForSelector('[id="101cruise-cruise-destination"][data-dx-media-ready="true"] .dx-page', {
    timeout: 120000
  });
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
  await page.waitForTimeout(400);
}

const browser = await chromium.launch();
const page = await browser.newPage();

const jobs = [
  {
    name: "public-finder-caribbean-desktop.png",
    width: 1440,
    timing: { mode: "month", month: "11", year: "2026" },
    dest: "caribbean"
  },
  {
    name: "public-finder-caribbean-mobile.png",
    width: 390,
    timing: { mode: "month", month: "11", year: "2026" },
    dest: "caribbean"
  },
  {
    name: "public-finder-japan-desktop.png",
    width: 1440,
    timing: { mode: "flexible" },
    dest: "japan"
  },
  {
    name: "public-finder-japan-mobile.png",
    width: 320,
    timing: { mode: "flexible" },
    dest: "japan"
  }
];

const report = [];

for (const job of jobs) {
  await page.setViewportSize({ width: job.width, height: 900 });
  await completeFinder(page, job.timing);
  await openDestination(page, job.dest);
  const outfile = path.join(outDir, job.name);
  await page.screenshot({ path: outfile, fullPage: true, timeout: 120000 });
  const metrics = await page.evaluate(() => ({
    url: location.href,
    hasDx: !!document.querySelector(".dx-page"),
    hasLegacy: !!document.querySelector(".cf-dest-media, .dest-page"),
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  report.push({ file: job.name, ...metrics });
  console.log("wrote", outfile, metrics);
}

await browser.close();
console.log(JSON.stringify(report, null, 2));
