#!/usr/bin/env node
/**
 * Destination Experience — mobile layout containment tests (Playwright).
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 8799;
const cruiseQuery = "slug=caribbean&timing=cruise&start=2026-11-17&end=2026-11-27";

function contentType(filePath) {
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

function withinViewport(rect, vw) {
  return rect.left >= -0.5 && rect.right <= vw + 0.5;
}

async function assertLayout(page, width, query, label) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`http://127.0.0.1:${port}/destination-experience.html?${query}`, {
    waitUntil: "networkidle"
  });
  await page.waitForSelector("#destination-experience-app.is-ready .dx-page", { timeout: 20000 });
  await page.evaluate(() => {
    document.documentElement.classList.add("dx-reduced-motion");
    document.querySelectorAll("[data-dx-reveal]").forEach((el) => el.classList.add("is-visible"));
  });

  const metrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight
  }));

  assert.ok(
    metrics.scrollWidth <= metrics.clientWidth,
    `${label} ${width}px: scrollWidth ${metrics.scrollWidth} > clientWidth ${metrics.clientWidth}`
  );
  assert.ok(metrics.scrollHeight > 1800, `${label} ${width}px: page height too short (${metrics.scrollHeight})`);

  const boxes = await page.evaluate((vw) => {
    function box(sel) {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width, top: r.top, bottom: r.bottom };
    }
    return {
      vw,
      heroChips: Array.from(document.querySelectorAll(".dx-hero-styles li")).map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right };
      }),
      snapshots: Array.from(document.querySelectorAll(".dx-snapshot-card")).map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right };
      }),
      reasons: Array.from(document.querySelectorAll(".dx-reason-card")).map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right };
      }),
      season: box(".dx-season-section .dx-wrap"),
      cta: box(".dx-cta"),
      ports: box(".dx-ports-section"),
      lines: box(".dx-lines-section"),
      advice: box(".dx-advice-section")
    };
  }, width);

  boxes.heroChips.forEach((chip, index) => {
    assert.ok(withinViewport(chip, width), `${label} ${width}px: hero chip ${index} overflows`);
  });
  boxes.snapshots.forEach((card, index) => {
    assert.ok(withinViewport(card, width), `${label} ${width}px: snapshot ${index} overflows`);
  });
  boxes.reasons.forEach((card, index) => {
    assert.ok(withinViewport(card, width), `${label} ${width}px: reason ${index} overflows`);
  });
  assert.ok(boxes.season && withinViewport(boxes.season, width), `${label} ${width}px: season overflows`);
  assert.ok(boxes.cta && withinViewport(boxes.cta, width), `${label} ${width}px: cta overflows`);
  assert.ok(boxes.cta && boxes.cta.bottom > boxes.cta.top, `${label} ${width}px: cta missing`);
  assert.ok(boxes.ports, `${label} ${width}px: ports section missing`);
  assert.ok(boxes.lines, `${label} ${width}px: lines section missing`);
  assert.ok(boxes.advice, `${label} ${width}px: advice section missing`);

  return metrics;
}

await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
const browser = await chromium.launch();
const page = await browser.newPage();

const measured = [];
for (const width of [390, 375, 320]) {
  measured.push(await assertLayout(page, width, "slug=caribbean", "general"));
  measured.push(await assertLayout(page, width, cruiseQuery, "cruise"));
}

await browser.close();
server.close();

console.log("test-destination-experience-layout: ok");
for (const m of measured) {
  console.log(`clientWidth=${m.clientWidth} scrollWidth=${m.scrollWidth} scrollHeight=${m.scrollHeight}`);
}
