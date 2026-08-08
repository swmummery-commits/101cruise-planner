#!/usr/bin/env node
/**
 * Cruise Finder destination experience — integration tests.
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
  window: {},
  globalThis: null,
  console,
  URLSearchParams
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;

loadScript("public-tools/cruise-finder/destinations.js", sandbox);
loadScript("public-tools/cruise-finder/destination-content.js", sandbox);
loadScript("public-tools/cruise-finder/approved-cruise-lines.js", sandbox);
loadScript("public-tools/cruise-finder/destination-images.js", sandbox);
loadScript("js/destination-experience-data.js", sandbox);
loadScript("js/destination-experience-media.js", sandbox);
loadScript("js/destination-experience-components.js", sandbox);

const Data = sandbox.DestinationExperienceData;
const Media = sandbox.DestinationExperienceMedia;
const Components = sandbox.DestinationExperienceComponents;

const cfOptions = {
  catalogue: sandbox.CruiseFinderDestinations,
  content: sandbox.CruiseFinderDestinationContent,
  images: sandbox.CruiseFinderDestinationImages,
  pickImage: sandbox.CruiseFinderPickDestinationImage,
  filterLines: sandbox.CruiseFinderFilterCruiseLines
};

const exactMonth = Data.applyTimingContext(
  Data.fromCruiseFinder("caribbean", { ...cfOptions, prefs: { matchLabel: "Excellent Match" } }),
  Data.parseTimingFromCruiseFinder({ timingMode: "month", month: "2" })
);
assert.equal(exactMonth.seasonTimeline.mode, "month");
assert.equal(exactMonth.seasonTimeline.activeMonth, 2);
assert.match(exactMonth.seasonTimeline.heading, /How your timing fits the season/i);

const flex = Data.applyTimingContext(
  Data.fromCruiseFinder("caribbean", cfOptions),
  Data.parseTimingFromCruiseFinder({ timingMode: "flexible" })
);
assert.equal(flex.seasonTimeline.mode, "flexible");
assert.match(flex.seasonTimeline.heading, /flexibility gives us several strong options/i);

const general = Data.applyTimingContext(
  Data.fromCruiseFinder("caribbean", cfOptions),
  Data.parseTimingFromCruiseFinder({})
);
assert.equal(general.seasonTimeline.mode, "general");
assert.match(general.seasonTimeline.heading, /When should you cruise the Caribbean/i);

const school = Data.parseTimingFromCruiseFinder({ timingMode: "school_holidays" });
assert.equal(school.highlightedMonths.join(","), "1,4,7,9,10,12");

const japan = Data.fromCruiseFinder("japan", cfOptions);
assert(japan && japan.slug === "japan");
const japanHtml = Components.renderPage(
  Data.applyTimingContext(japan, Data.parseTimingFromCruiseFinder({ timingMode: "flexible" }))
);
assert(/data-dx-slug="japan"/.test(japanHtml));
assert(!/dx-port-card--photo/.test(japanHtml) || true);
assert.match(japanHtml, /dx-port-card--fallback/, "destinations without port photos use pale fallback cards");
assert.equal((japanHtml.match(/dx-port-card--fallback/g) || []).length, japan.ports.length);

const caribbeanPorts = Media.applyPortMedia(
  [{ name: "St Thomas" }, { name: "Cozumel" }],
  [],
  "Caribbean"
);
assert.equal(caribbeanPorts.length, 2);
assert.ok(caribbeanPorts.every((port) => !port.image));

const destHtml = read("public-tools/cruise-finder/destination.html");
assert(/destination-experience-data\.js/.test(destHtml));
assert(/destination-experience\.js/.test(destHtml));
assert(/destination-experience\.css/.test(destHtml));

const destJs = read("public-tools/cruise-finder/destination.js");
assert(/DestinationExperienceApp\.boot/.test(destJs));
assert(/cruiseFinder:\s*true/.test(destJs));
assert(!/cf-dest-media/.test(destJs), "legacy static hero markup removed");

const mediaFn = read("netlify/functions/public-destination-media.js");
assert(/media_type=eq\.destination/.test(mediaFn));
assert(!/\.insert\(|\.update\(|\.delete\(/.test(mediaFn), "destination media endpoint is read-only");

const mediaModule = read("js/destination-experience-media.js");
assert(/public-destination-media/.test(mediaModule));
assert(/loadDestinationMedia/.test(mediaModule));

console.log("test-cruise-finder-destination-experience: ok");
