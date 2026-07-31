#!/usr/bin/env node
/**
 * Local review screenshots — bulk ship class assignment (fixtures only).
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import http from "http";
import vm from "node:vm";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const outDir = path.join(root, "generated-assets/ship-intelligence/ship-class-bulk-assign-v1");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function loadBulk() {
  const sandbox = { module: { exports: {} }, exports: {} };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(read("js/ci-ship-class-bulk.js"), sandbox, { filename: "ci-ship-class-bulk.js" });
  return sandbox.module.exports;
}

const Bulk = loadBulk();
const adminCss = read("css/admin.css");

const LINE_CELEB = "line-celeb";
const celebrityFleet = [
  { id: "mill", name: "Celebrity Millennium", cruise_line_id: LINE_CELEB, ship_class: "Millennium class", status: "active", active: true },
  { id: "inf", name: "Celebrity Infinity", cruise_line_id: LINE_CELEB, ship_class: "Millennium class", status: "active", active: true },
  { id: "con", name: "Celebrity Constellation", cruise_line_id: LINE_CELEB, ship_class: "Millennium class", status: "active", active: true },
  { id: "sum", name: "Celebrity Summit", cruise_line_id: LINE_CELEB, ship_class: "Millennium class", status: "active", active: true },
  { id: "sol", name: "Celebrity Solstice", cruise_line_id: LINE_CELEB, ship_class: "Solstice class", status: "active", active: true },
  { id: "ecl", name: "Celebrity Eclipse", cruise_line_id: LINE_CELEB, ship_class: "Solstice class", status: "active", active: true },
  { id: "eq", name: "Celebrity Equinox", cruise_line_id: LINE_CELEB, ship_class: "Solstice class", status: "active", active: true },
  { id: "sil", name: "Celebrity Silhouette", cruise_line_id: LINE_CELEB, ship_class: "Solstice class", status: "active", active: true },
  { id: "ref", name: "Celebrity Reflection", cruise_line_id: LINE_CELEB, ship_class: "Solstice class", status: "active", active: true },
  { id: "edge", name: "Celebrity Edge", cruise_line_id: LINE_CELEB, ship_class: "Edge class", status: "active", active: true },
  { id: "apex", name: "Celebrity Apex", cruise_line_id: LINE_CELEB, ship_class: "Edge class", status: "active", active: true },
  { id: "bynd", name: "Celebrity Beyond", cruise_line_id: LINE_CELEB, ship_class: "Edge class", status: "active", active: true },
  { id: "asc", name: "Celebrity Ascent", cruise_line_id: LINE_CELEB, ship_class: "Edge class", status: "active", active: true },
  { id: "xcel", name: "Celebrity Xcel", cruise_line_id: LINE_CELEB, ship_class: "Edge class", status: "active", active: true },
  { id: "unassigned", name: "Celebrity Flora", cruise_line_id: LINE_CELEB, ship_class: null, status: "active", active: true },
  { id: "mixed", name: "Celebrity Xpedition", cruise_line_id: LINE_CELEB, ship_class: "Expedition class", status: "active", active: true },
  { id: "retired", name: "Celebrity Century", cruise_line_id: LINE_CELEB, ship_class: "Millennium class", status: "retired", active: false },
  { id: "royal", name: "Royal Princess", cruise_line_id: "line-royal", ship_class: "Royal class", status: "active", active: true }
];

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderRow(ship, proposedClass, checked, sourceId) {
  const row = Bulk.classifyAssignment(ship, proposedClass);
  const current = Bulk.isUnassignedClass(ship.ship_class)
    ? `<span class="ci-bulk-class-muted">Unassigned</span>`
    : esc(ship.ship_class);
  let proposed = `<span class="ci-bulk-class-tag is-new">${esc(proposedClass)}</span>`;
  if (row.kind === "unchanged") proposed = `<span class="ci-bulk-class-tag is-unchanged">No change</span>`;
  if (row.kind === "replace") proposed = `<span class="ci-bulk-class-tag is-replace">Will replace “${esc(row.currentClass)}”</span>`;
  const sourceMark = sourceId === ship.id ? `<span class="ci-bulk-class-source">Current ship</span>` : "";
  return `
    <tr class="ci-bulk-class-row"><td><input type="checkbox"${checked ? " checked" : ""}></td><td>${esc(ship.name)}${sourceMark}</td><td>${esc(Bulk.formatStatusLabel(ship))}</td><td>${current}</td><td>${proposed}</td></tr>
    <tr class="ci-bulk-class-card"><td colspan="5"><label class="ci-check-control ci-bulk-class-card-head"><input type="checkbox"${checked ? " checked" : ""}><strong>${esc(ship.name)}</strong>${sourceMark}</label><div class="ci-bulk-class-card-meta"><span>${esc(Bulk.formatStatusLabel(ship))}</span><span>Current: ${current}</span><span>${proposed}</span></div></td></tr>`;
}

function renderModal({
  title,
  shipClass,
  ships,
  selectedIds = [],
  sourceShipId = null,
  showConfirmSummary = false,
  showResultSummary = false,
  showIndividualEntry = false
}) {
  const selected = ships.filter((ship) => selectedIds.includes(ship.id));
  const summary = Bulk.buildAssignmentSummary(selected, shipClass);
  const replacementRequired = summary.replaceCount > 0;
  const applyDisabled = !Bulk.canApplyClassAssignment({
    selectedCount: summary.selectedCount,
    shipClass,
    changeCount: summary.changeCount,
    replaceCount: summary.replaceCount,
    replacementConfirmed: replacementRequired
  });
  const applyLabel = Bulk.applyClassButtonLabel({
    selectedCount: summary.selectedCount,
    changeCount: summary.changeCount
  });
  const clearDisabled = !Bulk.canClearClassAssignment({
    selectedCount: summary.selectedCount,
    shipsWithClassCount: selected.filter((ship) => !Bulk.isUnassignedClass(ship.ship_class)).length
  });
  const suggestions = Bulk.listDistinctClassesForLine(celebrityFleet, LINE_CELEB);
  const plannedResults = showResultSummary ? Bulk.planBulkAssignResults(selected, shipClass) : [];
  const reconciled = showResultSummary
    ? Bulk.reconcileBulkAssignResults(
        selectedIds,
        plannedResults.map((row) => ({ ...row, ok: true }))
      )
    : null;
  const resultText = reconciled ? Bulk.formatAssignResultMessage(reconciled) : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${adminCss}</style></head>
<body style="padding:24px;background:#fff;font-family:Helvetica,Arial,sans-serif;max-width:980px;">
${showIndividualEntry ? `
<div class="ci-ship-class-field admin-field" style="margin-bottom:18px;">
  <label>Ship class</label>
  <div class="ci-ship-class-input-row">
    <input value="${esc(shipClass)}" readonly>
    <button type="button" class="admin-button secondary small">Assign this class to other ships</button>
  </div>
</div>` : ""}
<div class="ci-bulk-class-overlay" style="position:relative;inset:auto;background:transparent;padding:0;">
  <div class="ci-bulk-class-modal" style="box-shadow:none;border:1px solid #e8e8e8;max-height:none;">
    <div class="ci-bulk-class-modal-head"><h4>Assign ship class</h4></div>
    <div class="ci-bulk-class-modal-body">
      <p class="admin-small"><strong>Cruise line:</strong> Celebrity Cruises</p>
      <div class="admin-field"><label>Ship class</label><input value="${esc(shipClass)}" list="suggestions"><datalist id="suggestions">${suggestions.map((item) => `<option value="${esc(item)}"></option>`).join("")}</datalist></div>
      <div class="ci-bulk-class-toolbar">
        <input type="search" placeholder="Search ships…">
        <select><option>Active</option></select>
        <select><option>All classes</option></select>
      </div>
      <div class="ci-bulk-class-selection-tools">
        <button type="button" class="admin-button secondary small">Select all visible</button>
        <button type="button" class="admin-button secondary small">Clear all</button>
        <button type="button" class="admin-button secondary small">Select unassigned</button>
      </div>
      <div class="ci-bulk-class-table-wrap"><table class="ci-bulk-class-table"><thead><tr><th>Select</th><th>Ship</th><th>Status</th><th>Current class</th><th>Proposed class</th></tr></thead><tbody>${ships.map((ship) => renderRow(ship, shipClass, selectedIds.includes(ship.id), sourceShipId)).join("")}</tbody></table></div>
      <div class="ci-bulk-class-summary"><p class="admin-small"><strong>Assignment summary</strong></p><ul class="ci-bulk-class-summary-list"><li>${summary.selectedCount} selected</li><li>${summary.newCount} receiving a new class</li><li>${summary.replaceCount} changing from another class</li><li>${summary.unchangedCount} already unchanged</li></ul></div>
      ${replacementRequired ? `<label class="ci-check-control ci-bulk-class-warning"><input type="checkbox"${summary.replaceCount ? " checked" : ""}> I understand that existing class assignments will be replaced.</label>` : ""}
      ${showConfirmSummary ? `<div class="ci-bulk-class-summary"><p class="admin-small"><strong>Final confirmation</strong></p><p class="admin-small">Assign <strong>${esc(shipClass)}</strong> on Celebrity Cruises to:<br>${selected.map((ship) => esc(ship.name)).join("<br>")}<br><br>New: ${summary.newCount} · Replace: ${summary.replaceCount} · Unchanged: ${summary.unchangedCount}</p></div>` : ""}
      ${showResultSummary ? `<p class="admin-small"><strong>Result:</strong> ${esc(resultText)}</p>` : ""}
    </div>
    <div class="ci-bulk-class-modal-footer"><div class="admin-actions-row ci-bulk-class-modal-actions"><button type="button" class="admin-button secondary small">Cancel</button><button type="button" class="admin-button secondary small"${clearDisabled ? " disabled" : ""}>Clear class from selected ships</button><button type="button" class="admin-button small"${applyDisabled ? " disabled" : ""}>${esc(applyLabel)}</button></div></div>
  </div>
</div>
</body></html>`;
}

const unassignedShips = Bulk.filterFleetShips(celebrityFleet, LINE_CELEB, {
  statusFilter: "active",
  classFilter: "unassigned"
});
const millenniumShips = celebrityFleet.filter((ship) =>
  ["mill", "inf", "con", "sum", "sol", "mixed", "unassigned"].includes(ship.id)
);
const replaceShips = celebrityFleet.filter((ship) => ["mill", "inf", "con", "sum", "sol"].includes(ship.id));

const pages = {
  "/unassigned": renderModal({
    title: "Unassigned ships",
    shipClass: "Millennium class",
    ships: unassignedShips
  }),
  "/mixed": renderModal({
    title: "Mixed classes",
    shipClass: "Millennium class",
    ships: millenniumShips,
    selectedIds: ["mill", "inf", "con", "sum"]
  }),
  "/replacement": renderModal({
    title: "Replacement warning",
    shipClass: "Millennium class",
    ships: replaceShips,
    selectedIds: ["inf", "con", "sum", "sol"]
  }),
  "/individual": renderModal({
    title: "Individual ship entry",
    shipClass: "Millennium class",
    ships: millenniumShips.filter((ship) => ["mill", "inf", "con", "sum", "unassigned"].includes(ship.id)),
    selectedIds: ["mill"],
    sourceShipId: "mill",
    showIndividualEntry: true
  }),
  "/confirm": renderModal({
    title: "Confirmation summary",
    shipClass: "Millennium class",
    ships: replaceShips,
    selectedIds: ["inf", "con", "sum", "sol"],
    showConfirmSummary: true
  }),
  "/result": renderModal({
    title: "Result summary",
    shipClass: "Millennium class",
    ships: replaceShips,
    selectedIds: ["inf", "con", "sum", "sol"],
    showResultSummary: true
  }),
  "/no-changes": renderModal({
    title: "No changes to apply",
    shipClass: "Millennium class",
    ships: replaceShips.filter((ship) => ["inf", "con", "sum", "mill"].includes(ship.id)),
    selectedIds: ["inf", "con", "sum", "mill"]
  }),
  "/mobile": renderModal({
    title: "Mobile modal",
    shipClass: "Millennium class",
    ships: replaceShips.filter((ship) => ["inf", "con", "sum", "sol"].includes(ship.id)),
    selectedIds: ["inf", "con", "sum"]
  })
};

const server = await new Promise((resolve) => {
  const s = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (pages[url.pathname]) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(pages[url.pathname]);
      return;
    }
    res.writeHead(404);
    res.end("");
  });
  s.listen(0, "127.0.0.1", () => resolve(s));
});

const base = `http://127.0.0.1:${server.address().port}`;
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const shots = [
  ["fleet-modal-mixed-existing-classes.png", "/mixed", 900],
  ["fleet-modal-replacement-warning.png", "/replacement", 900],
  ["individual-ship-assign-to-fleet.png", "/individual", 900],
  ["assignment-confirmation-summary.png", "/confirm", 900],
  ["assignment-result-summary.png", "/result", 900],
  ["fleet-modal-no-changes.png", "/no-changes", 900],
  ["mobile-fleet-modal-390.png", "/mobile", 390]
];

for (const [file, route, width] of shots) {
  const page = await browser.newPage({ viewport: { width, height: 1400 } });
  await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
  await page.screenshot({ path: path.join(outDir, file), fullPage: true });
  await page.close();
}

for (const width of [900, 768, 390]) {
  for (const route of ["/mixed", "/replacement", "/mobile", "/no-changes"]) {
    const page = await browser.newPage({ viewport: { width, height: 1200 } });
    await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
    const overflow = await page.evaluate(() => ({
      pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      footerVisible: Boolean(document.querySelector(".ci-bulk-class-modal-footer"))
    }));
    if (overflow.pageOverflow || !overflow.footerVisible) {
      throw new Error(`Overflow at ${width}px on ${route}: ${JSON.stringify(overflow)}`);
    }
    await page.close();
  }
}

await browser.close();
server.close();
console.log(JSON.stringify({ outDir, screenshots: shots.map(([file]) => file) }, null, 2));
