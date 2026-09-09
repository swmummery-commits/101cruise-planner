/**
 * Disney weekly inventory maintenance — thin Scheduled Function launcher.
 *
 * Target slot: schedule = "0 2 * * 1" (Monday 02:00 UTC / Monday 10:00 Perth).
 * Dispatches long-running work to disney-weekly-maintenance-background.
 */

const { supabase } = require("./lib/cruise-discovery-maintenance-cron");
const {
  LAUNCHER_FUNCTION_NAME,
  BACKGROUND_FUNCTION_NAME,
  assertDisneyWeeklyAuth,
  parseJsonBody,
  resolveDryRun,
  resolveMaxWrites,
  resolveTriggerType,
  resolveScheduledLauncherState,
  dispatchDisneyWeeklyBackground,
  redactSecrets,
  isNetlifyPlatformScheduledInvocation
} = require("./lib/disney-weekly-maintenance-dispatch");
const { handleLeasedWeeklyCron } = require("./lib/weekly-maintenance-schedule-control");

exports.handler = async (event) => {
  const started = Date.now();
  try {
    const scheduleState = resolveScheduledLauncherState(event);
    if (scheduleState.disabled) {
      return {
        statusCode: 200,
        body: JSON.stringify(
          redactSecrets({
            success: true,
            phase: "dispatch",
            status: "disabled",
            launcher: LAUNCHER_FUNCTION_NAME,
            reason: scheduleState.reason,
            scheduled_invocation: isNetlifyPlatformScheduledInvocation(event),
            elapsed_ms: Date.now() - started
          })
        )
      };
    }

    return await handleLeasedWeeklyCron(event, {
      supabase,
      lineSlug: "disney-cruise-line",
      launcherFunctionName: LAUNCHER_FUNCTION_NAME,
      backgroundFunctionName: BACKGROUND_FUNCTION_NAME,
      redactSecrets,
      assertAuth: assertDisneyWeeklyAuth,
      parseJsonBody,
      resolveDryRun,
      resolveMaxWrites,
      resolveTriggerType,
      dispatchBackground: (args) =>
        dispatchDisneyWeeklyBackground({
          ...args,
          platformScheduled: isNetlifyPlatformScheduledInvocation(event)
        })
    });
  } catch (error) {
    console.error("disney-weekly-maintenance-cron dispatch failed", {
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
          error: error.message || "Disney weekly dispatch failed",
          code: error.code || null,
          elapsed_ms: Date.now() - started
        })
      )
    };
  }
};
