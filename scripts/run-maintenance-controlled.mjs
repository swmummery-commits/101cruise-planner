#!/usr/bin/env node
/**
 * Controlled production maintenance runs (max 20 writes per line).
 * Requires maintenance flags enabled locally.
 *   HAL_WEEKLY_RECONCILIATION_ENABLED=true CELEBRITY_WEEKLY_RECONCILIATION_ENABLED=true npm run maintenance:controlled-run
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  require("dotenv").config({ path: path.join(root, ".env") });
} catch {
  /* optional */
}

const { runHalWeeklyMaintenance, runCelebrityWeeklyMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-runner"
));
const { executeWeeklyMaintenance, executeDailyExpiry } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-cron"
));
const { createMaintenanceSupabase, loadEnvFile } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const {
  assertHalWeeklyMaintenanceEnabled,
  assertCelebrityWeeklyMaintenanceEnabled,
  assertDailyExpiryEnabled,
  HAL_WEEKLY_MAINTENANCE_RUN_TYPE,
  CELEBRITY_WEEKLY_MAINTENANCE_RUN_TYPE
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));

async function main() {
  const supabase = createMaintenanceSupabase(root);
  const halLine = (await supabase("ci_cruise_lines?slug=eq.holland-america-line&select=id&limit=1"))?.[0];
  const celLine = (await supabase("ci_cruise_lines?slug=eq.celebrity-cruises&select=id&limit=1"))?.[0];

  assertHalWeeklyMaintenanceEnabled();
  assertCelebrityWeeklyMaintenanceEnabled();
  assertDailyExpiryEnabled();

  const hal = await executeWeeklyMaintenance({
    lineSlug: "holland-america-line",
    cruiseLineId: halLine.id,
    runType: HAL_WEEKLY_MAINTENANCE_RUN_TYPE,
    assertEnabled: assertHalWeeklyMaintenanceEnabled,
    runMaintenance: runHalWeeklyMaintenance,
    dryRun: false,
    maxWrites: 20,
    triggerType: "controlled_first_run",
    supabaseClient: supabase
  });
  console.log("HAL controlled:", JSON.stringify(hal, null, 2));

  const halIdem = await runHalWeeklyMaintenance({
    dryRun: true,
    performWrites: false,
    supabase,
    triggerType: "idempotency_check"
  });
  console.log("HAL idempotency dry:", JSON.stringify(halIdem.summary || halIdem, null, 2));

  const celebrity = await executeWeeklyMaintenance({
    lineSlug: "celebrity-cruises",
    cruiseLineId: celLine.id,
    runType: CELEBRITY_WEEKLY_MAINTENANCE_RUN_TYPE,
    assertEnabled: assertCelebrityWeeklyMaintenanceEnabled,
    runMaintenance: runCelebrityWeeklyMaintenance,
    dryRun: false,
    maxWrites: 20,
    triggerType: "controlled_first_run",
    supabaseClient: supabase
  });
  console.log("Celebrity controlled:", JSON.stringify(celebrity, null, 2));

  const celIdem = await runCelebrityWeeklyMaintenance({
    dryRun: true,
    performWrites: false,
    supabase,
    triggerType: "idempotency_check"
  });
  console.log("Celebrity idempotency dry:", JSON.stringify(celIdem.summary || celIdem, null, 2));

  const expirySim = await executeDailyExpiry({ dryRun: true, triggerType: "simulation" });
  console.log("Expiry simulation:", JSON.stringify(expirySim, null, 2));

  const expiry = await executeDailyExpiry({ dryRun: false, triggerType: "controlled_first_run" });
  console.log("Expiry run:", JSON.stringify(expiry, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
