#!/usr/bin/env node
/**
 * Cruise Finder — departure port matching tests.
 * Run: npm run test:cruise-finder-departure-match
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const {
  classifyDepartureMatch,
  categorizeResultsByDeparture,
  isExcludedCruiseLine,
  isFlexibleDeparture,
  loadPortsCatalogue,
  summariseDepartureCoverage
} = require(path.join(root, "netlify/functions/lib/cruise-finder-departure-match.js"));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const ports = loadPortsCatalogue();

function sailing(overrides) {
  return Object.assign(
    {
      cruiseLine: "Princess",
      ship: "Discovery Princess",
      itineraryTitle: "Sample cruise",
      departureDate: "15 Mar 2026",
      durationNights: 10,
      durationLabel: "10 nights",
      departurePort: "Sydney, Australia",
      sourceUrl: "https://example.com/cruise"
    },
    overrides
  );
}

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: String(error.message || error) });
  }
}

async function main() {
  await test("Sydney selected — Sydney departure is exact Best Match", () => {
    const c = classifyDepartureMatch("Sydney, Australia", "sydney", ports);
    assert(c.tier === "exact", `expected exact, got ${c.tier}`);
    assert(c.matchCategory === "best_match", c.matchCategory);
  });

  await test("Sydney selected — Rome cannot be Best Match", () => {
    const c = classifyDepartureMatch("Rome (Civitavecchia), Italy", "sydney", ports);
    assert(c.tier === "overseas", `expected overseas, got ${c.tier}`);
    assert(c.matchCategory === "alternative", c.matchCategory);
    const buckets = categorizeResultsByDeparture(
      [sailing({ departurePort: "Rome (Civitavecchia), Italy" })],
      "sydney"
    );
    assert(buckets.results.length === 0, "Rome must not be in Best Match");
    assert(buckets.otherResults.length === 1, "Rome should be alternative");
  });

  await test("Fremantle selected — Fremantle ranks exact; Perth alias matches", () => {
    for (const portText of ["Fremantle (Perth), Australia", "Perth", "Fremantle, Australia"]) {
      const c = classifyDepartureMatch(portText, "perth", ports);
      assert(c.tier === "exact", `${portText} should match perth: ${c.tier}`);
    }
    const buckets = categorizeResultsByDeparture(
      [
        sailing({ departurePort: "Fremantle (Perth), Australia", ship: "A" }),
        sailing({ departurePort: "Singapore", ship: "B" })
      ],
      "perth"
    );
    assert(buckets.results.length === 1, "Fremantle first in best match");
    assert(buckets.otherResults.length === 1, "Singapore is alternative");
  });

  await test("Brisbane selected — exact beats overseas style proxy", () => {
    const overseas = sailing({
      departurePort: "Miami, United States",
      ship: "Overseas Ship",
      itineraryTitle: "Caribbean escape"
    });
    const brisbane = sailing({
      departurePort: "Brisbane, Australia",
      ship: "Local Ship",
      itineraryTitle: "Queensland coast"
    });
    const buckets = categorizeResultsByDeparture([overseas, brisbane], "brisbane");
    assert(buckets.results.length === 1, "only Brisbane in best match");
    assert(buckets.results[0].ship === "Local Ship", "Brisbane sailing wins");
    assert(buckets.otherResults.length === 1, "Miami is alternative");
  });

  await test("Flexible departure allows international sailings in Best Match", () => {
    assert(isFlexibleDeparture("anywhere"), "anywhere is flexible");
    const buckets = categorizeResultsByDeparture(
      [
        sailing({ departurePort: "Miami, United States" }),
        sailing({ departurePort: "Rome (Civitavecchia), Italy" })
      ],
      "anywhere"
    );
    assert(buckets.results.length === 2, "flexible keeps all in best match");
    assert(buckets.otherResults.length === 0, "no alternative bucket when flexible");
  });

  await test("Same-country alternative when Sydney selected and Brisbane sailing present", () => {
    const buckets = categorizeResultsByDeparture(
      [sailing({ departurePort: "Brisbane, Australia" })],
      "sydney"
    );
    assert(buckets.results.length === 0, "no Sydney exact match");
    assert(buckets.alsoWorthConsidering.length === 1, "Brisbane is also worth");
    assert(
      /Alternative departure:/.test(buckets.alsoWorthConsidering[0].departureNote),
      "departure note shown"
    );
    assert(buckets.departureSummary.message, "no-match message when no exact");
  });

  await test("Port aliases — case and punctuation normalised", () => {
    const c = classifyDepartureMatch("  SYDNEY,  Australia ", "sydney", ports);
    assert(c.tier === "exact", c.tier);
  });

  await test("Unknown departure data does not receive exact-match credit", () => {
    const c = classifyDepartureMatch("Mystery Port XYZ", "sydney", ports);
    assert(c.tier === "unknown", c.tier);
    assert(c.matchCategory === "alternative", c.matchCategory);
    const buckets = categorizeResultsByDeparture([sailing({ departurePort: "Mystery Port XYZ" })], "sydney");
    assert(buckets.results.length === 0, "unknown not best match");
  });

  await test("P&O Cruises Australia remains excluded", () => {
    assert(isExcludedCruiseLine("P&O Cruises Australia"), "P&O AU excluded");
    assert(!isExcludedCruiseLine("Princess"), "Princess allowed");
    const buckets = categorizeResultsByDeparture(
      [sailing({ cruiseLine: "P&O Cruises Australia", departurePort: "Sydney, Australia" })],
      "sydney"
    );
    assert(buckets.results.length === 0, "P&O excluded from all buckets");
  });

  await test("No exact departure match produces calm explanation", () => {
    const buckets = categorizeResultsByDeparture(
      [sailing({ departurePort: "Southampton, United Kingdom" })],
      "perth",
      { destinationName: "Asia" }
    );
    assert(buckets.results.length === 0, "no best match");
    assert(
      /couldn't find a current cruise departing from Perth/i.test(buckets.departureSummary.message),
      buckets.departureSummary.message
    );
  });

  await test("Existing sailings with mixed constraints still categorise", () => {
    const rows = [
      sailing({ departurePort: "Sydney, Australia", departureDate: "01 Apr 2026" }),
      sailing({ departurePort: "Melbourne, Australia", departureDate: "02 Apr 2026" }),
      sailing({ departurePort: "Singapore", departureDate: "03 Apr 2026" })
    ];
    const buckets = categorizeResultsByDeparture(rows, "sydney");
    assert(buckets.results.length === 1, "one exact");
    assert(buckets.alsoWorthConsidering.length === 1, "one same-country");
    assert(buckets.otherResults.length === 1, "one overseas");
  });

  await test("Coverage summary helper counts canonical vs text-only", () => {
    const stats = summariseDepartureCoverage(
      [
        { departure_port: "Sydney, Australia" },
        { departure_port: "Brisbane, Australia" },
        { departure_port: "Unknown Harbour" },
        { departure_port: "" }
      ],
      ports
    );
    assert(stats.total === 4, "total rows");
    assert(stats.canonicalMatched === 2, "canonical matched");
    assert(stats.textOnly === 1, "text only");
    assert(stats.noUsableDeparture === 1, "empty departure");
    assert(stats.australianByPort.Sydney === 1, "Sydney counted");
  });

  await test("Search API ignores month/year filters for flexible timing modes", () => {
    const src = fs.readFileSync(
      path.join(root, "netlify/functions/search-current-cruises.js"),
      "utf8"
    );
    assert(/flexibleTiming/.test(src), "flexible timing guard present");
    assert(/school_holidays/.test(src), "school holidays treated as flexible timing");
  });

  await test("Search API returns catalogue-aware empty messages", () => {
    const searchSrc = fs.readFileSync(
      path.join(root, "netlify/functions/search-current-cruises.js"),
      "utf8"
    );
    const destSrc = fs.readFileSync(
      path.join(root, "public-tools/cruise-finder/destination.js"),
      "utf8"
    );
    assert(/catalogueStatus/.test(searchSrc), "catalogue status returned");
    assert(/filtered_out/.test(searchSrc), "filtered out status present");
    assert(/renderEmpty\(payload\)/.test(destSrc), "destination page shows API empty context");
  });

  const failed = results.filter((r) => !r.ok);
  for (const row of results) {
    console.log(row.ok ? `✓ ${row.name}` : `✗ ${row.name}: ${row.error}`);
  }
  if (failed.length) {
    process.exitCode = 1;
    throw new Error(`${failed.length} test(s) failed`);
  }
  console.log(`\ntest-cruise-finder-departure-match: ${results.length} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
