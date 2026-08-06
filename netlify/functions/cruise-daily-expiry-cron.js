/**
 * Daily sailed-cruise expiration (Netlify Scheduled Function).
 * Schedule: 17:30 UTC daily = 01:30 Australia/Perth
 */

const { isCruiseDailyExpiryEnabled } = require("./lib/cruise-discovery-maintenance");
const { executeDailyExpiry } = require("./lib/cruise-discovery-maintenance-cron");

exports.handler = async (event) => {
  const started = Date.now();
  try {
    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      body = {};
    }

    const dryRun = body.dry_run === true || !isCruiseDailyExpiryEnabled();
    const result = await executeDailyExpiry({
      dryRun,
      triggerType: body.trigger_type || "scheduled"
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ ...result, elapsed_ms: Date.now() - started })
    };
  } catch (error) {
    console.error("cruise-daily-expiry-cron failed", error);
    return {
      statusCode: error.statusCode || 500,
      body: JSON.stringify({ success: false, error: error.message || "Daily expiry failed" })
    };
  }
};
