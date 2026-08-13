#!/usr/bin/env node
/**
 * Production read-only Royal Caribbean Discovery smoke (Netlify runtime).
 *
 *   npm run smoke:royal-caribbean-discovery-production
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
  const authoritative = process.argv.includes("--authoritative");
  if (!secret) {
    console.error("DISCOVERY_CRON_SECRET is required for production smoke test");
    process.exit(1);
  }

  const endpoint = `${siteUrl}/.netlify/functions/royal-caribbean-discovery-smoke`;
  const started = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-discovery-cron-secret": secret
    },
    body: JSON.stringify({
      mode: "production_read_only",
      authoritative_enumeration: authoritative
    })
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
    endpoint: "royal-caribbean-discovery-smoke",
    site_url: siteUrl,
    elapsed_ms: Date.now() - started,
    graphql_valid: body.graphql_valid,
    upstream_http_status: body.upstream_http_status,
    fleet_count: body.fleet_count,
    sample_group_count: body.sample_group_count,
    authoritative_enumeration_requested: body.authoritative_enumeration_requested,
    authoritative_sailing_ids_union: body.authoritative_sailing_ids_union,
    authoritative_requests: body.authoritative_requests,
    user_agent: body.user_agent,
    deploy_url: body.deploy_url,
    deployed_commit_ref: body.deployed_commit_ref,
    writes_performed: body.writes_performed,
    inventory_writes: body.inventory_writes,
    duration_ms: body.duration_ms
  };

  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok || summary.writes_performed) process.exit(1);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
