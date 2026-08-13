/**
 * Royal Caribbean branch deploy runtime proof — auth, parsing, and compact summaries.
 */

const BRANCH_RUNTIME_PROOF_HOST =
  "feat-royal-caribbean-final-catchup--admirable-tiramisu-d4da8a.netlify.app";
const BRANCH_RUNTIME_PROOF_CONFIRMATION = "RC_BRANCH_RUNTIME_PROOF_2026";
const BRANCH_RUNTIME_PROOF_MODE = "branch_runtime_proof";
const PRODUCTION_HOST = "admirable-tiramisu-d4da8a.netlify.app";

function branchRuntimeProofEnabled(env = process.env) {
  return String(env.ROYAL_CARIBBEAN_BRANCH_RUNTIME_PROOF_ENABLED || "")
    .trim()
    .toLowerCase() === "true";
}

function discoveryCronSecretPresent(env = process.env) {
  return Boolean(String(env.DISCOVERY_CRON_SECRET || "").trim());
}

function headerValue(event, name) {
  const headers = event?.headers || {};
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === lower) return String(value || "").trim();
  }
  return "";
}

function requestHost(event) {
  const raw = headerValue(event, "host") || headerValue(event, "x-forwarded-host");
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "");
}

function parseJsonBody(event) {
  try {
    return JSON.parse(event?.body || "{}");
  } catch {
    return {};
  }
}

function parseBranchProofBody(event, env = process.env) {
  const qs = event?.queryStringParameters || {};
  const json = parseJsonBody(event);
  const body =
    event?.httpMethod === "GET"
      ? {
          mode: qs.mode,
          confirmation: qs.confirmation,
          run_id: qs.run_id || qs.runId
        }
      : {
          ...json,
          ...(qs.mode != null ? { mode: qs.mode } : {}),
          ...(qs.confirmation != null ? { confirmation: qs.confirmation } : {}),
          ...(qs.run_id || qs.runId ? { run_id: qs.run_id || qs.runId } : {})
        };
  return {
    mode: String(body.mode || "").trim(),
    confirmation: String(body.confirmation || "").trim(),
    run_id: String(body.run_id || body.runId || "").trim() || null,
    raw: body
  };
}

function isBranchRuntimeProofRequest(event, body = {}, env = process.env) {
  if (!branchRuntimeProofEnabled(env)) return false;
  const proof = body?.mode != null ? body : parseBranchProofBody(event, env);
  if (proof.mode !== BRANCH_RUNTIME_PROOF_MODE) return false;
  if (proof.confirmation !== BRANCH_RUNTIME_PROOF_CONFIRMATION) return false;
  const host = requestHost(event);
  return host === BRANCH_RUNTIME_PROOF_HOST.toLowerCase();
}

function assertWriteModesForbidden(body = {}) {
  const forbidden =
    body.apply === true ||
    body.perform_writes === true ||
    body.performWrites === true ||
    body.inventory_writes === true ||
    body.maintenance_writes === true ||
    body.dry_run === false ||
    body.dryRun === false;
  if (forbidden) {
    const err = new Error("Branch runtime proof forbids write or apply modes");
    err.statusCode = 403;
    err.code = "branch_runtime_proof_write_mode_forbidden";
    throw err;
  }
}

function assertBranchRuntimeProofAccess(event, body = {}, env = process.env) {
  if (!branchRuntimeProofEnabled(env)) {
    const err = new Error("Branch runtime proof is disabled");
    err.statusCode = 403;
    err.code = "branch_runtime_proof_disabled";
    throw err;
  }
  const proof = body?.mode != null ? body : parseBranchProofBody(event, env);
  if (proof.mode !== BRANCH_RUNTIME_PROOF_MODE) {
    const err = new Error("Invalid branch runtime proof mode");
    err.statusCode = 400;
    err.code = "branch_runtime_proof_mode_invalid";
    throw err;
  }
  if (proof.confirmation !== BRANCH_RUNTIME_PROOF_CONFIRMATION) {
    const err = new Error("Invalid branch runtime proof confirmation");
    err.statusCode = 403;
    err.code = "branch_runtime_proof_confirmation_invalid";
    throw err;
  }
  const host = requestHost(event);
  if (host === PRODUCTION_HOST.toLowerCase()) {
    const err = new Error("Branch runtime proof is forbidden on production host");
    err.statusCode = 403;
    err.code = "branch_runtime_proof_forbidden_on_production_host";
    throw err;
  }
  if (host !== BRANCH_RUNTIME_PROOF_HOST.toLowerCase()) {
    const err = new Error("Branch runtime proof host mismatch");
    err.statusCode = 403;
    err.code = "branch_runtime_proof_host_mismatch";
    throw err;
  }
  assertWriteModesForbidden(proof.raw || body);
}

