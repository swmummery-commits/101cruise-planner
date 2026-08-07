#!/usr/bin/env node
/**
 * Production read-only Princess Discovery smoke test (deployed function).
 *
 *   npm run smoke:princess-discovery-production
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

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
  try {
    const { execSync } = require("child_process");
    const value = execSync("netlify env:get DISCOVERY_CRON_SECRET --context production", {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return value;
  } catch {
    return "";
  }
}

async function main() {
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

  const summary = {
    ok: response.status === 200 && body.ok === true,
    status: response.status,
    endpoint: "princess-discovery-smoke",
    elapsed_ms: Date.now() - started,
    ...body
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    !summary.ok ||
    summary.writesPerformed ||
    summary.rollbackManifestId ||
    summary.activeProductionTotal !== 20 ||
    summary.qualityGatePassed !== true
  ) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
