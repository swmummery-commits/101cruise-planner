/**
 * Sprint 12A — Deck Plan Links API.
 *
 * POST /.netlify/functions/deck-plans
 * Actions:
 *   dashboard | list_lines | list_ships | find | approve | reject_candidate |
 *   mark_status | clear_candidates | coverage_audit | list_history |
 *   list_missing_for_bulk | reverify
 *
 * Assisted discovery only. No automatic publishing. No scheduled runs.
 */

const { requireAdmin } = require("./admin-auth");
const {
  findDeckPlanCandidates,
  domainFromUrl,
  isBlockedDomain,
  sameSiteOrSubdomain
} = require("./lib/deck-plan-find");

const STATUSES = new Set([
  "missing",
  "found",
  "needs_review",
  "approved",
  "outdated",
  "unavailable"
]);

const SOURCE_TYPES = new Set([
  "official_page",
  "official_pdf",
  "official_interactive_viewer",
  "other_official_asset"
]);

const HISTORY_ACTIONS = new Set([
  "source_added",
  "source_replaced",
  "source_marked_outdated",
  "source_reverified",
  "source_rejected"
]);

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server access is not configured");
  return { url: url.replace(/\/$/, ""), key };
}

async function supabase(path, options = {}) {
  const { url, key } = config();
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    ...(options.headers || {})
  };
  if (options.body !== undefined && options.body !== null) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }
  const response = await fetch(`${url}/rest/v1/${path}`, { ...options, headers });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const msg = data?.message || data?.error || data?.msg || `HTTP ${response.status}`;
    const err = new Error(msg);
    err.statusCode = response.status;
    err.body = data;
    throw err;
  }
  return data;
}

function adminLabel(user) {
  return (
    String(user?.email || user?.user_metadata?.full_name || user?.id || "admin").trim() || "admin"
  );
}

function publicDeckUrl(row) {
  return (
    String(row.deck_plan_url || "").trim() ||
    String(row.deck_plan_pdf_url || "").trim() ||
    String(row.deck_plan_page_url || "").trim() ||
    ""
  );
}

function mapShipRow(row) {
  const line = row.ci_cruise_lines || {};
  const candidates = Array.isArray(row.deck_plan_candidates) ? row.deck_plan_candidates : [];
  return {
    id: row.id,
    name: row.name,
    active: row.active,
    cruise_line_id: row.cruise_line_id,
    cruise_line_name: line.name || "",
    website_url: line.website_url || "",
    official_ship_url: row.official_ship_url || "",
    deck_plan_status: row.deck_plan_status || "missing",
    deck_plan_url: publicDeckUrl(row),
    deck_plan_page_url: row.deck_plan_page_url || "",
    deck_plan_pdf_url: row.deck_plan_pdf_url || "",
    deck_plan_source_type: row.deck_plan_source_type || "",
    deck_plan_source_domain: row.deck_plan_source_domain || "",
    deck_plan_version: row.deck_plan_version || "",
    deck_plan_effective_date: row.deck_plan_effective_date || null,
    deck_plan_last_verified_at: row.deck_plan_last_verified_at || null,
    deck_plan_verified_by: row.deck_plan_verified_by || "",
    deck_plan_notes: row.deck_plan_notes || "",
    deck_plan_last_searched_at: row.deck_plan_last_searched_at || null,
    deck_plan_search_count: row.deck_plan_search_count || 0,
    deck_plan_brave_request_count: row.deck_plan_brave_request_count || 0,
    candidates,
    candidate_count: candidates.length
  };
}

async function recordHistory({ shipId, action, previousUrl, newUrl, administrator, notes }) {
  if (!HISTORY_ACTIONS.has(action)) return;
  try {
    await supabase("deck_plan_history", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        ship_id: shipId,
        action,
        previous_url: previousUrl || null,
        new_url: newUrl || null,
        administrator: administrator || null,
        notes: notes || null
      })
    });
  } catch (error) {
    // History must not block approval if the history table is missing or RLS blocks writes.
    console.warn("[deck-plans] history write failed:", error.message || error);
  }
}

