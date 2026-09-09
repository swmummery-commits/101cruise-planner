/**
 * Silversea weekly maintenance — thin Scheduled Function launcher.
 * Dispatches to silversea-weekly-maintenance-background.
 */

const { supabase } = require("./lib/cruise-discovery-maintenance-cron");
const {
  LAUNCHER_FUNCTION_NAME,
  BACKGROUND_FUNCTION_NAME,
  assertSilverseaWeeklyAuth,
  parseJsonBody,
  resolveDryRun,
  resolveTriggerType,
  dispatchSilverseaWeeklyBackground,
  redactSecrets,
  isNetlifyPlatformScheduledInvocation
} = require("./lib/silversea-weekly-maintenance-dispatch");
const { handleLeasedWeeklyCron } = require("./lib/weekly-maintenance-schedule-control");

exports.handler = async (event) => {
  const started = Date.now();
  try {
    return await handleLeasedWeeklyCron(event, {
      supabase,
      lineSlug: "silversea-cruises",
      launcherFunctionName: LAUNCHER_FUNCTION_NAME,
      backgroundFunctionName: BACKGROUND_FUNCTION_NAME,
      redactSecrets,
      assertAuth: assertSilverseaWeeklyAuth,
      parseJsonBody,
      resolveDryRun: (body) => resolveDryRun(body, process.env),
      resolveTriggerType,
      dispatchBackground: (args) =>
        dispatchSilverseaWeeklyBackground({
          ...args,
          platformScheduled: isNetlifyPlatformScheduledInvocation(event)
        })
    });
  } catch (error) {
    return {
      statusCode: error.statusCode || 500,
      body: JSON.stringify(
        redactSecrets({
          success: false,
          error: error.message,
          code: error.code || null,
          elapsed_ms: Date.now() - started
        })
      )
    };
  }
};
