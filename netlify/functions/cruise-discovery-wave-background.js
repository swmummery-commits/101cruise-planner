/**
 * Background worker: full discovery across cruise lines (up to ~15 minutes).
 *
 * Invoked by cruise-discovery-cron (weekly) or manually with
 * header x-discovery-cron-secret = DISCOVERY_CRON_SECRET.
 *
 * Netlify background functions: filename must end in -background.
 */

const {
  discoverOneLine,
  listActiveSoldCruiseLineIds
} = require("./lib/cruise-discovery-runner");

function cronSecret() {
  return String(process.env.DISCOVERY_CRON_SECRET || "").trim();
}

function assertCronAuth(event) {
  const expected = cronSecret();
  if (!expected) {
    const err = new Error("DISCOVERY_CRON_SECRET is not configured");
    err.statusCode = 503;
    throw err;
  }
  const provided = String(
    event.headers?.["x-discovery-cron-secret"] ||
      event.headers?.["X-Discovery-Cron-Secret"] ||
      ""
  ).trim();
  if (provided !== expected) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
}

exports.handler = async (event) => {
  try {
    assertCronAuth(event);

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      body = {};
    }

    const waveId = String(body.wave_id || `wave-${Date.now()}`).trim();
    let lineIds = Array.isArray(body.line_ids)
      ? body.line_ids.map((id) => String(id || "").trim()).filter(Boolean)
      : [];

    if (!lineIds.length) {
      const lines = await listActiveSoldCruiseLineIds();
      lineIds = lines.map((l) => l.id);
    }

    console.log("cruise-discovery-wave-background start", {
      waveId,
      line_count: lineIds.length
    });

    const results = [];
    for (let i = 0; i < lineIds.length; i += 1) {
      const cruiseLineId = lineIds[i];
      console.log("cruise-discovery-wave-background line", {
        waveId,
        index: i,
        total: lineIds.length,
        cruiseLineId
      });
      try {
        const result = await discoverOneLine({
          cruiseLineId,
          scope: "full",
          triggeredBy: "weekly_cron"
        });
        results.push({
          cruise_line_id: cruiseLineId,
          ok: true,
          run_id: result.run_id,
          stats: result.stats
        });
      } catch (error) {
        console.error("cruise-discovery-wave-background line failed", cruiseLineId, error);
        results.push({
          cruise_line_id: cruiseLineId,
          ok: false,
          error: error.message || "Discovery failed"
        });
      }
    }

    const summary = {
      success: true,
      wave_id: waveId,
      line_count: lineIds.length,
      completed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results
    };
    console.log("cruise-discovery-wave-background done", summary);
    return {
      statusCode: 200,
      body: JSON.stringify(summary)
    };
  } catch (error) {
    console.error("cruise-discovery-wave-background", error);
    return {
      statusCode: error.statusCode || 500,
      body: JSON.stringify({
        success: false,
        error: error.message || "Discovery wave failed"
      })
    };
  }
};
