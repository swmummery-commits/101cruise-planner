/**
 * Sprint 12A — Deck Plan Links (Research Content subsection).
 * Assisted find → human review → approve. No automatic publishing.
 */
(function (global) {
  "use strict";

  let loading = false;
  let findingShipId = "";
  let message = "";
  let messageTone = "info";
  let cards = null;
  let lines = [];
  let ships = [];
  let filterLineId = "";
  let filterStatus = "";
  let filterShip = "";
  let filterVerifiedAfter = "";
  let filterVerifiedBefore = "";
  let reviewShipId = "";
  let lastDiagnostics = null;
  let historyRows = [];
  let coverageReport = null;
  let showCoverage = false;

  // Optional bulk find (one ship at a time; never auto-approves)
  let bulkRunning = false;
  let bulkCancel = false;
  let bulkProgress = null;

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

  function statusLabel(status) {
    switch (status) {
      case "approved":
        return "Approved";
      case "needs_review":
        return "Needs Review";
      case "found":
        return "Found";
      case "outdated":
        return "Outdated";
      case "unavailable":
        return "Unavailable";
      default:
        return "Missing";
    }
  }

  function sourceTypeLabel(type) {
    switch (type) {
      case "official_pdf":
        return "Official PDF";
      case "official_interactive_viewer":
        return "Interactive viewer";
      case "official_page":
        return "Official page";
      case "other_official_asset":
        return "Other official asset";
      default:
        return "—";
    }
  }

  function historyActionLabel(action) {
    switch (action) {
      case "source_added":
        return "Source added";
      case "source_replaced":
        return "Source replaced";
      case "source_marked_outdated":
        return "Marked outdated";
      case "source_reverified":
        return "Reverified";
      case "source_rejected":
        return "Source rejected";
      default:
        return action || "—";
    }
  }

  async function api(action, payload = {}) {
    const headers =
      typeof global.adminAuthHeaders === "function"
        ? await global.adminAuthHeaders()
        : { "Content-Type": "application/json" };
    const response = await fetch("/.netlify/functions/deck-plans", {
      method: "POST",
      headers,
      body: JSON.stringify({ action, ...payload })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      const err = new Error(data.error || `Request failed (${response.status})`);
      err.status = response.status;
      err.payload = data;
      throw err;
    }
    return data;
  }

  function upsertShip(ship) {
    if (!ship?.id) return;
    const idx = ships.findIndex((s) => s.id === ship.id);
    if (idx >= 0) ships[idx] = ship;
    else ships.unshift(ship);
  }

  async function refreshList() {
    const result = await api("list_ships", {
      cruise_line_id: filterLineId || undefined,
      deck_plan_status: filterStatus || undefined,
      ship_query: filterShip || undefined,
      verified_after: filterVerifiedAfter || undefined,
      verified_before: filterVerifiedBefore || undefined
    });
    ships = result.ships || [];
  }

  async function loadHistory(shipId) {
    if (!shipId) {
      historyRows = [];
      return;
    }
    const data = await api("list_history", { ship_id: shipId, limit: 20 });
    historyRows = data.history || [];
  }

  async function ensureLoaded({ quiet = false } = {}) {
    loading = true;
    if (!quiet && typeof global.renderAdmin === "function") global.renderAdmin();
    try {
      const [dash, lineResult] = await Promise.all([api("dashboard"), api("list_lines")]);
      cards = dash.cards || null;
      lines = lineResult.cruise_lines || [];
      await refreshList();
      if (reviewShipId) await loadHistory(reviewShipId);
      if (!quiet) message = "";
    } catch (error) {
      message = error.message || "Failed to load Deck Plans";
      messageTone = "error";
    } finally {
      loading = false;
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    }
  }

  function renderCards() {
    const c = cards || {};
    const items = [
      { label: "Total Active Ships", value: c.total_active_ships ?? "—" },
      { label: "Approved Deck Plans", value: c.approved_deck_plans ?? 0 },
      { label: "Missing Deck Plans", value: c.missing_deck_plans ?? 0 },
      { label: "Needs Review", value: c.needs_review ?? 0 },
      { label: "Outdated", value: c.outdated ?? 0 },
      { label: "Last Verification Run", value: formatDate(c.last_verification_run) }
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

  function renderFilters() {
    return `
      <div class="research-filters deck-plans-filters">
        <div class="admin-field">
          <label for="deck-plan-filter-line">Cruise Line</label>
          <select id="deck-plan-filter-line" onchange="DeckPlansAdmin.setFilter('line', this.value)">
            <option value="">All lines</option>
            ${lines
              .map(
                (line) =>
                  `<option value="${esc(line.id)}" ${filterLineId === line.id ? "selected" : ""}>${esc(line.name)}</option>`
              )
              .join("")}
          </select>
        </div>
        <div class="admin-field">
          <label for="deck-plan-filter-status">Deck Plan Status</label>
          <select id="deck-plan-filter-status" onchange="DeckPlansAdmin.setFilter('status', this.value)">
            <option value="">All statuses</option>
            ${["missing", "needs_review", "found", "approved", "outdated", "unavailable"]
              .map(
                (s) =>
                  `<option value="${s}" ${filterStatus === s ? "selected" : ""}>${esc(statusLabel(s))}</option>`
              )
              .join("")}
          </select>
        </div>
        <div class="admin-field">
          <label for="deck-plan-filter-ship">Ship</label>
          <input
            id="deck-plan-filter-ship"
            type="search"
            placeholder="Ship name…"
            value="${esc(filterShip)}"
            oninput="DeckPlansAdmin.setFilter('ship', this.value)"
          />
        </div>
        <div class="admin-field">
          <label for="deck-plan-filter-after">Verified from</label>
          <input
            id="deck-plan-filter-after"
            type="date"
            value="${esc(filterVerifiedAfter)}"
            onchange="DeckPlansAdmin.setFilter('verified_after', this.value)"
          />
        </div>
        <div class="admin-field">
          <label for="deck-plan-filter-before">Verified to</label>
          <input
            id="deck-plan-filter-before"
            type="date"
            value="${esc(filterVerifiedBefore)}"
            onchange="DeckPlansAdmin.setFilter('verified_before', this.value)"
          />
        </div>
      </div>
    `;
  }

  function renderToolbar() {
    return `
      <div class="deck-plans-toolbar">
        <button type="button" class="admin-button secondary small" onclick="DeckPlansAdmin.runCoverageAudit()">
          Deck Plan Coverage Audit
        </button>
        ${
          bulkRunning
            ? `<button type="button" class="admin-button secondary small" onclick="DeckPlansAdmin.cancelBulkFind()">Cancel bulk find</button>`
            : `<button type="button" class="admin-button secondary small" onclick="DeckPlansAdmin.startBulkFind()">Find Deck Plans for Missing Ships</button>`
        }
        <p class="admin-small admin-muted">Primary workflow remains ship-by-ship review. Bulk find only creates candidates — never approves.</p>
      </div>
      ${
        bulkProgress
          ? `<div class="admin-card deck-plans-bulk-progress">
              <p><strong>Bulk find:</strong> ${esc(String(bulkProgress.done))}/${esc(
                String(bulkProgress.total)
              )} · current: ${esc(bulkProgress.current || "—")} · candidates found: ${esc(
                String(bulkProgress.candidatesFound || 0)
              )}${bulkProgress.error ? ` · last error: ${esc(bulkProgress.error)}` : ""}${
                bulkProgress.stopped ? " · stopped" : ""
              }</p>
            </div>`
          : ""
      }
    `;
  }

  function renderCoverage() {
    if (!showCoverage || !coverageReport) return "";
    const t = coverageReport.totals || {};
    const linesNone = coverageReport.cruise_lines_with_no_deck_plans || [];
    return `
      <section class="admin-card deck-plans-coverage">
        <div class="deck-plans-review-header">
          <h3>Coverage Audit</h3>
          <button type="button" class="admin-button secondary small" onclick="DeckPlansAdmin.hideCoverage()">Close</button>
        </div>
        <p class="admin-muted">Reporting only — this does not search or change ships.</p>
        <ul class="deck-plans-coverage-list">
          <li>Approved: <strong>${esc(String(t.approved ?? 0))}</strong></li>
          <li>Missing: <strong>${esc(String(t.missing ?? 0))}</strong></li>
          <li>Needs review: <strong>${esc(String(t.needs_review ?? 0))}</strong></li>
          <li>Not verified in last 12 months: <strong>${esc(String(t.not_verified_in_12_months ?? 0))}</strong></li>
          <li>Cruise lines with no deck plans captured: <strong>${esc(
            String(t.cruise_lines_with_no_deck_plans ?? 0)
          )}</strong></li>
        </ul>
        ${
          linesNone.length
            ? `<p class="admin-small"><strong>Lines with none approved:</strong> ${esc(
                linesNone.map((l) => l.name).join(", ")
              )}</p>`
            : ""
        }
      </section>
    `;
  }

  function renderHistory() {
    if (!historyRows.length) {
      return `<p class="admin-muted admin-small">No history yet for this ship.</p>`;
    }
    return `
      <div class="research-table-wrap deck-plans-history-wrap">
        <table class="research-table deck-plans-history-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>Previous</th>
              <th>New</th>
              <th>Admin</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            ${historyRows
              .map(
                (h) => `
              <tr>
                <td>${esc(formatDate(h.created_at))}</td>
                <td>${esc(historyActionLabel(h.action))}</td>
                <td class="deck-plans-url-cell">${esc(h.previous_url || "—")}</td>
                <td class="deck-plans-url-cell">${esc(h.new_url || "—")}</td>
                <td>${esc(h.administrator || "—")}</td>
                <td>${esc(h.notes || "—")}</td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderReviewPanel(ship) {
    if (!ship) return "";
    const candidates = Array.isArray(ship.candidates) ? ship.candidates : [];
    const diag = lastDiagnostics;
    return `
      <section class="admin-card deck-plans-review">
        <div class="deck-plans-review-header">
          <div>
            <h3>Review — ${esc(ship.name)}</h3>
            <p class="admin-muted">${esc(ship.cruise_line_name || "")}${
              ship.official_ship_url
                ? ` · <a href="${esc(ship.official_ship_url)}" target="_blank" rel="noopener noreferrer">Official ship page</a>`
                : " · No official ship URL set"
            }</p>
            ${
              ship.deck_plan_status === "approved" && ship.deck_plan_url
                ? `<p class="admin-small">Current approved: <a href="${esc(
                    ship.deck_plan_url
                  )}" target="_blank" rel="noopener noreferrer">${esc(ship.deck_plan_url)}</a>
                  · <button type="button" class="admin-button secondary small" onclick="DeckPlansAdmin.reverify('${esc(
                    ship.id
                  )}')">Reverify</button></p>`
                : ""
            }
          </div>
          <button type="button" class="admin-button secondary small" onclick="DeckPlansAdmin.closeReview()">Close</button>
        </div>
        ${
          !candidates.length
            ? `<p class="admin-muted">No candidates yet. Use Find Deck Plans to search official sources only (max 3 strong results).</p>`
            : `<div class="deck-plans-candidate-list">
                ${candidates
                  .map((c) => {
                    const candKey = encodeURIComponent(c.id || c.url || "");
                    return `
                      <article class="deck-plans-candidate">
                        <div class="deck-plans-candidate-main">
                          <h4>${esc(c.title || "Deck plan source")}</h4>
                          <p class="admin-small">${esc(c.url)}</p>
                          <p class="admin-muted">
                            Source type: ${esc(c.source_type_label || sourceTypeLabel(c.source_type))}
                            · Domain: ${esc(c.source_domain || "—")}
                            · Confidence: ${esc(String(c.confidence || "—"))}
                          </p>
                          <p>${esc(c.reason || "")}</p>
                        </div>
                        <div class="deck-plans-candidate-actions">
                          <a class="admin-button secondary small" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">Open Source</a>
                          <button type="button" class="admin-button small" onclick="DeckPlansAdmin.approve('${esc(
                            ship.id
                          )}', decodeURIComponent('${candKey}'))">Approve</button>
                          <button type="button" class="admin-button secondary small" onclick="DeckPlansAdmin.reject('${esc(
                            ship.id
                          )}', decodeURIComponent('${candKey}'))">Reject</button>
                        </div>
                      </article>`;
                  })
                  .join("")}
              </div>`
        }
        <div class="deck-plans-review-footer">
          <button type="button" class="admin-button secondary small" onclick="DeckPlansAdmin.find('${esc(
            ship.id
          )}', true)">Find again (force)</button>
          <button type="button" class="admin-button secondary small" onclick="DeckPlansAdmin.markStatus('${esc(
            ship.id
          )}', 'unavailable')">Mark Unavailable</button>
          <button type="button" class="admin-button secondary small" onclick="DeckPlansAdmin.markStatus('${esc(
            ship.id
          )}', 'outdated')">Mark Outdated</button>
          <button type="button" class="admin-button secondary small" onclick="DeckPlansAdmin.clearCandidates('${esc(
            ship.id
          )}')">Clear Candidates</button>
        </div>
        ${
          diag
            ? `<p class="admin-small admin-muted">Scan: ${
                diag.cache_hit ? "cached (recent search)" : diag.scanned_ship_page ? "official ship page" : "no ship page"
              }${diag.used_brave_fallback ? ` · Brave fallback (${esc(String(diag.brave_requests || 0))} requests)` : ""}${
                diag.ship_page_error ? ` · page error: ${esc(diag.ship_page_error)}` : ""
              }</p>`
            : ""
        }
        <h4 class="deck-plans-history-heading">History</h4>
        ${renderHistory()}
      </section>
    `;
  }

  function renderTable() {
    if (loading && !ships.length) {
      return `<p class="admin-muted">Loading ships…</p>`;
    }
    if (!ships.length) {
      return `<div class="admin-card"><p class="admin-muted">No ships match these filters.</p></div>`;
    }

    const rows = ships
      .map((ship) => {
        const id = esc(ship.id);
        const sourceUrl = ship.deck_plan_url || "";
        const finding = findingShipId === ship.id;
        return `
          <tr>
            <td>${esc(ship.cruise_line_name || "—")}</td>
            <td>${esc(ship.name)}</td>
            <td><span class="deck-plan-status deck-plan-status--${esc(ship.deck_plan_status || "missing")}">${esc(
              statusLabel(ship.deck_plan_status)
            )}</span></td>
            <td>${esc(sourceTypeLabel(ship.deck_plan_source_type))}</td>
            <td>${esc(formatDate(ship.deck_plan_last_verified_at))}</td>
            <td>${
              sourceUrl
                ? `<a href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer">View Source</a>`
                : "—"
            }</td>
            <td class="deck-plans-row-actions">
              <button type="button" class="admin-button secondary small" ${finding ? "disabled" : ""} onclick="DeckPlansAdmin.find('${id}')">${
                finding ? "Finding…" : "Find Deck Plans"
              }</button>
              <button type="button" class="admin-button secondary small" onclick="DeckPlansAdmin.openReview('${id}')">Review${
                ship.candidate_count ? ` (${ship.candidate_count})` : ""
              }</button>
              ${
                ship.deck_plan_status === "approved"
                  ? `<button type="button" class="admin-button secondary small" disabled>Approved</button>`
                  : ship.candidates?.[0]
                    ? `<button type="button" class="admin-button small" onclick="DeckPlansAdmin.approve('${id}', decodeURIComponent('${encodeURIComponent(
                        ship.candidates[0].id || ship.candidates[0].url || ""
                      )}'))">Approve top</button>`
                    : `<button type="button" class="admin-button secondary small" disabled title="Find and review a candidate first">Approve</button>`
              }
            </td>
          </tr>`;
      })
      .join("");

    return `
      <div class="research-table-wrap">
        <table class="research-table deck-plans-table">
          <thead>
            <tr>
              <th>Cruise Line</th>
              <th>Ship Name</th>
              <th>Deck Plan Status</th>
              <th>Source Type</th>
              <th>Last Verified</th>
              <th>View Source</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function renderPanel() {
    const reviewShip = reviewShipId ? ships.find((s) => s.id === reviewShipId) : null;
    return `
      <div class="research-audit-panel deck-plans-panel">
        <div class="admin-section-header">
          <div>
            <h2>Deck Plans</h2>
            <p class="admin-muted">Find likely official deck-plan sources, review them, then approve a link for My Cruise. Nothing is published automatically.</p>
          </div>
        </div>
        ${message ? `<div class="admin-message ${esc(messageTone)}">${esc(message)}</div>` : ""}
        ${renderCards()}
        ${renderToolbar()}
        ${renderCoverage()}
        ${renderFilters()}
        ${reviewShip ? renderReviewPanel(reviewShip) : ""}
        <h3 class="deck-plans-list-heading">Ships</h3>
        ${renderTable()}
      </div>
    `;
  }

  let shipFilterTimer = null;

  async function approveFlow(shipId, candidateId, confirmReplace) {
    const data = await api("approve", {
      ship_id: shipId,
      candidate_id: candidateId,
      confirm_replace: confirmReplace === true
    });
    if (data.requires_confirmation) {
      const ok = window.confirm(
        `Replace approved deck plan?\n\nCurrent:\n${data.current_url}\n\nNew:\n${data.new_url}\n\nThe previous source will be kept in history.`
      );
      if (!ok) {
        message = "Approval cancelled — existing approved source unchanged.";
        messageTone = "info";
        return;
      }
      return approveFlow(shipId, candidateId, true);
    }
    upsertShip(data.ship);
    message = `Approved deck plan for ${data.ship.name}.`;
    messageTone = "success";
    if (reviewShipId === shipId) await loadHistory(shipId);
    const dash = await api("dashboard");
    cards = dash.cards || cards;
  }

  global.DeckPlansAdmin = {
    renderPanel,
    ensureLoaded,
    async setFilter(kind, value) {
      if (kind === "line") filterLineId = value;
      if (kind === "status") filterStatus = value;
      if (kind === "verified_after") filterVerifiedAfter = value;
      if (kind === "verified_before") filterVerifiedBefore = value;
      if (kind === "ship") {
        filterShip = value;
        clearTimeout(shipFilterTimer);
        shipFilterTimer = setTimeout(async () => {
          try {
            await refreshList();
            if (typeof global.renderAdmin === "function") global.renderAdmin();
          } catch (error) {
            message = error.message || "Filter failed";
            messageTone = "error";
            if (typeof global.renderAdmin === "function") global.renderAdmin();
          }
        }, 250);
        return;
      }
      try {
        loading = true;
        if (typeof global.renderAdmin === "function") global.renderAdmin();
        await refreshList();
        const dash = await api("dashboard");
        cards = dash.cards || cards;
      } catch (error) {
        message = error.message || "Filter failed";
        messageTone = "error";
      } finally {
        loading = false;
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async openReview(shipId) {
      reviewShipId = shipId;
      lastDiagnostics = null;
      try {
        await loadHistory(shipId);
      } catch {
        historyRows = [];
      }
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    closeReview() {
      reviewShipId = "";
      lastDiagnostics = null;
      historyRows = [];
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    async find(shipId, force) {
      findingShipId = shipId;
      message = "";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
      try {
        const data = await api("find", { ship_id: shipId, force: force === true });
        upsertShip(data.ship);
        lastDiagnostics = data.diagnostics || null;
        reviewShipId = shipId;
        await loadHistory(shipId);
        if (data.cache_hit) {
          message = `Using cached candidates from a recent search (${data.candidates?.length || 0}). Use Find again (force) to re-query.`;
          messageTone = "info";
        } else {
          message = data.candidates?.length
            ? `Found ${data.candidates.length} strong candidate${data.candidates.length === 1 ? "" : "s"} for review.`
            : "No strong official deck-plan sources found. Check the official ship URL or try again later.";
          messageTone = data.candidates?.length ? "success" : "info";
        }
        const dash = await api("dashboard");
        cards = dash.cards || cards;
      } catch (error) {
        message = error.message || "Find failed";
        messageTone = "error";
      } finally {
        findingShipId = "";
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async approve(shipId, candidateId) {
      try {
        await approveFlow(shipId, candidateId, false);
      } catch (error) {
        message = error.message || "Approve failed";
        messageTone = "error";
      } finally {
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async reject(shipId, candidateId) {
      try {
        const data = await api("reject_candidate", {
          ship_id: shipId,
          candidate_id: candidateId
        });
        upsertShip(data.ship);
        message = "Candidate rejected (recorded in history).";
        messageTone = "info";
        if (reviewShipId === shipId) await loadHistory(shipId);
      } catch (error) {
        message = error.message || "Reject failed";
        messageTone = "error";
      } finally {
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async reverify(shipId) {
      try {
        const data = await api("reverify", { ship_id: shipId });
        upsertShip(data.ship);
        message = "Approved source reverified.";
        messageTone = "success";
        if (reviewShipId === shipId) await loadHistory(shipId);
      } catch (error) {
        message = error.message || "Reverify failed";
        messageTone = "error";
      } finally {
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async markStatus(shipId, status) {
      try {
        const data = await api("mark_status", { ship_id: shipId, status });
        upsertShip(data.ship);
        message = `Marked as ${statusLabel(status)}.`;
        messageTone = "info";
        if (reviewShipId === shipId) await loadHistory(shipId);
        const dash = await api("dashboard");
        cards = dash.cards || cards;
      } catch (error) {
        message = error.message || "Status update failed";
        messageTone = "error";
      } finally {
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async clearCandidates(shipId) {
      try {
        const data = await api("clear_candidates", { ship_id: shipId });
        upsertShip(data.ship);
        message = "Candidates cleared.";
        messageTone = "info";
      } catch (error) {
        message = error.message || "Clear failed";
        messageTone = "error";
      } finally {
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async runCoverageAudit() {
      try {
        const data = await api("coverage_audit");
        coverageReport = data.report || null;
        showCoverage = true;
        message = "Coverage audit ready.";
        messageTone = "info";
      } catch (error) {
        message = error.message || "Coverage audit failed";
        messageTone = "error";
      } finally {
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    hideCoverage() {
      showCoverage = false;
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    cancelBulkFind() {
      bulkCancel = true;
      if (bulkProgress) bulkProgress.stopped = true;
      message = "Bulk find cancellation requested…";
      messageTone = "info";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    async startBulkFind() {
      if (bulkRunning) return;
      const confirmed = window.confirm(
        "Find deck plans for missing ships one at a time?\n\nThis only creates candidates for review — it never approves.\nYou can cancel at any time."
      );
      if (!confirmed) return;

      bulkRunning = true;
      bulkCancel = false;
      bulkProgress = {
        done: 0,
        total: 0,
        current: "",
        candidatesFound: 0,
        error: "",
        stopped: false
      };
      if (typeof global.renderAdmin === "function") global.renderAdmin();

      try {
        const list = await api("list_missing_for_bulk");
        const queue = list.ships || [];
        bulkProgress.total = queue.length;
        if (!queue.length) {
          message = "No missing ships to search.";
          messageTone = "info";
          return;
        }

        for (const ship of queue) {
          if (bulkCancel) {
            bulkProgress.stopped = true;
            break;
          }
          bulkProgress.current = `${ship.cruise_line_name || ""} ${ship.name}`.trim();
          if (typeof global.renderAdmin === "function") global.renderAdmin();
          try {
            const data = await api("find", { ship_id: ship.id, force: false });
            upsertShip(data.ship);
            bulkProgress.candidatesFound += data.candidates?.length || 0;
          } catch (error) {
            bulkProgress.error = error.message || "Find failed";
            // Stop safely on errors
            bulkProgress.stopped = true;
            message = `Bulk find stopped on error for ${ship.name}: ${bulkProgress.error}`;
            messageTone = "error";
            break;
          }
          bulkProgress.done += 1;
          if (typeof global.renderAdmin === "function") global.renderAdmin();
        }

        if (!bulkProgress.stopped || bulkCancel) {
          message = bulkCancel
            ? `Bulk find cancelled after ${bulkProgress.done}/${bulkProgress.total} ships.`
            : `Bulk find finished. ${bulkProgress.done} ships processed; ${bulkProgress.candidatesFound} candidates created for review.`;
          messageTone = bulkCancel ? "info" : "success";
        }
        const dash = await api("dashboard");
        cards = dash.cards || cards;
        await refreshList();
      } catch (error) {
        message = error.message || "Bulk find failed";
        messageTone = "error";
      } finally {
        bulkRunning = false;
        bulkCancel = false;
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
