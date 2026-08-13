#!/usr/bin/env node
/**
 * Read-only Royal Caribbean International source smoke for local or GitHub Actions.
 *
 *   node scripts/royal-caribbean-source-smoke-ci.mjs
 *
 * Hits the public GraphQL catalogue + fleet query.
 * Zero inventory writes. Does not require Supabase.
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const {
  GRAPH_URL,
  USER_AGENT,
  SEARCH_QUERY,
  FLEET_QUERY,
  looksLikeAkamaiDenied,
  expandGraphGroupsToRawSailings
} = require(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-source"));

async function postGraph(query, variables) {
  const started = Date.now();
  try {
    const response = await fetch(GRAPH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": USER_AGENT
      },
      body: JSON.stringify({ query, variables })
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return {
      status: response.status,
      ok: response.ok,
      ms: Date.now() - started,
      content_type: response.headers.get("content-type"),
      bytes: text.length,
      denied: looksLikeAkamaiDenied(response.status, text),
      json,
      preview: json ? null : text.slice(0, 180)
    };
  } catch (error) {
    return {
      status: 0,
      ok: false,
      ms: Date.now() - started,
      error: error.message,
      denied: false,
      json: null
    };
  }
}

async function main() {
  const started = Date.now();
  for (const flag of [
    "ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED",
    "ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED"
  ]) {
    if (String(process.env[flag] || "").toLowerCase() === "true") {
      throw new Error(`${flag} must not be true for Royal Caribbean source smoke`);
    }
  }

  const search = await postGraph(SEARCH_QUERY, {
    filters: "{}",
    pagination: { count: 5, skip: 0 }
  });
  const fleet = await postGraph(FLEET_QUERY, {});

  const cruises = search.json?.data?.cruiseSearch?.results?.cruises || [];
  const total = search.json?.data?.cruiseSearch?.results?.total ?? null;
  const expanded = expandGraphGroupsToRawSailings(cruises, {
    today: new Date().toISOString().slice(0, 10),
    futureOnly: false
  });
  const sample = expanded.products[0] || null;
  const ships = fleet.json?.data?.ships || [];

  const report = {
    execution_platform: process.env.GITHUB_ACTIONS === "true" ? "github_actions" : "local",
    github_run_id: process.env.GITHUB_RUN_ID || null,
    github_sha: process.env.GITHUB_SHA || null,
    runner_os: process.env.RUNNER_OS || process.platform || null,
    node_version: process.version,
    inventory_writes_performed: false,
    endpoint: GRAPH_URL,
    method: "POST",
    user_agent: USER_AGENT,
    search_http_status: search.status,
    search_ok: search.ok && Boolean(search.json?.data?.cruiseSearch),
    search_denied: search.denied,
    search_ms: search.ms,
    search_content_type: search.content_type,
    graphql_errors: search.json?.errors?.map((e) => e.message) || [],
    total_official_groups: total,
    returned_groups: cruises.length,
    sample_sailings: expanded.products.length,
    sample: sample
      ? {
          official_sailing_id: sample.official_sailing_id,
          ship: sample.ship_name,
          departure_date: sample.departure_date,
          nights: sample.nights,
          departure_port: sample.departure_port,
          destination: sample.destination_name
        }
      : null,
    fleet_http_status: fleet.status,
    fleet_ok: fleet.ok && ships.length > 0,
    fleet_count: ships.length,
    elapsed_ms: Date.now() - started
  };

  const ok =
    report.search_ok &&
    report.fleet_ok &&
    !report.search_denied &&
    Number(report.total_official_groups) > 0 &&
    report.sample_sailings > 0 &&
    report.inventory_writes_performed === false;

  console.log(JSON.stringify({ ok, ...report }, null, 2));
  if (!ok) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
