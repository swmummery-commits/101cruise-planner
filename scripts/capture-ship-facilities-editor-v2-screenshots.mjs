#!/usr/bin/env node
/**
 * Local review screenshots — ship facilities editor v2 (fixtures only).
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import http from "http";
import vm from "node:vm";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const outDir = path.join(root, "generated-assets/ship-intelligence/facilities-editor-v2");

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

const apexSentence =
  "The Retreat, a ship-within-a-ship concept for suite guests featuring a private sundeck, dedicated lounge, and the exclusive restaurant Luminae.";

const millenniumExclusive = [
  "Suite Deck",
  "Premium Lounge",
  "The Retreat",
  "a ship-within-a-ship concept for suite guests featuring a private sundeck",
  "dedicated lounge",
  "and the exclusive restaurant Luminae."
];

const edgeClassFixtureShips = [
  { id: "apex", name: "Celebrity Apex", cruise_line_id: "line-celeb", ship_class: "Edge class", active: true },
  { id: "edge", name: "Celebrity Edge", cruise_line_id: "line-celeb", ship_class: "Edge class", active: true },
  { id: "beyond", name: "Celebrity Beyond", cruise_line_id: "line-celeb", ship_class: "Edge class", active: true },
  { id: "ascent", name: "Celebrity Ascent", cruise_line_id: "line-celeb", ship_class: "Edge class", active: true },
  { id: "xcel", name: "Celebrity Xcel", cruise_line_id: "line-celeb", ship_class: "Edge class", active: true },
  { id: "eclipse", name: "Celebrity Eclipse", cruise_line_id: "line-celeb", ship_class: "Solstice class", active: true }
];

const edgeCopySource = edgeClassFixtureShips.find((ship) => ship.id === "apex");
const edgeCopyTargets = CiFac.listSameClassCopyTargets(edgeClassFixtureShips, edgeCopySource, "Edge class");
if (edgeCopyTargets.some((ship) => ship.id === "eclipse")) {
  throw new Error("Celebrity Eclipse must not appear in Edge class copy targets");
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderExclusiveFieldStack(row, index, { readonly = true } = {}) {
  const showDescription = Boolean(row.showDescription || row.description);
  const descHidden = showDescription ? "" : " hidden";
  const addDescHidden = showDescription ? " hidden" : "";
  const readAttr = readonly ? " readonly" : "";
  return `
      <div class="ci-exclusive-area-fields">
        <div class="admin-field ci-exclusive-area-name-field">
          <label>Name</label>
          <input type="text" class="ci-exclusive-area-name" value="${esc(row.name)}"${readAttr}>
        </div>
        <button type="button" class="admin-button secondary small ci-exclusive-area-add-desc${addDescHidden}"${readonly ? " disabled" : ""}>Add description</button>
        <div class="ci-exclusive-area-description-wrap admin-field${descHidden}">
          <label>Description <span class="admin-small">(optional)</span></label>
          <textarea class="ci-exclusive-area-description" rows="2"${readAttr}>${esc(row.description || "")}</textarea>
        </div>
      </div>`;
}

function renderExclusiveCard(row, index, total) {
  const fieldStack = renderExclusiveFieldStack(row, index);
  if (total <= 1) {
    return `<div class="ci-exclusive-area-card" data-index="${index}">${fieldStack}</div>`;
  }
  return `
    <div class="ci-exclusive-area-card" data-index="${index}">
      <div class="ci-exclusive-area-card-head">
        <strong class="ci-exclusive-area-card-title">Exclusive area ${index + 1}</strong>
      </div>
      <div class="ci-exclusive-area-card-actions">
        <button type="button" class="admin-button secondary small">↑</button>
        <button type="button" class="admin-button secondary small">↓</button>
        <button type="button" class="admin-button secondary small">Remove</button>
      </div>
      ${fieldStack}
    </div>`;
}

function renderSourcePreview(rows) {
  if (!rows.length) return "";
  return `
    <div class="ci-exclusive-area-source-preview">
      <p class="admin-small"><strong>Source exclusive area${rows.length === 1 ? "" : "s"}</strong></p>
      ${rows.map((row, index) => `
        <div class="ci-exclusive-area-card ci-exclusive-area-card--preview">
          ${rows.length > 1 ? `<strong class="ci-exclusive-area-card-title">Exclusive area ${index + 1}</strong>` : ""}
          ${renderExclusiveFieldStack(row, index)}
        </div>`).join("")}
    </div>`;
}

function renderCopyModalFixture() {
  const previewRows = [{ name: "The Retreat", description: "Shared Edge-class copy.", showDescription: true }];
  const selectedIds = new Set(["ascent", "beyond", "xcel"]);
  const selectedCount = edgeCopyTargets.filter((ship) => selectedIds.has(ship.id)).length;
  const buttonLabel = CiFac.sameClassCopyButtonLabel(selectedCount);
  const buttonDisabled = !CiFac.sameClassCopyCanSubmit({
    selectedCount,
    copyExclusive: true,
    copySpecialty: false
  });
  const selectedNames = edgeCopyTargets
    .filter((ship) => selectedIds.has(ship.id))
    .map((ship) => ship.name);
  return `
    <div class="ci-facilities-copy-overlay" style="position:relative; inset:auto; background:transparent; padding:0; margin-top:18px;">
      <div class="ci-facilities-copy-modal" style="box-shadow:none; border:1px solid #e8e8e8; max-height:none;">
        <div class="ci-facilities-copy-modal-head">
          <h4>Copy to ships in this class</h4>
        </div>
        <div class="ci-facilities-copy-modal-body">
          <p class="admin-small"><strong>Cruise line:</strong> Celebrity Cruises</p>
          <p class="admin-small"><strong>Ship class:</strong> Edge class</p>
          ${renderSourcePreview(previewRows)}
          <p class="ci-facility-warning">Selected facility sections will replace the same sections on each target ship.</p>
          <div class="ci-facilities-copy-toolbar">
            <label class="ci-check-control"><input type="checkbox"> Select all targets</label>
            <button type="button" class="admin-button secondary small">Clear all</button>
          </div>
          <div class="ci-facilities-copy-list">
            ${edgeCopyTargets.map((ship) => `
              <label class="ci-check-control ci-facilities-copy-item">
                <input type="checkbox"${selectedIds.has(ship.id) ? " checked" : ""}>
                <span>${esc(ship.name)}</span>
              </label>`).join("")}
          </div>
          <div class="ci-facilities-copy-sections">
            <label class="ci-check-control"><input type="checkbox" checked> Copy Exclusive Areas</label>
            <label class="ci-check-control"><input type="checkbox"> Copy Specialty Features</label>
          </div>
        </div>
        <div class="ci-facilities-copy-modal-footer">
          <p class="admin-small">Copy Exclusive Areas to ${selectedCount} ships: ${esc(selectedNames.join(", "))}.</p>
          <div class="admin-actions-row ci-facilities-copy-modal-actions">
            <button type="button" class="admin-button secondary small">Cancel</button>
            <button type="button" class="admin-button small"${buttonDisabled ? " disabled" : ""}>${esc(buttonLabel)}</button>
          </div>
        </div>
      </div>
    </div>`;
}

function adminPage({ title, exclusiveAreas, showFragmentWarning, showModal }) {
  let rows = CiFac.loadExclusiveAreasForAdmin(exclusiveAreas);
  if (!rows.length) rows = [{ name: "", description: "", showDescription: false }];
  const modal = showModal ? renderCopyModalFixture() : "";
  return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><title>${esc(title)}</title>
<link rel="stylesheet" href="/css/admin.css"></head>
<body style="padding:24px;background:#fff;font-family:Helvetica,Arial,sans-serif;max-width:760px;">
<h1 style="font-size:1.05rem;margin:0 0 14px;">${esc(title)}</h1>
<div class="ci-facility-section">
  <h5>Exclusive area</h5>
  ${showFragmentWarning ? `<p class="ci-facility-warning">Legacy entries may need combining before this ship is saved.</p>` : ""}
  <div id="ciExclusiveAreasList">${rows.map((row, index) => renderExclusiveCard(row, index, rows.length)).join("")}</div>
</div>
${modal}
</body></html>`;
}

function shipPage() {
  const areas = CiFac.normalizeExclusiveAreasForDisplay([
    { name: "The Retreat", description: "A ship-within-a-ship experience for suite guests, with commas preserved." }
  ]);
  return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><title>My Ship</title>
<link rel="stylesheet" href="/css/planner.css"></head>
<body style="padding:24px;background:#fff;font-family:Helvetica,Arial,sans-serif;max-width:760px;">
<section class="ship-section-card ship-info-card" style="margin-bottom:16px;">
  <h3>Ship Scale</h3>
  <div class="ship-scale-list"><div class="ship-scale-row"><span>Total decks</span><strong>15</strong></div></div>
</section>
<section class="ship-section-card ship-info-card">
  <h3>Exclusive Areas</h3>
  <div class="ship-exclusive-areas">${areas.map((item) => `
    <div class="ship-exclusive-area-item">
      <div class="dashboard-snapshot-extras-tags ship-chip-group"><span class="dashboard-snapshot-extras-tag">${esc(item.name)}</span></div>
      ${item.description ? `<p class="ship-exclusive-area-detail planner-muted">${esc(item.description)}</p>` : ""}
    </div>`).join("")}
  </div>
</section>
</body></html>`;
}

function contentType(filePath) {
  if (filePath.endsWith(".css")) return "text/css";
  return "text/plain";
}

const server = await new Promise((resolve) => {
  const s = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/apex") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(adminPage({ title: "Celebrity Apex", exclusiveAreas: [apexSentence] }));
      return;
    }
    if (url.pathname === "/millennium") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(adminPage({ title: "Celebrity Millennium", exclusiveAreas: millenniumExclusive, showFragmentWarning: true }));
      return;
    }
    if (url.pathname === "/single") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(adminPage({ title: "Single area collapsed", exclusiveAreas: [{ name: "Suite Deck", description: "" }] }));
      return;
    }
    if (url.pathname === "/modal") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(adminPage({ title: "Copy modal", exclusiveAreas: [{ name: "The Retreat", description: "Shared Edge-class copy." }], showModal: true }));
      return;
    }
    if (url.pathname === "/ship") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(shipPage());
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
  ["admin-celebrity-apex-retreat-split.png", "/apex"],
  ["admin-celebrity-millennium-legacy-warning.png", "/millennium"],
  ["admin-single-area-description-collapsed.png", "/single"],
  ["admin-copy-modal-edge-class-targets.png", "/modal"],
  ["my-ship-structured-exclusive-area.png", "/ship"],
  ["my-ship-total-decks-label.png", "/ship"]
];

for (const [file, route] of shots) {
  const page = await browser.newPage({ viewport: { width: 900, height: 1400 } });
  await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
  await page.screenshot({ path: path.join(outDir, file), fullPage: true });
  await page.close();
}

const overflowRoutes = ["/apex", "/millennium", "/single", "/modal"];
for (const width of [900, 768, 390]) {
  for (const route of overflowRoutes) {
    const page = await browser.newPage({ viewport: { width, height: 1200 } });
    await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      const hasOverflow = doc.scrollWidth > doc.clientWidth + 1;
      const cards = [...document.querySelectorAll(".ci-exclusive-area-card:not(.ci-exclusive-area-card--preview)")];
      const narrowName = cards.some((card) => {
        const input = card.querySelector(".ci-exclusive-area-name");
        const fields = card.querySelector(".ci-exclusive-area-fields");
        if (!input || !fields) return false;
        return input.getBoundingClientRect().width < fields.getBoundingClientRect().width * 0.85;
      });
      const gridCard = cards.some((card) => getComputedStyle(card).display === "grid");
      const modal = document.querySelector(".ci-facilities-copy-modal");
      let modalFooterVisible = true;
      if (modal) {
        const footer = modal.querySelector(".ci-facilities-copy-modal-footer");
        const cancelBtn = footer?.querySelector(".admin-button.secondary");
        const copyBtn = footer?.querySelector(".admin-button.small");
        const modalRect = modal.getBoundingClientRect();
        const footerRect = footer?.getBoundingClientRect();
        modalFooterVisible = Boolean(
          footer &&
          cancelBtn &&
          copyBtn &&
          footerRect &&
          footerRect.bottom <= modalRect.bottom + 1 &&
          footerRect.top >= modalRect.top
        );
      }
      return { hasOverflow, narrowName, gridCard, modalFooterVisible };
    });
    if (overflow.hasOverflow || overflow.narrowName || overflow.gridCard || overflow.modalFooterVisible === false) {
      throw new Error(`Layout overflow at ${width}px on ${route}: ${JSON.stringify(overflow)}`);
    }
    await page.close();
  }
}

await browser.close();
server.close();
console.log(JSON.stringify({ outDir, screenshots: shots.map(([file]) => file) }, null, 2));
