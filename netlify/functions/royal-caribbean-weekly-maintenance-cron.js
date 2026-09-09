/**
 * Royal Caribbean weekly maintenance — thin launcher (NOT scheduled until activation).
 */

const { supabase } = require("./lib/cruise-discovery-maintenance-cron");
const {
  LAUNCHER_FUNCTION_NAME,
  BACKGROUND_FUNCTION_NAME,
  assertLauncherAuth,
  parseJsonBody,
  resolveWeeklyExecutionPolicy,
  resolveTriggerType,
  dispatchRoyalCaribbeanWeeklyBackground,
  redactSecrets
} = require("./lib/royal-caribbean-weekly-maintenance-dispatch");
const { handleLeasedWeeklyCron } = require("./lib/weekly-maintenance-schedule-control");

exports.handler = async (event) => {
  const started = Date.now();
  try {
    assertLauncherAuth(event);
    const body = parseJsonBody(event);
    const policy = resolveWeeklyExecutionPolicy(body, event, process.env);
    const triggerType = resolveTriggerType(event, body);
    const dispatchId = `royal-caribbean-dispatch-${new Date().toISOString().replace(/[:.]/g, "-")}`;

    if (policy.blocked) {
      const elapsed_ms = Date.now() - started;
      return {
        statusCode: 403,
        body: JSON.stringify(
          redactSecrets({
            success: false,
            phase: "dispatch",
            status: "blocked",
            launcher: LAUNCHER_FUNCTION_NAME,
            dispatch_id: dispatchId,
            dry_run: true,
            max_writes: 0,
            trigger_type: triggerType,
            scheduled_invocation: policy.scheduled_invocation,
            reason: policy.reason,
            elapsed_ms
          })
        )
      };
    }

    return await handleLeasedWeeklyCron(event, {
      supabase,
      lineSlug: "royal-caribbean-international",
      launcherFunctionName: LAUNCHER_FUNCTION_NAME,
      backgroundFunctionName: BACKGROUND_FUNCTION_NAME,
      redactSecrets,
      assertAuth: assertLauncherAuth,
      parseJsonBody,
      resolveDryRun: () => policy.dryRun,
      resolveMaxWrites: () => policy.maxWrites,
      resolveTriggerType,
      extraDispatchArgs: { dispatchId },
      dispatchBackground: dispatchRoyalCaribbeanWeeklyBackground
    });
  } catch (error) {
    console.error("royal-caribbean-weekly-maintenance-cron dispatch failed", {
      message: error.message,
      code: error.code || null
    });
    return {
      statusCode: error.statusCode || 500,
      body: JSON.stringify(
        redactSecrets({
          success: false,
          phase: "dispatch",
          status: "dispatch_failed",
          error: error.message || "Royal Caribbean weekly dispatch failed",
          code: error.code || null,
          elapsed_ms: Date.now() - started
        })
      )
    };
  }
};
