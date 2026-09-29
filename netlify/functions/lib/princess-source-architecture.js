/**
 * Princess source architecture selection.
 * NETLIFY_FULL: Netlify harvests official source.
 * NETLIFY_ORCHESTRATED_MAC_HARVEST: Netlify schedules/leases; Mac harvests.
 * NETLIFY_ATTEMPT: diagnosis default — Netlify still tries a live harvest.
 */

const NETLIFY_FULL = "NETLIFY_FULL";
const NETLIFY_ORCHESTRATED_MAC_HARVEST = "NETLIFY_ORCHESTRATED_MAC_HARVEST";
const NETLIFY_ATTEMPT = "NETLIFY_ATTEMPT";

function isNetlifyRuntime(env = process.env) {
  return (
    String(env.NETLIFY || "").toLowerCase() === "true" ||
    Boolean(env.AWS_LAMBDA_FUNCTION_NAME) ||
    Boolean(env.NETLIFY_DEV)
  );
}

function princessSourceArchitecture(env = process.env) {
  const raw = String(env.PRINCESS_SOURCE_ARCHITECTURE || "").trim();
  if (raw === NETLIFY_FULL || raw === NETLIFY_ORCHESTRATED_MAC_HARVEST) return raw;
  return NETLIFY_ATTEMPT;
}

function netlifyShouldOrchestrateMacHarvest(env = process.env) {
  return princessSourceArchitecture(env) === NETLIFY_ORCHESTRATED_MAC_HARVEST && isNetlifyRuntime(env);
}

module.exports = {
  NETLIFY_FULL,
  NETLIFY_ORCHESTRATED_MAC_HARVEST,
  NETLIFY_ATTEMPT,
  isNetlifyRuntime,
  princessSourceArchitecture,
  netlifyShouldOrchestrateMacHarvest
};
