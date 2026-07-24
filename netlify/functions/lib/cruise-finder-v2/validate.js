/**
 * Request / result set validation helpers for Engine V2.
 */

const { normaliseSearchRequest } = require("./normalise-search-request");
const { validateCandidateCruise } = require("./normalise-cruise-result");

function validateSearchRequest(body) {
  return normaliseSearchRequest(body);
}

/**
 * @param {Array<object>} candidates
 */
function validateCandidateSet(candidates) {
  if (!Array.isArray(candidates)) {
    return {
      ok: false,
      errors: [{ code: "not_array", message: "Candidates must be an array." }],
      cruises: []
    };
  }
  const cruises = [];
  const errors = [];
  candidates.forEach((raw, index) => {
    const result = validateCandidateCruise(raw);
    if (!result.ok) {
      errors.push({
        code: "candidate_invalid",
        message: `Candidate ${index + 1} invalid.`,
        details: result.errors
      });
      return;
    }
    cruises.push(result.cruise);
  });
  return { ok: errors.length === 0, errors, cruises };
}

module.exports = {
  validateSearchRequest,
  validateCandidateSet
};
