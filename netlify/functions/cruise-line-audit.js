/**
 * Cruise Line Audit API (Sprint 11B — Research Health).
 *
 * POST /.netlify/functions/cruise-line-audit
 * Actions: dashboard | list_lines | list_runs | get_run | start_audit |
 *          apply_finding | ignore_finding | research_health
 *
 * Structural DB changes require manual apply_finding — never auto archive/delete.
 */

const { requireAdmin } = require("./admin-auth");
const { emptyContent } = require("./lib/research-schemas");
const { normaliseEntityKey } = require("./lib/research-normalize");
const { auditCruiseLineFleet, slugifyShip } = require("./lib/fleet-audit");

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

function monthsAgoIso(months) {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString();
}

async function loadActiveLines() {
  return (
    (await supabase(
      "ci_cruise_lines?select=id,name,slug,website_url,fleet_page_url,active,sold_by_101cruise&active=eq.true&order=name.asc"
    )) || []
  );
}

async function loadShipsForLine(lineId) {
  return (
    (await supabase(
      `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(lineId)}&select=id,name,slug,active,status,cruise_line_id&order=name.asc`
    )) || []
  );
}

async function researchHealthSummary() {
  const [lines, ships, research] = await Promise.all([
    supabase("ci_cruise_lines?select=id&active=eq.true"),
    supabase("ci_cruise_ships?select=id,cruise_line_id,active&active=eq.true"),
    supabase(
      "research_content?entity_type=eq.ship&select=id,entity_id,content_status,generated_at,published_at,updated_at&content_status=in.(draft,reviewed,published)"
    )
  ]);
  const shipIds = new Set((ships || []).map((s) => s.id));
  const researched = new Set();
  let stale = 0;
  const cutoff = monthsAgoIso(24);
  for (const row of research || []) {
    if (!row.entity_id || !shipIds.has(row.entity_id)) continue;
    researched.add(row.entity_id);
    const when = row.published_at || row.generated_at || row.updated_at;
    if (when && when < cutoff) stale += 1;
  }
  const never = Math.max(0, shipIds.size - researched.size);
  const total = shipIds.size || 1;
  const healthyShare = researched.size / total;
  let healthLabel = "Needs Updating";
  let healthStars = 3;
  if (healthyShare >= 0.85 && stale / total < 0.15) {
    healthLabel = "Excellent";
    healthStars = 5;
  } else if (healthyShare >= 0.6 && stale / total < 0.35) {
    healthLabel = "Good";
    healthStars = 4;
  }

  return {
    active_lines: (lines || []).length,
    active_ships: shipIds.size,
    ships_never_researched: never,
    ships_older_than_24_months: stale,
    research_health: healthLabel,
    research_health_stars: healthStars
  };
}

async function dashboard() {
  const health = await researchHealthSummary();
  const lastRuns =
    (await supabase(
      "cruise_line_audit_runs?select=*&order=created_at.desc&limit=1"
    )) || [];
  const last = lastRuns[0] || null;
  const pendingReview =
    (await supabase(
      "cruise_line_audit_findings?select=id&decision=eq.pending&finding_type=in.(new_ship,possible_retired,possible_rename,possible_transfer)"
    )) || [];
  const researchUpdates =
    health.ships_never_researched + health.ships_older_than_24_months;

  return {
    success: true,
    cards: {
      active_cruise_lines: health.active_lines,
      active_ships: health.active_ships,
      last_full_audit: last?.finished_at || last?.created_at || null,
      last_audit_scope: last?.scope || null,
      new_ships_found_last_audit: last?.new_ships_count || 0,
      ships_requiring_review: pendingReview.length,
      research_updates_required: researchUpdates
    },
    research_health: health
  };
}

