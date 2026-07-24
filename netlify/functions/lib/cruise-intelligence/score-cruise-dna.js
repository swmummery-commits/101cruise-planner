/**
 * Deterministic Cruise DNA rule engine.
 * Each contribution is an integer delta with a human-readable reason.
 */

const { DNA_CATEGORY_IDS, emptyDnaScores, clampScore } = require("./dna-model");
const { extractFeatures } = require("./extract-features");

/**
 * @param {string} category
 * @param {number} points
 * @param {string} reason
 * @param {Array} bucket
 */
function add(category, points, reason, bucket) {
  if (!points) return;
  bucket.push({ category, points, reason });
}

/**
 * Build raw contribution list from features.
 * @param {ReturnType<typeof extractFeatures>} f
 */
function collectContributions(f) {
  /** @type {Array<{category:string,points:number,reason:string}>} */
  const c = [];

  // --- Destination / itinerary geography ---
  if (f.flags.alaska) {
    add("wildlife", 30, "Alaska itinerary", c);
    add("scenic_cruising", 25, "Alaska scenic corridors", c);
    add("adventure", 20, "Alaska adventure destination", c);
  }
  if (f.flags.glacier) {
    add("wildlife", 15, "Glacier / ice scenery on itinerary", c);
    add("scenic_cruising", 20, "Glacier cruising", c);
  }
  if (f.scenicDays > 0) {
    add("scenic_cruising", Math.min(30, f.scenicDays * 12), `${f.scenicDays} scenic-cruising day(s)`, c);
    add("romance", 8, "Scenic cruising days", c);
  }
  if (f.flags.antarctica) {
    add("wildlife", 35, "Antarctica itinerary", c);
    add("expedition", 35, "Antarctic expedition character", c);
    add("adventure", 25, "Antarctic adventure", c);
    add("experienced_appeal", 25, "Remote polar voyage", c);
  }
  if (f.flags.galapagos) {
    add("wildlife", 40, "Galápagos wildlife destination", c);
    add("expedition", 30, "Galápagos expedition character", c);
  }
  if (f.flags.caribbean) {
    add("relaxation", 25, "Caribbean destination", c);
    add("family", 20, "Caribbean family appeal", c);
    add("first_time_friendly", 15, "Familiar warm-weather cruising", c);
    add("value_for_money", 10, "Mainstream warm-weather region", c);
  }
  if (f.flags.private_island) {
    add("relaxation", 15, "Private island / exclusive beach stop", c);
    add("family", 10, "Private-island day suitable for families", c);
  }
  if (f.flags.mediterranean) {
    add("culture_history", 30, "Mediterranean cultural ports", c);
    add("food_wine", 25, "Mediterranean food & wine region", c);
    add("romance", 15, "Mediterranean romance appeal", c);
  }
  if (f.flags.unesco_proxy) {
    add("culture_history", 12, "Heritage / landmark port cues", c);
  }
  if (f.flags.norway_fjords) {
    add("scenic_cruising", 30, "Norwegian fjords / scenic northern Europe", c);
    add("adventure", 15, "Nordic outdoor appeal", c);
  }
  if (f.flags.japan) {
    add("culture_history", 25, "Japan cultural itinerary", c);
    add("food_wine", 20, "Japan culinary destination", c);
    add("experienced_appeal", 15, "Asia specialist appeal", c);
  }
  if (f.flags.australia_nz) {
    add("first_time_friendly", 10, "Australia / NZ regional familiarity for AU travellers", c);
    add("scenic_cruising", 10, "Australia / NZ coastal scenery", c);
  }
  if (f.flags.pacific) {
    add("relaxation", 15, "Pacific / island leisure destination", c);
    add("romance", 10, "South Pacific romance cue", c);
  }
  if (f.flags.panama_canal) {
    add("adventure", 15, "Panama Canal transit", c);
    add("scenic_cruising", 15, "Canal scenic transit", c);
    add("experienced_appeal", 10, "Canal transit appeal", c);
  }
  if (f.flags.world_cruise) {
    add("experienced_appeal", 35, "World cruise / long segment", c);
    add("adventure", 15, "Extended global voyage", c);
  }

  // --- Sea / port balance ---
  if (f.seaDays >= 3) {
    add("relaxation", 15, `${f.seaDays} sea days`, c);
  } else if (f.seaDays === 0 && f.portDays >= 5) {
    add("culture_history", 8, "Port-intensive itinerary", c);
    add("adventure", 5, "Few sea days / active porting", c);
  }
  if (f.nights != null) {
    if (f.nights <= 5) {
      add("first_time_friendly", 20, "Short voyage (≤5 nights)", c);
      add("accessibility", 10, "Short duration", c);
      add("value_for_money", 8, "Shorter cruise length", c);
    } else if (f.nights <= 8) {
      add("first_time_friendly", 15, "Classic week-length voyage", c);
      add("family", 8, "Family-friendly duration band", c);
    } else if (f.nights <= 14) {
      add("experienced_appeal", 10, "Longer than a week", c);
    } else {
      add("experienced_appeal", 20, "Extended voyage (15+ nights)", c);
      add("adventure", 8, "Long itinerary commitment", c);
    }
  }
  if (f.roundTrip) {
    add("accessibility", 15, "Round-trip itinerary (same embark/disembark port)", c);
    add("first_time_friendly", 10, "Round-trip simplicity", c);
  }

  // --- Line positioning ---
  if (f.line.isLuxury) {
    add("luxury", 40, "Luxury / premium cruise line", c);
    add("romance", 15, "Premium line romance cue", c);
    add("food_wine", 10, "Premium dining expectation", c);
    add("value_for_money", -15, "Luxury positioning (lower mass-market value score)", c);
  }
  if (f.line.isMainstream) {
    add("value_for_money", 25, "Mainstream cruise line", c);
    add("first_time_friendly", 15, "Mainstream product familiarity", c);
    add("family", 10, "Mainstream family appeal", c);
  }
  if (f.line.isExpeditionBrand || f.line.lineType === "expedition") {
    add("expedition", 35, "Expedition-oriented line", c);
    add("adventure", 15, "Expedition brand adventure cue", c);
  }

  // --- Ship facilities (only when enrichment provided) ---
  if (f.ship.kidsClub) {
    add("family", 25, "Ship has kids club", c);
    add("first_time_friendly", 5, "Family facilities onboard", c);
  }
  if (f.ship.spa) {
    add("relaxation", 15, "Ship spa", c);
    add("romance", 8, "Spa / wellness cue", c);
  }
  if (f.ship.casino) {
    add("nightlife", 20, "Ship casino", c);
  }
  if (f.ship.theater) {
    add("nightlife", 12, "Ship theater / shows", c);
  }
  if (f.ship.bars != null && f.ship.bars >= 8) {
    add("nightlife", 15, `High bar count (${f.ship.bars})`, c);
  } else if (f.ship.bars != null && f.ship.bars >= 4) {
    add("nightlife", 8, `Multiple bars (${f.ship.bars})`, c);
  }
  if (f.ship.specialtyDining != null && f.ship.specialtyDining >= 4) {
    add("food_wine", 20, `Specialty dining venues (${f.ship.specialtyDining})`, c);
  } else if (f.ship.specialtyDining != null && f.ship.specialtyDining >= 1) {
    add("food_wine", 10, "Specialty dining available", c);
  }
  if (f.ship.restaurants != null && f.ship.restaurants >= 10) {
    add("food_wine", 10, `Many restaurants (${f.ship.restaurants})`, c);
  }
  if (f.ship.exclusiveAreas > 0) {
    add("luxury", 10, "Exclusive / suite areas onboard", c);
    add("romance", 5, "Exclusive areas", c);
  }
  if (f.ship.passengerCapacity != null) {
    if (f.ship.passengerCapacity >= 4000) {
      add("nightlife", 10, "Very large ship (entertainment scale)", c);
      add("family", 8, "Large-ship family facilities likely", c);
      add("value_for_money", 10, "Large mainstream ship scale", c);
      add("luxury", -10, "Mega-ship scale (less intimate luxury)", c);
    } else if (f.ship.passengerCapacity <= 1000) {
      add("luxury", 15, "Smaller ship intimacy", c);
      add("expedition", 10, "Small-ship expedition suitability", c);
      add("romance", 10, "Smaller ship atmosphere", c);
    }
  }
  if (f.ship.shipAgeYears != null && f.ship.shipAgeYears <= 5) {
    add("first_time_friendly", 5, "Newer ship", c);
    add("luxury", 5, "Recent build / refresh cue", c);
  }

  return c.filter((row) => DNA_CATEGORY_IDS.includes(row.category));
}

