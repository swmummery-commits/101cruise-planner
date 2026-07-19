/**
 * Admin Usage & Insights aggregates.
 *
 * GET /.netlify/functions/usage-insights?range=7d|30d|90d|today|custom&from=&to=
 * GET /.netlify/functions/usage-insights?range=7d&customer=<booking_reference>
 *
 * Requires Admin JWT. Reads via service role.
 *
 * Phase 1 loads capped raw event rows and aggregates in JavaScript.
 * When a query returns exactly its row limit, the response sets
 * reporting.incomplete = true so Admin does not treat results as complete.
 *
 * Future scaling: once event volume makes raw-row aggregation impractical,
 * move reporting aggregation into SQL (GROUP BY / window functions) or
 * maintain rollup tables. Do not raise row caps indefinitely.
 */

const RANGE_EVENT_LIMIT = 5000;
const LOOKBACK_EVENT_LIMIT = 8000;

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

function config() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error("Supabase server configuration is missing");
  return { supabaseUrl, serviceKey };
}

const { requireAdmin } = require("./admin-auth");

async function rest(path) {
  const { supabaseUrl, serviceKey } = config();
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Accept: "application/json"
    }
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_error) {
    data = null;
  }
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `Supabase HTTP ${response.status}`);
  }
  return Array.isArray(data) ? data : [];
}

const MODULE_LABELS = {
  dashboard: "Dashboard",
  booking: "Booking",
  packing: "Pack List",
  preparation: "Checklist",
  documents: "Documents",
  budget: "Budget",
  the_ship: "Your Ship",
  drinks_calculator: "Drinks Calculator",
  public_drinks_calculator: "Public Drinks Calculator"
};

const EVENT_LABELS = {
  page_open: "Opened",
  tool_started: "Started",
  tool_completed: "Completed",
  save: "Saved",
  document_upload: "Uploaded a document",
  login: "Signed in",
  logout: "Signed out"
};

function resolveRange(params) {
  const now = new Date();
  const end = new Date(now);
  end.setUTCHours(23, 59, 59, 999);
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);

  const range = String(params.range || "7d").trim();
  if (range === "today") {
    return { start, end, range };
  }
  if (range === "custom") {
    const from = params.from ? new Date(`${params.from}T00:00:00.000Z`) : start;
    const to = params.to ? new Date(`${params.to}T23:59:59.999Z`) : end;
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw Object.assign(new Error("Invalid custom date range."), { statusCode: 400 });
    }
    return { start: from, end: to, range };
  }

  const days = range === "30d" ? 30 : range === "90d" ? 90 : 7;
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { start, end, range: range === "30d" || range === "90d" ? range : "7d" };
}

function customerKey(event) {
  if (event.booking_reference) return `b:${event.booking_reference}`;
  if (event.user_id) return `u:${event.user_id}`;
  return `s:${event.session_id}`;
}

function customerLabel(event) {
  const label = event.metadata && event.metadata.customer_label;
  if (label) return String(label);
  if (event.booking_reference) return event.booking_reference;
  if (event.surface === "public_tools") return "Public visitor";
  return "Guest";
}

function activityLabel(event) {
  const moduleLabel = MODULE_LABELS[event.module] || event.module;
  const typeLabel = EVENT_LABELS[event.event_type] || event.event_type;
  if (event.event_type === "page_open") return `Opened ${moduleLabel}`;
  if (event.event_type === "tool_completed") return `Completed ${moduleLabel}`;
  if (event.event_type === "tool_started") return `Started ${moduleLabel}`;
  if (event.event_type === "document_upload") return "Uploaded a document";
  return `${typeLabel} ${moduleLabel}`;
}

