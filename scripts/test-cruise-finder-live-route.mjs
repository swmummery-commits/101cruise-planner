#!/usr/bin/env node
/**
 * Regression: Cruise Finder result action must open the shared Destination Experience.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function loadScript(rel, sandbox) {
  vm.runInNewContext(read(rel), sandbox, { filename: rel });
}

const sandbox = {
  window: { CruiseFinderAssetVersion: "test-version" },
  globalThis: null,
  console,
  URLSearchParams,
  document: {
    readyState: "complete",
    querySelectorAll() {
      return [];
    },
    getElementById() {
      return null;
    },
    head: { appendChild() {} },
    addEventListener() {}
  }
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;

loadScript("public-tools/cruise-finder/cf-asset-version.js", sandbox);
loadScript("public-tools/cruise-finder/destinations.js", sandbox);
loadScript("public-tools/cruise-finder/finder.js", sandbox);

const routing = sandbox.CruiseFinderDestinationRouting;
assert(routing, "CruiseFinderDestinationRouting export missing");

const caribbean = routing.destinationPageUrl("caribbean", "excellent");
assert.match(caribbean, /\/cruise-destination\?/);
assert.match(caribbean, /destination=caribbean/);
assert.doesNotMatch(caribbean, /\/destination\/caribbean/);

const japan = routing.destinationPageUrl("japan", "worth");
assert.match(japan, /destination=japan/);
assert.doesNotMatch(japan, /\/destination\/japan/);

const alaska = routing.destinationPageUrl("alaska", "top");
assert.match(alaska, /\/destination\/alaska/);
assert.doesNotMatch(alaska, /cruise-destination/);

const finderJs = read("public-tools/cruise-finder/finder.js");
assert.match(finderJs, /window\.location\.assign\(url\)/);
assert.match(finderJs, /cruiseFinderDestinationUrl/);

const destHtml = read("public-tools/cruise-finder/destination.html");
assert.match(destHtml, /data-destination-experience-version=/);
assert.match(destHtml, /destination-experience\.js/);
assert.match(destHtml, /function versioned\(/);

const embed = read("public-tools/cruise-finder/squarespace-embed.html");
assert.match(embed, /cf-asset-version\.js\?v=/);
assert.match(embed, /finder\.js\?v=/);

const toml = read("netlify.toml");
assert.match(toml, /\/destination\/caribbean/);
assert.match(toml, /\/cruise-destination\?destination=caribbean/);

console.log("test-cruise-finder-live-route: ok");
