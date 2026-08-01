#!/usr/bin/env node
/**
 * Capture ship-class facilities template visual review pack.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const fixturePath = path.join(__dirname, "visual-review/ship-class-facilities-template-v1.html");
const fixtureUrl = pathToFileURL(fixturePath).href;
const outDir = path.join(root, "generated-assets/ship-intelligence/ship-class-facilities-template-v1");

const DESKTOP_SCREENS = [
  "cruise-line-ship-classes-section",
  "class-template-editor-existing",
  "class-template-editor-empty-sections",
  "import-from-ship",
  "unsaved-template-state",
  "apply-confirmation",
  "apply-confirmation-acknowledged",
  "empty-section-clear-warning",
  "apply-result",
  "individual-ship-template-note"
];

const MOBILE_SCREENS = [
  { id: "class-template-editor-existing", file: "mobile-class-template-editor-390.png", viewport: { width: 390, height: 900 } },
  { id: "apply-confirmation", file: "mobile-apply-confirmation-390.png", viewport: { width: 390, height: 900 } }
];

const OVERFLOW_CHECKS = [
  { id: "cruise-line-ship-classes-section", widths: [900, 768, 390] },
  { id: "class-template-editor-existing", widths: [900, 768, 390] },
  { id: "apply-confirmation", widths: [900, 768, 390] }
];

async function showScreen(page, screenId) {
  await page.evaluate(function (activeId) {
    document.querySelectorAll(".vr-capture-root").forEach(function (el) {
      el.classList.add("vr-hidden");
    });
    const active = document.getElementById(activeId);
    if (active) active.classList.remove("vr-hidden");
  }, screenId);
  await page.waitForTimeout(150);
}

async function measureOverflow(page, screenId, width) {
  await page.setViewportSize({ width, height: 900 });
  await showScreen(page, screenId);
  return page.evaluate(function () {
    const doc = document.documentElement;
    const body = document.body;
    const overflowX = Math.max(doc.scrollWidth, body.scrollWidth) - window.innerWidth;
    return {
      scrollWidth: Math.max(doc.scrollWidth, body.scrollWidth),
      clientWidth: window.innerWidth,
      overflowX: overflowX
    };
  });
}

async function captureDesktop(page, screenId) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await showScreen(page, screenId);
  const el = page.locator(`#${screenId}`);
  await el.screenshot({ path: path.join(outDir, `${screenId}.png`) });
}

async function captureMobile(page, spec) {
  await page.setViewportSize(spec.viewport);
  await showScreen(page, spec.id);
  const modal = page.locator(`#${spec.id} .ci-bulk-class-modal`).first();
  await modal.screenshot({ path: path.join(outDir, spec.file) });
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(fixtureUrl);
  await page.waitForFunction(function () {
    return document.getElementById("ea-existing")?.children.length > 0;
  });

  for (const screenId of DESKTOP_SCREENS) {
    await captureDesktop(page, screenId);
    console.log("Captured", screenId);
  }

  for (const spec of MOBILE_SCREENS) {
    await captureMobile(page, spec);
    console.log("Captured", spec.file);
  }

  const overflowResults = [];
  for (const check of OVERFLOW_CHECKS) {
    for (const width of check.widths) {
      const result = await measureOverflow(page, check.id, width);
      overflowResults.push({
        screen: check.id,
        width,
        overflowX: result.overflowX,
        pass: result.overflowX <= 1
      });
    }
  }

  await browser.close();

  const reportPath = path.join(outDir, "overflow-report.json");
  fs.writeFileSync(reportPath, JSON.stringify({ overflowResults }, null, 2));
  console.log("Overflow report:", reportPath);
  overflowResults.forEach(function (row) {
    console.log(`${row.pass ? "PASS" : "FAIL"} ${row.screen} @ ${row.width}px overflowX=${row.overflowX}`);
  });
  if (overflowResults.some(function (row) { return !row.pass; })) {
    process.exitCode = 1;
  }
  console.log("Screenshots written to", outDir);
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
