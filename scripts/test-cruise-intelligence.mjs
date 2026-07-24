#!/usr/bin/env node
/**
 * Sprint 16B — Cruise Intelligence / Cruise DNA tests (deterministic, offline).
 * Run: node scripts/test-cruise-intelligence.mjs
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const {
  DNA_CATEGORY_IDS,
  scoreCruiseDna,
  buildCustomerProfile,
  matchCruisesToCustomer,
  similarityScore
} = require(path.join(root, "netlify/functions/lib/cruise-intelligence/index.js"));

const results = [];
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: String(e.message || e) });
  }
}

const ALASKA_SAILING = {
  provider: "track-cruises",
  providerCruiseId: "1632",
  sailingKey: "test|royal|2026-07-25|7|seattle",
  title: "Inside Passage (with Glacier Bay National Park)",
  cruiseLine: {
    id: "x",
    canonicalName: "Princess Cruises",
    providerName: "Princess Cruises",
    matchStatus: "MATCHED"
  },
  ship: {
    id: "y",
    canonicalName: "Royal Princess",
    providerName: "Royal Princess",
    matchStatus: "MATCHED"
  },
  departureDate: "2026-07-25",
  returnDate: "2026-08-01",
  nights: 7,
  destinations: ["Pacific", "Alaska"],
  itinerary: [
    { dayNumber: 1, date: "2026-07-25", type: "embarkation", providerPortName: "Seattle, Washington", canonicalPortName: "Seattle", portId: "1", matchStatus: "MATCHED" },
    { dayNumber: 2, date: "2026-07-26", type: "port", providerPortName: "Juneau, Alaska", canonicalPortName: "Juneau", portId: "2", matchStatus: "MATCHED" },
    { dayNumber: 3, date: "2026-07-27", type: "port", providerPortName: "Skagway, Alaska", canonicalPortName: "Skagway", portId: "3", matchStatus: "MATCHED" },
    { dayNumber: 4, date: "2026-07-28", type: "scenic_cruising", providerPortName: "Glacier Bay National Park (scenic Cruising), Alaska", canonicalPortName: null, portId: null, matchStatus: "NOT_FOUND" },
    { dayNumber: 5, date: "2026-07-29", type: "port", providerPortName: "Ketchikan, Alaska", canonicalPortName: "Ketchikan", portId: "4", matchStatus: "MATCHED" },
    { dayNumber: 6, date: "2026-07-30", type: "port", providerPortName: "Victoria, Canada", canonicalPortName: "Victoria BC", portId: "5", matchStatus: "MATCHED" },
    { dayNumber: 7, date: "2026-07-31", type: "sea", providerPortName: "At Sea", canonicalPortName: null, portId: null, matchStatus: "NOT_APPLICABLE" },
    { dayNumber: 8, date: "2026-08-01", type: "disembarkation", providerPortName: "Seattle, Washington", canonicalPortName: "Seattle", portId: "1", matchStatus: "MATCHED" }
  ]
};

const MED_SAILING = {
  provider: "track-cruises",
  providerCruiseId: "U629",
  sailingKey: "test|sun|2026-07-25|7|rome",
  title: "Mediterranean with Italy & Turkey",
  cruiseLine: {
    canonicalName: "Princess Cruises",
    providerName: "Princess Cruises",
    matchStatus: "MATCHED"
  },
  ship: { canonicalName: "Sun Princess", providerName: "Sun Princess", matchStatus: "MATCHED" },
  nights: 7,
  destinations: ["Mediterranean"],
  itinerary: [
    { dayNumber: 1, type: "embarkation", providerPortName: "Rome (Civitavecchia), Italy", canonicalPortName: "Civitavecchia", matchStatus: "MATCHED" },
    { dayNumber: 2, type: "sea", providerPortName: "At Sea", matchStatus: "NOT_APPLICABLE" },
    { dayNumber: 3, type: "port", providerPortName: "Mykonos, Greece", canonicalPortName: "Mykonos", matchStatus: "MATCHED" },
    { dayNumber: 4, type: "port", providerPortName: "Kusadasi (Ephesus), Turkey", canonicalPortName: "Kusadasi", matchStatus: "MATCHED" },
    { dayNumber: 5, type: "port", providerPortName: "Crete, Greece", canonicalPortName: "Heraklion", matchStatus: "MATCHED" },
    { dayNumber: 6, type: "sea", providerPortName: "At Sea", matchStatus: "NOT_APPLICABLE" },
    { dayNumber: 7, type: "port", providerPortName: "Athens (Piraeus), Greece", canonicalPortName: "Piraeus", matchStatus: "MATCHED" },
    { dayNumber: 8, type: "disembarkation", providerPortName: "Athens (Piraeus), Greece", canonicalPortName: "Piraeus", matchStatus: "MATCHED" }
  ]
};

async function main() {
  await test("DNA category set is complete (15)", () => {
    assert(DNA_CATEGORY_IDS.length === 15, `count ${DNA_CATEGORY_IDS.length}`);
  });

  await test("same cruise always produces same DNA", () => {
    const a = scoreCruiseDna(ALASKA_SAILING);
    const b = scoreCruiseDna(ALASKA_SAILING);
    assert(JSON.stringify(a.scores) === JSON.stringify(b.scores), "scores equal");
    assert(JSON.stringify(a.explanations) === JSON.stringify(b.explanations), "explanations equal");
    assert(a.version === b.version, "version");
  });

  await test("Alaska sailing elevates wildlife + scenic", () => {
    const dna = scoreCruiseDna(ALASKA_SAILING);
    assert(dna.scores.wildlife >= 40, `wildlife ${dna.scores.wildlife}`);
    assert(dna.scores.scenic_cruising >= 40, `scenic ${dna.scores.scenic_cruising}`);
    assert(dna.explanations.wildlife.length > 0, "wildlife reasons");
    assert(dna.explanations.scenic_cruising.some((r) => /scenic|glacier|alaska/i.test(r)), "scenic reason");
  });

  await test("Mediterranean sailing elevates culture + food", () => {
    const dna = scoreCruiseDna(MED_SAILING);
    assert(dna.scores.culture_history >= 30, `culture ${dna.scores.culture_history}`);
    assert(dna.scores.food_wine >= 20, `food ${dna.scores.food_wine}`);
  });

  await test("ship enrichment affects family / nightlife", () => {
    const shipRow = {
      passenger_capacity: 3600,
      year_built: 2013,
      facilities: JSON.stringify({
        kids_club: true,
        spa: true,
        casino: true,
        bars: 10,
        specialty_dining: 5,
        restaurants: 12,
        theater: true
      })
    };
    const dna = scoreCruiseDna(ALASKA_SAILING, { shipRow });
    assert(dna.scores.family >= 25, `family ${dna.scores.family}`);
    assert(dna.scores.nightlife >= 20, `nightlife ${dna.scores.nightlife}`);
    assert(dna.explanations.family.includes("Ship has kids club"), "kids reason");
  });

  await test("explanations generated for non-zero scores", () => {
    const dna = scoreCruiseDna(ALASKA_SAILING);
    for (const id of DNA_CATEGORY_IDS) {
      if (dna.scores[id] > 0) {
        assert(dna.explanations[id].length > 0, `${id} needs reasons`);
      }
    }
  });

  await test("customer profile maps questionnaire styles", () => {
    const profile = buildCustomerProfile({
      styles: ["wildlife", "scenic_cruising"],
      durationId: "6-8",
      budgetId: "5-8k",
      departure: "sydney",
      destinationId: "alaska"
    });
    assert(profile.scores.wildlife >= 80, `wildlife pref ${profile.scores.wildlife}`);
    assert(profile.scores.scenic_cruising >= 70, `scenic pref ${profile.scores.scenic_cruising}`);
    assert(Math.abs(profile.weightSum - 1) < 1e-9, `weights sum ${profile.weightSum}`);
  });

  await test("same questionnaire always produces same ranking", () => {
    const answers = {
      styles: ["wildlife", "adventure"],
      durationId: "6-8",
      budgetId: "3-5k",
      departure: "anywhere",
      destinationIds: ["alaska"]
    };
    const a = matchCruisesToCustomer(answers, [ALASKA_SAILING, MED_SAILING]);
    const b = matchCruisesToCustomer(answers, [ALASKA_SAILING, MED_SAILING]);
    assert(JSON.stringify(a.ranked.map((r) => r.providerCruiseId)) === JSON.stringify(b.ranked.map((r) => r.providerCruiseId)), "order");
    assert(a.ranked[0].matchScore === b.ranked[0].matchScore, "scores");
    assert(a.ranked[0].providerCruiseId === "1632", "Alaska ranks first for wildlife");
  });

  await test("match buckets populated", () => {
    const out = matchCruisesToCustomer(
      { styles: ["culture", "food_wine"], durationId: "6-8", budgetId: "5-8k", destinationId: "mediterranean" },
      [ALASKA_SAILING, MED_SAILING]
    );
    assert(out.buckets.bestMatch || out.buckets.alsoWorthConsidering, "buckets");
    assert(out.ranked[0].providerCruiseId === "U629", "Med first for culture");
  });

  await test("similarity is deterministic and bounded", () => {
    const profile = buildCustomerProfile({ styles: ["luxury"] });
    const dna = scoreCruiseDna(ALASKA_SAILING);
    const s1 = similarityScore(profile.scores, dna.scores, profile.weights);
    const s2 = similarityScore(profile.scores, dna.scores, profile.weights);
    assert(s1 === s2, "stable");
    assert(s1 >= 0 && s1 <= 100, "bounds");
  });

  await test("scores remain stable across clone", () => {
    const clone = JSON.parse(JSON.stringify(ALASKA_SAILING));
    const a = scoreCruiseDna(ALASKA_SAILING);
    const b = scoreCruiseDna(clone);
    assert(JSON.stringify(a.scores) === JSON.stringify(b.scores), "clone stable");
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok ? "" : ` — ${r.error}`}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(String(e.stack || e));
  process.exitCode = 1;
});