async function loadShip(shipId) {
  const rows =
    (await supabase(
      `ci_cruise_ships?id=eq.${encodeURIComponent(shipId)}&select=id,name,active,cruise_line_id,official_ship_url,deck_plan_url,deck_plan_status,deck_plan_page_url,deck_plan_pdf_url,deck_plan_source_type,deck_plan_source_domain,deck_plan_version,deck_plan_effective_date,deck_plan_last_verified_at,deck_plan_verified_by,deck_plan_notes,deck_plan_candidates,deck_plan_last_searched_at,deck_plan_search_count,deck_plan_brave_request_count,ci_cruise_lines(id,name,website_url)`
    )) || [];
  return rows[0] || null;
}

async function dashboard() {
  const ships =
    (await supabase(
      "ci_cruise_ships?select=id,active,deck_plan_status,deck_plan_last_verified_at&active=eq.true"
    )) || [];

  const counts = {
    total_active_ships: ships.length,
    approved: 0,
    missing: 0,
    needs_review: 0,
    found: 0,
    outdated: 0,
    unavailable: 0
  };

  let lastVerification = null;
  for (const ship of ships) {
    const status = ship.deck_plan_status || "missing";
    if (counts[status] != null) counts[status] += 1;
    else counts.missing += 1;
    if (ship.deck_plan_last_verified_at) {
      if (!lastVerification || ship.deck_plan_last_verified_at > lastVerification) {
        lastVerification = ship.deck_plan_last_verified_at;
      }
    }
  }

  return {
    cards: {
      total_active_ships: counts.total_active_ships,
      approved_deck_plans: counts.approved,
      missing_deck_plans: counts.missing,
      needs_review: counts.needs_review + counts.found,
      outdated: counts.outdated,
      unavailable: counts.unavailable,
      last_verification_run: lastVerification
    }
  };
}

async function coverageAudit() {
  const [ships, lines] = await Promise.all([
    supabase(
      "ci_cruise_ships?select=id,name,active,cruise_line_id,deck_plan_status,deck_plan_last_verified_at,ci_cruise_lines(id,name)&active=eq.true&order=name.asc"
    ),
    supabase("ci_cruise_lines?select=id,name&active=eq.true&order=name.asc")
  ]);

  const list = ships || [];
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setUTCFullYear(twelveMonthsAgo.getUTCFullYear() - 1);
  const cutoff = twelveMonthsAgo.toISOString();

  const approved = [];
  const missing = [];
  const needsReview = [];
  const stale = [];

  for (const ship of list) {
    const status = ship.deck_plan_status || "missing";
    const lineName = ship.ci_cruise_lines?.name || "";
    const item = { id: ship.id, name: ship.name, cruise_line_name: lineName, status };

    if (status === "approved") {
      approved.push(item);
      if (!ship.deck_plan_last_verified_at || ship.deck_plan_last_verified_at < cutoff) {
        stale.push({
          ...item,
          deck_plan_last_verified_at: ship.deck_plan_last_verified_at || null
        });
      }
    } else if (status === "needs_review" || status === "found") {
      needsReview.push(item);
    } else if (status === "missing" || status === "unavailable" || status === "outdated") {
      missing.push(item);
      if (status === "outdated" || (ship.deck_plan_last_verified_at && ship.deck_plan_last_verified_at < cutoff)) {
        stale.push({
          ...item,
          deck_plan_last_verified_at: ship.deck_plan_last_verified_at || null
        });
      }
    }
  }

  const approvedByLine = new Map();
  for (const ship of list) {
    const lineId = ship.cruise_line_id;
    if (!approvedByLine.has(lineId)) {
      approvedByLine.set(lineId, {
        id: lineId,
        name: ship.ci_cruise_lines?.name || "Unknown",
        approved: 0,
        total: 0
      });
    }
    const entry = approvedByLine.get(lineId);
    entry.total += 1;
    if (ship.deck_plan_status === "approved") entry.approved += 1;
  }

  const linesWithNoDeckPlans = (lines || [])
    .map((line) => {
      const stats = approvedByLine.get(line.id) || {
        id: line.id,
        name: line.name,
        approved: 0,
        total: 0
      };
      return stats;
    })
    .filter((line) => line.total > 0 && line.approved === 0)
    .map((line) => ({ id: line.id, name: line.name, active_ships: line.total }));

  return {
    report: {
      generated_at: new Date().toISOString(),
      totals: {
        active_ships: list.length,
        approved: approved.length,
        missing: missing.length,
        needs_review: needsReview.length,
        not_verified_in_12_months: stale.length,
        cruise_lines_with_no_deck_plans: linesWithNoDeckPlans.length
      },
      approved_ships: approved,
      missing_ships: missing,
      needs_review_ships: needsReview,
      not_verified_in_12_months: stale,
      cruise_lines_with_no_deck_plans: linesWithNoDeckPlans
    }
  };
}

