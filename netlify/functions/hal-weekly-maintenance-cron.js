/**
 * Holland America weekly maintenance — thin Scheduled Function launcher.
 * Schedule: Sunday 18:00 UTC = Monday 02:00 Australia/Perth.
 * Must stay under the Scheduled Function cap. Long work runs in
 * hal-weekly-maintenance-background.
 */

const { supabase } = require("./lib/cruise-discovery-maintenance-cron");
const {
  LAUNCHER_FUNCTION_NAME,
  BACKGROUND_FUNCTION_NAME,
  assertLauncherAuth,
  parseJsonBody,
  resolveDryRun,
  resolveMaxWrites,
  resolveTriggerType,
  dispatchHalWeeklyBackground,
  redactSecrets
} = require("./lib/hal-weekly-maintenance-dispatch");
const { handleLeasedWeeklyCron } = require("./lib/weekly-maintenance-schedule-control");

exports.handler = async (event) => {
  const started = Date.now();
  try {
    return await handleLeasedWeeklyCron(event, {
      supabase,
      lineSlug: "holland-america-line",
      launcherFunctionName: LAUNCHER_FUNCTION_NAME,
      backgroundFunctionName: BACKGROUND_FUNCTION_NAME,
      redactSecrets,
      assertAuth: assertLauncherAuth,
      parseJsonBody,
      resolveDryRun,
      resolveMaxWrites,
      resolveTriggerType,
      dispatchBackground: dispatchHalWeeklyBackground
    });
  } catch (error) {
    console.error("hal-weekly-maintenance-cron dispatch failed", {
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
          error: error.message || "HAL weekly dispatch failed",
          code: error.code || null,
          elapsed_ms: Date.now() - started
        })
      )
    };
  }
};
