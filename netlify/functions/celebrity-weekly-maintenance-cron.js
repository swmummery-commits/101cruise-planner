/**
 * Celebrity weekly maintenance — thin Scheduled Function launcher.
 * Schedule: Sunday 19:00 UTC = Monday 03:00 Australia/Perth.
 * Must stay under the Scheduled Function cap. Long work runs in
 * celebrity-weekly-maintenance-background.
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
  dispatchCelebrityWeeklyBackground,
  redactSecrets,
  isScheduledInvocation
} = require("./lib/celebrity-weekly-maintenance-dispatch");
const {
  withScheduledDispatchLease,
  alreadyDispatchedHttpResponse,
  collectInvocationProvenance
} = require("./lib/weekly-maintenance-schedule-control");

exports.handler = async (event) => {
  const started = Date.now();
  try {
    assertLauncherAuth(event);

    const body = parseJsonBody(event);
    const dryRun = resolveDryRun(body);
    const maxWrites = resolveMaxWrites(body);
    const triggerType = resolveTriggerType(event, body);
    const dispatchId = `celebrity-dispatch-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const provenance = collectInvocationProvenance(event, process.env, {
      function_name: LAUNCHER_FUNCTION_NAME,
      dispatch_id: dispatchId
    });

    const leased = await withScheduledDispatchLease({
      supabase,
      lineSlug: "celebrity-cruises",
      triggerType,
      dispatchId,
      dispatch: () =>
        dispatchCelebrityWeeklyBackground({
          dryRun,
          maxWrites,
          triggerType,
          dispatchId,
          nextRun: body.next_run || null,
          provenance
        })
    });

    if (leased.already_dispatched) {
      return alreadyDispatchedHttpResponse({
        dispatchId,
        periodKey: leased.period_key,
        launcher: LAUNCHER_FUNCTION_NAME,
        elapsedMs: Date.now() - started,
        redactSecrets
      });
    }

    const kick = leased.kick;
    const elapsed_ms = Date.now() - started;
    if (!kick?.accepted) {
      return {
        statusCode: 502,
        body: JSON.stringify(
          redactSecrets({
            success: false,
            phase: "dispatch",
            status: "dispatch_failed",
            launcher: LAUNCHER_FUNCTION_NAME,
            background: BACKGROUND_FUNCTION_NAME,
            dispatch_id: dispatchId,
            dry_run: dryRun,
            scheduled_invocation: isScheduledInvocation(event),
            invocation_provenance: provenance,
            background_http_status: kick?.status || null,
            error: "background_dispatch_rejected",
            detail: kick?.body,
            elapsed_ms
          })
        )
      };
    }

    return {
      statusCode: 202,
      body: JSON.stringify(
        redactSecrets({
          success: true,
          phase: "dispatch",
          status: "dispatched",
          maintenance_status: "pending_background",
          launcher: LAUNCHER_FUNCTION_NAME,
          background: BACKGROUND_FUNCTION_NAME,
          dispatch_id: dispatchId,
          dry_run: dryRun,
          max_writes: maxWrites,
          trigger_type: triggerType,
          scheduled_invocation: isScheduledInvocation(event),
          invocation_provenance: provenance,
          background_http_status: kick.status,
          elapsed_ms,
          note: "Background worker owns run-record lifecycle; poll cruise_discovery_runs for completion."
        })
      )
    };
  } catch (error) {
    console.error("celebrity-weekly-maintenance-cron dispatch failed", {
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
          error: error.message || "Celebrity weekly dispatch failed",
          code: error.code || null,
          elapsed_ms: Date.now() - started
        })
      )
    };
  }
};