async function listLines() {
  return (
    (await supabase(
      "ci_cruise_lines?select=id,name,website_url,active&active=eq.true&order=name.asc"
    )) || []
  );
}

async function listShips(filters = {}) {
  const lineId = String(filters.cruise_line_id || "").trim();
  const status = String(filters.deck_plan_status || "").trim();
  const shipQuery = String(filters.ship_query || "").trim().toLowerCase();
  const verifiedAfter = String(filters.verified_after || "").trim();
  const verifiedBefore = String(filters.verified_before || "").trim();

  let path =
    "ci_cruise_ships?select=id,name,active,cruise_line_id,official_ship_url,deck_plan_url,deck_plan_status,deck_plan_page_url,deck_plan_pdf_url,deck_plan_source_type,deck_plan_source_domain,deck_plan_version,deck_plan_effective_date,deck_plan_last_verified_at,deck_plan_verified_by,deck_plan_notes,deck_plan_candidates,deck_plan_last_searched_at,deck_plan_search_count,deck_plan_brave_request_count,ci_cruise_lines(id,name,website_url)&active=eq.true&order=name.asc";

  if (lineId) path += `&cruise_line_id=eq.${encodeURIComponent(lineId)}`;
  if (status && STATUSES.has(status)) path += `&deck_plan_status=eq.${encodeURIComponent(status)}`;
  if (verifiedAfter) {
    path += `&deck_plan_last_verified_at=gte.${encodeURIComponent(verifiedAfter)}`;
  }
  if (verifiedBefore) {
    path += `&deck_plan_last_verified_at=lte.${encodeURIComponent(verifiedBefore)}`;
  }

  let rows = (await supabase(path)) || [];
  if (shipQuery) {
    rows = rows.filter((row) => String(row.name || "").toLowerCase().includes(shipQuery));
  }
  return rows.map(mapShipRow);
}

async function listMissingForBulk() {
  const rows =
    (await supabase(
      "ci_cruise_ships?select=id,name,cruise_line_id,deck_plan_status,deck_plan_last_searched_at,ci_cruise_lines(name)&active=eq.true&deck_plan_status=in.(missing,unavailable)&order=name.asc"
    )) || [];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    cruise_line_name: row.ci_cruise_lines?.name || "",
    deck_plan_status: row.deck_plan_status,
    deck_plan_last_searched_at: row.deck_plan_last_searched_at || null
  }));
}

async function listHistory(shipId, limit = 25) {
  const capped = Math.min(50, Math.max(1, Number(limit) || 25));
  let path = `deck_plan_history?select=id,ship_id,action,previous_url,new_url,administrator,notes,created_at&order=created_at.desc&limit=${capped}`;
  if (shipId) path += `&ship_id=eq.${encodeURIComponent(shipId)}`;
  return (await supabase(path)) || [];
}

function assertOfficialCandidate(candidate, officialDomain, officialShipUrl) {
  const url = String(candidate?.url || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    const err = new Error("Candidate URL must be http(s)");
    err.statusCode = 400;
    throw err;
  }
  const host = domainFromUrl(url);
  if (isBlockedDomain(host)) {
    const err = new Error("Unofficial third-party sources cannot be approved");
    err.statusCode = 400;
    throw err;
  }
  const fromOfficialPage = Boolean(
    officialShipUrl && String(candidate.reason || "").toLowerCase().includes("official ship page")
  );
  if (officialDomain && !sameSiteOrSubdomain(host, officialDomain) && !fromOfficialPage) {
    const err = new Error("Approved deck plans must use the official cruise line domain");
    err.statusCode = 400;
    throw err;
  }
}

