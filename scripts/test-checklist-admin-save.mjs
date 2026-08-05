/**
 * Admin checklist item save — scoped form IDs and save feedback.
 *
 * Run: node scripts/test-checklist-admin-save.mjs
 *  or: npm run test:checklist-admin-save
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const adminJs = fs.readFileSync(path.join(root, "js/admin.js"), "utf8");
const adminCss = fs.readFileSync(path.join(root, "css/admin.css"), "utf8");

// Duplicate global IDs removed — each form gets a scoped key.
assert.ok(adminJs.includes("function checklistItemFieldId"), "scoped field ids helper");
assert.ok(adminJs.includes("function readChecklistItemFormValues"), "scoped form reader");
assert.ok(adminJs.includes('renderChecklistItemForm(null, "add")'), "add form uses add key");
assert.match(
  adminJs,
  /renderChecklistItemForm\(item, `edit-\$\{item\.id\}`\)/,
  "edit form uses per-item key"
);
assert.match(adminJs, /saveChecklistItem\('\$\{formKey\}'\)/, "save button passes form key");
assert.match(adminJs, /async function saveChecklistItem\(formKey = "add"\)/, "save reads scoped form");
assert.ok(
  !/id="checklistItemId"/.test(adminJs) || adminJs.includes('field("checklistItemId")'),
  "no bare duplicate checklistItemId"
);
assert.ok(!/id="item-message"/.test(adminJs), "no bare duplicate item-message id");
assert.ok(
  adminJs.includes("Finish editing the checklist item below"),
  "add form hidden while editing"
);
assert.ok(adminJs.includes('AdminToast.show("Checklist item saved."'), "success toast on save");
assert.match(
  adminJs,
  /withAdminBusy\([\s\S]*?checklist-item-save[\s\S]*?Saving checklist item/,
  "saving overlay wired"
);
assert.ok(adminCss.includes(".checklist-admin-item.is-just-saved"), "saved pulse on checklist card");

console.log("test-checklist-admin-save: all assertions passed");
