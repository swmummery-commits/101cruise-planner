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
  let selectedLineId = "";
  let selectedDestinationId = "";
  let view = "dashboard"; // dashboard | review
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

  async function ensureLoaded({ quiet = false } = {}) {
    loading = true;
    if (!quiet && typeof global.renderAdmin === "function") global.renderAdmin();
    try {
      const [dash, lineResult, destResult, runResult, reviewResult] = await Promise.all([
        api("dashboard"),
        api("list_lines"),
        api("list_destinations"),
        api("list_runs", { limit: 15 }),
        api("list_review", { status: "pending", limit: 80 })
      ]);
      cards = dash.cards || null;
      lines = lineResult.cruise_lines || [];
      destinations = destResult.destinations || [];
      runs = runResult.runs || [];
      reviewItems = reviewResult.items || [];
      if (!selectedLineId && lines[0]) selectedLineId = lines[0].id;
      if (!selectedDestinationId && destinations[0]) selectedDestinationId = destinations[0].id;
      if (!quiet) message = "";
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
    const items = [
      { label: "Active Cruises", value: c.active_cruises ?? "—" },
      { label: "Cruise Lines (active)", value: c.active_cruise_lines ?? "—" },
      { label: "Last Discovery Run", value: formatDate(c.last_discovery_run) },
      { label: "New Cruises (7 days)", value: c.new_cruises ?? 0 },
      { label: "Changed (last run)", value: c.changed_cruises ?? 0 },
      { label: "Review Required", value: c.review_required ?? 0 }
    ];
    return `
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

  function renderReview() {
    if (!reviewItems.length) {
      return `<p class="admin-muted">Review queue is empty.</p>`;
    }
    return `
      <div class="usage-table-wrap">
        <table class="usage-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Item</th>
              <th>Source</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${reviewItems
              .map((item) => {
                const applyShip =
                  item.item_type === "missing_ship_url"
                    ? `<button type="button" class="admin-button black small" onclick='CruiseDiscoveryAdmin.resolveReview(${JSON.stringify(
                        item.id
                      )}, true)'>Apply ship URL</button>`
                    : "";
                return `<tr>
                  <td>${esc(item.item_type)}</td>
                  <td>
                    <strong>${esc(item.title || "—")}</strong>
                    <div class="admin-small">${esc(item.detail || "")}</div>
                  </td>
                  <td>${
                    item.source_url
                      ? `<a href="${esc(item.source_url)}" target="_blank" rel="noopener noreferrer">Open</a>`
                      : "—"
                  }</td>
                  <td class="admin-settings-actions">
                    ${applyShip}
                    <button type="button" class="admin-button secondary small" onclick='CruiseDiscoveryAdmin.resolveReview(${JSON.stringify(
                      item.id
                    )}, false)'>Resolve</button>
                    <button type="button" class="admin-button secondary small" onclick='CruiseDiscoveryAdmin.ignoreReview(${JSON.stringify(
                      item.id
                    )})'>Ignore</button>
                  </td>
                </tr>`;
              })
              .join("")}
          </tbody>
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
    let totals = { new: 0, changed: 0, review_items: 0 };
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
          totals.new += s.new || 0;
          totals.changed += s.changed || 0;
          totals.review_items += s.review_items || 0;
        } catch (error) {
          console.warn("full discovery line failed", queue[i], error);
        }
      }
      message = cancelFull
        ? "Full discovery cancelled."
        : `Full discovery finished: ${totals.new} new, ${totals.changed} changed, ${totals.review_items} review.`;
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
            <h3>Cruise Discovery</h3>
            <p class="admin-muted">Discover current sailings from official cruise line websites only. Never invents prices or itineraries. Unknown ships/destinations go to the Review Queue.</p>
          </div>
          <div class="admin-row-actions">
            <button type="button" class="admin-button secondary small" onclick="CruiseDiscoveryAdmin.setView('dashboard')" ${
              view === "dashboard" ? "disabled" : ""
            }>Dashboard</button>
            <button type="button" class="admin-button secondary small" onclick="CruiseDiscoveryAdmin.setView('review')">Review Queue (${esc(
              String(reviewItems.length)
            )})</button>
            <button type="button" class="admin-button secondary small" onclick="CruiseDiscoveryAdmin.refresh()" ${
              loading || discovering ? "disabled" : ""
            }>${loading ? "Loading…" : "Refresh"}</button>
          </div>
        </div>
        ${message && !discovering ? `<div class="admin-message ${messageClass}">${esc(message)}</div>` : ""}
        ${runningStatus}
      </div>

      ${
        view === "review"
          ? `<div class="admin-card" style="margin-top:16px"><h3>Review Queue</h3>${renderReview()}</div>`
          : `
      ${renderCards()}

      <div class="admin-card" style="margin-top:16px">
        <h3>Run discovery</h3>
        <p class="admin-helper">Each run searches official domains (website_url / cruise_search_url) via Brave, extracts only what appears in source text, matches Ships + Destinations, and upserts the Cruises table.</p>
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
      view = next === "review" ? "review" : "dashboard";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    setLine(id) {
      selectedLineId = id;
    },
    setDestination(id) {
      selectedDestinationId = id;
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
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
