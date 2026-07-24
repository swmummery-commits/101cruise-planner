/**
 * Cruise Intelligence Layer — public entry (Sprint 16B).
 * Provider-independent. Not wired to customer Finder.
 */

const { DNA_CATEGORY_META, DNA_CATEGORY_IDS, STYLE_TO_DNA } = require("./dna-model");
const { extractFeatures } = require("./extract-features");
const { scoreCruiseDna } = require("./score-cruise-dna");
const { buildCustomerProfile } = require("./customer-profile");
const { matchCruisesToCustomer, similarityScore } = require("./match-engine");

module.exports = {
  DNA_CATEGORY_META,
  DNA_CATEGORY_IDS,
  STYLE_TO_DNA,
  extractFeatures,
  scoreCruiseDna,
  buildCustomerProfile,
  matchCruisesToCustomer,
  similarityScore
};
