#!/usr/bin/env node
/**
 * Dispatch a production Netlify Princess READ-ONLY harvest for P3O parity.
 * Unique namespace. Does not claim Monday scheduled lease. Zero inventory writes.
 *
 *   node scripts/dispatch-princess-p3o-netlify-parity.mjs
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
const dispatchId = `princess-p3o-netlify-parity-${new Date().toISOString().replace(/[:.]/g, "-")}`;

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
  const payload = {
    dry_run: true,
    trigger_type: "parity_test",
    dispatch_id: dispatchId,
    force_apply: false,
    max_writes: 30
  };
  const url = `${siteUrl}/.netlify/functions/princess-weekly-maintenance-cron`;
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
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 400) };
  }
  console.log(
    JSON.stringify(
      {
        ok: response.status === 202 || response.ok,
        status: response.status,
        dispatch_id: dispatchId,
        trigger_type: "parity_test",
        dry_run: true,
        force_apply: false,
        scheduled_lease_claimed: false,
        body
      },
      null,
      2
    )
  );
  process.exit(response.status === 202 || response.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
});
