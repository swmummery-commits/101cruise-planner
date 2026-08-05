/**
 * Cruise Lines admin: full-width list/detail workspace with tabs.
 *
 * Run: npm run test:cruise-line-admin-tabs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

const adminJs = read("js/admin.js");
const adminCss = read("css/admin.css");
const adminHtml = read("admin.html");

function assertIncludes(source, snippet, label) {
  assert.ok(source.includes(snippet), label || `expected to include: ${snippet}`);
}

function assertMatch(source, pattern, label) {
  assert.match(source, pattern, label || `expected to match ${pattern}`);
}

// List mode vs detail mode
assertIncludes(adminJs, "ci-line-list-mode", "list mode container");
assertIncludes(adminJs, "renderCiLineDetailWorkspace", "detail workspace renderer");
assertIncludes(adminJs, "ci-line-workspace--detail", "detail workspace class");
assertIncludes(adminJs, "returnToCiLinesList", "back to list helper");
assertIncludes(adminJs, "← Cruise Lines", "back control label");

// Selecting a line hides list (detail path does not render list mode)
assertMatch(
  adminJs,
  /function renderCiLinesSection\(\)[\s\S]*?if \(editingCiLineId\)[\s\S]*?return renderCiLineDetailWorkspace/,
  "selected line enters detail workspace"
);
assertMatch(
  adminJs,
  /function renderCiLinesSection\(\)[\s\S]*?ci-line-list-mode[\s\S]*?ciLineMasterList/,
  "list mode still renders searchable master list"
);
assert.ok(
  !/function renderCiLinesSection\(\)[\s\S]*?ci-master-detail[\s\S]*?renderCiLineForm/.test(adminJs),
  "cruise lines no longer use persistent two-column master-detail"
);

// Ships page still uses master-detail
assertMatch(
  adminJs,
  /function renderCiShipsSection\(\)[\s\S]*?ci-master-detail[\s\S]*?ciShipMasterList/,
  "ships administration retains master-detail layout"
);
assertIncludes(adminJs, "deleteCiShip", "ship delete handler");
assertIncludes(adminJs, "Delete ship", "ship delete button");
assertMatch(adminJs, /\.from\("ci_cruise_ships"\)\.delete\(\)/, "ship delete uses supabase delete");

// Tabs
assertIncludes(adminJs, 'id: "details"', "Details tab id");
assertIncludes(adminJs, 'id: "room-types"', "Room Types tab id");
assertIncludes(adminJs, 'id: "features"', "Features tab id");
assertIncludes(adminJs, 'id: "ship-classes"', "Ship Classes tab id");
assertIncludes(adminJs, 'data-ci-line-tab="${tab.id}"', "dynamic tab buttons");
for (const tab of ["details", "room-types", "features", "ship-classes"]) {
  assertIncludes(adminJs, `data-ci-line-tabpanel="${tab}"`, `tab panel ${tab}`);
  assertIncludes(adminJs, `ciLineTabPanel-${tab}`, `tab panel id ${tab}`);
}
assertIncludes(adminJs, 'role="tablist"', "tablist semantics");
assertIncludes(adminJs, 'role="tab"', "tab semantics");
assertIncludes(adminJs, 'role="tabpanel"', "tabpanel semantics");
assertIncludes(adminJs, "aria-selected", "aria-selected on tabs");
assertIncludes(adminJs, "normalizeCiLineTab", "invalid tab fallback helper");
assertMatch(adminJs, /function normalizeCiLineTab[\s\S]*?return "details"/, "invalid tabs fall back to details");

// Header + save
assertIncludes(adminJs, "ci-line-detail-header", "detail header");
assertIncludes(adminJs, "ci-line-detail-logo", "logo thumbnail in header");
assertIncludes(adminJs, 'id="ciLineSaveBtn"', "save button in header");
assertIncludes(adminJs, "Saving…", "saving state label");
assertIncludes(adminJs, "Save failed", "save failed state label");
assertIncludes(adminJs, "updateCiLineSaveButtonState", "save button state helper");

// Details tab content mapping
assertMatch(
  adminJs,
  /data-ci-line-tabpanel="details"[\s\S]*?renderCiLineDetailsFields/,
  "Details tab contains identity/details fields"
);
assertIncludes(adminJs, "renderCiLineStatsPanel", "statistics retained");
assertIncludes(adminJs, 'inputId: "ciLineLogo"', "logo controls retained");
assertIncludes(adminJs, "Cruise-line information", "identity section heading");
assertIncludes(adminJs, ">Status<", "status section");
assertIncludes(adminJs, 'id="ciLineDescription"', "description field");

// Room Types / Features / Ship Classes mapping
assertMatch(
  adminJs,
  /data-ci-line-tabpanel="room-types"[\s\S]*?renderCiLineStateroomTypesSection/,
  "Room Types tab contains stateroom controls"
);
assertMatch(
  adminJs,
  /data-ci-line-tabpanel="features"[\s\S]*?CruiseLineFeaturesAdmin/,
  "Features tab contains cruise-line features catalogue"
);
assertMatch(
  adminJs,
  /data-ci-line-tabpanel="ship-classes"[\s\S]*?renderCiLineShipClassesSection/,
  "Ship Classes tab contains class table"
);
assertIncludes(
  adminJs,
  "Select the room types available when entering newsletter prices for this cruise line",
  "room types intro text"
);

// Tab switching preserves form values (no re-render path)
assertMatch(
  adminJs,
  /function setCiLineTab\([\s\S]*?syncCiLineDetailDomTabs\([\s\S]*?syncCiLineAdminUrl\(/,
  "tab switch updates DOM/URL without full reload"
);
assertIncludes(adminJs, "captureCiLineFormDraftFromDom", "form draft capture");
assertIncludes(adminJs, "restoreCiLineFormDraftToDom", "form draft restore across re-renders");
assertIncludes(adminJs, "ciLineFormIsDirty", "unsaved-change detection");
assertIncludes(
  adminJs,
  "You have unsaved changes. Return to the Cruise Lines list without saving?",
  "back confirm dialog for unsaved changes"
);

// Save retains tab + baseline
assertIncludes(adminJs, "markCiLineFormBaseline", "saved baseline update");
assertMatch(
  adminJs,
  /async function persistCiLine[\s\S]*?renderCiAdmin\(\);[\s\S]*?markCiLineFormBaseline\(\);[\s\S]*?syncCiLineAdminUrl\(\)/,
  "successful save stays on current line/tab and updates baseline"
);
assertIncludes(adminJs, "if (ciSaving) return", "prevents repeated save submissions");

// URL navigation
assertIncludes(adminJs, 'searchParams.set("section", "cruise-lines")', "section query param");
assertIncludes(adminJs, 'searchParams.set("line", editingCiLineId)', "line query param");
assertIncludes(adminJs, 'searchParams.set("tab", normalizeCiLineTab(ciLineActiveTab))', "tab query param");
assertIncludes(adminJs, "applyCiLineAdminUrlState", "URL restore on init");
assertIncludes(adminJs, "Cruise line not found", "invalid line controlled error");

// Selecting another line resets tab/state
assertMatch(
  adminJs,
  /async function selectCiLine[\s\S]*?ciLineActiveTab =[\s\S]*?normalizeCiLineTab\(tab \|\| "details"\)/,
  "selecting a line resets tab to Details by default"
);
assertMatch(
  adminJs,
  /async function selectCiLine[\s\S]*?ciLineFormBaseline = null/,
  "selecting a line clears previous form baseline"
);

// Search/filter/scroll preservation
assertIncludes(adminJs, "ciLineListScrollY", "list scroll preservation");
assertIncludes(adminJs, "ciLineSearchQuery", "search state retained in memory");
assertIncludes(adminJs, "ciLineFilter", "filter state retained in memory");

// Existing behaviours still wired
assertIncludes(adminJs, "persistCiLineStateroomTypes", "room-type save path retained");
assertIncludes(adminJs, "CruiseLineFeaturesAdmin", "feature catalogue retained");
assertIncludes(adminJs, "openCiBulkShipClassModalFromLine", "manage ship classes retained");
assertIncludes(adminJs, "openCiClassFacilitiesTemplateModalFromBtn", "edit template retained");
assertIncludes(adminJs, 'kind: "logo"', "logo media field retained");

// CSS: full-width detail, tabs, responsive room types, no page overflow helpers
assertIncludes(adminCss, ".ci-line-workspace", "detail workspace styles");
assertIncludes(adminCss, ".ci-line-tabs", "tab bar styles");
assertIncludes(adminCss, "overflow-x: auto", "horizontal scroll for tabs/tables");
assertIncludes(adminCss, ".ci-line-details-grid", "details field grid");
assertIncludes(adminCss, "#8DD9BF", "brand accent retained");
assertMatch(
  adminCss,
  /\.ci-stateroom-type-grid\s*\{[\s\S]*?repeat\(4/,
  "room types four-column desktop grid"
);
assertMatch(
  adminCss,
  /@media \(max-width: 520px\)\s*\{\s*\.ci-stateroom-type-grid\s*\{[\s\S]*?grid-template-columns:\s*1fr/,
  "room types single column on mobile"
);

// Ships CSS master-detail still present for ships page
assertIncludes(adminCss, ".ci-master-detail", "shared ships master-detail styles remain");

// Script load order unchanged for feature modules
assertIncludes(adminHtml, "admin-cruise-line-features.js", "admin still loads cruise line features module");
assertIncludes(adminJs, "window.renderAdmin = renderAdmin", "renderAdmin exposed for admin modules");
assertIncludes(adminJs, "scheduleAdminViewportToTop", "admin scroll-to-top helper");
assertIncludes(adminHtml, "viewport-scroll.js", "admin loads viewport scroll helper");

console.log("test-cruise-line-admin-tabs: all assertions passed");