async function findForShip(shipId, { force = false } = {}) {
  const ship = await loadShip(shipId);
  if (!ship) {
    const err = new Error("Ship not found");
    err.statusCode = 404;
    throw err;
  }

  const line = ship.ci_cruise_lines || {};
  const result = await findDeckPlanCandidates({
    shipName: ship.name,
    officialShipUrl: ship.official_ship_url,
    lineWebsiteUrl: line.website_url,
    lastSearchedAt: ship.deck_plan_last_searched_at,
    cachedCandidates: ship.deck_plan_candidates,
    force
  });

  let nextStatus = "missing";
  if (ship.deck_plan_status === "approved") nextStatus = "approved";
  else if (result.candidates.length > 0) nextStatus = "needs_review";

  const now = new Date().toISOString();
  const patch = {
    deck_plan_candidates: result.candidates,
    deck_plan_status: nextStatus,
    updated_at: now
  };

  if (!result.skippedSearch) {
    patch.deck_plan_last_searched_at = now;
    patch.deck_plan_search_count = Number(ship.deck_plan_search_count || 0) + 1;
    const braveUsed = Number(result.diagnostics?.brave_requests || 0);
    if (braveUsed > 0) {
      patch.deck_plan_brave_request_count =
        Number(ship.deck_plan_brave_request_count || 0) + braveUsed;
    }
  }

  await supabase(`ci_cruise_ships?id=eq.${encodeURIComponent(shipId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(patch)
  });

  const refreshed = await loadShip(shipId);
  return {
    ship: mapShipRow(refreshed),
    candidates: result.candidates,
    diagnostics: result.diagnostics,
    cache_hit: Boolean(result.skippedSearch)
  };
}

async function approveCandidate(shipId, candidateId, user, notes, confirmReplace) {
  const ship = await loadShip(shipId);
  if (!ship) {
    const err = new Error("Ship not found");
    err.statusCode = 404;
    throw err;
  }

  const candidates = Array.isArray(ship.deck_plan_candidates) ? ship.deck_plan_candidates : [];
  const candidate =
    candidates.find((c) => c.id === candidateId) ||
    candidates.find((c) => c.url === candidateId);

  if (!candidate) {
    const err = new Error("Candidate not found. Run Find Deck Plans again.");
    err.statusCode = 404;
    throw err;
  }

  const line = ship.ci_cruise_lines || {};
  const officialDomain = domainFromUrl(line.website_url) || domainFromUrl(ship.official_ship_url);
  assertOfficialCandidate(candidate, officialDomain, ship.official_ship_url);

  const sourceType = SOURCE_TYPES.has(candidate.source_type)
    ? candidate.source_type
    : "other_official_asset";
  const url = String(candidate.url).trim();
  const previousUrl = publicDeckUrl(ship);
  const now = new Date().toISOString();
  const admin = adminLabel(user);

  // Never silently overwrite an approved source
  if (
    ship.deck_plan_status === "approved" &&
    previousUrl &&
    previousUrl !== url &&
    confirmReplace !== true
  ) {
    return {
      requires_confirmation: true,
      message:
        "This ship already has an approved deck-plan source. Confirm replacement to continue. The previous URL will be kept in history.",
      current_url: previousUrl,
      current_source_type: ship.deck_plan_source_type || null,
      new_url: url,
      new_source_type: sourceType,
      ship: mapShipRow(ship)
    };
  }

  let historyAction = "source_added";
  if (ship.deck_plan_status === "approved" && previousUrl) {
    historyAction = previousUrl === url ? "source_reverified" : "source_replaced";
  }

  const patch = {
    deck_plan_status: "approved",
    deck_plan_url: url,
    deck_plan_source_type: sourceType,
    deck_plan_source_domain: domainFromUrl(url) || officialDomain || null,
    deck_plan_last_verified_at: now,
    deck_plan_verified_by: admin,
    deck_plan_notes: notes != null ? String(notes) : ship.deck_plan_notes || null,
    deck_plan_candidates: [],
    updated_at: now
  };

  if (sourceType === "official_pdf") {
    patch.deck_plan_pdf_url = url;
    patch.deck_plan_page_url = null;
  } else {
    patch.deck_plan_page_url = url;
    patch.deck_plan_pdf_url = null;
  }

  await supabase(`ci_cruise_ships?id=eq.${encodeURIComponent(shipId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(patch)
  });

  await recordHistory({
    shipId,
    action: historyAction,
    previousUrl: previousUrl || null,
    newUrl: url,
    administrator: admin,
    notes: notes != null ? String(notes) : null
  });

  const refreshed = await loadShip(shipId);
  return { ship: mapShipRow(refreshed), history_action: historyAction };
}

async function reverify(shipId, user, notes) {
  const ship = await loadShip(shipId);
  if (!ship) {
    const err = new Error("Ship not found");
    err.statusCode = 404;
    throw err;
  }
  const url = publicDeckUrl(ship);
  if (ship.deck_plan_status !== "approved" || !url) {
    const err = new Error("Only approved deck plans can be reverified");
    err.statusCode = 400;
    throw err;
  }
  const now = new Date().toISOString();
  const admin = adminLabel(user);
  await supabase(`ci_cruise_ships?id=eq.${encodeURIComponent(shipId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      deck_plan_last_verified_at: now,
      deck_plan_verified_by: admin,
      deck_plan_notes: notes != null ? String(notes) : ship.deck_plan_notes || null,
      updated_at: now
    })
  });
  await recordHistory({
    shipId,
    action: "source_reverified",
    previousUrl: url,
    newUrl: url,
    administrator: admin,
    notes: notes != null ? String(notes) : "Reverified existing approved source"
  });
  const refreshed = await loadShip(shipId);
  return { ship: mapShipRow(refreshed) };
}

async function rejectCandidate(shipId, candidateId, user, notes) {
  const ship = await loadShip(shipId);
  if (!ship) {
    const err = new Error("Ship not found");
    err.statusCode = 404;
    throw err;
  }

  const candidates = Array.isArray(ship.deck_plan_candidates) ? ship.deck_plan_candidates : [];
  const rejected =
    candidates.find((c) => c.id === candidateId) ||
    candidates.find((c) => c.url === candidateId);

  const remaining = candidates.filter((c) => c.id !== candidateId && c.url !== candidateId);

  let nextStatus = ship.deck_plan_status || "missing";
  if (nextStatus !== "approved") {
    nextStatus = remaining.length ? "needs_review" : "missing";
  }

  await supabase(`ci_cruise_ships?id=eq.${encodeURIComponent(shipId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      deck_plan_candidates: remaining,
      deck_plan_status: nextStatus,
      updated_at: new Date().toISOString()
    })
  });

  if (rejected?.url) {
    await recordHistory({
      shipId,
      action: "source_rejected",
      previousUrl: null,
      newUrl: rejected.url,
      administrator: adminLabel(user),
      notes: notes != null ? String(notes) : rejected.reason || "Candidate rejected"
    });
  }

  const refreshed = await loadShip(shipId);
  return { ship: mapShipRow(refreshed) };
}

