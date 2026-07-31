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
const apex = fixtures.ships.find((s) => s.id === "apex");
const beyond = fixtures.ships.find((s) => s.id === "beyond");
const edgeExclusive = ItemCopy.listSourceExclusiveAreas(edge.facilities.exclusive_areas);
const edgeSpecialty = ItemCopy.listSourceSpecialtyFeatures(edge.facilities.specialty_features);
const bluKey = edgeExclusive.find((i) => i.name === "Blu").source_key;
const retreatKey = edgeExclusive.find((i) => i.name === "The Retreat").source_key;
const magicKey = edgeSpecialty.find((i) => i.value === "Magic Carpet").source_key;
const edenKey = edgeSpecialty.find((i) => i.value === "Eden").source_key;
const rooftopKey = edgeSpecialty.find((i) => i.value === "Rooftop Garden").source_key;

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

function renderTargetRows(ships, keys, selectedIds) {
  const selectedItems = {
    exclusive_areas: edgeExclusive.filter((i) => keys.exclusive.includes(i.source_key)).map((i) => ({ source_key: i.source_key, name: i.name })),
    specialty_features: edgeSpecialty.filter((i) => keys.specialty.includes(i.source_key)).map((i) => ({ source_key: i.source_key, value: i.value }))
  };
  return ships.map((ship) => {
    const plan = ItemCopy.buildCopyPlans({
      sourceFacilities: edge.facilities,
      targets: [ship],
      selectedItems,
      conflictResolutions: []
    })[0];
    const status = ItemCopy.targetComparisonStatusLabel(plan.items);
    const checked = selectedIds.has(ship.id) ? " checked" : "";
    return `
      <tr class="ci-item-copy-row">
        <td><label class="ci-check-control"><input type="checkbox"${checked}></label></td>
        <td>${esc(ship.name)}</td>
        <td>${esc(ship.ship_class || "Unassigned")}</td>
        <td>${esc(status)}</td>
      </tr>
      <tr class="ci-item-copy-card"><td colspan="4">
        <label class="ci-check-control ci-item-copy-card-head"><input type="checkbox"${checked}><strong>${esc(ship.name)}</strong></label>
        <div class="ci-item-copy-card-meta"><span>${esc(ship.ship_class || "Unassigned")}</span><span>${esc(status)}</span></div>
      </td></tr>`;
  }).join("");
}

function renderConfirmList(title, items) {
  if (!items.length) return "";
  return `<p class="admin-small ci-item-copy-confirm-group-title">${esc(title)}</p><ul class="ci-bulk-class-summary-list">${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`;
}

function renderConfirmTargetCard(row) {
  return `<div class="ci-item-copy-confirm-card"><p class="admin-small"><strong>${esc(row.targetShipName)}</strong></p>
    ${renderConfirmList("Will add:", row.willAdd)}
    ${renderConfirmList("Will replace:", row.willReplace)}
    ${renderConfirmList("Already identical:", row.alreadyIdentical)}
    ${renderConfirmList("Keep target version:", row.keepTarget)}</div>`;
}

