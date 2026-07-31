#!/usr/bin/env node
/**
 * Local review screenshots for ship facilities editor (fixtures only — no Supabase writes).
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import http from "http";
import vm from "node:vm";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const outDir = path.join(root, "generated-assets/ship-intelligence/facilities-editor-v1");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function loadCiShipFacilities() {
  const sandbox = { module: { exports: {} }, exports: {} };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(read("js/ci-ship-facilities.js"), sandbox, { filename: "ci-ship-facilities.js" });
  return sandbox.module.exports;
}

const CiFac = loadCiShipFacilities();

const FIXTURES = {
  millennium: {
    title: "Celebrity Millennium — Admin Exclusive Areas",
    exclusive_areas: [
      "Suite Deck",
      "Premium Lounge",
      "The Retreat",
      "a ship-within-a-ship concept for suite guests featuring a private sundeck",
      "dedicated lounge",
      "and the exclusive restaurant Luminae."
    ],
    specialty_features: ["Main Pool", "Fitness Center"]
  },
  apex: {
    title: "Celebrity Apex — Admin Exclusive Areas",
    exclusive_areas: [
      "Suite Deck",
      "Premium Lounge",
      "The Retreat, a ship-within-a-ship concept for suite guests featuring a private sundeck, dedicated lounge, and the exclusive restaurant Luminae."
    ],
    specialty_features: ["Main Pool", "Fitness Center"]
  },
  placeholder: {
    title: "Placeholder ship — Admin Exclusive Areas",
    exclusive_areas: ["Suite Deck", "Premium Lounge"],
    specialty_features: ["Main Pool", "Fitness Center"]
  },
  explora: {
    title: "Explora I — Admin Specialty Features",
    exclusive_areas: ["Suite Deck", "Premium Lounge"],
    specialty_features: [
      "Suites: All suites feature private terraces",
      "floor-to-ceiling windows",
      "and walk-in wardrobes. Dining & Bars: Six restaurants including Anthology (fine dining)",
      "Sakura (Pan-Asian)"
    ]
  }
};

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderAdminExclusiveRows(rows) {
  return rows
    .map(
      (row, index) => `
    <div class="ci-facility-row ci-exclusive-area-row" data-index="${index}">
      <div class="ci-facility-row-fields">
        <div class="admin-field">
          <label>Name</label>
          <input type="text" class="ci-exclusive-area-name" value="${esc(row.name)}" readonly>
        </div>
        <div class="admin-field">
          <label>Description <span class="admin-small">(optional)</span></label>
          <textarea class="ci-exclusive-area-description" rows="2" readonly>${esc(row.description || "")}</textarea>
        </div>
      </div>
    </div>`
    )
    .join("");
}

function renderAdminSpecialtyRows(rows) {
  return rows
    .map(
      (row, index) => `
    <div class="ci-facility-row ci-specialty-feature-row" data-index="${index}">
      <div class="ci-facility-row-fields">
        <div class="admin-field">
          <label>Feature</label>
          <input type="text" class="ci-specialty-feature-label" value="${esc(row.label)}" readonly>
        </div>
      </div>
    </div>`
    )
    .join("");
}

function adminHarnessHtml(fixture) {
  const exclusiveRows = CiFac.loadExclusiveAreasForAdmin(fixture.exclusive_areas);
  const specialtyRows = CiFac.loadSpecialtyFeaturesForAdmin(fixture.specialty_features);
  return `<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8"><title>${esc(fixture.title)}</title>
<link rel="stylesheet" href="/css/admin.css"></head>
<body style="padding:24px;background:#fff;font-family:Helvetica,Arial,sans-serif;">
  <h1 style="font-size:1.1rem;margin:0 0 16px;">${esc(fixture.title)}</h1>
  <div class="ci-facility-section">
    <h5>Exclusive Areas</h5>
    <div id="ciExclusiveAreasList">${renderAdminExclusiveRows(exclusiveRows)}</div>
  </div>
  <div class="ci-facility-section">
    <h5>Specialty Features</h5>
    <div id="ciSpecialtyFeaturesList">${renderAdminSpecialtyRows(specialtyRows)}</div>
  </div>
</body></html>`;
}

function renderShipExclusiveAreas(areas) {
  return `
    <div class="ship-exclusive-areas">
      ${areas
        .map(
          (item) => `
        <div class="ship-exclusive-area-item">
          <div class="dashboard-snapshot-extras-tags ship-chip-group">
            <span class="dashboard-snapshot-extras-tag">${esc(item.name)}</span>
          </div>
          ${item.description ? `<p class="ship-exclusive-area-detail planner-muted">${esc(item.description)}</p>` : ""}
        </div>`
        )
        .join("")}
    </div>`;
}

function shipHarnessHtml() {
  const areas = CiFac.normalizeExclusiveAreasForDisplay([
    { name: "The Retreat", description: "A ship-within-a-ship experience for suite guests, with commas preserved." }
  ]);
  return `<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8"><title>My Ship — Exclusive Areas + Total Decks</title>
<link rel="stylesheet" href="/css/planner.css"></head>
<body style="padding:24px;background:#fff;font-family:Helvetica,Arial,sans-serif;">
  <section class="ship-section-card ship-info-card" style="max-width:760px;margin-bottom:18px;">
    <h3>Ship Scale</h3>
    <div class="ship-scale-list">
      <div class="ship-scale-row"><span>Total decks</span><strong>15</strong></div>
      <div class="ship-scale-row"><span>Max guests</span><strong>3,258</strong></div>
    </div>
  </section>
  <section class="ship-section-card ship-info-card" style="max-width:760px;margin-bottom:18px;">
    <h3>Specifications</h3>
    <div class="ship-spec-list">
      <div class="ship-spec-row"><span>Decks</span><strong>15</strong></div>
    </div>
  </section>
  <section class="ship-section-card ship-info-card" style="max-width:760px;">
    <h3>Exclusive Areas</h3>
    ${renderShipExclusiveAreas(areas)}
  </section>
</body></html>`;
}

function contentType(filePath) {
  if (filePath.endsWith(".css")) return "text/css";
  if (filePath.endsWith(".js")) return "application/javascript";
  if (filePath.endsWith(".html")) return "text/html";
  return "text/plain";
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/review/millennium") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(adminHarnessHtml(FIXTURES.millennium));
        return;
      }
      if (url.pathname === "/review/apex") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(adminHarnessHtml(FIXTURES.apex));
        return;
      }
      if (url.pathname === "/review/ship") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(shipHarnessHtml());
        return;
      }
      let filePath = path.join(root, decodeURIComponent(url.pathname));
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

fs.mkdirSync(outDir, { recursive: true });
const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });

const shots = [
  { url: `${base}/review/millennium`, file: "admin-celebrity-millennium-exclusive-areas.png" },
  { url: `${base}/review/apex`, file: "admin-celebrity-apex-exclusive-areas.png" },
  { url: `${base}/review/ship`, file: "my-ship-total-decks-and-exclusive-area.png" }
];

for (const shot of shots) {
  const page = await browser.newPage({ viewport: { width: 980, height: 1400 } });
  await page.goto(shot.url, { waitUntil: "networkidle" });
  await page.screenshot({ path: path.join(outDir, shot.file), fullPage: true });
  await page.close();
}

await browser.close();
server.close();
console.log(JSON.stringify({ outDir, screenshots: shots.map((s) => s.file) }, null, 2));
