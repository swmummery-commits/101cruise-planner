/**
 * Sprint 11B — Cruise Line Audit (Research Health).
 * Compares official fleet pages to ci_cruise_ships. No automatic DB mutations.
 */
(function (global) {
  "use strict";

  let loading = false;
  let auditing = false;
  let message = "";
  let messageTone = "info";
  let cards = null;
  let researchHealth = null;
  let lines = [];
  let selectedLineId = "";
  let runs = [];
  let activeRun = null;
  let findings = [];
  let view = "dashboard"; // dashboard | run
  let fullAuditCancel = false;
  let auditMode = null; // "full" | "selected"

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

  function stars(n) {
    const filled = Math.max(0, Math.min(5, Number(n) || 0));
    return "★".repeat(filled) + "☆".repeat(5 - filled);
  }

  async function api(action, payload = {}) {
    const headers =
      typeof global.adminAuthHeaders === "function"
        ? await global.adminAuthHeaders()
        : { "Content-Type": "application/json" };
    const response = await fetch("/.netlify/functions/cruise-line-audit", {
      method: "POST",
      headers,
      body: JSON.stringify({ action, ...payload })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      let msg = data.error || `Request failed (${response.status})`;
      if (response.status === 504 || response.status === 502) {
        msg = "Audit timed out. Try auditing one cruise line at a time.";
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
      const [dash, lineResult, runResult] = await Promise.all([
        api("dashboard"),
        api("list_lines"),
        api("list_runs", { limit: 15 })
      ]);
      cards = dash.cards || null;
      researchHealth = dash.research_health || null;
      lines = lineResult.cruise_lines || [];
      runs = runResult.runs || [];
      if (!selectedLineId && lines[0]) selectedLineId = lines[0].id;
      if (!quiet) message = "";
    } catch (error) {
      message = error.message || "Failed to load Cruise Line Audit";
      messageTone = "error";
    } finally {
      loading = false;
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    }
  }

  function renderCards() {
    const c = cards || {};
    const items = [
      { label: "Active Cruise Lines", value: c.active_cruise_lines ?? "—" },
      { label: "Active Ships", value: c.active_ships ?? "—" },
      { label: "Last Full Audit", value: formatDate(c.last_full_audit) },
      { label: "New Ships Found (last audit)", value: c.new_ships_found_last_audit ?? 0 },
      { label: "Ships Requiring Review", value: c.ships_requiring_review ?? 0 },
      { label: "Research Updates Required", value: c.research_updates_required ?? 0 }
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

  function renderHealth() {
    if (!researchHealth) return "";
    return `
      <div class="research-audit-health admin-card">
        <h3>Research Freshness</h3>
        <p class="research-audit-stars" aria-label="${esc(researchHealth.research_health)}">
          ${esc(stars(researchHealth.research_health_stars))}
          <strong>${esc(researchHealth.research_health)}</strong>
        </p>
        <ul class="research-audit-health-list">
          <li>Ships never researched: <strong>${esc(String(researchHealth.ships_never_researched))}</strong></li>
          <li>Ships older than 24 months: <strong>${esc(String(researchHealth.ships_older_than_24_months))}</strong></li>
        </ul>
        <p class="admin-muted">Health reflects Research Content coverage for active ships — not fleet audit status.</p>
      </div>
    `;
  }

  function findingActions(f) {
    if (f.decision !== "pending") {
      return `<span class="admin-muted">Decision: ${esc(f.decision)}</span>`;
    }
    const id = esc(f.id);
    const viewSrc = f.source_url
      ? `<a class="admin-button secondary small" href="${esc(f.source_url)}" target="_blank" rel="noopener noreferrer">View Source</a>`
      : "";
    if (f.finding_type === "new_ship") {
      return `
        <button type="button" class="admin-button black small" onclick="CruiseLineAuditAdmin.applyFinding('${id}','add')">Add to Database</button>
        <button type="button" class="admin-button secondary small" onclick="CruiseLineAuditAdmin.applyFinding('${id}','ignore')">Ignore</button>
        ${viewSrc}`;
    }
    if (f.finding_type === "possible_retired") {
      return `
        <button type="button" class="admin-button danger small" onclick="CruiseLineAuditAdmin.applyFinding('${id}','archive')">Archive Ship</button>
        <button type="button" class="admin-button secondary small" onclick="CruiseLineAuditAdmin.applyFinding('${id}','ignore')">Ignore</button>
        ${viewSrc}`;
    }
    if (f.finding_type === "possible_rename" || f.finding_type === "possible_transfer") {
      return `
        <button type="button" class="admin-button small" onclick="CruiseLineAuditAdmin.applyFinding('${id}','review')">Review</button>
        ${
          f.finding_type === "possible_transfer"
            ? `<button type="button" class="admin-button danger small" onclick="CruiseLineAuditAdmin.applyFinding('${id}','archive')">Archive Ship</button>`
            : ""
        }
        <button type="button" class="admin-button secondary small" onclick="CruiseLineAuditAdmin.applyFinding('${id}','ignore')">Ignore</button>
        ${viewSrc}`;
    }
    return `${viewSrc}
      <button type="button" class="admin-button secondary small" onclick="CruiseLineAuditAdmin.applyFinding('${id}','ignore')">Dismiss</button>`;
  }

  function statusIcon(type) {
    if (type === "no_changes") return "✔";
    if (type === "new_ship") return "+";
    if (type === "unable_to_verify") return "?";
    return "⚠";
  }

  function renderFindingsGrouped() {
    if (!findings.length) {
      return `<p class="admin-muted">No findings for this run.</p>`;
    }
    const byLine = new Map();
    for (const f of findings) {
      const lineName =
        f.ci_cruise_lines?.name ||
        lines.find((l) => l.id === f.cruise_line_id)?.name ||
        "Cruise line";
      if (!byLine.has(f.cruise_line_id)) byLine.set(f.cruise_line_id, { name: lineName, rows: [] });
      byLine.get(f.cruise_line_id).rows.push(f);
    }

    return [...byLine.values()]
      .map((group) => {
        const onlyOk =
          group.rows.length === 1 && group.rows[0].finding_type === "no_changes";
        if (onlyOk) {
          return `
            <div class="research-audit-line-block">
              <h4>${esc(group.name)}</h4>
              <p class="research-audit-ok">✔ No Changes</p>
            </div>`;
        }
        const rows = group.rows
          .map(
            (f) => `
          <tr>
            <td><span class="research-audit-status research-audit-status--${esc(f.finding_type)}">${esc(statusIcon(f.finding_type))} ${esc(f.status_label || f.finding_type)}</span></td>
            <td>${esc(f.ship_name || "—")}</td>
            <td class="research-audit-reason">${esc(f.reason || "—")}</td>
            <td>${esc(f.confidence || "—")}</td>
            <td>${f.source_url ? `<a href="${esc(f.source_url)}" target="_blank" rel="noopener noreferrer">Source</a>` : "—"}</td>
            <td class="research-audit-actions">${findingActions(f)}</td>
          </tr>`
          )
          .join("");
        return `
          <div class="research-audit-line-block">
            <h4>${esc(group.name)}</h4>
            <div class="research-table-wrap">
              <table class="research-table research-audit-table">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Ship Name</th>
                    <th>Reason</th>
                    <th>Confidence</th>
                    <th>Official Source</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          </div>`;
      })
      .join("");
  }

  function renderHistory() {
    if (!runs.length) return `<p class="admin-muted">No audit history yet.</p>`;
    return `
      <div class="research-table-wrap">
        <table class="research-table">
          <thead>
            <tr>
              <th>Audit Date</th>
              <th>Scope</th>
              <th>Line</th>
              <th>Lines</th>
              <th>Ships</th>
              <th>New</th>
              <th>Archived*</th>
              <th>Warnings</th>
              <th>Duration</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${runs
              .map((r) => {
                const lineName = r.ci_cruise_lines?.name || (r.scope === "full" ? "All lines" : "—");
                return `
              <tr>
                <td>${esc(formatDate(r.finished_at || r.created_at))}</td>
                <td>${esc(r.scope)}</td>
                <td>${esc(lineName)}</td>
                <td>${esc(String(r.lines_checked ?? 0))}</td>
                <td>${esc(String(r.ships_checked ?? 0))}</td>
                <td>${esc(String(r.new_ships_count ?? 0))}</td>
                <td>${esc(String(r.retired_candidates_count ?? 0))}*</td>
                <td>${esc(String(r.warnings_count ?? 0))}</td>
                <td>${r.duration_ms != null ? esc(`${Math.round(r.duration_ms / 1000)}s`) : "—"}</td>
                <td><button type="button" class="admin-button secondary small" onclick="CruiseLineAuditAdmin.openRun('${esc(r.id)}')">Open</button></td>
              </tr>`;
              })
              .join("")}
          </tbody>
        </table>
      </div>
      <p class="admin-muted">* Candidates flagged for review — ships are only archived after you approve Archive Ship.</p>
    `;
  }

  function isRunningTone() {
    return messageTone === "running";
  }

  function messageClassName() {
    if (messageTone === "error") return "admin-error";
    if (messageTone === "success") return "admin-success";
    if (messageTone === "running") return "admin-running";
    return "";
  }

  function renderRunningStatus() {
    if (!message || !isRunningTone()) return "";
    return `<span class="admin-running-status" role="status" aria-live="polite">${esc(message)}</span>`;
  }

  function renderDashboard() {
    const lineOptions = lines
      .map(
        (l) =>
          `<option value="${esc(l.id)}" ${selectedLineId === l.id ? "selected" : ""}>${esc(l.name)}</option>`
      )
      .join("");

    return `
      <section class="admin-panel research-panel research-audit-panel">
        <div class="admin-panel-header">
          <div>
            <h2>Cruise Line Audit</h2>
            <p class="admin-muted">Audit official cruise line fleets to identify new ships, retired ships and research updates.</p>
          </div>
        </div>
        ${message && !isRunningTone() ? `<p class="admin-message ${messageClassName()}">${esc(message)}</p>` : ""}
        ${loading ? `<p class="admin-muted">Loading…</p>` : ""}
        ${renderCards()}
        ${renderHealth()}

        <div class="research-audit-controls admin-card">
          <h3>Audit Controls</h3>
          <div class="research-audit-control-row">
            <button type="button" class="admin-button black ${auditing && auditMode === "full" ? "is-busy" : ""}" onclick="CruiseLineAuditAdmin.runFullAudit()" ${auditing ? "disabled" : ""}>
              ${auditing && auditMode === "full" ? "Auditing…" : "Run Full Fleet Audit"}
            </button>
            ${auditing && auditMode === "full" ? `<button type="button" class="admin-button danger" onclick="CruiseLineAuditAdmin.cancelFullAudit()">Stop after current line</button>` : ""}
            ${auditing && auditMode === "full" ? renderRunningStatus() : ""}
          </div>
          <div class="research-audit-control-row research-audit-selected">
            <label>Audit Selected Cruise Line
              <select onchange="CruiseLineAuditAdmin.setLine(this.value)" ${auditing ? "disabled" : ""}>
                <option value="">Choose cruise line…</option>
                ${lineOptions}
              </select>
            </label>
            <button type="button" class="admin-button ${auditing && auditMode === "selected" ? "is-busy" : ""}" onclick="CruiseLineAuditAdmin.runSelected()" ${auditing || !selectedLineId ? "disabled" : ""}>
              ${auditing && auditMode === "selected" ? "Auditing…" : "Run Audit"}
            </button>
            ${auditing && auditMode === "selected" ? renderRunningStatus() : ""}
          </div>
          <p class="admin-muted">Official cruise line websites are preferred. No ships are added, archived, or changed until you approve an action.</p>
        </div>

        ${
          activeRun
            ? `<div class="research-audit-results">
                <div class="admin-panel-header">
                  <h3>Latest Results</h3>
                  <button type="button" class="admin-button secondary small" onclick="CruiseLineAuditAdmin.clearActiveRun()">Clear</button>
                </div>
                ${renderFindingsGrouped()}
              </div>`
            : ""
        }

        <div class="research-audit-history">
          <h3>Audit History</h3>
          ${renderHistory()}
        </div>
      </section>
    `;
  }

  function renderRunView() {
    return `
      <section class="admin-panel research-panel research-audit-panel">
        <div class="admin-panel-header">
          <div>
            <button type="button" class="admin-button secondary small" onclick="CruiseLineAuditAdmin.backToDashboard()">← Back</button>
            <h2>Audit Report</h2>
            <p class="admin-muted">${esc(formatDate(activeRun?.finished_at || activeRun?.created_at))} · ${esc(activeRun?.scope || "")} · ${esc(activeRun?.status || "")}</p>
          </div>
        </div>
        ${message && !isRunningTone() ? `<p class="admin-message ${messageClassName()}">${esc(message)}</p>` : ""}
        ${renderFindingsGrouped()}
      </section>
    `;
  }

  function renderPanel() {
    if (view === "run" && activeRun) return renderRunView();
    return renderDashboard();
  }

  async function runAuditForLine(lineId, scope) {
    const result = await api("start_audit", { cruise_line_id: lineId, scope });
    activeRun = result.run;
    findings = result.findings || [];
    view = "dashboard";
    return result;
  }

  const apiPublic = {
    renderPanel,
    ensureLoaded,
    setLine(value) {
      selectedLineId = value;
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    async runSelected() {
      if (!selectedLineId || auditing) return;
      auditing = true;
      auditMode = "selected";
      message = "Running fleet audit…";
      messageTone = "running";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
      try {
        const result = await runAuditForLine(selectedLineId, "selected");
        message = `Audit complete for ${result.line?.name || "cruise line"}.`;
        messageTone = "success";
        await ensureLoaded({ quiet: true });
      } catch (error) {
        message = error.message || "Audit failed";
        messageTone = "error";
      } finally {
        auditing = false;
        auditMode = null;
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    cancelFullAudit() {
      fullAuditCancel = true;
      message = "Stopping after the current cruise line…";
      messageTone = "running";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    async runFullAudit() {
      if (auditing) return;
      if (!lines.length) {
        message = "No active cruise lines found.";
        messageTone = "warning";
        if (typeof global.renderAdmin === "function") global.renderAdmin();
        return;
      }
      auditing = true;
      auditMode = "full";
      fullAuditCancel = false;
      const allFindings = [];
      let lastRun = null;
      message = `Running full fleet audit: 0/${lines.length}…`;
      messageTone = "running";
      if (typeof global.renderAdmin === "function") global.renderAdmin();

      try {
        for (let i = 0; i < lines.length; i += 1) {
          if (fullAuditCancel) break;
          const line = lines[i];
          message = `Running full fleet audit: ${i + 1}/${lines.length} — ${line.name}`;
          messageTone = "running";
          if (typeof global.renderAdmin === "function") global.renderAdmin();
          try {
            const result = await runAuditForLine(line.id, "full");
            lastRun = result.run;
            allFindings.push(...(result.findings || []));
          } catch (error) {
            allFindings.push({
              finding_type: "unable_to_verify",
              status_label: "Unable to Verify",
              ship_name: null,
              reason: `${line.name}: ${error.message}`,
              confidence: "low",
              decision: "pending",
              cruise_line_id: line.id,
              id: `local-${line.id}`
            });
          }
        }
        activeRun = lastRun;
        findings = allFindings;
        message = fullAuditCancel
          ? "Full audit stopped early. Review findings below."
          : `Full fleet audit finished (${lines.length} lines).`;
        messageTone = fullAuditCancel ? "warning" : "success";
        await ensureLoaded({ quiet: true });
      } catch (error) {
        message = error.message || "Full audit failed";
        messageTone = "error";
      } finally {
        auditing = false;
        auditMode = null;
        fullAuditCancel = false;
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async openRun(id) {
      try {
        const result = await api("get_run", { id });
        activeRun = result.run;
        findings = result.findings || [];
        view = "run";
        message = "";
      } catch (error) {
        message = error.message || "Could not open audit";
        messageTone = "error";
      }
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    backToDashboard() {
      view = "dashboard";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    clearActiveRun() {
      activeRun = null;
      findings = [];
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    async applyFinding(findingId, applyAction) {
      try {
        const result = await api("apply_finding", {
          finding_id: findingId,
          apply_action: applyAction
        });
        message = result.message || "Updated.";
        messageTone = "success";
        // Refresh findings in place
        findings = findings.map((f) => (f.id === findingId ? result.finding || f : f));
        if (activeRun?.id) {
          const refreshed = await api("get_run", { id: activeRun.id });
          findings = refreshed.findings || findings;
          activeRun = refreshed.run || activeRun;
        }
        await ensureLoaded({ quiet: true });
      } catch (error) {
        message = error.message || "Action failed";
        messageTone = "error";
      }
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    }
  };

  global.CruiseLineAuditAdmin = apiPublic;
})(typeof window !== "undefined" ? window : globalThis);
