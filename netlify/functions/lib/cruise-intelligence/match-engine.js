/**
 * Customer DNA × Cruise DNA matching (design implementation, not customer-facing).
 * Deterministic ranking into buckets:
 *   Best Match | Also Worth Considering | Hidden Gems | Alternative Style
 */

const { DNA_CATEGORY_IDS } = require("./dna-model");
const { scoreCruiseDna } = require("./score-cruise-dna");
const { buildCustomerProfile } = require("./customer-profile");

/**
 * Weighted cosine-like similarity on DNA vectors using customer weights.
 * @param {Record<string, number>} customerScores
 * @param {Record<string, number>} cruiseScores
 * @param {Record<string, number>} weights
 */
function similarityScore(customerScores, cruiseScores, weights) {
  let dot = 0;
  let a2 = 0;
  let b2 = 0;
  for (const id of DNA_CATEGORY_IDS) {
    const w = weights[id] != null ? weights[id] : 1 / DNA_CATEGORY_IDS.length;
    const a = (customerScores[id] || 0) * w;
    const b = (cruiseScores[id] || 0) * w;
    dot += a * b;
    a2 += a * a;
    b2 += b * b;
  }
  if (a2 === 0 || b2 === 0) return 0;
  const raw = dot / (Math.sqrt(a2) * Math.sqrt(b2));
  // Map cosine [0,1] typical band to 0–100
  return Math.round(Math.max(0, Math.min(100, raw * 100)));
}

/**
 * Dominant customer categories (top 3 by score).
 */
function topCustomerCategories(profile, n = 3) {
  return Object.entries(profile.scores)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([id, score]) => ({ id, score }));
}

function cruiseStrengthOn(categories, cruiseDna) {
  if (!categories.length) return 0;
  const vals = categories.map((c) => cruiseDna.scores[c.id] || 0);
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * @param {object} customerAnswers questionnaire-shaped object
 * @param {Array<object>} sailings canonical sailings
 * @param {{ enrichmentByShipName?: Record<string, object> }} [options]
 */
function matchCruisesToCustomer(customerAnswers, sailings, options = {}) {
  const profile = buildCustomerProfile(customerAnswers);
  const focus = topCustomerCategories(profile, 3);

  const ranked = [];
  for (const sailing of sailings || []) {
    const shipName = sailing?.ship?.canonicalName || sailing?.ship?.providerName || "";
    const enrichment = {
      shipRow: options.enrichmentByShipName?.[shipName] || options.shipRow || null,
      lineRow: options.lineRow || null
    };
    const dna = scoreCruiseDna(sailing, enrichment);
    const matchScore = similarityScore(profile.scores, dna.scores, profile.weights);
    const focusAvg = cruiseStrengthOn(focus, dna);
    const luxuryGap =
      (profile.scores.luxury || 0) - (dna.scores.luxury || 0);
    const expeditionGap =
      (profile.scores.expedition || 0) - (dna.scores.expedition || 0);

    ranked.push({
      sailingKey: sailing.sailingKey || null,
      providerCruiseId: sailing.providerCruiseId || null,
      title: sailing.title || null,
      shipName,
      cruiseLineName: sailing.cruiseLine?.canonicalName || sailing.cruiseLine?.providerName || null,
      matchScore,
      focusAverage: Math.round(focusAvg),
      dna,
      luxuryGap,
      expeditionGap
    });
  }

  ranked.sort(
    (a, b) =>
      b.matchScore - a.matchScore ||
      b.focusAverage - a.focusAverage ||
      String(a.providerCruiseId || "").localeCompare(String(b.providerCruiseId || ""))
  );

  const bestMatch = ranked.filter((r) => r.matchScore >= 70).slice(0, 5);
  const also = ranked.filter((r) => r.matchScore >= 55 && r.matchScore < 70).slice(0, 8);

  // Hidden gems: strong on customer's #1 category but mid overall match
  const primary = focus[0]?.id;
  const hiddenGems = ranked
    .filter((r) => {
      if (!primary) return false;
      const primaryScore = r.dna.scores[primary] || 0;
      return primaryScore >= 60 && r.matchScore >= 40 && r.matchScore < 70;
    })
    .slice(0, 5);

  // Alternative style: high on a DNA category the customer scored low (<30) but cruise high (>=70)
  const alt = ranked
    .filter((r) => {
      for (const id of DNA_CATEGORY_IDS) {
        if ((profile.scores[id] || 0) < 30 && (r.dna.scores[id] || 0) >= 70) return true;
      }
      return false;
    })
    .slice(0, 5);

  // Ensure buckets mutually informative: if bestMatch empty, take top 3 overall
  const best = bestMatch.length ? bestMatch : ranked.slice(0, 3);

  return {
    version: "match-engine-1.0.0",
    profile,
    focusCategories: focus,
    totals: {
      candidates: ranked.length,
      bestMatch: best.length,
      alsoWorthConsidering: also.length,
      hiddenGems: hiddenGems.length,
      alternativeStyle: alt.length
    },
    buckets: {
      bestMatch: best,
      alsoWorthConsidering: also,
      hiddenGems,
      alternativeStyle: alt
    },
    ranked
  };
}

module.exports = {
  similarityScore,
  matchCruisesToCustomer,
  topCustomerCategories
};
