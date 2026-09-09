/**
 * Azamara weekly inventory maintenance — thin Scheduled Function launcher.
 */

const { supabase } = require("./lib/cruise-discovery-maintenance-cron");
const {
  LAUNCHER_FUNCTION_NAME,
  BACKGROUND_FUNCTION_NAME,
  assertAzamaraWeeklyAuth,
  parseJsonBody,
  resolveDryRun,
  resolveMaxWrites,
  resolveTriggerType,
  dispatchAzamaraWeeklyBackground,
  redactSecrets,
  isNetlifyPlatformScheduledInvocation
} = require("./lib/azamara-weekly-maintenance-dispatch");
const { handleLeasedWeeklyCron } = require("./lib/weekly-maintenance-schedule-control");

exports.handler = async (event) => {
  const started = Date.now();
  try {
    return await handleLeasedWeeklyCron(event, {
      supabase,
      lineSlug: "azamara",
      launcherFunctionName: LAUNCHER_FUNCTION_NAME,
      backgroundFunctionName: BACKGROUND_FUNCTION_NAME,
      redactSecrets,
      assertAuth: assertAzamaraWeeklyAuth,
      parseJsonBody,
      resolveDryRun,
      resolveMaxWrites,
      resolveTriggerType,
      dispatchBackground: (args) =>
        dispatchAzamaraWeeklyBackground({
          ...args,
          platformScheduled: isNetlifyPlatformScheduledInvocation(event)
        })
    });
  } catch (error) {
    console.error("azamara-weekly-maintenance-cron dispatch failed", {
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
          error: error.message || "Azamara weekly dispatch failed",
          code: error.code || null,
          elapsed_ms: Date.now() - started
        })
      )
    };
  }
};