async function startAudit(body, user) {
  const lineId = String(body.cruise_line_id || "").trim();
  if (!lineId) {
    throw Object.assign(new Error("cruise_line_id is required"), { statusCode: 400 });
  }
  const scope = body.scope === "full" ? "full" : "selected";

  const lines = await supabase(
    `ci_cruise_lines?id=eq.${encodeURIComponent(lineId)}&select=id,name,slug,website_url,fleet_page_url,active&limit=1`
  );
  const line = lines?.[0];
  if (!line) throw Object.assign(new Error("Cruise line not found"), { statusCode: 404 });

  const runRows = await supabase("cruise_line_audit_runs", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      scope,
      cruise_line_id: line.id,
      status: "running",
      started_at: new Date().toISOString(),
      created_by: user.id
    })
  });
  const run = runRows?.[0];
  if (!run) throw new Error("Failed to create audit run");

  try {
    const ships = await loadShipsForLine(line.id);
    const result = await auditCruiseLineFleet({ line, dbShips: ships });

    const findingRows = (result.findings || []).map((f) => ({
      run_id: run.id,
      cruise_line_id: line.id,
      finding_type: f.finding_type,
      status_label: f.status_label || f.finding_type,
      ship_name: f.ship_name,
      match_ship_id: f.match_ship_id || null,
      related_ship_id: f.related_ship_id || null,
      reason: f.reason,
      confidence: f.confidence || "medium",
      source_url: f.source_url || result.fleet_page_url,
      payload_json: f.payload_json || {},
      decision: f.finding_type === "no_changes" ? "reviewed" : "pending"
    }));

    if (findingRows.length) {
      await supabase("cruise_line_audit_findings", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(findingRows)
      });
    }

    if (result.fleet_page_url && !line.fleet_page_url) {
      await supabase(`ci_cruise_lines?id=eq.${encodeURIComponent(line.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ fleet_page_url: result.fleet_page_url })
      });
    }

    const counts = {
      new_ships_count: findingRows.filter((f) => f.finding_type === "new_ship").length,
      retired_candidates_count: findingRows.filter((f) => f.finding_type === "possible_retired")
        .length,
      rename_transfer_count: findingRows.filter((f) =>
        ["possible_rename", "possible_transfer"].includes(f.finding_type)
      ).length,
      warnings_count: findingRows.filter((f) =>
        ["possible_retired", "possible_rename", "possible_transfer"].includes(f.finding_type)
      ).length,
      unable_to_verify_count: findingRows.filter((f) => f.finding_type === "unable_to_verify")
        .length,
      no_changes_count: findingRows.filter((f) => f.finding_type === "no_changes").length
    };

    const finished = await supabase(`cruise_line_audit_runs?id=eq.${encodeURIComponent(run.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        status: "completed",
        fleet_page_url: result.fleet_page_url,
        lines_checked: 1,
        ships_checked: result.ships_checked || ships.length,
        ...counts,
        duration_ms: result.diagnostics?.duration_ms || null,
        diagnostics_json: result.diagnostics || {},
        finished_at: new Date().toISOString()
      })
    });

    const findings = await supabase(
      `cruise_line_audit_findings?run_id=eq.${encodeURIComponent(run.id)}&select=*&order=finding_type.asc`
    );

    return {
      success: true,
      run: finished?.[0] || run,
      findings: findings || [],
      line: { id: line.id, name: line.name }
    };
  } catch (error) {
    await supabase(`cruise_line_audit_runs?id=eq.${encodeURIComponent(run.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "failed",
        error_detail: String(error.message || error).slice(0, 2000),
        finished_at: new Date().toISOString()
      })
    });
    throw error;
  }
}

async function getRun(body) {
  const id = String(body.id || body.run_id || "").trim();
  if (!id) throw Object.assign(new Error("id is required"), { statusCode: 400 });
  const runs = await supabase(
    `cruise_line_audit_runs?id=eq.${encodeURIComponent(id)}&select=*&limit=1`
  );
  const run = runs?.[0];
  if (!run) throw Object.assign(new Error("Audit run not found"), { statusCode: 404 });
  const findings =
    (await supabase(
      `cruise_line_audit_findings?run_id=eq.${encodeURIComponent(id)}&select=*,ci_cruise_lines(id,name)&order=cruise_line_id.asc,finding_type.asc`
    )) || [];
  return { success: true, run, findings };
}

async function listRuns(body) {
  const limit = Math.min(50, Math.max(1, Number(body.limit) || 20));
  const runs =
    (await supabase(
      `cruise_line_audit_runs?select=*,ci_cruise_lines(id,name)&order=created_at.desc&limit=${limit}`
    )) || [];
  return { success: true, runs };
}

async function createResearchStub(ship, user) {
  const row = {
    entity_type: "ship",
    entity_id: ship.id,
    entity_key: normaliseEntityKey(ship.name),
    entity_name: ship.name,
    content_status: "draft",
    content_version: 1,
    content_json: emptyContent("ship"),
    summary_text: null,
    diagnostics_json: {
      queued_from: "cruise_line_audit",
      research_pending: true,
      media_download_queued: true,
      note: "Pending research and media — run Research Content when ready. Audit does not run AI research."
    },
    failure_detail: "Pending research — queued from Cruise Line Audit",
    created_by: user.id,
    updated_by: user.id
  };
  const created = await supabase("research_content", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(row)
  });
  return created?.[0] || null;
}

async function applyFinding(body, user) {
  const id = String(body.finding_id || body.id || "").trim();
  const action = String(body.apply_action || body.action || "").trim();
  // add | archive | review | ignore
  if (!id) throw Object.assign(new Error("finding_id is required"), { statusCode: 400 });
  if (!["add", "archive", "review", "ignore"].includes(action)) {
    throw Object.assign(new Error("apply_action must be add, archive, review, or ignore"), {
      statusCode: 400
    });
  }

  const rows = await supabase(
    `cruise_line_audit_findings?id=eq.${encodeURIComponent(id)}&select=*&limit=1`
  );
  const finding = rows?.[0];
  if (!finding) throw Object.assign(new Error("Finding not found"), { statusCode: 404 });
  if (finding.decision !== "pending" && action !== "ignore") {
    throw Object.assign(new Error("Finding already decided"), { statusCode: 409 });
  }

  if (action === "ignore") {
    const updated = await supabase(
      `cruise_line_audit_findings?id=eq.${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          decision: "ignored",
          decided_at: new Date().toISOString(),
          decided_by: user.id
        })
      }
    );
    return { success: true, finding: updated?.[0], message: "Finding ignored" };
  }

  if (action === "review") {
    const updated = await supabase(
      `cruise_line_audit_findings?id=eq.${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          decision: "reviewed",
          decided_at: new Date().toISOString(),
          decided_by: user.id
        })
      }
    );
    return {
      success: true,
      finding: updated?.[0],
      message: "Marked reviewed — no automatic rename/transfer applied"
    };
  }

  if (action === "add") {
    if (finding.finding_type !== "new_ship") {
      throw Object.assign(new Error("Only new_ship findings can be added"), { statusCode: 400 });
    }
    const name = String(finding.ship_name || "").trim();
    if (!name) throw Object.assign(new Error("Ship name missing"), { statusCode: 400 });
    const slugBase = finding.payload_json?.proposed_slug || slugifyShip(name);
    let slug = slugBase;
    let ship;
    for (let i = 0; i < 5; i += 1) {
      try {
        const created = await supabase("ci_cruise_ships", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            cruise_line_id: finding.cruise_line_id,
            name,
            slug: i === 0 ? slug : `${slugBase}-${i + 1}`,
            status: "active",
            active: true,
            public_visible: false,
            needs_review: true,
            review_notes: "Added via Cruise Line Audit — pending research & media",
            source_name: "cruise_line_audit",
            source_url: finding.source_url || null,
            last_verified_at: new Date().toISOString()
          })
        });
        ship = created?.[0];
        if (ship) break;
      } catch (error) {
        if (i === 4) throw error;
      }
    }
    if (!ship) throw new Error("Failed to create ship");

    const research = await createResearchStub(ship, user);

    const updated = await supabase(
      `cruise_line_audit_findings?id=eq.${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          decision: "added",
          decided_at: new Date().toISOString(),
          decided_by: user.id,
          resulting_ship_id: ship.id,
          payload_json: {
            ...(finding.payload_json || {}),
            research_content_id: research?.id || null,
            research_queued: true,
            media_download_queued: true
          }
        })
      }
    );

    return {
      success: true,
      finding: updated?.[0],
      ship,
      research,
      message:
        "Ship added. Research stub queued (Pending). Open Research Content to run AI research when ready. Media download queued for future workflow."
    };
  }

  if (action === "archive") {
    if (!["possible_retired", "possible_transfer"].includes(finding.finding_type)) {
      throw Object.assign(new Error("Only retired/transfer findings can be archived"), {
        statusCode: 400
      });
    }
    const shipId = finding.match_ship_id || finding.related_ship_id;
    if (!shipId) throw Object.assign(new Error("No matched ship to archive"), { statusCode: 400 });

    // Soft archive only — never delete
    const archived = await supabase(
      `ci_cruise_ships?id=eq.${encodeURIComponent(shipId)}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          active: false,
          status: "retired",
          public_visible: false,
          needs_review: false,
          review_notes: `Soft-archived via Cruise Line Audit (${finding.finding_type})`,
          last_verified_at: new Date().toISOString()
        })
      }
    );

    const updated = await supabase(
      `cruise_line_audit_findings?id=eq.${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          decision: "archived",
          decided_at: new Date().toISOString(),
          decided_by: user.id,
          resulting_ship_id: shipId
        })
      }
    );

    return {
      success: true,
      finding: updated?.[0],
      ship: archived?.[0],
      message: "Ship soft-archived (active=false, status=retired). Not deleted."
    };
  }

  throw Object.assign(new Error("Unsupported action"), { statusCode: 400 });
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(204, "");
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { success: false, error: "Method not allowed" });
  }

  try {
    const user = await requireAdmin(event);
    const body = JSON.parse(event.body || "{}");
    const action = String(body.action || "dashboard").trim();

    if (action === "dashboard") return jsonResponse(200, await dashboard());
    if (action === "list_lines") {
      return jsonResponse(200, { success: true, cruise_lines: await loadActiveLines() });
    }
    if (action === "research_health") {
      return jsonResponse(200, { success: true, ...(await researchHealthSummary()) });
    }
    if (action === "list_runs") return jsonResponse(200, await listRuns(body));
    if (action === "get_run") return jsonResponse(200, await getRun(body));
    if (action === "start_audit") return jsonResponse(200, await startAudit(body, user));
    if (action === "apply_finding") return jsonResponse(200, await applyFinding(body, user));
    if (action === "ignore_finding") {
      body.apply_action = "ignore";
      return jsonResponse(200, await applyFinding(body, user));
    }

    return jsonResponse(400, { success: false, error: `Unknown action: ${action}` });
  } catch (error) {
    const status = error.statusCode || 500;
    return jsonResponse(status, {
      success: false,
      error: error.message || "Cruise line audit failed",
      code: error.code || null
    });
  }
};
