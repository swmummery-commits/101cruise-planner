#!/usr/bin/env node
/**
 * Production read-only HAL Discovery smoke test (2–3 API pages, no writes).
 *
 *   npm run smoke:hal-discovery-production
 *
 * Requires DISCOVERY_CRON_SECRET and deployed site URL (or NETLIFY_SITE_URL).
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

const siteUrl = String(process.env.NETLIFY_SITE_URL || process.env.URL || "https://101cruise.com.au").replace(
  /\/$/,
  ""
);
const secret = String(process.env.DISCOVERY_CRON_SECRET || "").trim();

async function main() {
  if (!secret) {
    console.error("DISCOVERY_CRON_SECRET is required for production smoke test");
    process.exit(1);
  }

  const endpoint = `${siteUrl}/.netlify/functions/hal-discovery-batch-background`;
  const started = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-discovery-cron-secret": secret
    },
    body: JSON.stringify({
      mode: "production_read_only",
      max_pages: 3,
      cursor_start: 0,
      run_id: `hal-smoke-${Date.now()}`
    })
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }

  const elapsedMs = Date.now() - started;
  const summary = {
    ok: response.ok && body.success,
    status: response.status,
    elapsed_ms: elapsedMs,
    mode: body.mode?.mode || body.mode,
    writes_performed: body.writes_performed,
    cursor: body.cursor,
    cruise_metrics: body.cruise_metrics,
    stats: body.stats
  };

  console.log(JSON.stringify(summary, null, 2));

  if (!summary.ok || summary.writes_performed) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
