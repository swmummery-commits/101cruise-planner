/**
 * Translate Cruise Finder questionnaire answers → customer DNA preference vector.
 * Does not modify the questionnaire — only maps existing answer IDs.
 */

const { DNA_CATEGORY_IDS, STYLE_TO_DNA, emptyDnaScores, clampScore } = require("./dna-model");

const DURATION_TO_DNA = Object.freeze({
  "3-5": { first_time_friendly: 40, accessibility: 25, value_for_money: 15, experienced_appeal: -10 },
  "6-8": { first_time_friendly: 30, family: 15, relaxation: 10 },
  "9-12": { experienced_appeal: 15, culture_history: 10, scenic_cruising: 10 },
  "13-16": { experienced_appeal: 30, adventure: 10 },
  "17-plus": { experienced_appeal: 45, expedition: 15, adventure: 10 },
  flexible: { first_time_friendly: 10, accessibility: 10 }
});

const BUDGET_TO_DNA = Object.freeze({
  "under-3k": { value_for_money: 50, luxury: -25, first_time_friendly: 10 },
  "3-5k": { value_for_money: 35, family: 10, luxury: -10 },
  "5-8k": { luxury: 15, food_wine: 10, romance: 10 },
  "8k-plus": { luxury: 45, expedition: 15, experienced_appeal: 15, value_for_money: -20 },
  no_budget: { first_time_friendly: 5 }
});

const DEPARTURE_TO_DNA = Object.freeze({
  sydney: { accessibility: 10, first_time_friendly: 5 },
  brisbane: { accessibility: 10, first_time_friendly: 5 },
  melbourne: { accessibility: 10 },
  perth: { accessibility: 5, experienced_appeal: 5 },
  adelaide: { accessibility: 5 },
  auckland: { accessibility: 10 },
  anywhere: { adventure: 15, experienced_appeal: 10, accessibility: -5 }
});

/**
 * @param {{
 *   styles?: string[],
 *   durationId?: string|null,
 *   budgetId?: string|null,
 *   departure?: string|null,
 *   destinationIds?: string[],
 *   destinationId?: string|null
 * }} answers
 */
function buildCustomerProfile(answers = {}) {
  const scores = emptyDnaScores();
  /** @type {Record<string, string[]>} */
  const explanations = {};
  for (const id of DNA_CATEGORY_IDS) explanations[id] = [];

  function apply(map, label) {
    if (!map) return;
    for (const [cat, pts] of Object.entries(map)) {
      if (!DNA_CATEGORY_IDS.includes(cat)) continue;
      scores[cat] += pts;
      explanations[cat].push(label);
    }
  }

  const styles = Array.isArray(answers.styles) ? answers.styles : [];
  for (const styleId of styles) {
    apply(STYLE_TO_DNA[styleId], `Selected style: ${styleId}`);
  }

  if (answers.durationId) {
    apply(DURATION_TO_DNA[answers.durationId], `Duration preference: ${answers.durationId}`);
  }
  if (answers.budgetId) {
    apply(BUDGET_TO_DNA[answers.budgetId], `Budget band: ${answers.budgetId}`);
  }
  if (answers.departure) {
    apply(DEPARTURE_TO_DNA[answers.departure], `Departure preference: ${answers.departure}`);
  }

  const destIds = [
    ...(Array.isArray(answers.destinationIds) ? answers.destinationIds : []),
    answers.destinationId
  ].filter(Boolean);

  for (const dest of destIds) {
    const d = String(dest).toLowerCase();
    if (d === "alaska") {
      apply({ wildlife: 40, scenic_cruising: 35, adventure: 25 }, "Destination interest: Alaska");
    } else if (d === "caribbean") {
      apply({ relaxation: 35, family: 25, first_time_friendly: 20 }, "Destination interest: Caribbean");
    } else if (d === "mediterranean" || d === "greek-islands") {
      apply({ culture_history: 40, food_wine: 30, romance: 20 }, `Destination interest: ${d}`);
    } else if (d === "antarctica") {
      apply({ expedition: 45, wildlife: 40, adventure: 35, experienced_appeal: 30 }, "Destination interest: Antarctica");
    } else if (d === "norwegian-fjords") {
      apply({ scenic_cruising: 40, adventure: 20 }, "Destination interest: Norwegian fjords");
    } else if (d === "japan") {
      apply({ culture_history: 35, food_wine: 25 }, "Destination interest: Japan");
    } else if (d === "south-pacific" || d === "hawaii") {
      apply({ relaxation: 30, romance: 20 }, `Destination interest: ${d}`);
    } else if (d === "australia-new-zealand") {
      apply({ first_time_friendly: 15, scenic_cruising: 15 }, "Destination interest: Australia & NZ");
    }
  }

  // If styles selected, boost those strongly; ensure vector not all zeros
  if (styles.length === 0 && !answers.durationId && !answers.budgetId) {
    scores.first_time_friendly += 20;
    explanations.first_time_friendly.push("Default soft baseline (no preferences supplied)");
  }

  for (const id of DNA_CATEGORY_IDS) {
    scores[id] = clampScore(scores[id]);
    const seen = new Set();
    explanations[id] = (explanations[id] || []).filter((r) => {
      if (seen.has(r)) return false;
      seen.add(r);
      return true;
    });
  }

  const total = DNA_CATEGORY_IDS.reduce((sum, id) => sum + scores[id], 0);
  const weights = {};
  for (const id of DNA_CATEGORY_IDS) {
    weights[id] = total > 0 ? scores[id] / total : 1 / DNA_CATEGORY_IDS.length;
  }

  const weightSum = Object.values(weights).reduce((a, b) => a + b, 0);

  return {
    version: "customer-dna-1.0.0",
    scores,
    explanations,
    weights,
    weightSum,
    sourceAnswers: {
      styles: styles.slice(),
      durationId: answers.durationId || null,
      budgetId: answers.budgetId || null,
      departure: answers.departure || null,
      destinationIds: destIds.map(String)
    }
  };
}

module.exports = {
  buildCustomerProfile,
  DURATION_TO_DNA,
  BUDGET_TO_DNA,
  DEPARTURE_TO_DNA
};
