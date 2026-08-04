/**
 * Smoke tests for Stateroom Types Admin + Netlify actions surface.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fnSrc = fs.readFileSync(path.join(root, "netlify/functions/stateroom-types.js"), "utf8");
const uiSrc = fs.readFileSync(path.join(root, "js/admin-stateroom-types.js"), "utf8");
const adminSrc = fs.readFileSync(path.join(root, "js/admin.js"), "utf8");
const adminHtml = fs.readFileSync(path.join(root, "admin.html"), "utf8");

assert(/action === "create"/.test(fnSrc), "API supports create");
assert(/action === "update"/.test(fnSrc), "API supports update");
assert(/action === "delete"/.test(fnSrc), "API supports delete");
assert(/action === "list"/.test(fnSrc), "API supports list");
assert(/action === "check_usage"/.test(fnSrc), "API supports check_usage");
assert(/action === "reorder"/.test(fnSrc), "API supports reorder");

assert(/StateroomTypesAdmin/.test(uiSrc), "UI exports StateroomTypesAdmin");
assert(/function renderPanel/.test(uiSrc), "UI has renderPanel");
assert(/saveStateroomType/.test(uiSrc), "UI save path");
assert(/deleteStateroomType/.test(uiSrc), "UI delete path");
assert(/onDragStart/.test(uiSrc), "UI drag start handler");
assert(!/stateroomTypeDisplayOrder/.test(uiSrc), "UI no longer exposes display order field");

assert(/admin-stateroom-types\.js/.test(adminHtml), "admin.html loads stateroom types module");
assert(/stateroom-types", label: "Stateroom Types"/.test(adminSrc), "Stateroom Types nav item present");
assert(/StateroomTypesAdmin\?\.renderPanel/.test(adminSrc), "Admin tab renders stateroom types panel");
assert(/resolved === "stateroom-types"/.test(adminSrc), "setTab loads stateroom types");

console.log("test-admin-stateroom-types: ok");
