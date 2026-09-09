/**
 * Carnival weekly inventory maintenance — thin Scheduled Function launcher.
 */

const { supabase } = require("./lib/cruise-discovery-maintenance-cron");
const {
  LAUNCHER_FUNCTION_NAME,
  BACKGROUND_FUNCTION_NAME,
  assertCclWeeklyAuth,
  parseJsonBody,
  resolveDryRun,
  resolveMaxWrites,
  resolveTriggerType,
  dispatchCclWeeklyBackground,
  redactSecrets,
  isNetlifyPlatformScheduledInvocation
} = require("./lib/carnival-weekly-maintenance-dispatch");
const { handleLeasedWeeklyCron } = require("./lib/weekly-maintenance-schedule-control");

exports.handler = async (event) => {
  const started = Date.now();
  try {
    return await handleLeasedWeeklyCron(event, {
      supabase,
      lineSlug: "carnival-cruise-line",
      launcherFunctionName: LAUNCHER_FUNCTION_NAME,
      backgroundFunctionName: BACKGROUND_FUNCTION_NAME,
      redactSecrets,
      assertAuth: assertCclWeeklyAuth,
      parseJsonBody,
      resolveDryRun,
      resolveMaxWrites,
      resolveTriggerType,
      dispatchBackground: (args) =>
        dispatchCclWeeklyBackground({
          ...args,
          platformScheduled: isNetlifyPlatformScheduledInvocation(event)
        })
    });
  } catch (error) {
    console.error("carnival-weekly-maintenance-cron dispatch failed", {
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
          error: error.message || "Carnival weekly dispatch failed",
          code: error.code || null,
          elapsed_ms: Date.now() - started
        })
      )
    };
  }
};
