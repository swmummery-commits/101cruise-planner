#!/usr/bin/env node
/**
 * Read-only HAL automatic-continuation readiness check at the last completed cursor.
 *
 *   node scripts/run-hal-readonly-continuation-dry-run.mjs
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const { createSupabaseRest, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { runHalDiscoveryBatch, acquireRunLock, releaseRunLock } = require(path.join(root, "netlify/functions/lib/holland-america-discovery-batch"));
const { catalogueDestinations } = require(path.join(root, "netlify/functions/lib/holland-america-discovery-adapter"));
const { evaluateAcceptanceGate } = require(path.join(root, "netlify/functions/lib/holland-america-discovery-writes"));
const { loadHalInventoryProgress } = require(path.join(root, "netlify/functions/lib/holland-america-discovery-run-tracking"));
const { evaluateAutomaticQualityGate, isHalAutomaticContinuationEnabled } = require(path.join(root, "netlify/functions/lib/holland-america-discovery-automation"));

const MAX_PAGES = 3;
const MAX_WRITES = 40;
const RUN_ID = `hal-readonly-dry-run-${new Date().toISOString().replace(/[:.]/g, "-")}`;

async function headCount(table, query = "") {
  const https = require("https");
  const { url, key } = getSupabaseConfig(root);
  return new Promise((resolve, reject) => {
    const u = new URL(`${url}/rest/v1/${table}?select=id${query ? `&${query}` : ""}`);
    const req = https.request(
      u,
      { method: "HEAD", headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" } },
      (res) => {
        const range = res.headers["content-range"] || "";
        const m = range.match(/\/(\d+)/);
        resolve(m ? Number(m[1]) : 0);
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function fetchCounts(halLineId) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    discovered_cruises: await headCount("discovered_cruises"),
    active_discovered: await headCount("discovered_cruises", "status=eq.active"),
    active_future: await headCount("discovered_cruises", `status=eq.active&departure_date=gte.${today}`),
    hal_active: halLineId
      ? await headCount("discovered_cruises", `cruise_line_id=eq.${encodeURIComponent(halLineId)}&status=eq.active`)
      : 0,
    review_items: await headCount("cruise_discovery_review_items"),
    ship_aliases: await headCount("cruise_ship_aliases"),
    destinations: await headCount("destinations"),
    destination_ports: await headCount("destination_ports"),
    resolution_audit: await headCount("cruise_discovery_resolution_audit"),
    discovery_runs: await headCount("cruise_discovery_runs")
  };
}

async function main() {
  const sb = createSupabaseRest(root);
  const lines = await sb.get("ci_cruise_lines?slug=eq.holland-america-line&select=id,name&limit=1");
  const line = lines?.[0];
  if (!line) throw new Error("Holland America Line not found");

  const { supabase } = require(path.join(root, "netlify/functions/lib/cruise-discovery-ops"));
  const countsBefore = await fetchCounts(line.id);
  const progress = await loadHalInventoryProgress(supabase, line.id);
  const cursorStart = progress.next_eligible_cursor ?? 108;

  const lock = acquireRunLock(RUN_ID);
  const ships = await sb.get(`ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&active=eq.true&select=id,name,cruise_line_id`);
  const destRows = await sb.get("destinations?classification_enabled=eq.true&select=id,name,slug,status,classification_enabled");

  const result = await runHalDiscoveryBatch({
    mode: "production_read_only",
    runId: RUN_ID,
    cursorStart,
    maxPages: MAX_PAGES,
    maxCandidates: MAX_WRITES,
    maxWrites: MAX_WRITES,
    buildManifest: true,
    performWrites: false,
    recordRun: false,
    useCache: false,
    cruiseLine: line,
    ships: ships || [],
    destinations: catalogueDestinations(destRows || []),
    supabase
  });
  releaseRunLock(RUN_ID);

  const gate = evaluateAcceptanceGate(result.manifest || { products: [] }, { minComplete: 1 });
  const autoGate = evaluateAutomaticQualityGate({
    manifest: result.manifest,
    stats: result.stats,
    cruiseMetrics: result.cruise_metrics,
    writeResult: { stats: { inserted: 0, updated: 0, failed: 0 } }
  });

  const countsAfter = await fetchCounts(line.id);

  console.log(
    JSON.stringify(
      {
        phase: "readonly_continuation_dry_run",
        automatic_continuation_enabled: isHalAutomaticContinuationEnabled(),
        cursor_start: cursorStart,
        overlap_lock_acquired: lock.acquired,
        progress,
        projected: {
          raw_products: result.stats?.raw_docs_seen ?? 0,
          cruise_products: result.stats?.product_type_cruise ?? 0,
          cruisetour_products: result.stats?.product_type_cruisetour ?? 0,
          complete_high_confidence: result.cruise_metrics?.complete_high_confidence ?? 0,
          incomplete_products: result.cruise_metrics?.incomplete_cruise ?? 0,
          proposed_writes: gate.proposed_write_count,
          destination_resolution_rate_pct: result.cruise_metrics?.destination_resolution_rate_pct ?? null,
          departure_port_rate_pct: result.cruise_metrics?.departure_port_rate_pct ?? null,
          acceptance_gate_passed: gate.passed,
          automatic_quality_gate_passed: autoGate.passed,
          proposed_next_cursor: result.cursor?.next_start ?? null
        },
        timing: result.timing,
        counts_before: countsBefore,
        counts_after: countsAfter,
        counts_unchanged: JSON.stringify(countsBefore) === JSON.stringify(countsAfter)
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
