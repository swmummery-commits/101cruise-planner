/**
 * Shared weekly-maintenance runner return contract.
 *
 * Every weekly runner must return explicit booleans:
 *   ok, success
 * plus as appropriate:
 *   blocked, review_required, reason, summary
 *
 * executeWeeklyMaintenance must never treat undefined `ok` as success.
 */

const REQUIRED_BOOLEANS = ["ok", "success"];

function makeContractError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function buildWeeklyRunnerResult({
  ok,
  success,
  blocked = false,
  review_required = false,
  reason = null,
  summary = {},
  ...rest
} = {}) {
  if (typeof ok !== "boolean" && typeof success !== "boolean") {
    throw makeContractError(
      "weekly_runner_invalid_ok_contract",
      "weekly runner result requires an explicit boolean ok or success"
    );
  }
  const resolvedOk = typeof ok === "boolean" ? ok : success;
  const resolvedSuccess = typeof success === "boolean" ? success : resolvedOk;
  return {
    ok: resolvedOk,
    success: resolvedSuccess,
    blocked: blocked === true,
    review_required: review_required === true,
    reason: reason || null,
    summary: summary && typeof summary === "object" ? summary : {},
    ...rest
  };
}

function assertWeeklyRunnerResult(result, lineSlug = "unknown") {
  if (!result || typeof result !== "object") {
    throw makeContractError(
      "weekly_runner_result_missing",
      `weekly runner for ${lineSlug} returned no result object`
    );
  }
  if (typeof result.ok !== "boolean") {
    throw makeContractError(
      "weekly_runner_invalid_ok_contract",
      `weekly runner for ${lineSlug} must return boolean ok (got ${typeof result.ok})`
    );
  }
  return {
    ...result,
    ok: result.ok,
    success: typeof result.success === "boolean" ? result.success : result.ok,
    blocked: result.blocked === true,
    review_required: result.review_required === true,
    reason: result.reason || null,
    summary: result.summary && typeof result.summary === "object" ? result.summary : result.summary || {}
  };
}

module.exports = {
  REQUIRED_BOOLEANS,
  makeContractError,
  buildWeeklyRunnerResult,
  assertWeeklyRunnerResult
};
