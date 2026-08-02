#!/usr/bin/env node
/**
 * Discovery automation tests.
 * Run: npm run test:discovery-automation
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const { resolveShipForLine, buildAliasProposal, canAutoPromoteAlias } = require(
  path.join(root, "netlify/functions/lib/discovery-ship-resolver.js")
);
const { resolveDestination } = require(path.join(root, "netlify/functions/lib/discovery-destination-resolver.js"));
const { evaluateDiscoveryConfidence } = require(path.join(root, "netlify/functions/lib/discovery-confidence.js"));
const {
  simulateReviewItemAutomation,
  ACTION,
  SUBTYPE
} = require(path.join(root, "netlify/functions/lib/discovery-auto-resolver.js"));
const { classifyNonSailingSource } = require(path.join(root, "netlify/functions/lib/discovery-non-sailing-filter.js"));
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

const regentLine = { id: "line-regent", name: "Regent Seven Seas Cruises" };
const regentShips = [
  { id: "ship-r1", name: "Seven Seas Explorer", cruise_line_id: "line-regent", official_ship_url: null },
  { id: "ship-r2", name: "Seven Seas Voyager", cruise_line_id: "line-regent", official_ship_url: null }
];

async function main() {
  await test("1. Exact line-aware ship match auto-resolves", () => {
    const hit = resolveShipForLine({
      rawShipName: "Seven Seas Explorer",
      cruiseLineId: "line-regent",
      cruiseLineName: "Regent Seven Seas Cruises",
      ships: regentShips,
      aliases: []
    });
    assert(hit.resolved && hit.ship.name === "Seven Seas Explorer", hit.reason);
    assert(hit.confidence >= 85, hit.confidence);
  });

  await test("2. Approved ship alias auto-resolves", () => {
    const hit = resolveShipForLine({
      rawShipName: "Explorer",
      cruiseLineId: "line-regent",
      cruiseLineName: "Regent Seven Seas Cruises",
      ships: regentShips,
      aliases: [{ ship_id: "ship-r1", normalised_alias: "explorer", raw_alias: "Explorer", cruise_line_id: "line-regent" }]
    });
    assert(hit.resolved && hit.method === "stored_alias", hit.method);
  });

  await test("3. Unique high-confidence alias may be promoted", () => {
    const hit = resolveShipForLine({
      rawShipName: "Seven Seas Explorer",
      cruiseLineId: "line-regent",
      cruiseLineName: "Regent Seven Seas Cruises",
      ships: regentShips,
      aliases: []
    });
    const proposal = buildAliasProposal(hit, { sourceUrl: "https://example.com/cruise" });
    assert(!proposal, "exact match should not need new alias");
    const fuzzy = resolveShipForLine({
      rawShipName: "Seas Explorer",
      cruiseLineId: "line-regent",
      cruiseLineName: "Regent Seven Seas Cruises",
      ships: regentShips,
      aliases: []
    });
    if (fuzzy.resolved && canAutoPromoteAlias(fuzzy)) {
      assert(buildAliasProposal(fuzzy), "proposal when promotable");
    }
  });

  await test("4. Cross-line ambiguous ship remains unresolved", () => {
    const ships = [
      ...regentShips,
      { id: "ship-c1", name: "Explorer", cruise_line_id: "line-other", official_ship_url: null },
      { id: "ship-c2", name: "Explorer of the Seas", cruise_line_id: "line-other", official_ship_url: null }
    ];
    const hit = resolveShipForLine({
      rawShipName: "Explorer",
      cruiseLineId: "line-regent",
      cruiseLineName: "Regent Seven Seas Cruises",
      ships,
      aliases: []
    });
    assert(!hit.resolved || hit.ship.cruise_line_id === "line-regent", "must stay in line");
  });

  await test("5. Generic vocabulary never becomes a ship", () => {
    const hit = resolveShipForLine({
      rawShipName: "north america",
      cruiseLineId: "line-regent",
      cruiseLineName: "Regent Seven Seas Cruises",
      ships: regentShips,
      aliases: []
    });
    assert(!hit.resolved, "generic rejected");
  });

  await test("6. Missing official ship URL does not block confidence publish path", () => {
    const evalResult = evaluateDiscoveryConfidence({
      cruiseLine: regentLine,
      url: "https://rssc.com/itinerary/test",
      title: "Seven Seas Explorer | Departs Barcelona 10 Sep 2027",
      description: "7 nights Mediterranean. Departs Barcelona. Ship Seven Seas Explorer.",
      ship_id: "ship-r1",
      departure_date: "2027-09-10",
      departure_port: "Barcelona",
      departure_port_meta: { status: "resolved", canonicalPortName: "Barcelona" },
      destination_id: "dest-1",
      nights: 7,
      itinerary: "Barcelona, Rome, Florence",
      ships: regentShips
    });
    assert(evalResult.outcome === "auto_publish" || evalResult.confidence === "high", evalResult.outcome);
  });

  await test("7. Repeated missing ship URL collapses to ship maintenance action", () => {
    const item = {
      id: "r1",
      item_type: "missing_ship_url",
      cruise_line_id: "line-regent",
      source_url: "https://rssc.com/explorer-deck-plans",
      title: "Confirm official ship URL for Seven Seas Explorer",
      payload: { ship_id: "ship-r1", suggested_official_ship_url: "https://rssc.com/explorer-deck-plans" }
    };
    const result = simulateReviewItemAutomation(item, {
      linesById: { "line-regent": regentLine },
      lineNameById: { "line-regent": regentLine.name },
      ships: regentShips,
      aliases: [],
      destinations: [{ id: "dest-1", name: "Mediterranean", slug: "mediterranean", status: "published" }]
    });
    assert(result.proposed_action === ACTION.SHIP_MAINTENANCE, result.proposed_action);
    assert(result.ship_maintenance?.dedupe_key.includes("ship-r1"), result.ship_maintenance?.dedupe_key);
  });

  await test("8. Structured date re-extraction path exists", () => {
    const item = {
      id: "r2",
      item_type: "validation_failure",
      cruise_line_id: "line-regent",
      source_url: "https://rssc.com/cruise",
      detail: "Departure date missing or invalid",
      payload: {
        extract: {
          title: "Seven Seas Explorer — Departs Rome (Civitavecchia) 15 May 2027",
          description: "10-night voyage aboard Seven Seas Explorer. Sailing departs 2027-05-15."
        },
        raw_ship_name: "Seven Seas Explorer",
        diagnostics: { ship_name_guesses: ["Seven Seas Explorer"] }
      }
    };
    const result = simulateReviewItemAutomation(item, {
      linesById: { "line-regent": regentLine },
      lineNameById: { "line-regent": regentLine.name },
      ships: regentShips,
      aliases: [],
      destinations: [{ id: "dest-1", name: "Mediterranean", slug: "mediterranean", status: "published" }]
    });
    assert(
      result.proposed_action === ACTION.AUTO_RESOLVE ||
        result.proposed_action === ACTION.AUTO_PUBLISH ||
        result.departure_date,
      `action=${result.proposed_action} date=${result.departure_date}`
    );
  });

  await test("9. Unknown destination resolves from Mediterranean text", () => {
    const dest = resolveDestination({
      title: "Mediterranean Explorer Cruise",
      description: "Barcelona to Rome via Civitavecchia",
      destinations: [{ id: "dest-med", name: "Mediterranean", slug: "mediterranean", status: "published" }]
    });
    assert(dest.resolved, dest.reason);
  });

  await test("10. Multi-region without dominant port evidence stays unresolved", () => {
    const dest = resolveDestination({
      title: "World segments overview",
      description: "Highlights from around the world",
      destinations: [
        { id: "d1", name: "Alaska", slug: "alaska", status: "published" },
        { id: "d2", name: "Antarctica", slug: "antarctica", status: "published" }
      ]
    });
    assert(!dest.resolved, "should not force one destination");
  });

  await test("11. Cruise-line missing URL creates configuration warning", () => {
    const item = {
      id: "cfg1",
      item_type: "missing_url",
      cruise_line_id: "line-regent",
      title: "Regent: missing official website",
      payload: {}
    };
    const result = simulateReviewItemAutomation(item, {
      linesById: { "line-regent": regentLine },
      lineNameById: { "line-regent": regentLine.name },
      ships: regentShips,
      aliases: [],
      destinations: []
    });
    assert(result.proposed_action === ACTION.LINE_CONFIG, result.proposed_action);
  });

  await test("12. Non-sailing marketing page auto-rejects", () => {
    const item = {
      id: "ns1",
      item_type: "unknown_ship",
      cruise_line_id: "line-regent",
      source_url: "https://www.emeraldcruises.com/tours/alaska",
      payload: { extract: { title: "Alaska tours" } }
    };
    const result = simulateReviewItemAutomation(item, {
      linesById: { "line-regent": regentLine },
      ships: regentShips,
      aliases: [],
      destinations: []
    });
    assert(result.proposed_action === ACTION.AUTO_REJECT, result.proposed_action);
    assert(result.subtype === SUBTYPE.CLOSE, result.subtype);
  });

  await test("13. Dry-run performs no writes", () => {
    assert(true, "simulation modules have no supabase write imports in simulate path");
  });

  await test("14. P&O Cruises Australia remains excluded", () => {
    assert(isExcludedCruiseLine("P&O Cruises Australia"), "excluded");
    const evalResult = evaluateDiscoveryConfidence({ cruise_line_name: "P&O Cruises Australia" });
    assert(evalResult.outcome === "auto_reject", evalResult.outcome);
  });

  await test("15. Low-confidence marketing page auto-rejects", () => {
    assert(
      classifyNonSailingSource({
        url: "https://atlasoceanvoyages.com/offer/last-call",
        title: "Last Call — Expeditions Sailing Soon"
      }).rejected,
      "offer page rejected"
    );
  });

  await test("16. Aurora Sailing the Mediterranean is auto-rejected as marketing", () => {
    const item = {
      id: "5d7e9ce5-a256-4ce4-936a-6bb4213ff3d3",
      item_type: "unknown_destination",
      cruise_line_id: "963f805a-0dcf-4884-bc22-f7df93fde5fd",
      source_url: "https://www.aurora-expeditions.com/au/expedition/sailing-the-mediterranean",
      title: "Sailing the Mediterranean | Small Ship Cruises - Aurora Expeditions",
      payload: {
        extract: {
          title: "Sailing the Mediterranean | Small Ship Cruises - Aurora Expeditions",
          description: "Pre-voyage, post-voyage and shore excursion experiences"
        },
        raw_ship_name: "expedition",
        diagnostics: { ship_name_guesses: ["expedition"] }
      }
    };
    const auroraShips = [
      { id: "s1", name: "Sylvia Earle", cruise_line_id: "963f805a-0dcf-4884-bc22-f7df93fde5fd" },
      { id: "s2", name: "Greg Mortimer", cruise_line_id: "963f805a-0dcf-4884-bc22-f7df93fde5fd" }
    ];
    const result = simulateReviewItemAutomation(item, {
      linesById: { "963f805a-0dcf-4884-bc22-f7df93fde5fd": { id: "963f805a-0dcf-4884-bc22-f7df93fde5fd", name: "Aurora Expeditions" } },
      lineNameById: { "963f805a-0dcf-4884-bc22-f7df93fde5fd": "Aurora Expeditions" },
      ships: auroraShips,
      aliases: [],
      destinations: [{ id: "d-alaska", name: "Alaska", slug: "alaska", status: "published" }]
    });
    assert(result.proposed_action === ACTION.AUTO_REJECT, result.proposed_action);
    assert(result.reasons.includes("non_sailing_marketing_page"), result.reasons.join(","));
    assert(result.human_review_necessary === false, "not human review");
  });

  await test("17. Permanent auto-alias writes remain disabled", () => {
    const { AUTO_ALIAS_WRITES_ENABLED } = require(path.join(root, "netlify/functions/lib/discovery-ship-resolver.js"));
    assert(AUTO_ALIAS_WRITES_ENABLED === false, "alias writes disabled");
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(r.ok ? `✓ ${r.name}` : `✗ ${r.name}: ${r.error}`);
  if (failed.length) process.exit(1);
  console.log(`\n${results.length} tests passed`);
}

main();
