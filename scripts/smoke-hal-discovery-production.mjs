#!/usr/bin/env node
/**
 * Production read-only HAL Discovery smoke test (synchronous endpoint).
 *
 *   npm run smoke:hal-discovery-production
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

  const endpoint = `${siteUrl}/.netlify/functions/hal-discovery-smoke`;
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
    endpoint: "hal-discovery-smoke",
    elapsed_ms: Date.now() - started,
    mode: body.mode,
    pagesFetched: body.pagesFetched,
    rawProducts: body.rawProducts,
    cruiseProducts: body.cruiseProducts,
    cruisetourProducts: body.cruisetourProducts,
    completeHighConfidence: body.completeHighConfidence,
    nextCursor: body.nextCursor,
    writesPerformed: body.writesPerformed,
    durationMs: body.durationMs,
    transpacificResolved: body.transpacificResolved,
    fairbanksAsCruise: body.fairbanksAsCruise
  };

  console.log(JSON.stringify(summary, null, 2));

  if (!summary.ok || summary.writesPerformed) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
