#!/usr/bin/env node
/**
 * Production read-only Celebrity Discovery smoke test.
 *   npm run smoke:celebrity-discovery-production
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
const secret = String(process.env.DISCOVERY_CRON_SECRET || "").trim();

async function main() {
  if (!secret) {
    console.error("DISCOVERY_CRON_SECRET is required for production smoke test");
    process.exit(1);
  }

  const endpoint = `${siteUrl}/.netlify/functions/celebrity-discovery-smoke`;
  const started = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-discovery-cron-secret": secret
    },
    body: JSON.stringify({ mode: "production_read_only" })
  });

  const body = await response.json().catch(() => ({}));
  const summary = {
    ok: response.status === 200 && body.ok === true,
    status: response.status,
    endpoint: "celebrity-discovery-smoke",
    elapsed_ms: Date.now() - started,
    ...body
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok || summary.writesPerformed) process.exit(1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
