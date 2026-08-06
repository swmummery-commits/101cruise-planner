#!/usr/bin/env node
/**
 * Read-only weekly maintenance dry runs for HAL and Celebrity.
 *   npm run maintenance:dry-run
 */

const path = require("path");
const { createMaintenanceSupabase } = require(path.join(__dirname, "lib/supabase-rest.cjs"));
const { runHalWeeklyMaintenance, runCelebrityWeeklyMaintenance } = require(path.join(
  __dirname,
  "../netlify/functions/lib/cruise-discovery-maintenance-runner"
));

const root = path.join(__dirname, "..");
const supabase = createMaintenanceSupabase(root);

async function main() {
  console.log("Running HAL dry run...");
  const hal = await runHalWeeklyMaintenance({ dryRun: true, supabase, triggerType: "dry_run" });
  console.log("HAL:", JSON.stringify(hal.summary || hal, null, 2));
  if (!hal.ok) {
    console.error("HAL dry run failed:", hal.reason || hal);
    process.exit(1);
  }
  console.log("Running Celebrity dry run...");
  const celebrity = await runCelebrityWeeklyMaintenance({ dryRun: true, supabase, triggerType: "dry_run" });
  console.log("Celebrity:", JSON.stringify(celebrity.summary || celebrity, null, 2));
  if (!celebrity.ok) {
    console.error("Celebrity dry run failed:", celebrity.reason || celebrity);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