function buildInsights(events, rangeInfo) {
  const myCruiseEvents = events.filter(event => event.surface === "my_cruise");
  const publicEvents = events.filter(event => event.surface === "public_tools");

  const activeCustomers = new Set(
    myCruiseEvents
      .filter(event => event.booking_reference || event.user_id)
      .map(customerKey)
  );

  const sessions = new Set(
    events.filter(event => event.surface !== "admin").map(event => event.session_id)
  );

  const moduleStats = {};
  Object.keys(MODULE_LABELS).forEach(moduleName => {
    moduleStats[moduleName] = {
      module: moduleName,
      label: MODULE_LABELS[moduleName],
      customers: new Set(),
      sessions: new Set(),
      lastUsed: null,
      priorSessions: new Set()
    };
  });

  const midpoint = new Date(
    rangeInfo.start.getTime() + (rangeInfo.end.getTime() - rangeInfo.start.getTime()) / 2
  );

  events.forEach(event => {
    if (event.surface !== "my_cruise") return;
    const stats = moduleStats[event.module];
    if (!stats) return;
    stats.sessions.add(event.session_id);
    if (event.booking_reference || event.user_id) stats.customers.add(customerKey(event));
    const occurred = new Date(event.occurred_at);
    if (!stats.lastUsed || occurred > new Date(stats.lastUsed)) {
      stats.lastUsed = event.occurred_at;
    }
    if (occurred < midpoint) stats.priorSessions.add(event.session_id);
  });

  const toolUsage = Object.values(moduleStats)
    .map(stats => {
      const uniqueCustomers = stats.customers.size;
      const sessionCount = stats.sessions.size;
      const priorCount = stats.priorSessions.size;
      const recentCount = Math.max(0, sessionCount - priorCount);
      let trend = "flat";
      if (recentCount > priorCount) trend = "up";
      if (recentCount < priorCount) trend = "down";
      return {
        module: stats.module,
        tool: stats.label,
        unique_customers: uniqueCustomers,
        sessions: sessionCount,
        avg_sessions_per_customer:
          uniqueCustomers > 0 ? Number((sessionCount / uniqueCustomers).toFixed(2)) : 0,
        last_used: stats.lastUsed,
        trend
      };
    })
    .filter(row => row.sessions > 0)
    .sort((a, b) => b.sessions - a.sessions || a.tool.localeCompare(b.tool));

  const mostUsedTool = toolUsage[0] ? toolUsage[0].tool : "—";

  const publicCalculator = {
    tool: "Public Drinks Calculator",
    page_views: 0,
    starts: 0,
    completed: 0,
    completion_rate: 0
  };
  publicEvents.forEach(event => {
    if (event.module !== "public_drinks_calculator") return;
    if (event.event_type === "page_open") publicCalculator.page_views += 1;
    if (event.event_type === "tool_started") publicCalculator.starts += 1;
    if (event.event_type === "tool_completed") publicCalculator.completed += 1;
  });
  if (publicCalculator.starts > 0) {
    publicCalculator.completion_rate = Number(
      ((publicCalculator.completed / publicCalculator.starts) * 100).toFixed(1)
    );
  } else if (publicCalculator.page_views > 0 && publicCalculator.completed > 0) {
    publicCalculator.completion_rate = Number(
      ((publicCalculator.completed / publicCalculator.page_views) * 100).toFixed(1)
    );
  }

  const customerMap = new Map();
  myCruiseEvents.forEach(event => {
    if (!event.booking_reference && !event.user_id) return;
    const key = customerKey(event);
    let row = customerMap.get(key);
    if (!row) {
      row = {
        key,
        customer: customerLabel(event),
        booking_reference: event.booking_reference || null,
        cruise: (event.metadata && event.metadata.cruise_name) || null,
        cruise_line: (event.metadata && event.metadata.cruise_line) || null,
        last_active: event.occurred_at,
        tools: new Set(),
        visits: new Set(),
        recent: []
      };
      customerMap.set(key, row);
    }
    row.tools.add(MODULE_LABELS[event.module] || event.module);
    row.visits.add(event.session_id);
    if (new Date(event.occurred_at) > new Date(row.last_active)) {
      row.last_active = event.occurred_at;
      if (event.metadata?.cruise_name) row.cruise = event.metadata.cruise_name;
      if (event.metadata?.cruise_line) row.cruise_line = event.metadata.cruise_line;
      if (event.metadata?.customer_label) row.customer = event.metadata.customer_label;
    }
    row.recent.push({
      occurred_at: event.occurred_at,
      label: activityLabel(event),
      module: event.module,
      event_type: event.event_type
    });
  });

  const customers = Array.from(customerMap.values())
    .map(row => ({
      key: row.key,
      customer: row.customer,
      booking_reference: row.booking_reference,
      cruise: row.cruise,
      cruise_line: row.cruise_line,
      last_active: row.last_active,
      tools_used: Array.from(row.tools).sort(),
      visits: row.visits.size,
      recent_activity: row.recent
        .sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)))
        .slice(0, 20)
    }))
    .sort((a, b) => String(b.last_active).localeCompare(String(a.last_active)));

  const inactiveCutoff = new Date();
  inactiveCutoff.setUTCDate(inactiveCutoff.getUTCDate() - 30);
  const inactiveCustomers = customers.filter(
    row => new Date(row.last_active) < inactiveCutoff
  ).length;

  const recentActivity = events
    .filter(event => event.surface !== "admin")
    .slice()
    .sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)))
    .slice(0, 40)
    .map(event => ({
      occurred_at: event.occurred_at,
      customer: customerLabel(event),
      booking_reference: event.booking_reference || null,
      label: activityLabel(event),
      surface: event.surface,
      module: event.module,
      event_type: event.event_type
    }));

  return {
    summary: {
      active_customers: activeCustomers.size,
      total_sessions: sessions.size,
      most_used_tool: mostUsedTool,
      inactive_30_days: inactiveCustomers,
      public_calculator_uses: publicCalculator.page_views + publicCalculator.completed
    },
    tool_usage: toolUsage,
    customers,
    public_tools: [publicCalculator],
    recent_activity: recentActivity
  };
}

