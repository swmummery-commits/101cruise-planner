#!/usr/bin/env node
/**
 * Dispatch a production Netlify Princess READ-ONLY source diagnostic for P3P.
 * Unique namespace. Does not claim Monday scheduled lease. Zero inventory writes.
 *
 *   node scripts/dispatch-princess-p3p-netlify-diagnostic.mjs
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { spawnSync } from "child_process";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const siteUrl = String(
  process.env.NETLIFY_SITE_URL || process.env.URL || "https://admirable-tiramisu-d4da8a.netlify.app"
).replace(/\/$/, "");
const dispatchId = `princess-p3p-netlify-diag-${new Date().toISOString().replace(/[:.]/g, "-")}`;

function resolveSecret() {
  const local = String(process.env.DISCOVERY_CRON_SECRET || "").trim();
  if (local) return local;
  const commands = [
    ["npx", ["--yes", "netlify", "env:get", "DISCOVERY_CRON_SECRET", "--context", "production"]],
    ["npx", ["--yes", "netlify-cli", "env:get", "DISCOVERY_CRON_SECRET", "--context", "production"]]
  ];
  for (const [cmd, args] of commands) {
    const pull = spawnSync(cmd, args, { cwd: root, encoding: "utf8" });
    const value = String(pull.stdout || "").trim();
    if (value && !/error|unauthorized/i.test(value)) return value;
  }
  return "";
}

async function main() {
  const secret = resolveSecret();
  if (!secret) {
    console.error(JSON.stringify({ ok: false, error: "DISCOVERY_CRON_SECRET missing" }));
    process.exit(1);
  }
  const smokeUrl = `${siteUrl}/.netlify/functions/princess-discovery-smoke`;
  const weeklyUrl = `${siteUrl}/.netlify/functions/princess-weekly-maintenance-cron`;
  const smokeResponse = await fetch(smokeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-discovery-cron-secret": secret
    },
    body: JSON.stringify({ mode: "production_read_only", collectSourceDiagnostics: true })
  });
  const smokeText = await smokeResponse.text();
  let smokeBody = null;
  try {
    smokeBody = smokeText ? JSON.parse(smokeText) : null;
  } catch {
    smokeBody = { raw: smokeText.slice(0, 400) };
  }
  const weeklyResponse = await fetch(weeklyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-discovery-cron-secret": secret
    },
    body: JSON.stringify({
      dry_run: true,
      trigger_type: "p3p_source_diagnostic",
      dispatch_id: dispatchId,
      force_apply: false,
      max_writes: 30,
      collectSourceDiagnostics: true
    })
  });
  const weeklyText = await weeklyResponse.text();
  let weeklyBody = null;
  try {
    weeklyBody = weeklyText ? JSON.parse(weeklyText) : null;
  } catch {
    weeklyBody = { raw: weeklyText.slice(0, 400) };
  }
  console.log(
    JSON.stringify(
      {
        ok: smokeResponse.ok || weeklyResponse.status === 202,
        smoke_status: smokeResponse.status,
        weekly_status: weeklyResponse.status,
        dispatch_id: dispatchId,
        trigger_type: "p3p_source_diagnostic",
        dry_run: true,
        writes: 0,
        smoke: smokeBody,
        weekly: weeklyBody
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message || String(error) }));
  process.exit(1);
});