/**
 * @param {object} sailing
 * @param {{ shipRow?: object|null, lineRow?: object|null }} [enrichment]
 */
function scoreCruiseDna(sailing, enrichment = {}) {
  const features = extractFeatures(sailing, enrichment);
  const contributions = collectContributions(features);
  const scores = emptyDnaScores();
  /** @type {Record<string, string[]>} */
  const explanations = {};
  for (const id of DNA_CATEGORY_IDS) explanations[id] = [];

  for (const row of contributions) {
    scores[row.category] = (scores[row.category] || 0) + row.points;
    if (row.reason) explanations[row.category].push(row.reason);
  }

  // Baseline so empty categories stay defined; clamp
  for (const id of DNA_CATEGORY_IDS) {
    scores[id] = clampScore(scores[id]);
    // Deduplicate explanation strings while preserving order
    const seen = new Set();
    explanations[id] = (explanations[id] || []).filter((r) => {
      if (seen.has(r)) return false;
      seen.add(r);
      return true;
    });
  }

  const topCategories = Object.entries(scores)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([id, score]) => ({ id, score, reasons: explanations[id] }));

  return {
    version: "cruise-dna-1.0.0",
    sailingKey: sailing?.sailingKey || null,
    providerCruiseId: sailing?.providerCruiseId || null,
    scores,
    explanations,
    topCategories,
    featuresSummary: {
      nights: features.nights,
      seaDays: features.seaDays,
      scenicDays: features.scenicDays,
      portDays: features.portDays,
      roundTrip: features.roundTrip,
      regionFlags: Object.entries(features.flags)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .sort()
    },
    contributions
  };
}

module.exports = {
  scoreCruiseDna,
  collectContributions
};