function assertCronAuth(event, env = process.env) {
  const expected = String(env.DISCOVERY_CRON_SECRET || "").trim();
  if (!expected) {
    const err = new Error("DISCOVERY_CRON_SECRET is not configured");
    err.statusCode = 503;
    err.code = "discovery_cron_secret_missing";
    throw err;
  }
  const provided = headerValue(event, "x-discovery-cron-secret");
  if (provided !== expected) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    err.code = "unauthorized";
    throw err;
  }
}

function assertSmokeAuth(event, body = {}, env = process.env) {
  if (isBranchRuntimeProofRequest(event, body, env)) {
    assertBranchRuntimeProofAccess(event, body, env);
    return { auth: "branch_runtime_proof" };
  }
  assertCronAuth(event, env);
  return { auth: "discovery_cron_secret" };
}

function redactSecrets(value) {
  if (value == null) return value;
  if (typeof value === "string") {
    return value
      .replace(/x-discovery-cron-secret["']?\s*[:=]\s*["']?[^"'\\s]+/gi, "x-discovery-cron-secret=[REDACTED]")
      .replace(/DISCOVERY_CRON_SECRET["']?\s*[:=]\s*["']?[^"'\\s]+/gi, "DISCOVERY_CRON_SECRET=[REDACTED]")
      .replace(/service_role["']?\s*[:=]\s*["']?[^"'\\s]+/gi, "service_role=[REDACTED]");
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/secret|token|authorization|service_role/i.test(k)) out[k] = "[REDACTED]";
      else out[k] = redactSecrets(v);
    }
    return out;
  }
  return value;
}

function buildCompactRuntimeSummary(result = {}, meta = {}) {
  const summary = result.summary || {};
  const weeklyHealth = summary.weekly_health || {};
  const enumerationHealth = summary.enumeration_health || {};
  const actualWrites = Number(summary.actual_writes ?? result.actual_writes ?? 0) || 0;
  const enumerationOk = enumerationHealth.royal_caribbean_source_enumeration_ok === true;
  const weeklyOk = weeklyHealth.weekly_maintenance_healthy === true;
  const royal_caribbean_netlify_background_runtime_ok =
    result.ok === true && actualWrites === 0 && enumerationOk && weeklyOk;

  return redactSecrets({
    ok: result.ok === true,
    run_id: meta.run_id || summary.run_id || null,
    actual_writes: actualWrites,
    union_sailing_identities: summary.union_sailing_identities ?? null,
    fleet_ship_count: summary.fleet_ship_count ?? null,
    recognised_existing_eligible_sailings: summary.recognised_existing_eligible_sailings ?? null,
    proposed_inserts: summary.proposed_inserts ?? null,
    source_absent_active: summary.source_absent_active ?? null,
    production_cutoff_candidates: summary.production_cutoff_candidates ?? null,
    incomplete_skipped: summary.incomplete_skipped ?? null,
    cruisetours_excluded: summary.cruisetours_excluded ?? null,
    enumeration_health: {
      royal_caribbean_source_enumeration_ok: enumerationOk
    },
    weekly_health: {
      weekly_maintenance_healthy: weeklyOk,
      failures: weeklyHealth.failures || []
    },
    proposed_insert_sample: summary.proposed_insert_sample || [],
    royal_caribbean_netlify_background_runtime_ok
  });
}

module.exports = {
  BRANCH_RUNTIME_PROOF_HOST,
  BRANCH_RUNTIME_PROOF_CONFIRMATION,
  BRANCH_RUNTIME_PROOF_MODE,
  PRODUCTION_HOST,
  branchRuntimeProofEnabled,
  discoveryCronSecretPresent,
  parseJsonBody,
  parseBranchProofBody,
  isBranchRuntimeProofRequest,
  assertBranchRuntimeProofAccess,
  assertCronAuth,
  assertSmokeAuth,
  redactSecrets,
  buildCompactRuntimeSummary
};