exports.handler = async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, { success: true });
  }

  if (event.httpMethod !== "GET") {
    return jsonResponse(405, {
      success: false,
      error: "METHOD_NOT_ALLOWED",
      message: "Use GET to load usage insights."
    });
  }

  try {
    await requireAdmin(event);
    const params = event.queryStringParameters || {};
    const rangeInfo = resolveRange(params);

    const andFilter = `and=(occurred_at.gte.${rangeInfo.start.toISOString()},occurred_at.lte.${rangeInfo.end.toISOString()})`;
    const events = await rest(
      `usage_events?select=id,occurred_at,user_id,booking_reference,session_id,surface,module,event_type,metadata,device_type&${andFilter}&order=occurred_at.desc&limit=${RANGE_EVENT_LIMIT}`
    );
    const rangeCapped = events.length >= RANGE_EVENT_LIMIT;

    if (params.customer) {
      const key = String(params.customer).trim();
      const filtered = events.filter(
        event =>
          event.booking_reference === key ||
          customerKey(event) === key ||
          `b:${event.booking_reference}` === key
      );
      const insights = buildInsights(filtered.length ? filtered : events, rangeInfo);
      const customer =
        insights.customers.find(
          row => row.key === key || row.booking_reference === key || row.key === `b:${key}`
        ) || null;
      return jsonResponse(200, {
        success: true,
        range: rangeInfo.range,
        from: rangeInfo.start.toISOString(),
        to: rangeInfo.end.toISOString(),
        reporting: {
          incomplete: rangeCapped,
          range_capped: rangeCapped,
          lookback_capped: false,
          range_limit: RANGE_EVENT_LIMIT,
          lookback_limit: LOOKBACK_EVENT_LIMIT,
          range_rows: events.length,
          lookback_rows: 0
        },
        customer
      });
    }

    const insights = buildInsights(events, rangeInfo);

    // Inactive 30+ days: customers with any My Cruise activity in the last 180 days
    // whose most recent activity is older than 30 days.
    const lookbackStart = new Date();
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - 180);
    const lookbackEvents = await rest(
      `usage_events?select=booking_reference,user_id,session_id,occurred_at,surface&and=(surface.eq.my_cruise,occurred_at.gte.${lookbackStart.toISOString()})&order=occurred_at.desc&limit=${LOOKBACK_EVENT_LIMIT}`
    );
    const lookbackCapped = lookbackEvents.length >= LOOKBACK_EVENT_LIMIT;
    const lastSeen = new Map();
    lookbackEvents.forEach(event => {
      if (!event.booking_reference && !event.user_id) return;
      const key = customerKey(event);
      if (!lastSeen.has(key)) lastSeen.set(key, event.occurred_at);
    });
    const inactiveCutoff = new Date();
    inactiveCutoff.setUTCDate(inactiveCutoff.getUTCDate() - 30);
    let inactiveCount = 0;
    lastSeen.forEach(occurredAt => {
      if (new Date(occurredAt) < inactiveCutoff) inactiveCount += 1;
    });
    insights.summary.inactive_30_days = inactiveCount;

    const incomplete = rangeCapped || lookbackCapped;

    return jsonResponse(200, {
      success: true,
      range: rangeInfo.range,
      from: rangeInfo.start.toISOString(),
      to: rangeInfo.end.toISOString(),
      reporting: {
        incomplete,
        range_capped: rangeCapped,
        lookback_capped: lookbackCapped,
        range_limit: RANGE_EVENT_LIMIT,
        lookback_limit: LOOKBACK_EVENT_LIMIT,
        range_rows: events.length,
        lookback_rows: lookbackEvents.length
      },
      ...insights
    });
  } catch (error) {
    console.error("usage-insights error", error);
    const status = error.statusCode || 500;
    return jsonResponse(status, {
      success: false,
      error: status === 401 || status === 403 ? "UNAUTHORIZED" : "INSIGHTS_UNAVAILABLE",
      message: error.message || "Unable to load usage insights."
    });
  }
};