async function markStatus(shipId, status, user, notes) {
  if (!STATUSES.has(status)) {
    const err = new Error("Invalid deck plan status");
    err.statusCode = 400;
    throw err;
  }

  const ship = await loadShip(shipId);
  if (!ship) {
    const err = new Error("Ship not found");
    err.statusCode = 404;
    throw err;
  }

  const now = new Date().toISOString();
  const admin = adminLabel(user);
  const previousUrl = publicDeckUrl(ship);
  const patch = {
    deck_plan_status: status,
    updated_at: now,
    deck_plan_notes: notes != null ? String(notes) : ship.deck_plan_notes || null
  };

  if (status === "missing") {
    patch.deck_plan_url = null;
    patch.deck_plan_page_url = null;
    patch.deck_plan_pdf_url = null;
    patch.deck_plan_source_type = null;
    patch.deck_plan_source_domain = null;
    patch.deck_plan_candidates = [];
  }

  if (status === "outdated" || status === "unavailable") {
    patch.deck_plan_last_verified_at = now;
    patch.deck_plan_verified_by = admin;
  }

  await supabase(`ci_cruise_ships?id=eq.${encodeURIComponent(shipId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(patch)
  });

  if (status === "outdated") {
    await recordHistory({
      shipId,
      action: "source_marked_outdated",
      previousUrl: previousUrl || null,
      newUrl: previousUrl || null,
      administrator: admin,
      notes: notes != null ? String(notes) : null
    });
  }

  const refreshed = await loadShip(shipId);
  return { ship: mapShipRow(refreshed) };
}

async function clearCandidates(shipId) {
  const ship = await loadShip(shipId);
  if (!ship) {
    const err = new Error("Ship not found");
    err.statusCode = 404;
    throw err;
  }
  const nextStatus =
    ship.deck_plan_status === "approved"
      ? "approved"
      : publicDeckUrl(ship)
        ? ship.deck_plan_status
        : "missing";

  await supabase(`ci_cruise_ships?id=eq.${encodeURIComponent(shipId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      deck_plan_candidates: [],
      deck_plan_status: nextStatus,
      updated_at: new Date().toISOString()
    })
  });
  const refreshed = await loadShip(shipId);
  return { ship: mapShipRow(refreshed) };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(204, {});
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { success: false, error: "Method not allowed" });
  }

  try {
    const user = await requireAdmin(event);
    const body = JSON.parse(event.body || "{}");
    const action = String(body.action || "").trim();

    if (action === "dashboard") {
      const data = await dashboard();
      return jsonResponse(200, { success: true, ...data });
    }

    if (action === "coverage_audit") {
      const data = await coverageAudit();
      return jsonResponse(200, { success: true, ...data });
    }

    if (action === "list_lines") {
      const cruise_lines = await listLines();
      return jsonResponse(200, { success: true, cruise_lines });
    }

    if (action === "list_ships") {
      const ships = await listShips(body);
      return jsonResponse(200, { success: true, ships });
    }

    if (action === "list_missing_for_bulk") {
      const ships = await listMissingForBulk();
      return jsonResponse(200, { success: true, ships });
    }

    if (action === "list_history") {
      const shipId = String(body.ship_id || "").trim();
      try {
        const history = await listHistory(shipId || null, body.limit);
        return jsonResponse(200, { success: true, history });
      } catch (error) {
        // Soft-fail so a missing history table does not break the Deck Plans UI
        console.warn("[deck-plans] list_history failed:", error.message || error);
        return jsonResponse(200, { success: true, history: [], history_unavailable: true });
      }
    }

    if (action === "find") {
      const shipId = String(body.ship_id || "").trim();
      if (!shipId) return jsonResponse(400, { success: false, error: "ship_id is required" });
      const data = await findForShip(shipId, { force: body.force === true });
      return jsonResponse(200, { success: true, ...data });
    }

    if (action === "approve") {
      const shipId = String(body.ship_id || "").trim();
      const candidateId = String(body.candidate_id || body.url || "").trim();
      if (!shipId || !candidateId) {
        return jsonResponse(400, { success: false, error: "ship_id and candidate_id are required" });
      }
      const data = await approveCandidate(
        shipId,
        candidateId,
        user,
        body.notes,
        body.confirm_replace === true
      );
      return jsonResponse(200, { success: true, ...data });
    }

    if (action === "reverify") {
      const shipId = String(body.ship_id || "").trim();
      if (!shipId) return jsonResponse(400, { success: false, error: "ship_id is required" });
      const data = await reverify(shipId, user, body.notes);
      return jsonResponse(200, { success: true, ...data });
    }

    if (action === "reject_candidate") {
      const shipId = String(body.ship_id || "").trim();
      const candidateId = String(body.candidate_id || body.url || "").trim();
      if (!shipId || !candidateId) {
        return jsonResponse(400, { success: false, error: "ship_id and candidate_id are required" });
      }
      const data = await rejectCandidate(shipId, candidateId, user, body.notes);
      return jsonResponse(200, { success: true, ...data });
    }

    if (action === "mark_status") {
      const shipId = String(body.ship_id || "").trim();
      const status = String(body.status || "").trim();
      if (!shipId || !status) {
        return jsonResponse(400, { success: false, error: "ship_id and status are required" });
      }
      const data = await markStatus(shipId, status, user, body.notes);
      return jsonResponse(200, { success: true, ...data });
    }

    if (action === "clear_candidates") {
      const shipId = String(body.ship_id || "").trim();
      if (!shipId) return jsonResponse(400, { success: false, error: "ship_id is required" });
      const data = await clearCandidates(shipId);
      return jsonResponse(200, { success: true, ...data });
    }

    return jsonResponse(400, { success: false, error: `Unknown action: ${action}` });
  } catch (error) {
    const status = error.statusCode || error.status || 500;
    return jsonResponse(status, {
      success: false,
      error: error.message || "Deck plans request failed"
    });
  }
};
