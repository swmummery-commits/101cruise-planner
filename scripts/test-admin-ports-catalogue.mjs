/**
 * Smoke tests for Ports catalogue Admin + Netlify actions surface.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fnSrc = fs.readFileSync(path.join(root, "netlify/functions/ports-catalogue.js"), "utf8");
const uiSrc = fs.readFileSync(path.join(root, "js/admin-ports-catalogue.js"), "utf8");
const adminSrc = fs.readFileSync(path.join(root, "js/admin.js"), "utf8");
const adminHtml = fs.readFileSync(path.join(root, "admin.html"), "utf8");

assert(/action === "create"/.test(fnSrc), "API supports create");
assert(/action === "update"/.test(fnSrc), "API supports update");
assert(/action === "delete"/.test(fnSrc), "API supports delete");
assert(/action === "list"/.test(fnSrc), "API supports list");
assert(/action === "create_provisional"/.test(fnSrc), "API keeps create_provisional");
assert(/function buildMatchKey/.test(fnSrc), "API builds match_key");

assert(/PortsCatalogueAdmin/.test(uiSrc), "UI exports PortsCatalogueAdmin");
assert(/function renderPanel/.test(uiSrc), "UI has renderPanel");
assert(/action, \{ port: payload \}/.test(uiSrc) || /api\("create"/.test(uiSrc), "UI create path");
assert(/api\("delete"/.test(uiSrc), "UI delete path");
assert(/api\("update"/.test(uiSrc), "UI update path");

assert(/admin-ports-catalogue\.js/.test(adminHtml), "admin.html loads ports module");
assert(!/ports-catalogue", label: "Ports", placeholder: true/.test(adminSrc), "Ports nav not placeholder");
assert(/PortsCatalogueAdmin\?\.renderPanel/.test(adminSrc), "Admin tab renders ports panel");
assert(/port-image-finder/.test(uiSrc), "Ports admin uses port image finder");
assert(/Find missing port images/.test(uiSrc), "Ports admin has bulk enrichment action");
assert(/resolved === "ports-catalogue"/.test(adminSrc), "setTab loads ports catalogue");
assert(/isMissingImageSchemaError/.test(fnSrc), "ports catalogue API handles missing image migration");
assert(/image_schema_warning/.test(fnSrc), "ports catalogue surfaces schema warning to admin");

console.log("test-admin-ports-catalogue: ok");
