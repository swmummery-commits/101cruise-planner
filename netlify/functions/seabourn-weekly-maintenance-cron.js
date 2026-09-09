/**
 * Seabourn weekly inventory maintenance — thin Scheduled Function launcher.
 *
 * Target slot: schedule = "0 22 * * 0" (Sunday 22:00 UTC / Monday 06:00 Perth).
 */

const { supabase } = require("./lib/cruise-discovery-maintenance-cron");
const {
  LAUNCHER_FUNCTION_NAME,
  BACKGROUND_FUNCTION_NAME,
  assertSeabournWeeklyAuth,
  parseJsonBody,
  resolveDryRun,
  resolveMaxWrites,
  resolveTriggerType,
  dispatchSeabournWeeklyBackground,
  redactSecrets,
  isNetlifyPlatformScheduledInvocation
} = require("./lib/seabourn-weekly-maintenance-dispatch");
const { handleLeasedWeeklyCron } = require("./lib/weekly-maintenance-schedule-control");

exports.handler = async (event) => {
  const started = Date.now();
  try {
    return await handleLeasedWeeklyCron(event, {
      supabase,
      lineSlug: "seabourn-cruise-line",
      launcherFunctionName: LAUNCHER_FUNCTION_NAME,
      backgroundFunctionName: BACKGROUND_FUNCTION_NAME,
      redactSecrets,
      assertAuth: assertSeabournWeeklyAuth,
      parseJsonBody,
      resolveDryRun,
      resolveMaxWrites,
      resolveTriggerType,
      dispatchBackground: (args) =>
        dispatchSeabournWeeklyBackground({
          ...args,
          platformScheduled: isNetlifyPlatformScheduledInvocation(event)
        })
    });
  } catch (error) {
    console.error("seabourn-weekly-maintenance-cron dispatch failed", {
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
          error: error.message || "Seabourn weekly dispatch failed",
          code: error.code || null,
          elapsed_ms: Date.now() - started
        })
      )
    };
  }
};
