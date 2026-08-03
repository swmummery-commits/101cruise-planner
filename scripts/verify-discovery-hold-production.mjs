#!/usr/bin/env node
/**
 * Verify production Discovery hold controls (read-only / blocked requests).
 *   npm run verify:discovery-hold-production
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
const adminToken = String(process.env.ADMIN_API_TOKEN || process.env.DISCOVERY_ADMIN_TOKEN || "").trim();

async function postFunction(pathSuffix, body = {}, headers = {}) {
  const response = await fetch(`${siteUrl}/.netlify/functions/${pathSuffix}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { rawPreview: text.slice(0, 200) };
  }
  return { status: response.status, body: json };
}

async function headCount(table, query = "") {
  const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
  const https = require("https");
  const { getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
  const { url, key } = getSupabaseConfig(root);
  return new Promise((resolve, reject) => {
    const u = new URL(`${url}/rest/v1/${table}?select=id${query ? `&${query}` : ""}`);
    https
      .request(
        u,
        { method: "HEAD", headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" } },
        (res) => {
          const range = res.headers["content-range"] || "";
          const m = range.match(/\/(\d+)/);
          resolve(m ? Number(m[1]) : 0);
        }
      )
      .on("error", reject)
      .end();
  });
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const countsBefore = {
    discovered_cruises: await headCount("discovered_cruises"),
    active_cruises: await headCount("discovered_cruises", "status=eq.active"),
    active_future: await headCount(
      "discovered_cruises",
      `status=eq.active&or=(departure_date.is.null,departure_date.gte.${today})`
    ),
    pending_review: await headCount("cruise_discovery_review_items", "status=eq.pending"),
    discovery_runs: await headCount("cruise_discovery_runs")
  };

  const wave = secret
    ? await postFunction(
        "cruise-discovery-wave-background",
        { wave_id: "hold-verify", line_ids: [] },
        { "x-discovery-cron-secret": secret }
      )
    : { status: 503, body: { skipped: true, reason: "missing_secret" } };

  const adminHeaders = adminToken ? { Authorization: `Bearer ${adminToken}` } : {};
  const startDiscovery = adminToken
    ? await postFunction("cruise-discovery", { action: "start_discovery", scope: "full" }, adminHeaders)
    : { status: 503, body: { skipped: true, reason: "missing_admin_token" } };
  const expireSailed = adminToken
    ? await postFunction("cruise-discovery", { action: "expire_sailed" }, adminHeaders)
    : { status: 503, body: { skipped: true, reason: "missing_admin_token" } };

  const countsAfter = {
    discovered_cruises: await headCount("discovered_cruises"),
    active_cruises: await headCount("discovered_cruises", "status=eq.active"),
    active_future: await headCount(
      "discovered_cruises",
      `status=eq.active&or=(departure_date.is.null,departure_date.gte.${today})`
    ),
    pending_review: await headCount("cruise_discovery_review_items", "status=eq.pending"),
    discovery_runs: await headCount("cruise_discovery_runs")
  };

  const result = {
    wave_blocked: wave.status === 409 || wave.body?.blocked === true,
    wave_status: wave.status,
    start_discovery_blocked: startDiscovery.status === 409,
    start_discovery_status: startDiscovery.status,
    expire_sailed_blocked: expireSailed.status === 409,
    expire_sailed_status: expireSailed.status,
    counts_before: countsBefore,
    counts_after: countsAfter,
    database_unchanged: JSON.stringify(countsBefore) === JSON.stringify(countsAfter)
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
