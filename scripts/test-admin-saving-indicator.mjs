#!/usr/bin/env node
/**
 * Audit: Admin save/delete flows must use the shared saving overlay.
 * Run: npm run test:admin-saving-indicator
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

const brandLoading = read("js/brand-loading.js");
const adminLoading = read("js/admin-loading.js");
const adminJs = read("js/admin.js");

assert.match(brandLoading, /SAVING_MESSAGE\s*=\s*"Hang tight! Saving your info\."/);
assert.match(brandLoading, /SAVING_MESSAGE:\s*SAVING_MESSAGE/);
assert.match(adminLoading, /function withSaving\(/);
assert.match(adminLoading, /withSaving:\s*withSaving/);
assert.match(adminJs, /options\.saving/);
assert.match(adminJs, /withSavingOverlay|AdminLoading\.withSaving|withAdminBusy\([^)]*\{[^}]*saving:\s*true/s);

const modules = [
  {
    file: "js/admin-cruise-line-features.js",
    saves: ["saveFeature", "deleteFeature", "saveOrderFromDom"],
    marker: /withSavingOverlay|AdminLoading\.withSaving/
  },
  {
    file: "js/admin-stateroom-types.js",
    saves: ["saveStateroomType", "deleteStateroomType", "saveOrderFromDom"],
    marker: /withSavingOverlay|AdminLoading\.withSaving/
  },
  {
    file: "js/admin-ports-catalogue.js",
    saves: ["savePort", "deleteSelectedPort"],
    marker: /withSavingOverlay|AdminLoading\.withSaving/
  },
  {
    file: "js/admin-media-library.js",
    saves: ["saveMediaEditor", "deleteMediaEditor"],
    marker: /withSavingOverlay|AdminLoading\.withSaving/
  },
  {
    file: "js/admin-ship-class-facilities-template.js",
    saves: ["saveTemplate", "applyTemplate"],
    marker: /withSavingOverlay|AdminLoading\.withSaving/
  },
  {
    file: "js/admin-newsletter-composer.js",
    saves: ["saveNewsletter"],
    marker: /AdminLoading\.withSaving/
  }
];

for (const mod of modules) {
  const src = read(mod.file);
  assert.ok(mod.marker.test(src), `${mod.file} must use AdminLoading.withSaving or withSavingOverlay`);
  for (const fn of mod.saves) {
    const fnMatch = src.match(new RegExp(`async function ${fn}[\\s\\S]*?(?=\\n  async function|\\n  function|$)`));
    assert.ok(fnMatch, `${mod.file} should define ${fn}`);
    assert.ok(
      mod.marker.test(fnMatch[0]),
      `${mod.file} → ${fn} must wrap work in the saving overlay`
    );
  }
}

assert.match(read("js/admin.js"), /persistCiLine[\s\S]*?withAdminBusy\(doPersist,\s*\{[\s\S]*?saving:\s*true/);
assert.match(read("js/admin.js"), /persistCiShip[\s\S]*?withAdminBusy\(doPersist,\s*\{[\s\S]*?saving:\s*true/);
assert.match(read(".cursor/rules/admin-saving-indicator.mdc"), /AdminLoading\.withSaving/);

console.log("test-admin-saving-indicator: all assertions passed");
