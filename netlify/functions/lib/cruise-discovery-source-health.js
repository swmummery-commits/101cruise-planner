/**
 * Source health classification for Cruise Discovery lines.
 * Calculated from configuration + recent run stats — no schema writes.
 */

const HEALTH = {
  HEALTHY: "healthy",
  HEALTHY_NO_SAILINGS: "healthy_no_current_sailings",
  MISCONFIGURED: "misconfigured",
  EXTRACTION_FAILED: "extraction_failed",
  JS_DATA_REQUIRED: "javascript_data_required",
  TEMPORARILY_UNAVAILABLE: "temporarily_unavailable",
  BLOCKED: "blocked",
  UNSUPPORTED: "unsupported"
};

function hostnameOf(url) {
  try {
    return new URL(String(url || "").trim()).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function inferSourceUrlType(line) {
  const search = String(line.cruise_search_url || "").trim();
  const website = String(line.website_url || "").trim();
  if (!search && !website) return "missing";
  const u = search || website;
  const path = (() => {
    try {
      return new URL(u).pathname.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (/sitemap/i.test(u)) return "sitemap";
  if (/find-a-cruise|cruise-search|search/i.test(path)) return "search_page";
  if (/\/cruises?\/?$/i.test(path) || /\/cruises?\//i.test(path)) return "cruise_listing";
  if (/\/destinations?\//i.test(path)) return "destination_page";
  if (/\/ships?\//i.test(path) || /\/fleet/i.test(path)) return "fleet_page";
  if (path === "/" || path === "") return "homepage";
  if (/itinerar|sailing|voyage|journey|expedition/i.test(path)) return "itinerary_listing";
  return "other_official_url";
}

function classifyLineHealth({ line, lastRun, activeFutureCount, activeAllCount }) {
  if (!line.sold_by_101cruise) return { status: HEALTH.UNSUPPORTED, primary_issue: "Not sold by 101cruise" };
  if (!line.website_url && !line.cruise_search_url) {
    return {
      status: HEALTH.MISCONFIGURED,
      primary_issue: "Missing website_url and cruise_search_url",
      recommended_action: "Set official website and cruise search URL in Cruise Intelligence"
    };
  }
  if (!line.cruise_search_url) {
    return {
      status: HEALTH.MISCONFIGURED,
      primary_issue: "Missing cruise_search_url (using website_url fallback)",
      recommended_action: "Add dedicated cruise search or sailing listing URL"
    };
  }

  const stats = lastRun?.stats || {};
  const fetchFailed = stats.pages_fetched === 0 && lastRun?.status === "completed" && (stats.candidates ?? 0) === 0;
  const jsHint =
    stats.source_method_counts?.official_embedded_json > 0 ||
    stats.source_method_counts?.official_api > 0 ||
    stats.javascript_empty_html === true;

  if (lastRun?.status === "failed") {
    const err = String(lastRun.error_message || stats.error_message || "").toLowerCase();
    if (/403|401|blocked|captcha|forbidden/.test(err)) {
      return { status: HEALTH.BLOCKED, primary_issue: lastRun.error_message || "Access blocked" };
    }
    return {
      status: HEALTH.TEMPORARILY_UNAVAILABLE,
      primary_issue: lastRun.error_message || "Last run failed",
      recommended_action: "Retry fetch; check URL availability"
    };
  }

  if (activeFutureCount > 0) {
    return { status: HEALTH.HEALTHY, primary_issue: null, recommended_action: null };
  }

  if (lastRun && (stats.candidates ?? 0) > 0 && (stats.upserted_active ?? stats.cruises_inserted ?? 0) === 0) {
    return {
      status: HEALTH.EXTRACTION_FAILED,
      primary_issue: "Candidates found but none validated",
      recommended_action: jsHint ? "Inspect structured/JS data extraction" : "Review URL patterns and extraction"
    };
  }

  if (jsHint && (stats.candidates ?? 0) === 0) {
    return {
      status: HEALTH.JS_DATA_REQUIRED,
      primary_issue: "Page hints at JS/API data but no voyages extracted",
      recommended_action: "Inspect embedded JSON or sitemap; avoid paid rendering until approved"
    };
  }

  if (lastRun?.status === "completed" && fetchFailed) {
    return {
      status: HEALTH.TEMPORARILY_UNAVAILABLE,
      primary_issue: "Fetch returned no pages",
      recommended_action: "Verify cruise_search_url responds with HTML"
    };
  }

  if (lastRun?.status === "completed") {
    return {
      status: HEALTH.HEALTHY_NO_SAILINGS,
      primary_issue: activeAllCount > 0 ? "Active sailings exist but past departure" : "No current sailings in inventory",
      recommended_action: "Run discovery or verify source exposes future sailings"
    };
  }

  return {
    status: HEALTH.UNSUPPORTED,
    primary_issue: "No discovery run recorded",
    recommended_action: "Run Verify Selected Line or Full Discovery"
  };
}

function inferRunType(run) {
  if (!run) return "none";
  const rt = run.stats?.run_type || "";
  if (rt === "hal_weekly_maintenance") return "hal_weekly_maintenance";
  if (rt === "celebrity_weekly_maintenance") return "celebrity_weekly_maintenance";
  if (rt === "daily_expiry_maintenance") return "daily_expiry_maintenance";
  if (rt === "hal_controlled_batch") return "hal_controlled_batch";
  if (rt === "hal_automatic_batch") return "hal_automatic_batch";
  const tb = run.stats?.triggered_by || "";
  if (tb === "selected_line_verification") return "verify_selected_line";
  if (tb === "weekly_cron") return "scheduled_wave";
  if (run.scope === "destination") return "discover_selected_destination";
  if (run.scope === "cruise_line") return "discover_selected_cruise_line";
  if (run.scope === "full" && tb === "admin") return "run_full_discovery_line";
  if (run.scope === "full") return "full_discovery_line";
  return run.scope || "unknown";
}

function buildLineHealthRow({ line, runs, activeFutureByLine, activeAllByLine }) {
  const lineRuns = (runs || []).filter((r) => r.cruise_line_id === line.id);
  const lastRun = lineRuns[0] || null;
  const stats = lastRun?.stats || {};
  const health = classifyLineHealth({
    line,
    lastRun,
    activeFutureCount: activeFutureByLine[line.id] || 0,
    activeAllCount: activeAllByLine[line.id] || 0
  });

  return {
    cruise_line_id: line.id,
    cruise_line: line.name,
    slug: line.slug,
    enabled: Boolean(line.active && line.sold_by_101cruise),
    source_url: line.cruise_search_url || line.website_url || null,
    source_url_type: inferSourceUrlType(line),
    official_domain: hostnameOf(line.website_url || line.cruise_search_url),
    last_run_at: lastRun?.finished_at || lastRun?.started_at || null,
    last_run_type: inferRunType(lastRun),
    last_run_status: lastRun?.status || null,
    pages_checked: stats.pages_fetched ?? 0,
    candidates: stats.candidates ?? 0,
    activated: stats.upserted_active ?? stats.cruises_inserted ?? 0,
    active_future_sailings: activeFutureByLine[line.id] || 0,
    active_all_status: activeAllByLine[line.id] || 0,
    source_health: health.status,
    primary_issue: health.primary_issue,
    recommended_action: health.recommended_action,
    adapter_id: stats.adapter_id || null,
    last_error: lastRun?.error_message || stats.error_message || null
  };
}

function summariseLineHealth(rows) {
  const summary = {
    enabled_lines: 0,
    healthy: 0,
    healthy_no_current_sailings: 0,
    misconfigured: 0,
    extraction_failed: 0,
    javascript_data_required: 0,
    temporarily_unavailable: 0,
    blocked: 0,
    unsupported: 0,
    lines_with_future_active: 0
  };
  for (const row of rows || []) {
    if (!row.enabled) continue;
    summary.enabled_lines += 1;
    const key = String(row.source_health || "unsupported").replace(/-/g, "_");
    if (summary[key] != null) summary[key] += 1;
    if ((row.active_future_sailings || 0) > 0) summary.lines_with_future_active += 1;
  }
  return summary;
}

module.exports = {
  HEALTH,
  inferRunType,
  inferSourceUrlType,
  classifyLineHealth,
  buildLineHealthRow,
  summariseLineHealth
};
