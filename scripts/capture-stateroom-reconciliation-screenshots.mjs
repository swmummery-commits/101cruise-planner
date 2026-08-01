#!/usr/bin/env node
/**
 * Capture stateroom reconciliation visual review screenshots.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const outDir = path.join(root, "generated-assets/ship-intelligence/stateroom-total-reconciliation-v1");
const htmlPath = path.join(__dirname, "visual-review/stateroom-total-reconciliation-v1.html");

const shots = [
  { id: "millennium-all-categories-blank-centre", file: "millennium-all-categories-blank-centre.png" },
  { id: "exact-match-total-centre", file: "exact-match-total-centre.png" },
  { id: "below-total-blank-centre", file: "below-total-blank-centre.png" },
  { id: "admin-mismatch-public-behaviour", file: "admin-mismatch-public-behaviour.png" },
  { id: "mobile-millennium-390", file: "mobile-millennium-390.png", mobile: true }
];

fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle" });

for (const shot of shots) {
  if (shot.mobile) {
    await page.setViewportSize({ width: 390, height: 900 });
  } else {
    await page.setViewportSize({ width: 1180, height: 900 });
  }
  const locator = page.locator(`#${shot.id} .vr-capture`);
  await locator.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  await locator.screenshot({ path: path.join(outDir, shot.file) });
  console.log("wrote", shot.file);
}

await browser.close();
