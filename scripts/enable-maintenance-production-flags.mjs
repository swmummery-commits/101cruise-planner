#!/usr/bin/env node
/**
 * Enable dedicated maintenance flags in Netlify production.
 * Keeps bulk-import and general Discovery flags disabled.
 *
 *   node scripts/enable-maintenance-production-flags.mjs
 */

import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const ENABLE = [
  "HAL_WEEKLY_RECONCILIATION_ENABLED=true",
  "CELEBRITY_WEEKLY_RECONCILIATION_ENABLED=true",
  "ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED=true",
  "CRUISE_DAILY_EXPIRY_ENABLED=true"
];

const KEEP_FALSE = [
  "CRUISE_DISCOVERY_AUTOMATION_ENABLED=false",
  "CRUISE_DISCOVERY_EXPIRE_SAILED_ENABLED=false",
  "HAL_DISCOVERY_WRITE_ENABLED=false",
  "HAL_AUTOMATIC_CONTINUATION_ENABLED=false",
  "CELEBRITY_DISCOVERY_WRITE_ENABLED=false",
  "CELEBRITY_AUTOMATIC_CONTINUATION_ENABLED=false",
  "ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED=false"
];

function run(args) {
  const result = spawnSync("npm", ["exec", "--", "netlify", ...args], { cwd: root, encoding: "utf8" });
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr, status: result.status };
}

console.log("Setting dedicated maintenance flags in Netlify production...");
for (const entry of [...ENABLE, ...KEEP_FALSE]) {
  const [key, value] = entry.split("=");
  const res = run(["env:set", key, value, "--context", "production"]);
  console.log(`${key}=${value}`, res.ok ? "ok" : `failed (${res.stderr || res.status})`);
}

console.log("\nRollback: netlify env:set HAL_WEEKLY_RECONCILIATION_ENABLED false --context production");
console.log("Rollback: netlify env:set CELEBRITY_WEEKLY_RECONCILIATION_ENABLED false --context production");
console.log("Rollback: netlify env:set CRUISE_DAILY_EXPIRY_ENABLED false --context production");
