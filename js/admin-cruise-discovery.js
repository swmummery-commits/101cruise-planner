/**
 * Sprint 11D — Cruise Discovery Engine (Research Content section).
 * Discovers sailings from official cruise-line websites only.
 */
(function (global) {
  "use strict";

  let loading = false;
  let discovering = false;
  let message = "";
  let messageTone = "info";
  let cards = null;
  let lines = [];
  let destinations = [];
  let runs = [];
  let reviewItems = [];
  let reviewGroups = [];
  let reviewItemCount = 0;
  let reviewBreakdown = null;
  let reviewFilterType = "";
  let reviewLabels = {};
  let lineHealth = [];
  let lineHealthSummary = null;
  let lastRunMeta = null;
  let activeCruises = [];
  let departurePorts = [];
  let browseDestinationId = "";
  let browseLineId = "";
  let selectedLineId = "";
  let selectedDestinationId = "";
  let view = "dashboard"; // dashboard | review | cruises
  let cancelFull = false;

  function esc(value) {
    return typeof global.esc === "function"
      ? global.esc(value)
      : String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
  }

  function formatDate(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString("en-AU", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      });
    } catch {
      return String(iso);
    }
  }

  function formatDay(iso) {
    if (!iso) return "—";
    try {
      return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-AU", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC"
      });
    } catch {
      return String(iso);
    }
  }

  async function api(action, payload = {}) {
    const headers =
      typeof global.adminAuthHeaders === "function"
        ? await global.adminAuthHeaders()
        : { "Content-Type": "application/json" };
    const response = await fetch("/.netlify/functions/cruise-discovery", {
      method: "POST",
      headers,
      body: JSON.stringify({ action, ...payload })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      let msg = data.error || `Request failed (${response.status})`;
      if (response.status === 504 || response.status === 502) {
        msg = "Discovery timed out. Try one cruise line or one destination at a time.";
      }
      const err = new Error(msg);
      err.status = response.status;
      err.payload = data;
      throw err;
    }
    return data;
  }

  async function loadActiveCruises() {
    const result = await api("list_cruises", {
      status: "active",
      limit: 300,
      destination_id: browseDestinationId || undefined,
      cruise_line_id: browseLineId || undefined
    });
    activeCruises = result.cruises || [];
  }

  function loadingPanel() {
    if (typeof global.BrandLoading?.panelHtml === "function") {
      return global.BrandLoading.panelHtml();
    }
    return `<p class="admin-muted">Hang tight! Just getting your info.</p>`;
  }

  async function ensureLoaded({ quiet = false } = {}) {
    const load = async () => {
      const [dash, lineResult, destResult, runResult, reviewResult] = await Promise.all([
        api("dashboard"),
        api("list_lines"),
        api("list_destinations"),
        api("list_runs", { limit: 15 }),
        api("list_review_groups", {
          status: "pending",
          limit: 2000,
          item_type: reviewFilterType || undefined
        })
      ]);
      cards = dash.cards || null;
      reviewBreakdown = dash.review_breakdown || null;
      lineHealth = dash.line_health || [];
      lineHealthSummary = dash.line_health_summary || null;
      lastRunMeta = {
        type: dash.cards?.last_run_type,
        scope: dash.cards?.last_run_scope,
        line: dash.cards?.last_run_line_name,
        isSingleLine: dash.cards?.last_run_is_single_line
      };
      lines = lineResult.cruise_lines || [];
      destinations = destResult.destinations || [];
      runs = runResult.runs || [];
      reviewGroups = reviewResult.groups || [];
      reviewItemCount = reviewResult.item_count || 0;
      reviewLabels = reviewResult.labels || {};
      reviewItems = [];
      if (!selectedLineId && lines[0]) selectedLineId = lines[0].id;
      if (!selectedDestinationId && destinations[0]) selectedDestinationId = destinations[0].id;
      if (view === "cruises") await loadActiveCruises();
      if (!departurePorts.length) {
        try {
          const portResult = await api("list_departure_ports");
          departurePorts = portResult.ports || [];
        } catch (_error) {
          departurePorts = [];
        }
      }
      if (!quiet) message = "";
    };

    loading = true;
    if (!quiet && typeof global.renderAdmin === "function") global.renderAdmin();
    try {
      if (typeof global.AdminLoading?.withLoading === "function") {
        await global.AdminLoading.withLoading(load, {
          key: "cruise-discovery-load",
          delayMs: 0
        });
      } else {
        await load();
      }
    } catch (error) {
      message = error.message || "Failed to load Cruise Discovery";
      messageTone = "error";
    } finally {
      loading = false;
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    }
  }

  function renderCards() {
    const c = cards || {};
    const runNote =
      lastRunMeta?.isSingleLine && lastRunMeta?.line
        ? `<p class="admin-helper">Last run: <strong>${esc(lastRunMeta.type || "selected line")}</strong> — ${esc(lastRunMeta.line)}. Single-line metrics below do not represent full Discovery health.</p>`
        : lastRunMeta?.type
          ? `<p class="admin-helper">Last run type: <strong>${esc(lastRunMeta.type)}</strong>${lastRunMeta.line ? ` — ${esc(lastRunMeta.line)}` : ""}.</p>`
          : "";
    const items = [
      { label: "Active Future Sailings", value: c.active_cruises ?? "—" },
      { label: "Active (all status, incl. past date)", value: c.active_cruises_all_status ?? "—" },
      { label: "Past departure pending expire", value: c.active_past_departure_pending_expire ?? 0 },
      { label: "Enabled Cruise Lines", value: c.enabled_cruise_lines ?? "—" },
      { label: "Lines with future active", value: c.lines_with_future_active ?? 0 },
      { label: "Discovered Candidates — Last Run", value: c.discovered_candidates_last_run ?? 0 },
      { label: "Validated New Cruises — Last Run", value: c.validated_new_cruises_last_run ?? 0 },
      { label: "Review Required", value: c.review_required ?? 0 },
      { label: "Duplicate Candidates Suppressed", value: c.duplicate_candidates_suppressed ?? 0 },
      { label: "Low-Signal Sources Ignored", value: c.low_signal_sources_ignored ?? 0 },
      { label: "Lines scanned (last run)", value: c.cruise_lines_scanned_ok ?? "—" },
      { label: "Lines unable to scan", value: c.cruise_lines_unable_to_scan ?? 0 }
    ];
    return `
      ${runNote}
      <div class="usage-summary-grid research-audit-cards">
        ${items
          .map(
            (item) => `
          <article class="admin-card usage-summary-card">
            <p class="usage-summary-label">${esc(item.label)}</p>
            <p class="usage-summary-value">${esc(String(item.value))}</p>
          </article>`
          )
          .join("")}
      </div>
    `;
  }

  function renderLineHealth() {
    if (!lineHealth?.length) return "";
    const summary = lineHealthSummary || {};
    const rows = lineHealth
      .map(
        (row) => `
        <tr>
          <td>${esc(row.cruise_line)}</td>
          <td><span class="deck-plan-status deck-plan-status--${esc(row.source_health === "healthy" ? "approved" : row.source_health === "misconfigured" ? "missing" : "candidate")}">${esc(row.source_health)}</span></td>
          <td>${esc(row.source_url_type || "—")}</td>
          <td>${row.last_run_at ? esc(formatDate(row.last_run_at)) : "—"}</td>
          <td>${esc(String(row.pages_checked ?? 0))}</td>
          <td>${esc(String(row.candidates ?? 0))}</td>
          <td>${esc(String(row.activated ?? 0))}</td>
          <td>${esc(String(row.active_future_sailings ?? 0))}</td>
          <td>${esc(row.primary_issue || "—")}</td>
        </tr>`
      )
      .join("");
    return `
      <div class="admin-card" style="margin-top:16px">
        <h3>Line source health</h3>
        <p class="admin-helper">Operational status per enabled cruise line. Misconfigured or zero-yield lines need engineering attention — not Steve review.</p>
        <p class="admin-small">Summary: ${esc(String(summary.healthy || 0))} healthy · ${esc(String(summary.misconfigured || 0))} misconfigured · ${esc(String(summary.extraction_failed || 0))} extraction failed · ${esc(String(summary.unsupported || 0))} not yet run</p>
        <div class="research-table-wrap">
          <table class="research-table">
            <thead>
              <tr>
                <th>Cruise line</th>
                <th>Status</th>
                <th>Source type</th>
                <th>Last run</th>
                <th>Pages</th>
                <th>Candidates</th>
                <th>Activated</th>
                <th>Active</th>
                <th>Primary issue</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }

  function renderReviewBreakdown() {
    const b = reviewBreakdown || {};
    const cats = [
      ["unknown_ship", "Unknown Ship"],
      ["missing_departure_date", "Missing Departure Date"],
      ["missing_departure_port", "Missing Departure Port"],
      ["invalid_departure_port", "Invalid Departure Value"],
      ["ambiguous_departure_port", "Ambiguous Departure Port"],
      ["unknown_destination", "Unknown Destination"],
      ["missing_url", "Invalid Sailing URL"],
      ["ambiguous_match", "Ambiguous Match"],
      ["missing_ship_url", "Missing Official Ship URL"],
      ["validation_failure", "Other Validation Failure"]
    ];
    return `
      <div class="admin-card" style="margin-top:16px">
        <h3>Review Breakdown</h3>
        <p class="admin-helper">Click a category to filter the Review Queue.</p>
        <div class="admin-row-actions" style="flex-wrap:wrap;gap:8px">
          <button type="button" class="admin-button secondary small" onclick="CruiseDiscoveryAdmin.setReviewFilter('')">All</button>
          ${cats
            .map(([key, label]) => {
              const count = b[key] || 0;
              const active = reviewFilterType === key ? "black" : "secondary";
              return `<button type="button" class="admin-button ${active} small" onclick='CruiseDiscoveryAdmin.setReviewFilter(${JSON.stringify(
                key
              )})'>${esc(label)} (${esc(String(count))})</button>`;
            })
            .join("")}
        </div>
      </div>
    `;
  }

  function lineOptions() {
    return lines
      .map(
        (line) =>
          `<option value="${esc(line.id)}" ${line.id === selectedLineId ? "selected" : ""}>${esc(
            line.name
          )}${line.website_url ? "" : " (no website)"}</option>`
      )
      .join("");
  }

  function destinationOptions() {
    return destinations
      .map(
        (d) =>
          `<option value="${esc(d.id)}" ${d.id === selectedDestinationId ? "selected" : ""}>${esc(
            d.name
          )}</option>`
      )
      .join("");
  }

  function renderRuns() {
    if (!runs.length) {
      return `<p class="admin-muted">No discovery runs yet.</p>`;
    }
    const rows = runs
      .map((run) => {
        const stats = run.stats || {};
        return `<tr>
          <td>${esc(formatDate(run.created_at))}</td>
          <td>${esc(run.scope)}</td>
          <td>${esc(run.status)}</td>
          <td>${esc(String(stats.new ?? "—"))}</td>
          <td>${esc(String(stats.changed ?? "—"))}</td>
          <td>${esc(String(stats.review_items ?? "—"))}</td>
          <td class="admin-small">${esc(run.error_message || "")}</td>
        </tr>`;
      })
      .join("");
    return `
      <div class="usage-table-wrap">
        <table class="usage-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Scope</th>
              <th>Status</th>
              <th>New</th>
              <th>Changed</th>
              <th>Review</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function reviewActionBtn(action, groupId, label, primary) {
    return `<button type="button" class="admin-button ${primary ? "black" : "secondary"} small" data-cd-review-action="${esc(
      action
    )}" data-cd-group-id="${esc(groupId)}">${esc(label)}</button>`;
  }

  function bindReviewQueueActions() {
    if (typeof document === "undefined" || global.__cdReviewQueueBound) return;
    global.__cdReviewQueueBound = true;
    document.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-cd-review-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-cd-review-action");
      const groupId = btn.getAttribute("data-cd-group-id");
      if (!action || !groupId) return;
      event.preventDefault();
      if (action === "reprocess") global.CruiseDiscoveryAdmin.reprocessGroup(groupId);
      else if (action === "ignore") global.CruiseDiscoveryAdmin.ignoreGroup(groupId);
      else if (action === "manual_date") global.CruiseDiscoveryAdmin.manualDateForGroup(groupId);
      else if (action === "manual_port") global.CruiseDiscoveryAdmin.manualDeparturePortForGroup(groupId);
      else if (action === "match_ship") {
        global.CruiseDiscoveryAdmin.resolveGroup(groupId, { resolutionAction: "match_ship" });
      } else if (action === "match_ship_alias") {
        global.CruiseDiscoveryAdmin.resolveGroup(groupId, { resolutionAction: "match_and_save_alias" });
      } else if (action === "match_destination") {
        global.CruiseDiscoveryAdmin.resolveGroup(groupId, { resolutionAction: "match_destination" });
      } else if (action === "apply_ship_url") {
        global.CruiseDiscoveryAdmin.resolveGroup(groupId, { resolutionAction: "apply_ship_url" });
      }
    });
  }

  bindReviewQueueActions();

  function renderReview() {
    if (!reviewGroups.length) {
      return `${renderReviewBreakdown()}<p class="admin-muted" style="margin-top:16px">Review queue is empty${
        reviewFilterType ? " for this filter" : ""
      }.</p>`;
    }
    return `
      ${renderReviewBreakdown()}
      <div class="admin-card" style="margin:16px 0;padding:14px 16px;background:#f8faf9;border:1px solid #e3ece8">
        <p class="admin-small" style="margin:0 0 8px"><strong>How to fix items in this queue</strong></p>
        <ul class="admin-small" style="margin:0;padding-left:18px;line-height:1.5">
          <li><strong>Use suggested match</strong> — when Discovery proposes a ship or destination, apply it to all affected sailings.</li>
          <li><strong>Set departure port / date</strong> — for missing sailing details, enter the correct value manually.</li>
          <li><strong>Retry automatic fix</strong> — re-runs matching after you update ships, destinations, ports, or aliases.</li>
          <li><strong>Dismiss</strong> — not a real cruise (hub page, marketing page, duplicate). Removes from queue only.</li>
        </ul>
        <p class="admin-small admin-muted" style="margin:8px 0 0">To fix an already-active sailing, use <strong>Browse Active</strong> (set port / remove).</p>
      </div>
      <div class="admin-row-actions" style="margin:12px 0">
        <button type="button" class="admin-button secondary small" onclick="CruiseDiscoveryAdmin.collapseDuplicates()">Collapse duplicates</button>
        <button type="button" class="admin-button secondary small" onclick="CruiseDiscoveryAdmin.reprocessAllVisible()">Retry all visible groups</button>
      </div>
      <p class="admin-muted" style="margin-bottom:12px">
        ${esc(String(reviewGroups.length))} entity problem${reviewGroups.length === 1 ? "" : "s"}
        covering ${esc(String(reviewItemCount))} finding${reviewItemCount === 1 ? "" : "s"}.
      </p>
      <div class="usage-table-wrap">
        <table class="usage-table">
          <thead>
            <tr>
              <th>Problem</th>
              <th>Cruise line</th>
              <th>Ship / match</th>
              <th>Date / source</th>
              <th>Affected</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${reviewGroups
              .map((group) => {
                const typeLabel =
                  group.item_type_label ||
                  reviewLabels[group.item_type] ||
                  group.item_type;
                const suggestion =
                  group.suggested_ship_name != null
                    ? `${group.suggested_ship_name} (${group.suggested_confidence ?? "—"}%)`
                    : group.suggested_destination_name
                      ? `${group.suggested_destination_name} (${
                          group.suggested_destination_confidence ?? "—"
                        }%)`
                      : "—";
                const groupId = String(group.group_id || "");
                const isShip = group.item_type === "unknown_ship";
                const isDestination = group.item_type === "unknown_destination";
                const isMissingUrl = group.item_type === "missing_ship_url";
                const actions = [
                  isShip && group.suggested_ship_id
                    ? reviewActionBtn("match_ship", groupId, "Use suggested ship", true)
                    : "",
                  isShip && group.suggested_ship_id
                    ? reviewActionBtn("match_ship_alias", groupId, "Use ship + save alias", false)
                    : "",
                  isDestination && group.suggested_destination_id
                    ? reviewActionBtn(
                        "match_destination",
                        groupId,
                        `Use destination: ${group.suggested_destination_name || "suggested"}`,
                        true
                      )
                    : "",
                  isMissingUrl
                    ? reviewActionBtn("apply_ship_url", groupId, "Apply ship URL", true)
                    : "",
                  group.item_type === "missing_departure_date" && group.affected_external_keys?.[0]
                    ? reviewActionBtn("manual_date", groupId, "Enter departure date", true)
                    : "",
                  ["missing_departure_port", "invalid_departure_port", "ambiguous_departure_port"].includes(
                    group.item_type
                  )
                    ? reviewActionBtn("manual_port", groupId, "Set departure port", true)
                    : "",
                  reviewActionBtn("reprocess", groupId, "Retry automatic fix", false),
                  reviewActionBtn("ignore", groupId, "Dismiss", false)
                ]
                  .filter(Boolean)
                  .join(" ");

                const samples = (group.sample_urls || [])
                  .slice(0, 2)
                  .map(
                    (url, idx) =>
                      `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Source ${
                        idx + 1
                      }</a>`
                  )
                  .join(" · ");

                return `<tr>
                  <td>
                    <strong>${esc(typeLabel)}</strong>
                    <div class="admin-small">${esc(group.reasons || "")}</div>
                    <div class="admin-small">First: ${esc(
                      formatDate(group.first_seen_at || group.created_at)
                    )} · Last: ${esc(formatDate(group.last_seen_at || group.created_at))}</div>
                  </td>
                  <td>${esc(group.cruise_line_name || "—")}</td>
                  <td>
                    <div>Raw: ${esc(group.raw_ship_name || "—")}</div>
                    <div class="admin-small">Normalised: ${esc(
                      group.normalised_raw_ship_name || "—"
                    )}</div>
                    <div class="admin-small">Suggested: ${esc(suggestion)}</div>
                  </td>
                  <td>
                    <div class="admin-small">Parsed: ${esc(
                      group.parsed_departure_date || "—"
                    )}</div>
                    <div class="admin-small">${esc(group.source_title || "")}</div>
                    <div class="admin-small">${samples || "—"}</div>
                  </td>
                  <td>${esc(String(group.affected_count))}</td>
                  <td class="admin-settings-actions">${actions}</td>
                </tr>`;
              })
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function browseLineOptions() {
    return [
      `<option value="" ${!browseLineId ? "selected" : ""}>All cruise lines</option>`,
      ...lines.map(
        (line) =>
          `<option value="${esc(line.id)}" ${line.id === browseLineId ? "selected" : ""}>${esc(
            line.name
          )}</option>`
      )
    ].join("");
  }

  function browseDestinationOptions() {
    return [
      `<option value="" ${!browseDestinationId ? "selected" : ""}>All destinations</option>`,
      ...destinations.map(
        (d) =>
          `<option value="${esc(d.id)}" ${d.id === browseDestinationId ? "selected" : ""}>${esc(
            d.name
          )}</option>`
      )
    ].join("");
  }

  function departurePortNeedsAttention(cruise) {
    const meta = cruise.departure_audit?.departure_port_meta || {};
    const port = String(cruise.departure_port || "").trim();
    if (!port) return true;
    if (meta.status && meta.status !== "resolved" && meta.status !== "resolved_legacy") return true;
    if (cruise.departure_audit?.validation_status === "invalid") return true;
    return false;
  }

  function suggestedPortName(cruise) {
    const audit = cruise.departure_audit || {};
    const raw = String(audit.departure_port_raw || "").trim();
    if (raw) return raw.replace(/\s*\([^)]*\)\s*$/, "").trim();
    const title = String(cruise.itinerary || "").trim();
    const route = title.match(/\s[-–|]\s*(.+?)\s+to\s+/i);
    if (route) return route[1].replace(/\([^)]*\)/g, "").trim();
    return "";
  }

  function renderCruiseActions(cruise) {
    const needsPort = departurePortNeedsAttention(cruise);
    const suggested = suggestedPortName(cruise);
    const suggestedJson = JSON.stringify(suggested);
    const parts = [];
    if (cruise.official_url) {
      parts.push(
        `<a href="${esc(cruise.official_url)}" target="_blank" rel="noopener noreferrer">Official</a>`
      );
    }
    parts.push(
      `<button type="button" class="admin-button secondary small" onclick='CruiseDiscoveryAdmin.manualDeparturePort(${JSON.stringify(
        cruise.id
      )})'>Set port</button>`
    );
    if (needsPort) {
      parts.push(
        `<button type="button" class="admin-button black small" onclick='CruiseDiscoveryAdmin.openAddPort(${suggestedJson})'>Add port</button>`
      );
    }
    parts.push(
      `<button type="button" class="admin-button secondary small" onclick='CruiseDiscoveryAdmin.removeCruise(${JSON.stringify(
        cruise.id
      )})'>Remove</button>`
    );
    return parts.join(" ");
  }

  function departurePortSummary(cruise) {
    const audit = cruise.departure_audit || {};
    const meta = audit.departure_port_meta || {};
    const current = cruise.departure_port || "—";
    if (meta.status === "resolved" && current !== "—") {
      return `${current}${meta.manual ? " (manual)" : ""}`;
    }
    if (audit.departure_port_raw && meta.status !== "resolved") {
      return `${current} · raw: ${audit.departure_port_raw} · ${meta.status}`;
    }
    if (meta.status && meta.status !== "resolved" && meta.status !== "resolved_legacy") {
      return `${current} · ${meta.status}${meta.reason ? `: ${meta.reason}` : ""}`;
    }
    return current;
  }

  function renderActiveCruises() {
    const filters = `
      <div class="featured-cruises-toolbar" style="margin-bottom:12px">
        <div class="admin-field">
          <label for="browseLineSelect">Cruise line</label>
          <select id="browseLineSelect" onchange="CruiseDiscoveryAdmin.setBrowseLine(this.value)">
            ${browseLineOptions()}
          </select>
        </div>
        <div class="admin-field">
          <label for="browseDestSelect">Destination</label>
          <select id="browseDestSelect" onchange="CruiseDiscoveryAdmin.setBrowseDestination(this.value)">
            ${browseDestinationOptions()}
          </select>
        </div>
      </div>
      <p class="admin-muted" style="margin-bottom:12px">Showing ${esc(
        String(activeCruises.length)
      )} active sailing${activeCruises.length === 1 ? "" : "s"} (max 300).</p>
    `;

    if (!activeCruises.length) {
      return `${filters}<p class="admin-muted">No active cruises match these filters.</p>`;
    }

    const rows = activeCruises
      .map((cruise) => {
        const fare = cruise.brochure_fare_display || "—";
        const nights = cruise.nights != null ? `${cruise.nights}n` : "—";
        const dest = cruise.destination_name || "—";
        const destLink =
          cruise.destination_slug
            ? `<a href="/destination/${esc(cruise.destination_slug)}" target="_blank" rel="noopener noreferrer">${esc(
                dest
              )}</a>`
            : esc(dest);
        return `<tr>
          <td>${esc(formatDay(cruise.departure_date))}</td>
          <td>${esc(cruise.cruise_line_name || "—")}</td>
          <td>${esc(cruise.ship_name || "—")}</td>
          <td>${destLink}</td>
          <td>${esc(nights)}</td>
          <td>${esc(departurePortSummary(cruise))}</td>
          <td>${esc(fare)}</td>
          <td class="admin-actions-cell">${renderCruiseActions(cruise)}</td>
        </tr>`;
      })
      .join("");

    return `
      ${filters}
      <div class="usage-table-wrap">
        <table class="usage-table">
          <thead>
            <tr>
              <th>Departure</th>
              <th>Cruise line</th>
              <th>Ship</th>
              <th>Destination</th>
              <th>Nights</th>
              <th>From</th>
              <th>Fare</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  async function discoverLine(lineId, destinationId) {
    return api("start_discovery", {
      scope: destinationId ? "destination" : "cruise_line",
      cruise_line_id: lineId,
      destination_id: destinationId || undefined
    });
  }

  async function runSelectedLine() {
    if (!selectedLineId) {
      message = "Select a cruise line first.";
      messageTone = "error";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
      return;
    }
    discovering = true;
    message = "Discovering cruises for selected cruise line…";
    messageTone = "running";
    if (typeof global.renderAdmin === "function") global.renderAdmin();
    try {
      const result = await discoverLine(selectedLineId, "");
      const s = result.stats || {};
      message = `Done for ${result.cruise_line_name || "line"}: ${s.new || 0} new, ${s.changed || 0} changed, ${s.review_items || 0} review.`;
      messageTone = "success";
      await ensureLoaded({ quiet: true });
    } catch (error) {
      message = error.message || "Discovery failed";
      messageTone = "error";
    } finally {
      discovering = false;
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    }
  }

  async function runSelectedDestination() {
    if (!selectedDestinationId) {
      message = "Select a destination first.";
      messageTone = "error";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
      return;
    }
    const soldLines = lines.filter((l) => l.sold_by_101cruise !== false);
    const queue = (soldLines.length ? soldLines : lines).map((l) => l.id);
    if (!queue.length) {
      message = "No active cruise lines to scan.";
      messageTone = "error";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
      return;
    }

    discovering = true;
    cancelFull = false;
    let totals = { new: 0, changed: 0, review_items: 0 };
    try {
      for (let i = 0; i < queue.length; i += 1) {
        if (cancelFull) break;
        const line = lines.find((l) => l.id === queue[i]);
        message = `Destination discovery ${i + 1}/${queue.length}: ${line?.name || "line"}…`;
        messageTone = "running";
        if (typeof global.renderAdmin === "function") global.renderAdmin();
        try {
          const result = await discoverLine(queue[i], selectedDestinationId);
          const s = result.stats || {};
          totals.new += s.new || 0;
          totals.changed += s.changed || 0;
          totals.review_items += s.review_items || 0;
        } catch (error) {
          console.warn("destination discovery line failed", queue[i], error);
        }
      }
      message = cancelFull
        ? "Destination discovery cancelled."
        : `Destination discovery finished: ${totals.new} new, ${totals.changed} changed, ${totals.review_items} review.`;
      messageTone = cancelFull ? "error" : "success";
      await ensureLoaded({ quiet: true });
    } finally {
      discovering = false;
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    }
  }

  async function runFullDiscovery() {
    const queue = lines.map((l) => l.id);
    if (!queue.length) {
      message = "No active cruise lines to scan.";
      messageTone = "error";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
      return;
    }
    discovering = true;
    cancelFull = false;
    let totals = {
      candidates: 0,
      cruises_inserted: 0,
      upserted_active: 0,
      review_items: 0,
      skipped_non_cruise: 0,
      duplicate_candidates_suppressed: 0,
      new: 0,
      changed: 0
    };
    try {
      for (let i = 0; i < queue.length; i += 1) {
        if (cancelFull) break;
        const line = lines.find((l) => l.id === queue[i]);
        message = `Full discovery ${i + 1}/${queue.length}: ${line?.name || "line"}…`;
        messageTone = "running";
        if (typeof global.renderAdmin === "function") global.renderAdmin();
        try {
          const result = await discoverLine(queue[i], "");
          const s = result.stats || {};
          totals.candidates += s.candidates || s.new || 0;
          totals.cruises_inserted += s.cruises_inserted || 0;
          totals.upserted_active += s.upserted_active || 0;
          totals.review_items += s.review_items || 0;
          totals.skipped_non_cruise += s.skipped_non_cruise || 0;
          totals.duplicate_candidates_suppressed += s.duplicate_candidates_suppressed || 0;
          totals.new += s.new || 0;
          totals.changed += s.changed || 0;
        } catch (error) {
          console.warn("full discovery line failed", queue[i], error);
        }
      }
      message = cancelFull
        ? "Full discovery cancelled."
        : `Full discovery finished: ${totals.candidates || totals.new || 0} candidates found, ${
            totals.cruises_inserted || totals.upserted_active || 0
          } validated cruises added, ${totals.review_items || 0} candidates require review, ${
            (totals.skipped_non_cruise || 0) + (totals.duplicate_candidates_suppressed || 0)
          } low-signal or duplicate results ignored.`;
      messageTone = cancelFull ? "error" : "success";
      await ensureLoaded({ quiet: true });
    } finally {
      discovering = false;
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    }
  }

  function renderPanel() {
    const messageClass =
      messageTone === "error"
        ? "admin-error"
        : messageTone === "success"
          ? "admin-success"
          : messageTone === "running"
            ? "admin-running"
            : "";
    const runningStatus =
      discovering && message
        ? `<span class="admin-running-status" role="status" aria-live="polite">${esc(message)}</span>`
        : "";

    return `
      <div class="admin-card">
        <div class="admin-list-top">
          <div>
            <p class="admin-nav-eyebrow">Content Studio</p>
            <h3>Cruise Discovery</h3>
            <p class="admin-muted">Discover current sailings from official cruise line websites only. Never invents prices or itineraries. Unknown ships/destinations go to the Review Queue.</p>
          </div>
          <div class="admin-row-actions">
            <button type="button" class="admin-button secondary small" onclick="CruiseDiscoveryAdmin.setView('dashboard')" ${
              view === "dashboard" ? "disabled" : ""
            }>Dashboard</button>
            <button type="button" class="admin-button secondary small" onclick="CruiseDiscoveryAdmin.setView('cruises')" ${
              view === "cruises" ? "disabled" : ""
            }>Browse Active (${esc(String(cards?.active_cruises ?? activeCruises.length ?? 0))})</button>
            <button type="button" class="admin-button secondary small" onclick="CruiseDiscoveryAdmin.setView('review')" ${
              view === "review" ? "disabled" : ""
            }>Review Queue (${esc(String(reviewGroups.length || reviewItemCount))})</button>
            <button type="button" class="admin-button secondary small" onclick="CruiseDiscoveryAdmin.refresh()" ${
              loading || discovering ? "disabled" : ""
            }>Refresh</button>
          </div>
        </div>
        ${message && !discovering ? `<div class="admin-message ${messageClass}">${esc(message)}</div>` : ""}
        ${runningStatus}
      </div>

      ${
        view === "review"
          ? `<div class="admin-card" style="margin-top:16px"><h3>Review Queue</h3>${loading ? loadingPanel() : renderReview()}</div>`
          : view === "cruises"
            ? `<div class="admin-card" style="margin-top:16px">
                <h3>Browse Active Cruises</h3>
                <p class="admin-helper">Complete sailings in the Discovery catalogue (status = active). These can appear on Living Destination pages and Cruise Finder.</p>
                ${loading ? loadingPanel() : renderActiveCruises()}
              </div>`
            : loading
              ? `<div class="admin-card" style="margin-top:16px">${loadingPanel()}</div>`
              : `
      ${renderCards()}
      ${renderLineHealth()}
      ${renderReviewBreakdown()}

      <div class="admin-card" style="margin-top:16px">
        <h3>Run discovery</h3>
        <p class="admin-helper">Each run searches official domains, extracts → normalises → matches → validates. Only validated sailings become Active cruises. Unvalidated records are candidates. Prefer <strong>Verify selected line</strong> before another full run.</p>
        <div class="featured-cruises-toolbar">
          <div class="admin-field">
            <label for="discoveryLineSelect">Cruise line</label>
            <select id="discoveryLineSelect" onchange="CruiseDiscoveryAdmin.setLine(this.value)" ${
              discovering ? "disabled" : ""
            }>
              ${lineOptions()}
            </select>
          </div>
          <div class="admin-field">
            <label for="discoveryDestSelect">Destination</label>
            <select id="discoveryDestSelect" onchange="CruiseDiscoveryAdmin.setDestination(this.value)" ${
              discovering ? "disabled" : ""
            }>
              ${destinationOptions()}
            </select>
          </div>
        </div>
        <div class="admin-row-actions" style="margin-top:12px">
          <button type="button" class="admin-button secondary" onclick="CruiseDiscoveryAdmin.verifyLine()" ${
            discovering ? "disabled" : ""
          }>Verify Selected Line</button>
          <button type="button" class="admin-button black" onclick="CruiseDiscoveryAdmin.runFull()" ${
            discovering ? "disabled" : ""
          }>Run Full Discovery</button>
          <button type="button" class="admin-button secondary" onclick="CruiseDiscoveryAdmin.runLine()" ${
            discovering ? "disabled" : ""
          }>Discover Selected Cruise Line</button>
          <button type="button" class="admin-button secondary" onclick="CruiseDiscoveryAdmin.runDestination()" ${
            discovering ? "disabled" : ""
          }>Discover Selected Destination</button>
          ${
            discovering
              ? `<button type="button" class="admin-button danger small" onclick="CruiseDiscoveryAdmin.cancel()">Cancel</button>`
              : ""
          }
        </div>
      </div>

      <div class="admin-card" style="margin-top:16px">
        <h3>Recent runs</h3>
        ${renderRuns()}
      </div>`
      }
    `;
  }

  global.CruiseDiscoveryAdmin = {
    ensureLoaded,
    renderPanel,
    refresh() {
      ensureLoaded();
    },
    setView(next) {
      if (next === "review") view = "review";
      else if (next === "cruises") view = "cruises";
      else view = "dashboard";
      if (view === "cruises") {
        loadActiveCruises()
          .then(() => {
            if (typeof global.renderAdmin === "function") global.renderAdmin();
          })
          .catch((error) => {
            message = error.message || "Failed to load active cruises";
            messageTone = "error";
            if (typeof global.renderAdmin === "function") global.renderAdmin();
          });
      }
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    setLine(id) {
      selectedLineId = id;
    },
    setDestination(id) {
      selectedDestinationId = id;
    },
    setBrowseLine(id) {
      browseLineId = id || "";
      loadActiveCruises()
        .then(() => {
          if (typeof global.renderAdmin === "function") global.renderAdmin();
        })
        .catch((error) => {
          message = error.message || "Failed to filter cruises";
          messageTone = "error";
          if (typeof global.renderAdmin === "function") global.renderAdmin();
        });
    },
    setBrowseDestination(id) {
      browseDestinationId = id || "";
      loadActiveCruises()
        .then(() => {
          if (typeof global.renderAdmin === "function") global.renderAdmin();
        })
        .catch((error) => {
          message = error.message || "Failed to filter cruises";
          messageTone = "error";
          if (typeof global.renderAdmin === "function") global.renderAdmin();
        });
    },
    runFull: runFullDiscovery,
    runLine: runSelectedLine,
    runDestination: runSelectedDestination,
    cancel() {
      cancelFull = true;
      message = "Cancelling after current cruise line…";
      messageTone = "running";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    async resolveReview(id, applyShipUrl) {
      try {
        await api("resolve_review", { review_id: id, apply_official_ship_url: Boolean(applyShipUrl) });
        message = applyShipUrl ? "Official ship URL applied." : "Review item resolved.";
        messageTone = "success";
        await ensureLoaded({ quiet: true });
      } catch (error) {
        message = error.message || "Could not resolve review item";
        messageTone = "error";
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async ignoreReview(id) {
      try {
        await api("ignore_review", { review_id: id });
        message = "Review item ignored.";
        messageTone = "success";
        await ensureLoaded({ quiet: true });
      } catch (error) {
        message = error.message || "Could not ignore review item";
        messageTone = "error";
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async resolveGroup(groupId, options = {}) {
      try {
        const result = await api("resolve_review_group", {
          group_id: groupId,
          resolution_action: options.resolutionAction || "resolve",
          apply_suggested_ship:
            options.resolutionAction === "match_ship" ||
            options.resolutionAction === "match_and_save_alias" ||
            Boolean(options.applySuggestedShip),
          save_alias: options.resolutionAction === "match_and_save_alias",
          apply_suggested_destination:
            options.resolutionAction === "match_destination" ||
            Boolean(options.applySuggestedDestination),
          apply_official_ship_url:
            options.resolutionAction === "apply_ship_url" ||
            Boolean(options.applyOfficialShipUrl)
        });
        message = result.message || "Review group resolved.";
        messageTone = "success";
        await ensureLoaded({ quiet: true });
      } catch (error) {
        message = error.message || "Could not resolve review group";
        messageTone = "error";
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async ignoreGroup(groupId) {
      try {
        const result = await api("ignore_review_group", { group_id: groupId });
        message = result.message || "Review group ignored.";
        messageTone = "success";
        await ensureLoaded({ quiet: true });
      } catch (error) {
        message = error.message || "Could not ignore review group";
        messageTone = "error";
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async reprocessGroup(groupId) {
      try {
        const result = await api("reprocess_group", { group_id: groupId });
        message = `Reprocessed ${result.reprocessed || 0}; promoted ${result.promoted || 0}; unresolved ${result.unresolved || 0}.`;
        messageTone = "success";
        await ensureLoaded({ quiet: true });
      } catch (error) {
        message = error.message || "Reprocess failed";
        messageTone = "error";
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async manualDateForGroup(groupId) {
      const group = reviewGroups.find((g) => g.group_id === groupId);
      const departure = global.prompt(
        "Enter departure date (YYYY-MM-DD). Only for genuine sailings — not hub pages.",
        group?.parsed_departure_date || ""
      );
      if (!departure) return;
      const returnDate =
        global.prompt("Optional return date (YYYY-MM-DD), or leave blank", "") || "";
      try {
        const result = await api("resolve_review_group", {
          group_id: groupId,
          resolution_action: "resolve",
          manual_departure_date: departure,
          manual_return_date: returnDate || null
        });
        message = result.message || `Manual date ${departure} saved and candidates reprocessed.`;
        messageTone = "success";
        await ensureLoaded({ quiet: true });
      } catch (error) {
        message = error.message || "Could not save manual date";
        messageTone = "error";
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async reprocessAllVisible() {
      try {
        discovering = true;
        let promoted = 0;
        let reprocessed = 0;
        for (const group of reviewGroups) {
          const result = await api("reprocess_group", { group_id: group.group_id });
          reprocessed += result.reprocessed || 0;
          promoted += result.promoted || 0;
        }
        message = `Reprocessed ${reprocessed} candidates across ${reviewGroups.length} groups; promoted ${promoted}.`;
        messageTone = "success";
        await ensureLoaded({ quiet: true });
      } catch (error) {
        message = error.message || "Reprocess failed";
        messageTone = "error";
      } finally {
        discovering = false;
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    setReviewFilter(type) {
      reviewFilterType = type || "";
      view = "review";
      ensureLoaded();
    },
    async verifyLine() {
      if (!selectedLineId) {
        message = "Select a cruise line first.";
        messageTone = "error";
        if (typeof global.renderAdmin === "function") global.renderAdmin();
        return;
      }
      discovering = true;
      message = "Verifying selected cruise line (not a full discovery)…";
      messageTone = "running";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
      try {
        const result = await api("verify_selected_line", { cruise_line_id: selectedLineId });
        const s = result.stats || {};
        message = `Verification for ${result.cruise_line_name || "line"} [${s.adapter_id || "adapter"}]: Brave ${s.brave_results_received || 0}, excluded before fetch ${s.results_excluded_before_fetch || 0}, sailing fetched ${s.sailing_urls_fetched || 0}, candidates ${s.candidates || 0}, validated ${s.candidates_validated || s.upserted_active || 0}, review ${s.review_items || 0}, method ${JSON.stringify(s.source_method_counts || {})}. Full discovery is NOT marked safe yet.`;
        messageTone = "success";
        await ensureLoaded({ quiet: true });
      } catch (error) {
        message = error.message || "Verification failed";
        messageTone = "error";
      } finally {
        discovering = false;
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async manualDeparturePort(cruiseId) {
      try {
        const portResult = await api("list_departure_ports");
        departurePorts = portResult.ports || departurePorts;
      } catch (_error) {
        // Keep existing catalogue if refresh fails.
      }
      const sample = departurePorts.slice(0, 8).map((p) => p.canonical_name).join(", ");
      const value = global.prompt(
        `Enter canonical departure port (e.g. ${sample || "Sydney, Vancouver, Seattle"}).\n\nIf the port is missing from the catalogue, use Add port first, save it, then Set port again.`,
        ""
      );
      if (!value) return;
      try {
        const result = await api("manual_resolve_departure_port", {
          cruise_id: cruiseId,
          canonical_port_name: value
        });
        message = result.message || "Departure port saved.";
        messageTone = "success";
        await ensureLoaded({ quiet: true });
      } catch (error) {
        message = error.message || "Could not save departure port";
        messageTone = "error";
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    openAddPort(suggestedName) {
      const prefill = {
        canonical_name: String(suggestedName || "").trim(),
        display_name: String(suggestedName || "").trim(),
        status: "provisional",
        source: "admin"
      };
      if (typeof global.setTab === "function") {
        global.setTab("ports-catalogue");
      } else if (typeof setTab === "function") {
        setTab("ports-catalogue");
      }
      window.setTimeout(() => {
        if (global.PortsCatalogueAdmin?.startCreate) {
          global.PortsCatalogueAdmin.startCreate(prefill);
        }
      }, 120);
    },
    async removeCruise(cruiseId) {
      const cruise = activeCruises.find((row) => row.id === cruiseId);
      const label = [
        cruise?.cruise_line_name,
        cruise?.ship_name,
        cruise?.departure_date ? formatDay(cruise.departure_date) : null
      ]
        .filter(Boolean)
        .join(" · ");
      const ok = global.confirm(
        `Remove this cruise from active inventory?\n\n${label || cruiseId}\n\nIt will be hidden, not permanently deleted.`
      );
      if (!ok) return;
      try {
        const result = await api("hide_discovered_cruise", { cruise_id: cruiseId });
        message = result.message || "Cruise removed.";
        messageTone = "success";
        await ensureLoaded({ quiet: true });
      } catch (error) {
        message = error.message || "Could not remove cruise";
        messageTone = "error";
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async manualDeparturePortForGroup(groupId) {
      const group = reviewGroups.find((g) => g.group_id === groupId);
      const cruiseId = group?.affected_cruise_ids?.[0] || group?.payload?.cruise_id || null;
      if (!cruiseId) {
        message = "No affected cruise id found for this group.";
        messageTone = "error";
        if (typeof global.renderAdmin === "function") global.renderAdmin();
        return;
      }
      await CruiseDiscoveryAdmin.manualDeparturePort(cruiseId);
    },
    async collapseDuplicates() {
      try {
        const result = await api("collapse_duplicate_review");
        message = result.message || "Duplicate review items collapsed.";
        messageTone = "success";
        await ensureLoaded({ quiet: true });
      } catch (error) {
        message = error.message || "Could not collapse duplicates";
        messageTone = "error";
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
