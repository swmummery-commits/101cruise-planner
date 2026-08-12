/**
 * Explora Journeys weekly inventory maintenance — Netlify Background Function.
 *
 * Naming suffix `-background` enables Netlify background mode (up to ~15 minutes).
 * Invoked by `explora-weekly-maintenance-cron` with header:
 *   x-discovery-cron-secret = DISCOVERY_CRON_SECRET
 *
 * Owns the full shared weekly path via runExploraWeeklyMaintenance /
 * executeWeeklyMaintenance. Creates the maintenance run record as `running`
 * only when background work begins (never at launcher dispatch time).
 *
 * Write gating unchanged:
 *   EXPLORA_WEEKLY_RECONCILIATION_ENABLED must be true for production writes.
 *   Dry-run is the default when the flag is unset/false.
 *   EXPLORA_MAX_WEEKLY_WRITES remains 25.
 *   EXPLORA_DISCOVERY_WRITE_ENABLED is unrelated to weekly maintenance.
 */

const {
  assertCronAuth,
  parseJsonBody,
  resolveDryRun,
  resolveMaxWrites,
  runExploraWeeklyBackgroundMaintenance,
  redactSecrets,
  BACKGROUND_FUNCTION_NAME
} = require("./lib/explora-weekly-maintenance-dispatch");

exports.handler = async (event) => {
  const started = Date.now();
  try {
    assertCronAuth(event);

    const body = parseJsonBody(event);
    if (body.authorised_scheduled_maintenance !== true && body.trigger_type == null) {
      // Still allow authorised secret holders; require explicit trigger metadata.
    }

    const dryRun = resolveDryRun(body);
    const maxWrites = resolveMaxWrites(body);
    const triggerType = String(body.trigger_type || body.triggerType || "background").trim();
    const dispatchId = body.dispatch_id || body.dispatchId || null;

    const result = await runExploraWeeklyBackgroundMaintenance({
      dryRun,
      maxWrites,
      triggerType,
      dispatchId
    });

    // Background return body is not delivered to the HTTP client (202 already sent),
    // but Netlify logs capture it for operations.
    return {
      statusCode: result.success ? 200 : 500,
      body: JSON.stringify(
        redactSecrets({
          ...result,
          worker: BACKGROUND_FUNCTION_NAME,
          elapsed_ms: Date.now() - started
        })
      )
    };
  } catch (error) {
    console.error("explora-weekly-maintenance-background failed", {
      message: error.message,
      code: error.code || null
    });
    return {
      statusCode: error.statusCode || 500,
      body: JSON.stringify(
        redactSecrets({
          success: false,
          phase: "background_maintenance",
          status: "failed",
          worker: BACKGROUND_FUNCTION_NAME,
          error: error.message || "Explora weekly background maintenance failed",
          code: error.code || null,
          elapsed_ms: Date.now() - started
        })
      )
    };
  }
};
