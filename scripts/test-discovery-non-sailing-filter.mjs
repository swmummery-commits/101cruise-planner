#!/usr/bin/env node
/**
 * Non-sailing discovery filter tests.
 * Run: npm run test:discovery-non-sailing-filter
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const {
  classifyNonSailingSource,
  evaluateSailingEvidence,
  pathMatchesHardReject,
  pathMatchesRegionalHub,
  guessLooksNonSailing,
  slugTokenRejected,
  isTransientFetchFailure,
  parseNonSailingReviewReason,
  matchesKnownShip,
  normaliseKnownShipNames
} = require(path.join(root, "netlify/functions/lib/discovery-non-sailing-filter.js"));
const { scoreSailingUrl } = require(path.join(root, "netlify/functions/lib/cruise-discovery-url-score.js"));
const { buildCandidateFromSource } = require(path.join(root, "netlify/functions/lib/cruise-discovery.js"));
const { shouldSkipUrlBeforeFetch, canonicalDiscoveryUrl } = require(
  path.join(root, "netlify/functions/lib/discovery-source-memory.js")
);
const { isExcludedCruiseLine } = require(path.join(root, "netlify/functions/lib/cruise-finder-departure-match.js"));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
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

const cruiseLine = { id: "line-1", name: "Emerald Cruises", website_url: "https://example.com" };
const virginLine = { id: "line-2", name: "Virgin Voyages", website_url: "https://virginvoyages.com" };
const ships = [{ id: "ship-1", name: "Emerald Azzurra", official_ship_url: "https://example.com/ships/azzurra" }];
const virginShips = [{ id: "ship-2", name: "Scarlet Lady", official_ship_url: "https://virginvoyages.com/ships/scarlet-lady" }];
const destinations = [{ id: "dest-1", name: "Alaska", slug: "alaska" }];

async function main() {
  await test("1. Emerald tours page is rejected", () => {
    const verdict = classifyNonSailingSource({
      url: "https://www.emeraldcruises.com/tours/alaska",
      title: "Alaska tours"
    });
    assert(verdict.rejected, "tours rejected");
    assert(verdict.reason === "non_sailing_url_path", verdict.reason);
  });

  await test("2. Ritz-Carlton hotel page is rejected", () => {
    assert(
      classifyNonSailingSource({
        url: "https://www.ritzcarlton.com/en/hotels/turks-caicos",
        title: "The Ritz-Carlton, Turks & Caicos | Luxury Grace Bay Beach Hotel"
      }).rejected,
      "hotel rejected"
    );
  });

  await test("3. Atlas news article is rejected", () => {
    const verdict = classifyNonSailingSource({
      url: "https://www.atlasoceanvoyages.com/news/antarctica-2023",
      title: "Atlas Ocean Voyages Opens 2023-24 Antarctica Expedition Season for Sale"
    });
    assert(verdict.rejected, "news rejected");
  });

  await test("4. Virgin North America regional hub is rejected without sailing evidence", () => {
    const built = buildCandidateFromSource({
      title: "8-Night One-way Alaska Cruise to Vancouver, BC",
      description: "Explore Alaska",
      url: "https://www.virginvoyages.com/north-america/alaska-cruise",
      excerpt: "",
      cruiseLine: virginLine,
      ships: virginShips,
      destinations,
      preferredDestination: destinations[0]
    });
    assert(built?.skip === true, "regional hub without evidence should skip");
  });

  await test("5. Generic onboard-service page is rejected", () => {
    const verdict = classifyNonSailingSource({
      url: "https://www.amawaterways.com/onboard/luxury-service",
      title: "Luxury OnBoard Service | River Cruise"
    });
    assert(verdict.rejected, "onboard service rejected");
  });

  await test("6. Search-results page is rejected", () => {
    const scored = scoreSailingUrl({
      url: "https://www.cunard.com/search/results?q=alaska",
      title: "Search results"
    });
    assert(scored.decision === "skip", scored.decision);
  });

  await test("7. Generic destination page is rejected", () => {
    assert(
      pathMatchesHardReject("https://www.celebritycruises.com/destinations/alaska"),
      "destination hub hard rejected"
    );
  });

  await test("8. Real sailing under regional path allowed with strong evidence", () => {
    const evidence = evaluateSailingEvidence({
      url: "https://www.virginvoyages.com/north-america/cruises/alaska-seattle-2027-05-20",
      title: "8-Night Alaska | Scarlet Lady | Departs Seattle 20 May 2027",
      description:
        "Ship: Scarlet Lady. Departure: Seattle, Washington. 8 nights. Voyage ID: VV-ALASKA-20270520. Ports: Seattle, Juneau, Ketchikan.",
      ship_name_guess: "Scarlet Lady",
      nights: 8,
      departure_date: "2027-05-20",
      departure_port: "Seattle",
      itinerary: "Seattle, Juneau, Ketchikan",
      knownShipNamesList: ["Scarlet Lady"]
    });
    assert(evidence.sufficient, `expected sufficient evidence: ${evidence.signals.join(",")}`);
    const verdict = classifyNonSailingSource({
      url: "https://www.virginvoyages.com/north-america/cruises/alaska-seattle-2027-05-20",
      title: "8-Night Alaska | Scarlet Lady | Departs Seattle 20 May 2027",
      description:
        "Ship: Scarlet Lady. Departure: Seattle. 8 nights. Voyage ID: VV-ALASKA-20270520.",
      ship_name_guess: "Scarlet Lady",
      nights: 8,
      departure_date: "2027-05-20",
      departure_port: "Seattle",
      ships: virginShips
    });
    assert(!verdict.rejected, "sailing with evidence should pass");
  });

  await test("9. Seven nights alone is insufficient to classify as cruise", () => {
    const evidence = evaluateSailingEvidence({
      title: "7 nights in Alaska",
      description: "7 nights"
    });
    assert(!evidence.sufficient, "nights only should fail");
    const built = buildCandidateFromSource({
      title: "7 nights in Alaska",
      description: "7 nights of adventure",
      url: "https://example.com/alaska/overview",
      excerpt: "7 nights",
      cruiseLine,
      ships,
      destinations,
      preferredDestination: destinations[0]
    });
    assert(!built || built.skip, "should skip weak page");
  });

  await test("10. Invalid path segments cannot become ship names", () => {
    for (const bad of ["tours", "hotels", "news", "north america", "promotions", "destinations", "cruises"]) {
      assert(guessLooksNonSailing(bad), `${bad} should be invalid ship guess`);
    }
  });

  await test("11. Canonical legitimate ship names remain valid", () => {
    const known = normaliseKnownShipNames(["Scarlet Lady", "Emerald Azzurra", "Oceania Regatta"]);
    assert(!guessLooksNonSailing("Scarlet Lady", known), "Scarlet Lady valid");
    assert(!slugTokenRejected("Emerald Azzurra", known), "Emerald Azzurra valid");
    assert(matchesKnownShip("Oceania Regatta", known), "Regatta matches catalogue");
  });

  await test("12. Rejected pages do not create review findings", () => {
    const built = buildCandidateFromSource({
      title: "Hotel overview",
      url: "https://www.ritzcarlton.com/en/hotels/test/overview",
      excerpt: "",
      cruiseLine,
      ships,
      destinations
    });
    assert(built?.skip === true, "skip flag");
    assert(!built?.candidate, "no candidate");
    assert(!built?.reasons, "no validation reasons");
  });

  await test("13. Rejected permanent sources are not retried automatically", () => {
    const url = "https://www.emeraldcruises.com/tours/alaska";
    const memory = new Map([
      [
        canonicalDiscoveryUrl(url),
        { reason: "non_sailing_url_path", version: "2026-08-02.1", first_seen: "2026-08-01", last_seen: "2026-08-02" }
      ]
    ]);
    assert(shouldSkipUrlBeforeFetch(url, { memoryMap: memory }), "memory skip");
    assert(parseNonSailingReviewReason("non_sailing:non_sailing_url_path:2026-08-02.1")?.classifier, "parses reason");
  });

  await test("14. Transient fetch failures remain retryable", () => {
    assert(isTransientFetchFailure("fetch_timeout"), "timeout retryable");
    assert(isTransientFetchFailure("fetch_failed"), "fetch_failed retryable");
    assert(!isTransientFetchFailure("non_sailing_url_path"), "non_sailing not transient");
    assert(
      !shouldSkipUrlBeforeFetch("https://example.com/cruise", {
        memoryMap: new Map(),
        transientReason: "fetch_timeout"
      }),
      "transient does not use memory skip"
    );
  });

  await test("15. P&O Cruises Australia remains excluded", () => {
    assert(isExcludedCruiseLine("P&O Cruises Australia"), "P&O AU excluded");
    assert(!isExcludedCruiseLine("Virgin Voyages"), "Virgin not excluded");
  });

  await test("Regional hub path detected separately from hard reject", () => {
    assert(pathMatchesRegionalHub("https://virginvoyages.com/north-america/alaska"), "regional hub");
    assert(!pathMatchesHardReject("https://virginvoyages.com/north-america/cruises/foo"), "cruises subpath not hard reject");
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(r.ok ? `✓ ${r.name}` : `✗ ${r.name}: ${r.error}`);
  }
  if (failed.length) {
    process.exit(1);
  }
  console.log(`\n${results.length} tests passed`);
}

main();
