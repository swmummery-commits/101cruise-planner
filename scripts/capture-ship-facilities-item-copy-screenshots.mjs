#!/usr/bin/env node
/**
 * Item-level ship facilities copy screenshots (fixtures only).
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import http from "http";
import vm from "node:vm";
import { fileURLToPath } from "url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const outDir = path.join(root, "generated-assets/ship-intelligence/ship-facilities-item-copy-v1");
const require = createRequire(import.meta.url);
const fixtures = require(path.join(root, "scripts/fixtures/ship-facilities-item-copy-fixtures.js"));

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function loadModule(rel) {
  const sandbox = { module: { exports: {} }, exports: {} };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(read(rel), sandbox, { filename: path.basename(rel) });
  return sandbox.module.exports;
}

const ItemCopy = loadModule("js/ci-ship-facilities-item-copy.js");
const edge = fixtures.ships.find((s) => s.id === "edge");
const edgeExclusive = ItemCopy.listSourceExclusiveAreas(edge.facilities.exclusive_areas);
const edgeSpecialty = ItemCopy.listSourceSpecialtyFeatures(edge.facilities.specialty_features);
const sameClassTargets = ItemCopy.listSameClassCopyTargets(fixtures.ships, edge, "Edge class");
const fleetTargets = ItemCopy.listFleetCopyTargets(fixtures.ships, edge);

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderSourceExclusive(item, checked) {
  const preview = item.legacy
    ? `<span class="ci-item-copy-legacy-tag">Legacy text</span>`
    : (item.description ? `<span class="ci-item-copy-desc-preview">${esc(item.description)}</span>` : "");
  return `
    <label class="ci-check-control ci-item-copy-source-item">
      <input type="checkbox"${checked ? " checked" : ""}>
      <span class="ci-item-copy-source-item-body"><strong>${esc(item.name)}</strong>${preview}</span>
    </label>`;
}

function renderSourceSpecialty(item, checked) {
  return `
    <label class="ci-check-control ci-item-copy-source-item">
      <input type="checkbox"${checked ? " checked" : ""}>
      <span class="ci-item-copy-source-item-body"><strong>${esc(item.value)}</strong></span>
    </label>`;
}

function renderTargetRow(ship, status, checked) {
  return `
    <label class="ci-check-control ci-item-copy-target-row">
      <input type="checkbox"${checked ? " checked" : ""}>
      <span class="ci-item-copy-target-body">
        <span class="ci-item-copy-target-name">${esc(ship.name)}</span>
        <span class="ci-item-copy-target-meta">${esc(ship.ship_class || "Unassigned")}</span>
        <span class="ci-item-copy-target-status">${esc(status)}</span>
      </span>
    </label>`;
}

function modalShell(body, footerExtra = "") {
  return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><title>Item copy</title>
<link rel="stylesheet" href="/css/admin.css"></head>
<body style="padding:20px;background:#eef1f4;">
<div class="ci-facilities-copy-overlay ci-item-copy-overlay" style="position:relative;inset:auto;background:transparent;padding:0;">
  <div class="ci-facilities-copy-modal ci-item-copy-modal" style="box-shadow:0 18px 48px rgba(17,24,39,.18);max-height:none;">
    <div class="ci-facilities-copy-modal-head"><h4>Copy ship facilities</h4></div>
    <div class="ci-facilities-copy-modal-body">${body}</div>
    <div class="ci-facilities-copy-modal-footer">${footerExtra}</div>
  </div>
</div>
</body></html>`;
}

function statusFor(ship, selectedKeys) {
  const selectedItems = {
    exclusive_areas: edgeExclusive.filter((i) => selectedKeys.exclusive.includes(i.source_key)).map((i) => ({ source_key: i.source_key, name: i.name })),
    specialty_features: edgeSpecialty.filter((i) => selectedKeys.specialty.includes(i.source_key)).map((i) => ({ source_key: i.source_key, value: i.value }))
  };
  const plan = ItemCopy.buildCopyPlans({
    sourceFacilities: edge.facilities,
    targets: [ship],
    selectedItems,
    conflictResolutions: []
  })[0];
  return ItemCopy.targetComparisonStatusLabel(plan.items);
}

const selectedKeys = {
  exclusive: edgeExclusive.map((i) => i.source_key),
  specialty: edgeSpecialty.map((i) => i.source_key)
};

function sourceSelectionPage() {
  const body = `
    <p class="admin-small"><strong>Source ship:</strong> Celebrity Edge</p>
    <p class="admin-small"><strong>Cruise line:</strong> Celebrity Cruises</p>
    <section class="ci-item-copy-section">
      <div class="ci-item-copy-section-head"><h5>Exclusive Areas</h5></div>
      <div class="ci-item-copy-source-list">${edgeExclusive.map((item, idx) => renderSourceExclusive(item, idx < 2)).join("")}</div>
    </section>
    <section class="ci-item-copy-section">
      <div class="ci-item-copy-section-head"><h5>Specialty Features</h5></div>
      <div class="ci-item-copy-source-list">${edgeSpecialty.map((item, idx) => renderSourceSpecialty(item, idx < 2)).join("")}</div>
    </section>`;
  return modalShell(body);
}

function sameClassTargetsPage() {
  const keys = { exclusive: [edgeExclusive.find((i) => i.name === "Blu").source_key], specialty: [edgeSpecialty.find((i) => i.value === "Magic Carpet").source_key, edgeSpecialty.find((i) => i.value === "Eden").source_key] };
  const body = `
    <section class="ci-item-copy-section"><h5>Target scope</h5>
      <label class="ci-check-control"><input type="radio" checked> Same class</label>
      <label class="ci-check-control"><input type="radio"> Entire cruise-line fleet</label>
    </section>
    <section class="ci-item-copy-section"><h5>Target ships</h5>
      <div class="ci-item-copy-target-list">${sameClassTargets.map((ship, idx) => renderTargetRow(ship, statusFor(ship, keys), idx < 3)).join("")}</div>
    </section>`;
  return modalShell(body, `<p class="admin-small">Blu and Magic Carpet will add; Eden already identical on some targets.</p>`);
}

function fleetTargetsPage() {
  const keys = { exclusive: [edgeExclusive.find((i) => i.name === "Blu").source_key], specialty: [] };
  const body = `
    <section class="ci-item-copy-section"><h5>Target scope</h5>
      <label class="ci-check-control"><input type="radio"> Same class</label>
      <label class="ci-check-control"><input type="radio" checked> Entire cruise-line fleet</label>
    </section>
    <div class="ci-item-copy-target-filters">
      <label class="admin-field"><span>Search ships</span><input type="search" value=""></label>
      <label class="admin-field"><span>Class filter</span><select><option>All classes</option><option>Edge class</option><option>Millennium class</option></select></label>
    </div>
    <div class="ci-item-copy-target-list">${fleetTargets.slice(0, 6).map((ship) => renderTargetRow(ship, statusFor(ship, keys), false)).join("")}</div>`;
  return modalShell(body);
}

function conflictPage() {
  const body = `
    <section class="ci-item-copy-section"><h5>Exclusive area conflicts</h5>
      <div class="ci-item-copy-conflict-card">
        <p class="admin-small"><strong>Celebrity Apex</strong> · The Retreat</p>
        <div class="ci-item-copy-conflict-grid">
          <div><p class="admin-small">Source</p><p>The Retreat</p><p class="ci-item-copy-desc-preview">Ship-within-a-ship for suite guests with Luminae and private sundeck.</p></div>
          <div><p class="admin-small">Target</p><p>The Retreat</p><p class="ci-item-copy-desc-preview">Different Retreat copy on Apex.</p></div>
        </div>
        <fieldset class="ci-item-copy-conflict-choices">
          <label class="ci-check-control"><input type="radio" name="c1" checked> Keep existing</label>
          <label class="ci-check-control"><input type="radio" name="c1"> Replace existing</label>
        </fieldset>
      </div>
    </section>`;
  return modalShell(body);
}

function confirmationPage() {
  return modalShell(`
    <section class="ci-item-copy-section"><h5>Review</h5>
      <div class="ci-item-copy-review-card">
        <p class="admin-small"><strong>Celebrity Beyond</strong></p>
        <p class="admin-small">3 items will be added · 1 identical item will be skipped</p>
      </div>
    </section>`, `
    <p class="admin-small">Additions: 3 · Replacements: 1 · Identical skipped: 2 · Target versions retained: 1</p>
    <p class="admin-small">Unrelated target facilities will be preserved.</p>
    <button type="button" class="admin-button small">Confirm copy</button>`);
}

function resultPage() {
  return modalShell("", `
    <div class="ci-item-copy-result-wrap">
      <p><strong>Copy complete</strong></p>
      <div class="ci-item-copy-result-card"><strong>Celebrity Beyond</strong><br>Added: Blu, Magic Carpet<br>Already present: Eden</div>
      <div class="ci-item-copy-result-card"><strong>Celebrity Apex</strong><br>Added: Magic Carpet<br>Replaced: The Retreat</div>
    </div>`);
}

function noChangesPage() {
  return modalShell(`
    <section class="ci-item-copy-section"><h5>Review</h5>
      <div class="ci-item-copy-review-card"><p class="admin-small"><strong>Celebrity Xcel</strong></p><p class="admin-small">No changes</p></div>
    </section>`, `
    <p class="admin-small">All selected items are already identical or set to keep existing — no changes to copy.</p>
    <button type="button" class="admin-button small" disabled aria-disabled="true">No changes to copy</button>`);
}

function mobileCombinedPage() {
  const body = sourceSelectionPage().match(/<div class="ci-facilities-copy-modal-body">([\s\S]*?)<\/div>\s*<div class="ci-facilities-copy-modal-footer">/)[1]
    + sameClassTargetsPage().match(/<div class="ci-facilities-copy-modal-body">([\s\S]*?)<\/div>\s*<div class="ci-facilities-copy-modal-footer">/)[1];
  return modalShell(body);
}

function contentType(filePath) {
  if (filePath.endsWith(".css")) return "text/css";
  return "text/plain";
}

const routes = {
  "/source": sourceSelectionPage(),
  "/same-class": sameClassTargetsPage(),
  "/fleet": fleetTargetsPage(),
  "/conflict": conflictPage(),
  "/confirm": confirmationPage(),
  "/result": resultPage(),
  "/no-change": noChangesPage(),
  "/mobile": mobileCombinedPage(),
  "/mobile-conflict": conflictPage()
};

const server = await new Promise((resolve) => {
  const s = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (routes[url.pathname]) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(routes[url.pathname]);
      return;
    }
    const filePath = path.join(root, decodeURIComponent(url.pathname));
    if (!filePath.startsWith(root) || !fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    res.end(fs.readFileSync(filePath));
  });
  s.listen(0, "127.0.0.1", () => resolve(s));
});

const base = `http://127.0.0.1:${server.address().port}`;
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const shots = [
  ["source-item-selection-desktop.png", "/source", { width: 1200, height: 1200 }],
  ["same-class-target-selection-desktop.png", "/same-class", { width: 1200, height: 1200 }],
  ["fleet-target-selection-desktop.png", "/fleet", { width: 1200, height: 1200 }],
  ["exclusive-area-conflict-resolution.png", "/conflict", { width: 1200, height: 900 }],
  ["copy-confirmation-summary.png", "/confirm", { width: 1200, height: 900 }],
  ["copy-result-summary.png", "/result", { width: 1200, height: 900 }],
  ["no-changes-to-copy.png", "/no-change", { width: 1200, height: 900 }],
  ["mobile-source-and-target-selection-390.png", "/mobile", { width: 390, height: 1400 }],
  ["mobile-conflict-resolution-390.png", "/mobile-conflict", { width: 390, height: 900 }]
];

for (const [file, route, viewport] of shots) {
  const page = await browser.newPage({ viewport });
  await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
  await page.screenshot({ path: path.join(outDir, file), fullPage: true });
  await page.close();
}

await browser.close();
server.close();
console.log(`Screenshots saved to ${outDir}`);
