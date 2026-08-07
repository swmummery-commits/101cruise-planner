#!/usr/bin/env node
/**
 * Production read-only Princess Discovery smoke test (deployed function).
 *
 *   npm run smoke:princess-discovery-production
 *   node scripts/smoke-princess-discovery-production.mjs --expected-active=120
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = { expectedActive: null };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--expected-active=")) out.expectedActive = Number(arg.split("=")[1]);
  }
  return out;
}

function loadEnv() {
  try {
    const dotenv = require("dotenv");
    dotenv.config({ path: path.join(root, ".env") });
    dotenv.config({ path: path.join(root, ".env.local") });
  } catch {
    /* optional */
  }
}

loadEnv();

const siteUrl = String(
  process.env.NETLIFY_SITE_URL || process.env.URL || "https://admirable-tiramisu-d4da8a.netlify.app"
).replace(/\/$/, "");

async function resolveCronSecret() {
  if (String(process.env.DISCOVERY_CRON_SECRET || "").trim()) {
    return String(process.env.DISCOVERY_CRON_SECRET).trim();
  }
  const { execSync } = require("child_process");
  const commands = [
    "netlify env:get DISCOVERY_CRON_SECRET --context production",
    "npx --yes netlify-cli env:get DISCOVERY_CRON_SECRET --context production"
  ];
  for (const command of commands) {
    try {
      const value = execSync(command, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
      if (value) return value;
    } catch {
      /* try next */
    }
  }
  return "";
}

async function main() {
  const args = parseArgs(process.argv);
  const secret = await resolveCronSecret();
  if (!secret) {
    console.error("DISCOVERY_CRON_SECRET is required for production smoke test");
    process.exit(1);
  }

  const endpoint = `${siteUrl}/.netlify/functions/princess-discovery-smoke`;
  const started = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-discovery-cron-secret": secret
    },
    body: JSON.stringify({ mode: "production_read_only" })
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { ok: false, parseError: true, rawPreview: text.slice(0, 200) };
  }

  const expectedActive = args.expectedActive;
  const actualActive = body.activeProductionTotal;
  const summary = {
    ok: response.status === 200 && body.ok === true,
    status: response.status,
    endpoint: "princess-discovery-smoke",
    elapsed_ms: Date.now() - started,
    expected_active: expectedActive,
    actual_active: actualActive,
    active_delta:
      expectedActive != null && actualActive != null ? actualActive - expectedActive : null,
    proposed_inserts: body.proposedInserts ?? null,
    unchanged: body.unchanged ?? null,
    snapshot_id: body.snapshotId ?? null,
    source_error: body.sourceError ?? null,
    source_error_stage: body.sourceErrorStage ?? null,
    source_diagnostics: body.sourceDiagnostics ?? null,
    ...body
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    !summary.ok ||
    body.writesPerformed ||
    body.rollbackManifestId ||
    body.sourceError ||
    body.sourceErrorStage ||
    body.qualityGatePassed !== true ||
    (expectedActive != null && actualActive !== expectedActive)
  ) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
