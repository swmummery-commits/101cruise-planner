#!/usr/bin/env node
/**
 * Read-only Discovery inventory + line audit.
 * NO WRITES. NO SQL.
 *
 *   node scripts/audit-discovery-inventory.mjs
 *   node scripts/audit-discovery-inventory.mjs --output=reports/discovery-inventory-audit.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const today = new Date().toISOString().slice(0, 10);

function parseArgs(argv) {
  const args = { output: path.join(root, "reports/discovery-inventory-audit.json") };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--output=")) args.output = arg.slice("--output=".length);
  }
  return args;
}

function classifyActiveRecord(row) {
  if (row.status !== "active") return row.status;
  if (row.departure_date && row.departure_date < today) return "active_but_past_departure";
  return "active_future_or_null_date";
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createSupabaseRest(root);

  const [
    allActive,
    dashboardActive,
    lines,
    allLines,
    runs,
    nonHidden,
    hidden,
    expired
  ] = await Promise.all([
    sb.get("discovered_cruises?status=eq.active&select=id,status,departure_date,cruise_line_id,ship_id,destination_id,official_url,external_key,discovered_at,last_changed_at&order=departure_date.asc&limit=5000"),
    sb.get(`discovered_cruises?status=eq.active&or=(departure_date.is.null,departure_date.gte.${today})&select=id,departure_date,cruise_line_id,official_url&limit=5000`),
    sb.get("ci_cruise_lines?active=eq.true&sold_by_101cruise=eq.true&select=id,name,slug,active,sold_by_101cruise,website_url,cruise_search_url,fleet_page_url&order=name.asc&limit=500"),
    sb.get("ci_cruise_lines?active=eq.true&select=id,name,slug,active,sold_by_101cruise,website_url,cruise_search_url,fleet_page_url&order=name.asc&limit=500"),
    sb.get("cruise_discovery_runs?select=id,scope,status,stats,started_at,finished_at,created_at,cruise_line_id,destination_id,error_message&order=created_at.desc&limit=50"),
    sb.get("discovered_cruises?status=neq.hidden&select=id,status,cruise_line_id,departure_date&limit=5000"),
    sb.get("discovered_cruises?status=eq.hidden&select=id&limit=5000"),
    sb.get(`discovered_cruises?status=eq.expired&select=id,departure_date&limit=5000`)
  ]);

  const lineById = Object.fromEntries((allLines || []).map((l) => [l.id, l]));
  const dashboardIds = new Set((dashboardActive || []).map((r) => r.id));

  const activeComparison = (allActive || []).map((row) => {
    const line = lineById[row.cruise_line_id];
    const visibility = classifyActiveRecord(row);
    return {
      id: row.id,
      cruise_line: line?.name || row.cruise_line_id,
      departure_date: row.departure_date,
      official_url: row.official_url,
      ship_id: row.ship_id,
      destination_id: row.destination_id,
      status: row.status,
      visibility,
      in_dashboard_active_count: dashboardIds.has(row.id),
      excluded_from_dashboard_reason:
        visibility === "active_but_past_departure"
          ? "departure_date_before_today"
          : !dashboardIds.has(row.id)
            ? "not_in_dashboard_query"
            : null
    };
  });

  const lastRun = runs?.[0] || null;
  const lastStats = lastRun?.stats || {};
  const lastLine = lastRun?.cruise_line_id ? lineById[lastRun.cruise_line_id] : null;

  function inferRunType(run) {
    if (!run) return "unknown";
    const tb = run.stats?.triggered_by || "";
    if (tb === "selected_line_verification") return "verify_selected_line";
    if (tb === "weekly_cron") return "scheduled_wave";
    if (run.scope === "destination") return "discover_selected_destination";
    if (run.scope === "cruise_line") return "discover_selected_cruise_line";
    if (run.scope === "full" && tb === "admin") return "run_full_discovery_line";
    if (run.scope === "full") return "full_discovery_line";
    return run.scope || "unknown";
  }

  const perLineActive = {};
  for (const row of allActive || []) {
    const lid = row.cruise_line_id || "unknown";
    perLineActive[lid] = (perLineActive[lid] || 0) + 1;
  }

  const perLineFutureActive = {};
  for (const row of dashboardActive || []) {
    const lid = row.cruise_line_id || "unknown";
    perLineFutureActive[lid] = (perLineFutureActive[lid] || 0) + 1;
  }

  const lineAudit = (lines || []).map((line) => {
    const lineRuns = (runs || []).filter((r) => r.cruise_line_id === line.id);
    const lastLineRun = lineRuns[0] || null;
    const ls = lastLineRun?.stats || {};
    let sourceType = "missing";
    if (line.cruise_search_url) sourceType = "cruise_search_url";
    else if (line.website_url) sourceType = "website_url_only";
    let configClass = "G_disabled_or_ok";
    if (!line.website_url && !line.cruise_search_url) configClass = "C_misconfigured";
    else if (!line.cruise_search_url) configClass = "C_search_url_missing";
    else if (line.cruise_search_url && !line.website_url) configClass = "C_website_missing";

    const hasRecentSuccess = lineRuns.some((r) => r.status === "completed");
    const lastCandidates = ls.candidates ?? 0;
    const lastActivated = ls.upserted_active ?? ls.cruises_inserted ?? 0;

    let health = "unsupported";
    if (!line.website_url && !line.cruise_search_url) health = "misconfigured";
    else if (lastLineRun?.status === "failed") health = "temporarily_unavailable";
    else if ((perLineFutureActive[line.id] || 0) > 0) health = "healthy";
    else if (hasRecentSuccess && lastCandidates === 0) health = "healthy_no_current_sailings";
    else if (hasRecentSuccess && lastCandidates > 0 && lastActivated === 0) health = "extraction_failed";
    else if (!lineRuns.length) health = "unsupported";

    return {
      id: line.id,
      name: line.name,
      slug: line.slug,
      sold_by_101cruise: line.sold_by_101cruise,
      website_url: line.website_url,
      cruise_search_url: line.cruise_search_url,
      fleet_page_url: line.fleet_page_url,
      source_type: sourceType,
      config_class: configClass,
      active_all_status: perLineActive[line.id] || 0,
      active_future_dashboard: perLineFutureActive[line.id] || 0,
      last_run_at: lastLineRun?.finished_at || lastLineRun?.started_at || null,
      last_run_status: lastLineRun?.status || null,
      last_run_type: inferRunType(lastLineRun),
      last_run_candidates: lastCandidates,
      last_run_activated: lastActivated,
      last_run_adapter: ls.adapter_id || null,
      last_run_error: lastLineRun?.error_message || ls.error_message || null,
      source_health: health
    };
  });

  const report = {
    generated_at: new Date().toISOString(),
    mode: "read_only",
    today,
    counts: {
      active_all_status: (allActive || []).length,
      active_dashboard_future_filter: (dashboardActive || []).length,
      active_past_departure_still_active_status: activeComparison.filter(
        (r) => r.visibility === "active_but_past_departure"
      ).length,
      active_future_or_null: activeComparison.filter((r) => r.visibility === "active_future_or_null_date").length,
      non_hidden_candidates: (nonHidden || []).length,
      hidden: (hidden || []).length,
      expired: (expired || []).length,
      enabled_discovery_lines: (lines || []).length,
      all_active_ci_lines: (allLines || []).length
    },
    reconciliation_13_vs_8: {
      prior_report_claim: 13,
      current_dashboard_active: (dashboardActive || []).length,
      current_browse_active_all_status: (allActive || []).length,
      likely_explanation:
        (allActive || []).length !== (dashboardActive || []).length
          ? "Dashboard applies future departure_date filter; Browse Active lists all status=active"
          : "Counts align — prior report may reflect different timestamp or environment",
      record_level: activeComparison
    },
    last_dashboard_run: {
      run_id: lastRun?.id,
      scope: lastRun?.scope,
      status: lastRun?.status,
      inferred_type: inferRunType(lastRun),
      triggered_by: lastStats.triggered_by,
      cruise_line: lastLine?.name || lastRun?.cruise_line_id,
      destination_id: lastRun?.destination_id,
      started_at: lastRun?.started_at,
      finished_at: lastRun?.finished_at,
      stats: lastStats,
      note:
        lastStats.cruise_lines_scanned != null
          ? "cruise_lines_scanned from last run stats"
          : "Dashboard fallback counts completed runs in last 25 when stat absent"
    },
    recent_runs: (runs || []).slice(0, 15).map((r) => ({
      id: r.id,
      scope: r.scope,
      status: r.status,
      type: inferRunType(r),
      line: lineById[r.cruise_line_id]?.name || r.cruise_line_id,
      started_at: r.started_at,
      candidates: r.stats?.candidates ?? 0,
      activated: r.stats?.upserted_active ?? r.stats?.cruises_inserted ?? 0,
      triggered_by: r.stats?.triggered_by
    })),
    line_audit: lineAudit,
    lines_not_sold_by_101: (allLines || [])
      .filter((l) => !l.sold_by_101cruise)
      .map((l) => ({ id: l.id, name: l.name }))
  };

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, JSON.stringify(report, null, 2));

  console.log("Discovery inventory audit (READ ONLY)");
  console.log("Active (all status=active):", report.counts.active_all_status);
  console.log("Active (dashboard future filter):", report.counts.active_dashboard_future_filter);
  console.log("Past departure still active:", report.counts.active_past_departure_still_active_status);
  console.log("Enabled discovery lines:", report.counts.enabled_discovery_lines);
  console.log("Last run type:", report.last_dashboard_run.inferred_type);
  console.log("Last run line:", report.last_dashboard_run.cruise_line);
  console.log("Report:", args.output);
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
