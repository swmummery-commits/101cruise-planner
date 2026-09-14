#!/usr/bin/env node
/**
 * P3E Monday missed-run recovery.
 * Uses unique manual_recovery dispatch IDs. Does not delete or reuse W38 scheduled leases.
 *
 *   node scripts/run-p3e-manual-recovery-dispatch.mjs --line=explora
 *   node scripts/run-p3e-manual-recovery-dispatch.mjs --line=seabourn
 *   node scripts/run-p3e-manual-recovery-dispatch.mjs --line=royal --dry-run
 *   node scripts/run-p3e-manual-recovery-dispatch.mjs --line=norwegian
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { spawnSync } from "child_process";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  require("dotenv").config({ path: path.join(root, ".env") });
  require("dotenv").config({ path: path.join(root, ".env.local") });
} catch {
  /* optional */
}

const LINES = {
  explora: {
    slug: "explora-journeys",
    launcher: "explora-weekly-maintenance-cron",
    dispatchId: "explora:w38:manual-recovery-2026-09-14",
    dryRun: false
  },
  seabourn: {
    slug: "seabourn-cruise-line",
    launcher: "seabourn-weekly-maintenance-cron",
    dispatchId: "seabourn:w38:manual-recovery-2026-09-14",
    dryRun: false
  },
  royal: {
    slug: "royal-caribbean-international",
    launcher: "royal-caribbean-weekly-maintenance-cron",
    dispatchId: "royal-caribbean:w38:manual-recovery-2026-09-14",
    dryRun: true
  },
  norwegian: {
    slug: "norwegian-cruise-line",
    launcher: "norwegian-weekly-maintenance-cron",
    dispatchId: "norwegian:w38:manual-recovery-2026-09-14",
    dryRun: false
  }
};

const siteUrl = String(
  process.env.NETLIFY_SITE_URL || process.env.URL || "https://admirable-tiramisu-d4da8a.netlify.app"
).replace(/\/$/, "");

function resolveSecret() {
  const local = String(process.env.DISCOVERY_CRON_SECRET || "").trim();
  if (local) return local;
  const pull = spawnSync("npx", ["--yes", "netlify", "env:get", "DISCOVERY_CRON_SECRET"], {
    cwd: root,
    encoding: "utf8",
    env: process.env
  });
  return String(pull.stdout || "").trim();
}

async function main() {
  const arg = process.argv.find((item) => item.startsWith("--line="));
  const forceDry = process.argv.includes("--dry-run");
  const key = arg ? arg.slice("--line=".length) : "";
  const spec = LINES[key];
  if (!spec) {
    throw new Error(`Unknown line. Use --line=${Object.keys(LINES).join("|")}`);
  }
  if (["disney", "azamara", "silversea", "carnival"].includes(key)) {
    throw new Error("Do not overlap later scheduled slots");
  }

  const secret = resolveSecret();
  if (!secret) throw new Error("DISCOVERY_CRON_SECRET missing");

  const dryRun = forceDry || spec.dryRun;
  const payload = {
    dry_run: dryRun,
    trigger_type: "manual_recovery",
    dispatch_id: spec.dispatchId,
    original_missed_scheduled_period: "W38",
    recovery_reason: "preflight_consumed_scheduled_dispatch_lease",
    control_plane_defect: "launcher_and_dispatch_double_claimed_scheduled_lease",
    authorised_manual_recovery: true
  };

  const url = `${siteUrl}/.netlify/functions/${spec.launcher}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-discovery-cron-secret": secret
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  console.log(
    JSON.stringify(
      {
        line: spec.slug,
        dispatch_id: spec.dispatchId,
        dry_run: dryRun,
        http_status: response.status,
        body
      },
      null,
      2
    )
  );
  if (!response.ok && response.status !== 202) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
