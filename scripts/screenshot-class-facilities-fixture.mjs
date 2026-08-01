#!/usr/bin/env node
/**
 * Capture fixture screenshots for class facilities template UI.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const fixtureUrl = pathToFileURL(path.join(root, "scripts/fixtures/class-facilities-template-ui.html")).href;
const outDir = path.join(root, "scripts/fixtures/screenshots");

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  await page.goto(fixtureUrl);
  await page.waitForTimeout(300);
  await page.locator("#ciLineShipClassesPanel").screenshot({
    path: path.join(outDir, "class-facilities-ship-classes-section.png")
  });
  await page.locator(".ci-class-tpl-modal").screenshot({
    path: path.join(outDir, "class-facilities-apply-confirmation.png")
  });
  await browser.close();
  console.log("Screenshots written to scripts/fixtures/screenshots/");
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
