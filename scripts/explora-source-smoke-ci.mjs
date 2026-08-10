#!/usr/bin/env node
/**
 * Read-only Explora Journeys source smoke for local or GitHub Actions.
 *
 *   node scripts/explora-source-smoke-ci.mjs
 *
 * Hits the public catalogue + a representative detail-page sample.
 * Zero inventory writes. Does not require Supabase.
 */

import https from "https";

const SITEMAP_URL = "https://explorajourneys.com/int/en/journey.sitemap.xml";
const SAMPLE_JOURNEY_ID = "EX20260212MIASJU";
const SAMPLE_DETAIL_URL =
  "https://explorajourneys.com/int/en/destinations-globe/car/journeys/miasju-08-v12?id-journey=EX20260212MIASJU";
const UA = "101cruise-discovery/1.0 (+https://101cruise.com.au; explora-source-smoke)";

function httpGet(url) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      {
        headers: { "User-Agent": UA, Accept: "text/html,application/xml;q=0.9,*/*;q=0.8" },
        timeout: 30000
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, headers: {}, body: "", error: "timeout" });
    });
    req.on("error", (err) => resolve({ status: 0, headers: {}, body: "", error: err.message }));
  });
}

function schemaNodes(block) {
  if (!block || typeof block !== "object") return [];
  if (Array.isArray(block)) return block.flatMap(schemaNodes);
  const graph = Array.isArray(block["@graph"]) ? block["@graph"] : [];
  return [block, ...graph.flatMap(schemaNodes)];
}

function extractTripJsonLd(html) {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of blocks) {
    try {
      const data = JSON.parse(match[1]);
      for (const item of schemaNodes(data)) {
        const type = item?.["@type"];
        if (type === "Trip" || (Array.isArray(type) && type.includes("Trip"))) return item;
      }
    } catch {
      /* ignore malformed blocks */
    }
  }
  return null;
}

function looksLikeChallengePage(status, body) {
  if (status === 403 || status === 429) return true;
  if (!body || body.length < 2000) {
    return /captcha|cf-challenge|attention required|access denied|verify you are human/i.test(body || "");
  }
  // Normal Explora pages mention reCAPTCHA flags and Cloudflare; that is not a block.
  return /cf-challenge-running|cdn-cgi\/challenge|attention required|sorry, you have been blocked/i.test(body);
}

async function main() {
  const started = Date.now();
  for (const flag of ["EXPLORA_DISCOVERY_WRITE_ENABLED", "EXPLORA_WEEKLY_RECONCILIATION_ENABLED"]) {
    if (String(process.env[flag] || "").toLowerCase() === "true") {
      throw new Error(`${flag} must not be true for Explora source smoke`);
    }
  }

  const catalogue = await httpGet(SITEMAP_URL);
  const locs = [...catalogue.body.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
  const uniqueIds = new Set(
    locs
      .map((u) => {
        try {
          return new URL(u).searchParams.get("id-journey");
        } catch {
          return null;
        }
      })
      .filter(Boolean)
  );

  const detail = await httpGet(SAMPLE_DETAIL_URL);
  const trip = detail.status === 200 ? extractTripJsonLd(detail.body) : null;
  const challengeHints =
    looksLikeChallengePage(catalogue.status, catalogue.body) ||
    looksLikeChallengePage(detail.status, detail.body);

  const report = {
    execution_platform: process.env.GITHUB_ACTIONS === "true" ? "github_actions" : "local",
    github_run_id: process.env.GITHUB_RUN_ID || null,
    github_sha: process.env.GITHUB_SHA || null,
    runner_os: process.env.RUNNER_OS || process.platform || null,
    node_version: process.version,
    inventory_writes_performed: false,
    catalogue_url: SITEMAP_URL,
    catalogue_http_status: catalogue.status,
    catalogue_valid:
      catalogue.status === 200 &&
      catalogue.body.includes("<urlset") &&
      uniqueIds.size > 100,
    catalogue_unique_journey_ids: uniqueIds.size,
    sample_journey_id: SAMPLE_JOURNEY_ID,
    detail_http_status: detail.status,
    trip_json_ld_extracted: Boolean(trip),
    trip_name: trip?.name || null,
    blocking_or_challenge_detected: challengeHints,
    ok:
      catalogue.status === 200 &&
      uniqueIds.size > 100 &&
      detail.status === 200 &&
      Boolean(trip) &&
      !challengeHints,
    elapsed_ms: Date.now() - started
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((err) => {
  console.error(
    JSON.stringify({ ok: false, error: err.message || String(err), inventory_writes_performed: false })
  );
  process.exit(1);
});
