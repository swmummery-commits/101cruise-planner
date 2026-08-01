#!/usr/bin/env node
/**
 * Capture ship spec/scale visual review screenshots.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const outDir = path.join(root, "generated-assets/ship-intelligence/ship-specifications-scale-v1");
const htmlPath = path.join(__dirname, "visual-review/ship-specifications-scale-v1.html");

const shots = [
  { id: "all-data-desktop-three-column-final", file: "all-data-desktop-three-column-final.png" },
  { id: "desktop-space-ratio-open-final", file: "desktop-space-ratio-open-final.png", openDesktop: true, fullPage: true },
  { id: "real-my-ship-space-ratio-open-final", file: "real-my-ship-space-ratio-open-final.png", openDesktop: true, fullPage: true },
  { id: "mobile-space-ratio-inline-closed-390", file: "mobile-space-ratio-inline-closed-390.png", mobile: true },
  { id: "mobile-space-ratio-inline-open-390", file: "mobile-space-ratio-inline-open-390.png", mobile: true, openMobile: true }
];

fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
await page.emulateMedia({ reducedMotion: "reduce" });
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle" });

for (const shot of shots) {
  await page.setViewportSize({ width: shot.mobile ? 390 : 1180, height: shot.mobile ? 1400 : 900 });
  const locator = page.locator(`#${shot.id} .vr-capture`);
  await locator.scrollIntoViewIfNeeded();

  if (shot.openDesktop) {
    await page.locator(`#${shot.id} [data-ship-space-ratio-trigger]`).click();
    await page.waitForTimeout(150);
    await page.waitForFunction(() => {
      const popover = document.querySelector(".ship-space-ratio-popover--portaled:not([hidden])");
      return Boolean(popover && popover.parentElement === document.body);
    });
  }
  if (shot.openMobile) {
    await page.locator(`#${shot.id} [data-ship-space-ratio-trigger]`).click();
    await page.waitForTimeout(100);
  }

  if (shot.fullPage) {
    await page.locator(`#${shot.id}`).screenshot({ path: path.join(outDir, shot.file) });
  } else {
    await locator.screenshot({ path: path.join(outDir, shot.file) });
  }
  console.log("wrote", shot.file);

  if (shot.openDesktop || shot.openMobile) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(50);
  }
}

await browser.close();