function modalPage({ title, body, footer, step }) {
  return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><title>${esc(title)}</title>
<link rel="stylesheet" href="/css/admin.css"></head>
<body style="margin:0;background:#eef1f4;font-family:Helvetica,Arial,sans-serif;">
<div class="ci-bulk-class-overlay ci-item-copy-overlay" style="position:relative;inset:auto;min-height:100vh;padding:20px;">
  <div class="ci-bulk-class-modal ci-item-copy-modal" style="margin:0 auto;max-height:none;">
    <div class="ci-bulk-class-modal-head"><h4>${esc(title)}</h4><button type="button" class="admin-button secondary small">Close</button></div>
    <div class="ci-bulk-class-modal-body">${body}</div>
    <div class="ci-bulk-class-modal-footer">${footer}</div>
  </div>
</div></body></html>`;
}

function selectFooter(disabled, summary) {
  return `
    <p class="admin-small">${esc(summary)}</p>
    <div class="admin-actions-row ci-bulk-class-modal-actions ci-item-copy-footer" data-footer-step="select">
      <button type="button" class="admin-button secondary small">Cancel</button>
      <button type="button" class="admin-button small"${disabled ? ' disabled aria-disabled="true"' : ""}>Continue to review</button>
    </div>`;
}

function selectBody(keys, ships, selectedIds, scopeFleet) {
  return `
    <p class="admin-small"><strong>Source ship:</strong> Celebrity Edge</p>
    <p class="admin-small"><strong>Cruise line:</strong> Celebrity Cruises</p>
    <div class="ci-item-copy-global-toolbar ci-bulk-class-selection-tools">
      <button type="button" class="admin-button secondary small">Select all items</button>
      <button type="button" class="admin-button secondary small">Clear all items</button>
    </div>
    <section class="ci-item-copy-section"><div class="ci-item-copy-section-head"><h5>Exclusive Areas</h5>
      <div class="ci-bulk-class-selection-tools"><button type="button" class="admin-button secondary small">Select all</button><button type="button" class="admin-button secondary small">Clear all</button></div></div>
      <div class="ci-item-copy-source-list">${edgeExclusive.map((item) => renderSourceExclusive(item, keys.exclusive.includes(item.source_key))).join("")}</div></section>
    <section class="ci-item-copy-section"><div class="ci-item-copy-section-head"><h5>Specialty Features</h5>
      <div class="ci-bulk-class-selection-tools"><button type="button" class="admin-button secondary small">Select all</button><button type="button" class="admin-button secondary small">Clear all</button></div></div>
      <div class="ci-item-copy-source-list">${edgeSpecialty.map((item) => renderSourceSpecialty(item, keys.specialty.includes(item.source_key))).join("")}</div></section>
    <section class="ci-item-copy-section"><h5>Target scope</h5>
      <label class="ci-check-control"><input type="radio"${scopeFleet ? "" : " checked"}> Same class</label>
      <label class="ci-check-control"><input type="radio"${scopeFleet ? " checked" : ""}> Entire cruise-line fleet</label></section>
    <section class="ci-item-copy-section"><div class="ci-item-copy-section-head"><h5>Target ships</h5>
      <div class="ci-bulk-class-selection-tools"><button type="button" class="admin-button secondary small">Select all visible</button><button type="button" class="admin-button secondary small">Clear all</button></div></div>
      ${scopeFleet ? `<div class="ci-bulk-class-toolbar ci-item-copy-target-filters"><input type="search" placeholder="Search ships…"><select><option>All classes</option><option>Edge class</option><option>Millennium class</option></select></div>` : ""}
      <div class="ci-bulk-class-table-wrap"><table class="ci-bulk-class-table ci-item-copy-table"><thead><tr><th>Select</th><th>Ship</th><th>Class</th><th>Selected items</th></tr></thead>
      <tbody>${renderTargetRows(ships, keys, selectedIds)}</tbody></table></div></section>`;
}

const emptyKeys = { exclusive: [], specialty: [] };
const selectedKeys = { exclusive: [bluKey, retreatKey], specialty: [magicKey, edenKey, rooftopKey] };
const conflictResolutions = [{ target_ship_id: "apex", source_key: retreatKey, action: "replace_source" }];
const confirmPlans = ItemCopy.buildCopyPlans({
  sourceFacilities: edge.facilities,
  targets: [apex, beyond],
  selectedItems: {
    exclusive_areas: [{ source_key: bluKey, name: "Blu" }, { source_key: retreatKey, name: "The Retreat" }],
    specialty_features: [{ source_key: magicKey, value: "Magic Carpet" }, { source_key: edenKey, value: "Eden" }, { source_key: rooftopKey, value: "Rooftop Garden" }]
  },
  conflictResolutions
});
const confirmation = ItemCopy.buildConfirmationSummary({
  sourceShipName: edge.name,
  cruiseLineName: fixtures.cruiseLine.name,
  targetScope: ItemCopy.TARGET_SCOPE_SAME_CLASS,
  exclusiveItems: edgeExclusive.filter((i) => [bluKey, retreatKey].includes(i.source_key)),
  specialtyItems: edgeSpecialty.filter((i) => [magicKey, edenKey, rooftopKey].includes(i.source_key)),
  plans: confirmPlans
});

const confirmBody = `
  <div class="ci-item-copy-confirm-meta">
    <p class="admin-small"><strong>Source ship:</strong> ${esc(confirmation.sourceShipName)}</p>
    <p class="admin-small"><strong>Cruise line:</strong> ${esc(confirmation.cruiseLineName)}</p>
    <p class="admin-small"><strong>Scope:</strong> ${esc(confirmation.targetScopeLabel)}</p>
  </div>
  ${renderConfirmList("Target ships", confirmation.targetShipNames)}
  ${renderConfirmList("Exclusive Areas", confirmation.exclusiveAreas)}
  ${renderConfirmList("Specialty Features", confirmation.specialtyFeatures)}
  <div class="ci-item-copy-confirm-targets">${confirmation.perTarget.map(renderConfirmTargetCard).join("")}</div>
  <div class="ci-item-copy-confirm-aggregates"><p class="admin-small"><strong>Aggregate totals</strong></p>
    <ul class="ci-bulk-class-summary-list">
      <li>${confirmation.aggregates.addCount} additions</li>
      <li>${confirmation.aggregates.replaceCount} replacements</li>
      <li>${confirmation.aggregates.skipIdenticalCount} identical items skipped</li>
      <li>${confirmation.aggregates.keepExistingCount} target versions retained</li>
    </ul></div>
  <p class="admin-small ci-item-copy-preserve-note">Unrelated target facilities will be preserved.</p>`;

const conflictBody = `<p class="admin-small">Resolve description conflicts before continuing to the final review.</p>
      <div class="ci-item-copy-conflict-card"><p class="admin-small"><strong>Celebrity Apex</strong> · The Retreat</p>
      <div class="ci-item-copy-conflict-grid"><div class="ci-item-copy-conflict-panel"><p class="admin-small">Source</p><p>The Retreat</p><p class="ci-item-copy-desc-preview">Ship-within-a-ship for suite guests with Luminae and private sundeck.</p></div>
      <div class="ci-item-copy-conflict-panel"><p class="admin-small">Target</p><p>The Retreat</p><p class="ci-item-copy-desc-preview">Different Retreat copy on Apex.</p></div></div>
      <label class="ci-check-control"><input type="radio" name="c1"> Keep existing</label>
      <label class="ci-check-control"><input type="radio" name="c1" checked> Replace existing</label></div>`;
const conflictFooter = `<p class="admin-small">Choose keep or replace for each conflicting exclusive area.</p>
      <div class="admin-actions-row ci-bulk-class-modal-actions ci-item-copy-footer" data-footer-step="conflicts">
        <button type="button" class="admin-button secondary small">Back</button>
        <button type="button" class="admin-button secondary small">Cancel</button>
        <button type="button" class="admin-button small">Continue to review</button></div>`;
const confirmFooter = `<p class="admin-small">Ready to copy ${confirmation.aggregates.addCount} additions and ${confirmation.aggregates.replaceCount} replacements.</p>
      <div class="admin-actions-row ci-bulk-class-modal-actions ci-item-copy-footer" data-footer-step="confirm">
        <button type="button" class="admin-button secondary small">Back</button>
        <button type="button" class="admin-button secondary small">Cancel</button>
        <button type="button" class="admin-button small">Confirm copy</button></div>`;

const CopyLib = require(path.join(root, "netlify/functions/lib/ci-ship-facilities-copy.js"));

const approvedSelectedItems = {
  exclusive_areas: [{ source_key: bluKey, name: "Blu" }, { source_key: retreatKey, name: "The Retreat" }],
  specialty_features: [
    { source_key: magicKey, value: "Magic Carpet" },
    { source_key: edenKey, value: "Eden" },
    { source_key: rooftopKey, value: "Rooftop Garden" }
  ]
};

const approvedPlans = ItemCopy.buildCopyPlans({
  sourceFacilities: edge.facilities,
  targets: [apex, beyond],
  selectedItems: approvedSelectedItems,
  conflictResolutions
});

const approvedTotals = ItemCopy.summarizeAllPlans(approvedPlans);
const approvedFooterText = ItemCopy.formatAggregateOperationSummary(approvedTotals, 2, { sourceCount: 5 }).text;

const partialKeys = { exclusive: [bluKey], specialty: [magicKey, edenKey] };
const partialPlans = ItemCopy.buildCopyPlans({
  sourceFacilities: edge.facilities,
  targets: [apex, beyond, fixtures.ships.find((s) => s.id === "ascent")],
  selectedItems: {
    exclusive_areas: [{ source_key: bluKey, name: "Blu" }],
    specialty_features: [{ source_key: magicKey, value: "Magic Carpet" }, { source_key: edenKey, value: "Eden" }]
  },
  conflictResolutions: []
});
const partialFooterText = ItemCopy.formatAggregateOperationSummary(
  ItemCopy.summarizeAllPlans(partialPlans),
  3,
  { sourceCount: 3 }
).text;

const fleetFooterText = ItemCopy.formatAggregateOperationSummary(
  ItemCopy.summarizeAllPlans([]),
  0,
  { sourceCount: 1 }
).text;

function buildSimulatedResults() {
  const results = [apex, beyond].map(function (target) {
    const exec = CopyLib.executeItemLevelCopy({
      sourceFacilities: edge.facilities,
      target: target,
      resolvedItems: approvedSelectedItems,
      conflictResolutions: conflictResolutions
    });
    if (!exec.ok) throw new Error(`Simulated copy failed for ${target.name}`);
    return {
      id: target.id,
      name: target.name,
      ok: true,
      outcomes: exec.outcomes,
      result: exec.resultRow
    };
  });
  ItemCopy.assertResultOutcomesReconcile({
    plans: approvedPlans,
    results: results,
    sourceFacilities: edge.facilities
  });
  return ItemCopy.reconcileResultRows({
    plans: approvedPlans,
    results: results,
    sourceFacilities: edge.facilities
  });
}

function renderResultPageBody(rows) {
  const cards = rows.map(function (row) {
    const result = row.result;
    return `<div class="ci-item-copy-result-card"><p class="admin-small"><strong>${esc(row.name)}</strong></p>
      ${renderConfirmList("Added", result.added || [])}
      ${renderConfirmList("Replaced", result.replaced || [])}
      ${renderConfirmList("Already present", result.skipped_identical || [])}
      ${renderConfirmList("Kept existing", result.kept_existing || [])}</div>`;
  }).join("");
  return `<div class="ci-item-copy-result-wrap"><p class="admin-small"><strong>Copy complete</strong></p>${cards}</div>`;
}

const simulatedResults = buildSimulatedResults();
const resultBody = renderResultPageBody(simulatedResults);

const routes = {
  "/initial": modalPage({
    title: "Copy ship facilities",
    body: selectBody(emptyKeys, sameClassTargets, new Set(), false),
    footer: selectFooter(true, "Select source items and target ships."),
    step: "select"
  }),
  "/source": modalPage({
    title: "Copy ship facilities",
    body: selectBody(selectedKeys, sameClassTargets, new Set(["apex", "beyond"]), false),
    footer: selectFooter(false, approvedFooterText),
    step: "select"
  }),
  "/same-class": modalPage({
    title: "Copy ship facilities",
    body: selectBody(partialKeys, sameClassTargets, new Set(["apex", "beyond", "ascent"]), false),
    footer: selectFooter(!ItemCopy.canContinueToReview({
      selectedSourceCount: 3,
      selectedTargetCount: 3,
      plans: partialPlans
    }), partialFooterText),
    step: "select"
  }),
  "/fleet": modalPage({
    title: "Copy ship facilities",
    body: selectBody({ exclusive: [bluKey], specialty: [] }, fleetTargets.slice(0, 6), new Set(), true),
    footer: selectFooter(true, fleetFooterText),
    step: "select"
  }),
  "/conflict": modalPage({
    title: "Resolve exclusive area conflicts",
    body: conflictBody,
    footer: conflictFooter
  }),
  "/confirm": modalPage({
    title: "Review and confirm copy",
    body: confirmBody,
    footer: confirmFooter
  }),
  "/result": modalPage({
    title: "Copy complete",
    body: resultBody,
    footer: `<div class="admin-actions-row ci-bulk-class-modal-actions ci-item-copy-footer" data-footer-step="result"><button type="button" class="admin-button small">Close</button></div>`
  }),
  "/no-change": modalPage({
    title: "Review and confirm copy",
    body: `<div class="ci-item-copy-confirm-card"><p class="admin-small"><strong>Celebrity Xcel</strong></p><p class="admin-small">No changes</p></div>`,
    footer: `<p class="admin-small">All selected items are already identical or set to keep existing — no changes to copy.</p>
      <div class="admin-actions-row ci-bulk-class-modal-actions ci-item-copy-footer" data-footer-step="confirm">
        <button type="button" class="admin-button secondary small">Back</button>
        <button type="button" class="admin-button secondary small">Cancel</button>
        <button type="button" class="admin-button small" disabled aria-disabled="true">No changes to copy</button></div>`
  }),
  "/mobile": modalPage({
    title: "Copy ship facilities",
    body: selectBody(selectedKeys, sameClassTargets.slice(0, 3), new Set(["apex", "beyond"]), false),
    footer: selectFooter(false, approvedFooterText)
  }),
  "/mobile-conflict": modalPage({
    title: "Resolve exclusive area conflicts",
    body: conflictBody,
    footer: conflictFooter
  }),
  "/mobile-confirm": modalPage({
    title: "Review and confirm copy",
    body: confirmBody,
    footer: confirmFooter
  })
};

function contentType(filePath) {
  if (filePath.endsWith(".css")) return "text/css";
  return "text/plain";
}

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
  ["initial-empty-selection-desktop.png", "/initial", { width: 1200, height: 1100 }],
  ["source-item-selection-desktop.png", "/source", { width: 1200, height: 1200 }],
  ["same-class-target-selection-desktop.png", "/same-class", { width: 1200, height: 1200 }],
  ["fleet-target-selection-desktop.png", "/fleet", { width: 1200, height: 1200 }],
  ["exclusive-area-conflict-resolution.png", "/conflict", { width: 1200, height: 900 }],
  ["copy-confirmation-summary.png", "/confirm", { width: 1200, height: 1200 }],
  ["copy-result-summary.png", "/result", { width: 1200, height: 900 }],
  ["no-changes-to-copy.png", "/no-change", { width: 1200, height: 900 }],
  ["mobile-source-and-target-selection-390.png", "/mobile", { width: 390, height: 1400 }],
  ["mobile-conflict-resolution-390.png", "/mobile-conflict", { width: 390, height: 900 }],
  ["mobile-confirmation-390.png", "/mobile-confirm", { width: 390, height: 1400 }]
];

for (const [file, route, viewport] of shots) {
  const page = await browser.newPage({ viewport });
  await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    modal: document.querySelector(".ci-item-copy-modal")?.scrollWidth > document.querySelector(".ci-item-copy-modal")?.clientWidth
  }));
  if (overflow.doc || overflow.modal) {
    throw new Error(`Overflow detected in ${file}: ${JSON.stringify(overflow)}`);
  }
  await page.screenshot({ path: path.join(outDir, file), fullPage: true });
  await page.close();
}

for (const width of [900, 768, 390]) {
  for (const route of ["/same-class", "/mobile"]) {
    const page = await browser.newPage({ viewport: { width, height: 1200 } });
    await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      modal: document.querySelector(".ci-item-copy-modal")?.scrollWidth > document.querySelector(".ci-item-copy-modal")?.clientWidth
    }));
    if (overflow.doc || overflow.modal) {
      throw new Error(`Overflow at ${width}px on ${route}: ${JSON.stringify(overflow)}`);
    }
    await page.close();
  }
}

await browser.close();
server.close();
console.log(`Screenshots saved to ${outDir}`);
