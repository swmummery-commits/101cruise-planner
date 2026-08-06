/**
 * Lightweight phase timing for Celebrity Discovery batch runs.
 */

const { createHalBatchTiming, mapWithConcurrency } = require("./holland-america-discovery-timing");

module.exports = {
  createCelebrityBatchTiming: createHalBatchTiming,
  mapWithConcurrency
};
