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

  // Optional bulk research (one ship at a time; never auto-approves)
  let bulkRunning = false;
  let bulkCancel = false;
  let bulkProgress = null;

  // Sprint 12A.1 — Rapid Review queue
  let viewMode = "list"; // list | rapid
  let rapidQueue = [];
  let rapidIndex = 0;
  let rapidSkippedIds = new Set();
  let rapidSessionStats = { approved: 0, rejected: 0, skipped: 0 };

  // Cruise line multi-select picker (research + rapid review)
  const LINE_PICKER_STORAGE_KEY = "101cruise.deckPlans.selectedLineIds";
  let linePicker = null; // { purpose, title, selectedIds: Set, resolve }
  let pendingLineIds = [];

  /** @type {{ type: string, shipId?: string, candidateId?: string, label: string } | null} */
  let busy = null;
  /** Draft values for the edit form (survive re-renders while reviewing a ship). */
  let editDraft = { shipId: "", url: "", sourceType: "", notes: "" };

  function isBusy() {
    return Boolean(busy) || Boolean(findingShipId) || bulkRunning;
  }

  function beginBusy(type, label, { shipId = "", candidateId = "" } = {}) {
    busy = { type, shipId, candidateId, label };
    message = label;
    messageTone = "info";
    if (typeof global.renderAdmin === "function") global.renderAdmin();
  }

  function endBusy() {
    busy = null;
  }

  function readEditFormIntoDraft(shipId) {
    const urlInput = document.getElementById("deck-plan-edit-url");
    const typeInput = document.getElementById("deck-plan-edit-type");
    const notesInput = document.getElementById("deck-plan-edit-notes");
    if (!urlInput && !typeInput && !notesInput) return;
    editDraft = {
      shipId: shipId || editDraft.shipId,
      url: urlInput ? urlInput.value : editDraft.url,
      sourceType: typeInput ? typeInput.value : editDraft.sourceType,
      notes: notesInput ? notesInput.value : editDraft.notes
    };
  }

  function editFormValues(ship) {
    const useDraft = editDraft.shipId && editDraft.shipId === ship.id;
    return {
      url: useDraft ? editDraft.url : ship.deck_plan_url || "",
      sourceType: useDraft
        ? editDraft.sourceType || ship.deck_plan_source_type || "official_page"
        : ship.deck_plan_source_type || "official_page",
      notes: useDraft ? editDraft.notes : ship.deck_plan_notes || ""
    };
  }

  function loadStoredLineIds() {
    try {
      const raw = localStorage.getItem(LINE_PICKER_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  function saveStoredLineIds(ids) {
    try {
      localStorage.setItem(LINE_PICKER_STORAGE_KEY, JSON.stringify(ids || []));
    } catch {
      /* ignore */
    }
  }

  function promptLinePicker({ purpose, title, body }) {
    return new Promise((resolve) => {
      const stored = loadStoredLineIds();
      const validStored = stored.filter((id) => lines.some((line) => line.id === id));
      const initial =
        validStored.length > 0
          ? validStored
          : filterLineId
            ? [filterLineId]
            : lines.map((line) => line.id);
      linePicker = {
        purpose,
        title: title || "Select cruise lines",
        body:
          body ||
          "Choose only the lines your clients use. This limits search and review work.",
        selectedIds: new Set(initial),
        resolve
      };
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    });
  }

  function closeLinePicker(result) {
    const resolve = linePicker?.resolve;
    linePicker = null;
    if (typeof global.renderAdmin === "function") global.renderAdmin();
    if (typeof resolve === "function") resolve(result);
  }

  function renderLinePicker() {
    if (!linePicker) return "";
    const selected = linePicker.selectedIds || new Set();
    const count = selected.size;
    return `
      <div class="deck-plans-line-picker-overlay" role="dialog" aria-modal="true" aria-labelledby="deck-plans-line-picker-title">
        <div class="deck-plans-line-picker">
          <div class="deck-plans-line-picker-header">
            <h3 id="deck-plans-line-picker-title">${esc(linePicker.title)}</h3>
            <p class="admin-muted">${esc(linePicker.body)}</p>
          </div>
          <div class="deck-plans-line-picker-toolbar">
            <button type="button" class="admin-button secondary small" onclick="DeckPlansAdmin.linePickerSelectAll()">Select all</button>
            <button type="button" class="admin-button secondary small" onclick="DeckPlansAdmin.linePickerClear()">Clear</button>
            <span class="admin-small admin-muted">${esc(String(count))} selected</span>
          </div>
          <div class="deck-plans-line-picker-list">
            ${
              lines.length
                ? lines
                    .map((line) => {
                      const checked = selected.has(line.id) ? "checked" : "";
                      return `
                        <label class="deck-plans-line-picker-item">
                          <input
                            type="checkbox"
                            ${checked}
                            onchange="DeckPlansAdmin.linePickerToggle('${esc(line.id)}', this.checked)"
                          />
                          <span>${esc(line.name)}</span>
                        </label>`;
                    })
                    .join("")
                : `<p class="admin-muted">No active cruise lines loaded.</p>`
            }
          </div>
          <div class="deck-plans-line-picker-actions">
            <button type="button" class="admin-button secondary small" onclick="DeckPlansAdmin.linePickerCancel()">Cancel</button>
            <button type="button" class="admin-button small" ${
              count ? "" : "disabled"
            } onclick="DeckPlansAdmin.linePickerConfirm()">${
              linePicker.purpose === "research" ? "Research selected lines" : "Start Rapid Review"
            }</button>
          </div>
        </div>
      </div>
    `;
  }

  function busyLabelForButton(type, shipId, candidateId, idleLabel, activeLabel) {
    if (!busy || busy.type !== type) return idleLabel;
    if (shipId && busy.shipId && busy.shipId !== shipId) return idleLabel;
    if (candidateId && busy.candidateId && busy.candidateId !== candidateId) return idleLabel;
    return activeLabel;
  }

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
    try {
      const data = await api("list_history", { ship_id: shipId, limit: 20 });
      historyRows = data.history || [];
    } catch (error) {
      historyRows = [];
      // Don't overwrite an in-progress action message with a hard failure
      if (!busy) {
        console.warn("[DeckPlans] history load failed:", error.message || error);
      }
    }
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
    const queueCount = cards?.needs_review ?? "—";
    return `
      <div class="deck-plans-toolbar">
        <button type="button" class="admin-button secondary small" onclick="DeckPlansAdmin.runCoverageAudit()">
          Coverage Audit
        </button>
        ${
          bulkRunning
            ? `<button type="button" class="admin-button secondary small" onclick="DeckPlansAdmin.cancelBulkFind()">Cancel research</button>`
            : `<button type="button" class="admin-button small" onclick="DeckPlansAdmin.startBulkFind()">Research Missing Deck Plans</button>`
        }
        <button type="button" class="admin-button small" ${
          bulkRunning || busy ? "disabled" : ""
        } onclick="DeckPlansAdmin.startRapidReview()">
          Rapid Review${typeof queueCount === "number" ? ` (${queueCount})` : ""}
        </button>
        ${
          viewMode === "rapid"
            ? `<button type="button" class="admin-button secondary small" onclick="DeckPlansAdmin.exitRapidReview()">Exit Rapid Review</button>`
            : ""
        }
        <p class="admin-small admin-muted">Pick cruise lines before research or rapid review — only those lines are processed. Approval stays manual.</p>
      </div>
      ${
        bulkProgress
          ? `<div class="admin-card deck-plans-bulk-progress">
              <p><strong>Research Missing:</strong> ${esc(String(bulkProgress.done))}/${esc(
                String(bulkProgress.total)
              )} · current: ${esc(bulkProgress.current || "—")} · ships with candidates: ${esc(
                String(bulkProgress.shipsWithCandidates || 0)
              )} · candidates: ${esc(String(bulkProgress.candidatesFound || 0))}${
                bulkProgress.failed ? ` · failed: ${esc(String(bulkProgress.failed))}` : ""
              }${bulkProgress.error ? ` · last error: ${esc(bulkProgress.error)}` : ""}${
                bulkProgress.stopped ? " · stopped" : ""
              }</p>
              ${
                !bulkRunning && (bulkProgress.shipsWithCandidates || 0) > 0
                  ? `<p><button type="button" class="admin-button small" onclick="DeckPlansAdmin.startRapidReview()">Start Rapid Review</button></p>`
                  : ""
              }
            </div>`
          : ""
      }
    `;
  }

  function currentRapidShip() {
    return rapidQueue[rapidIndex] || null;
  }

  function renderRapidReview() {
    const ship = currentRapidShip();
    const total = rapidQueue.length;
    const position = total ? rapidIndex + 1 : 0;
    if (!ship) {
      return `
        <section class="admin-card deck-plans-rapid">
          <div class="deck-plans-rapid-header">
            <h3>Rapid Review</h3>
            <button type="button" class="admin-button secondary small" onclick="DeckPlansAdmin.exitRapidReview()">Back to list</button>
          </div>
          <p class="admin-muted">No ships left in the review queue${
            rapidSessionStats.approved || rapidSessionStats.rejected || rapidSessionStats.skipped
              ? ` — session: ${rapidSessionStats.approved} approved, ${rapidSessionStats.rejected} rejected, ${rapidSessionStats.skipped} skipped.`
              : "."
          }</p>
          <p>
            <button type="button" class="admin-button small" onclick="DeckPlansAdmin.startRapidReview()">Refresh queue</button>
            <button type="button" class="admin-button secondary small" onclick="DeckPlansAdmin.exitRapidReview()">Exit</button>
          </p>
        </section>
      `;
    }

    const candidates = Array.isArray(ship.candidates) ? ship.candidates : [];
    const top = candidates[0];
    const actionsLocked = isBusy();

    return `
      <section class="admin-card deck-plans-rapid ${actionsLocked ? "deck-plans-review--busy" : ""}">
        <div class="deck-plans-rapid-header">
          <div>
            <p class="deck-plans-rapid-progress">Ship ${esc(String(position))} of ${esc(String(total))} in queue</p>
            <h3>${esc(ship.name)}</h3>
            <p class="admin-muted">${esc(ship.cruise_line_name || "")}${
              ship.official_ship_url
                ? ` · <a href="${esc(ship.official_ship_url)}" target="_blank" rel="noopener noreferrer">Official ship page</a>`
                : ""
            }</p>
            <p class="admin-small">Session: ${esc(String(rapidSessionStats.approved))} approved · ${esc(
              String(rapidSessionStats.rejected)
            )} rejected · ${esc(String(rapidSessionStats.skipped))} skipped</p>
          </div>
          <button type="button" class="admin-button secondary small" ${
            actionsLocked ? "disabled" : ""
          } onclick="DeckPlansAdmin.exitRapidReview()">Exit Rapid Review</button>
        </div>

        ${
          !top
            ? `<p class="admin-muted">No candidates on this ship — skipping.</p>`
            : `<article class="deck-plans-rapid-candidate">
                <h4>${esc(top.title || "Deck plan source")}</h4>
                <p class="admin-small"><a href="${esc(top.url)}" target="_blank" rel="noopener noreferrer">${esc(
                  top.url
                )}</a></p>
                <p class="admin-muted">
                  ${esc(top.source_type_label || sourceTypeLabel(top.source_type))}
                  · ${esc(top.source_domain || "—")}
                  · Confidence: ${esc(String(top.confidence || "—"))}
                </p>
                <p>${esc(top.reason || "")}</p>
                ${
                  candidates.length > 1
                    ? `<p class="admin-small admin-muted">+ ${esc(String(candidates.length - 1))} more candidate${
                        candidates.length === 2 ? "" : "s"
                      } (approve top, or open full review)</p>`
                    : ""
                }
              </article>`
        }

        <div class="deck-plans-rapid-actions">
          <button type="button" class="admin-button small deck-plans-rapid-approve" ${
            actionsLocked || !top ? "disabled" : ""
          } onclick="DeckPlansAdmin.rapidApprove()">${
            busy?.type === "approve" ? "Approving…" : "Approve (A)"
          }</button>
          <button type="button" class="admin-button secondary small" ${
            actionsLocked || !top ? "disabled" : ""
          } onclick="DeckPlansAdmin.rapidReject()">${
            busy?.type === "reject" ? "Rejecting…" : "Reject (R)"
          }</button>
          <button type="button" class="admin-button secondary small" ${
            actionsLocked ? "disabled" : ""
          } onclick="DeckPlansAdmin.rapidSkip()">Skip (S)</button>
          <button type="button" class="admin-button secondary small" ${
            actionsLocked ? "disabled" : ""
          } onclick="DeckPlansAdmin.rapidOpenFull()">Full review</button>
        </div>
        <p class="admin-small admin-muted">Keyboard: A approve · R reject · S skip. Approval is always manual.</p>
      </section>
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
    const actionsLocked = isBusy();
    const form = editFormValues(ship);
    return `
      <section class="admin-card deck-plans-review ${actionsLocked ? "deck-plans-review--busy" : ""}">
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
                  · <button type="button" class="admin-button secondary small" ${
                    actionsLocked ? "disabled" : ""
                  } onclick="DeckPlansAdmin.reverify('${esc(ship.id)}')">${esc(
                    busyLabelForButton("reverify", ship.id, "", "Reverify", "Reverifying…")
                  )}</button></p>`
                : ""
            }
          </div>
          <button type="button" class="admin-button secondary small" onclick="DeckPlansAdmin.closeReview()" ${
            actionsLocked ? "disabled" : ""
          }>Close</button>
        </div>
        <div class="deck-plans-edit-form admin-card">
          <h4>Edit / set deck plan source</h4>
          <p class="admin-muted admin-small">Correct the URL if a candidate is close but not right. Must be an official cruise line domain. Saving approves this source for My Cruise.</p>
          <div class="deck-plans-edit-grid">
            <div class="admin-field">
              <label for="deck-plan-edit-url">Source URL</label>
              <input
                id="deck-plan-edit-url"
                type="url"
                ${actionsLocked ? "disabled" : ""}
                placeholder="https://…"
                value="${esc(form.url)}"
                oninput="DeckPlansAdmin.captureEditDraft('${esc(ship.id)}')"
              />
            </div>
            <div class="admin-field">
              <label for="deck-plan-edit-type">Source type</label>
              <select id="deck-plan-edit-type" ${actionsLocked ? "disabled" : ""} onchange="DeckPlansAdmin.captureEditDraft('${esc(ship.id)}')">
                ${[
                  ["official_page", "Official page"],
                  ["official_pdf", "Official PDF"],
                  ["official_interactive_viewer", "Interactive viewer"],
                  ["other_official_asset", "Other official asset"]
                ]
                  .map(([value, label]) => {
                    const selected = form.sourceType === value ? "selected" : "";
                    return `<option value="${value}" ${selected}>${label}</option>`;
                  })
                  .join("")}
              </select>
            </div>
            <div class="admin-field deck-plans-edit-notes">
              <label for="deck-plan-edit-notes">Notes (optional)</label>
              <input
                id="deck-plan-edit-notes"
                type="text"
                ${actionsLocked ? "disabled" : ""}
                placeholder="Why this source / what you changed"
                value="${esc(form.notes)}"
                oninput="DeckPlansAdmin.captureEditDraft('${esc(ship.id)}')"
              />
            </div>
          </div>
          <div class="deck-plans-edit-actions">
            <button type="button" class="admin-button small" ${
              actionsLocked ? "disabled" : ""
            } onclick="DeckPlansAdmin.saveManual('${esc(ship.id)}')">${esc(
              busyLabelForButton("save", ship.id, "", "Save & Approve Source", "Saving…")
            )}</button>
            ${
              ship.deck_plan_url
                ? `<a class="admin-button secondary small" href="${esc(
                    ship.deck_plan_url
                  )}" target="_blank" rel="noopener noreferrer">Open current</a>`
                : ""
            }
          </div>
        </div>
        ${
          !candidates.length
            ? `<p class="admin-muted">No candidates yet. Use Find Deck Plans, or paste an official URL above.</p>`
            : `<div class="deck-plans-candidate-list">
                ${candidates
                  .map((c) => {
                    const candId = c.id || c.url || "";
                    const candKey = encodeURIComponent(candId);
                    const urlKey = encodeURIComponent(c.url || "");
                    const typeKey = encodeURIComponent(c.source_type || "official_page");
                    const approvingThis =
                      busy?.type === "approve" &&
                      busy.shipId === ship.id &&
                      busy.candidateId === candId;
                    const rejectingThis =
                      busy?.type === "reject" &&
                      busy.shipId === ship.id &&
                      busy.candidateId === candId;
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
                          <button type="button" class="admin-button secondary small" ${
                            actionsLocked ? "disabled" : ""
                          } onclick="DeckPlansAdmin.useCandidate(decodeURIComponent('${urlKey}'), decodeURIComponent('${typeKey}'))">Edit this</button>
                          <button type="button" class="admin-button small" ${
                            actionsLocked ? "disabled" : ""
                          } onclick="DeckPlansAdmin.approve('${esc(ship.id)}', decodeURIComponent('${candKey}'))">${
                            approvingThis ? "Approving…" : "Approve"
                          }</button>
                          <button type="button" class="admin-button secondary small" ${
                            actionsLocked ? "disabled" : ""
                          } onclick="DeckPlansAdmin.reject('${esc(ship.id)}', decodeURIComponent('${candKey}'))">${
                            rejectingThis ? "Rejecting…" : "Reject"
                          }</button>
                        </div>
                      </article>`;
                  })
                  .join("")}
              </div>`
        }
        <div class="deck-plans-review-footer">
          <button type="button" class="admin-button secondary small" ${
            actionsLocked ? "disabled" : ""
          } onclick="DeckPlansAdmin.find('${esc(ship.id)}', true)">${
            findingShipId === ship.id ? "Finding…" : "Find again (force)"
          }</button>
          <button type="button" class="admin-button secondary small" ${
            actionsLocked ? "disabled" : ""
          } onclick="DeckPlansAdmin.markStatus('${esc(ship.id)}', 'unavailable')">${esc(
            busyLabelForButton("mark", ship.id, "unavailable", "Mark Unavailable", "Updating…")
          )}</button>
          <button type="button" class="admin-button secondary small" ${
            actionsLocked ? "disabled" : ""
          } onclick="DeckPlansAdmin.markStatus('${esc(ship.id)}', 'outdated')">${esc(
            busyLabelForButton("mark", ship.id, "outdated", "Mark Outdated", "Updating…")
          )}</button>
          <button type="button" class="admin-button secondary small" ${
            actionsLocked ? "disabled" : ""
          } onclick="DeckPlansAdmin.clearCandidates('${esc(ship.id)}')">${esc(
            busyLabelForButton("clear", ship.id, "", "Clear Candidates", "Clearing…")
          )}</button>
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
        const rowLocked = isBusy();
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
              <button type="button" class="admin-button secondary small" ${
                rowLocked ? "disabled" : ""
              } onclick="DeckPlansAdmin.find('${id}')">${finding ? "Finding…" : "Find Deck Plans"}</button>
              <button type="button" class="admin-button secondary small" ${
                rowLocked ? "disabled" : ""
              } onclick="DeckPlansAdmin.openReview('${id}')">Review${
                ship.candidate_count ? ` (${ship.candidate_count})` : ""
              }</button>
              ${
                ship.deck_plan_status === "approved"
                  ? `<button type="button" class="admin-button secondary small" disabled>Approved</button>`
                  : ship.candidates?.[0]
                    ? `<button type="button" class="admin-button small" ${
                        rowLocked ? "disabled" : ""
                      } onclick="DeckPlansAdmin.approve('${id}', decodeURIComponent('${encodeURIComponent(
                        ship.candidates[0].id || ship.candidates[0].url || ""
                      )}'))">${
                        busy?.type === "approve" && busy.shipId === ship.id ? "Approving…" : "Approve top"
                      }</button>`
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

  function renderBusyBanner() {
    if (!busy && !findingShipId && !bulkRunning) return "";
    const label =
      busy?.label ||
      (findingShipId ? "Finding official deck-plan sources…" : "") ||
      (bulkRunning ? "Bulk find in progress…" : "Working…");
    return `
      <div class="admin-message info deck-plans-busy-banner" role="status" aria-live="polite">
        <span class="deck-plans-busy-spinner" aria-hidden="true"></span>
        ${esc(label)}
      </div>
    `;
  }

  function renderPanel() {
    if (viewMode === "rapid") {
      return `
        <div class="research-audit-panel deck-plans-panel">
          <div class="admin-section-header">
            <div>
              <h2>Deck Plans — Rapid Review</h2>
              <p class="admin-muted">Approve, reject, or skip one ship at a time. Nothing is published automatically.</p>
            </div>
          </div>
          ${renderBusyBanner()}
          ${!busy && message ? `<div class="admin-message ${esc(messageTone)}" role="status">${esc(message)}</div>` : ""}
          ${renderRapidReview()}
          ${renderLinePicker()}
        </div>
      `;
    }

    const reviewShip = reviewShipId ? ships.find((s) => s.id === reviewShipId) : null;
    return `
      <div class="research-audit-panel deck-plans-panel">
        <div class="admin-section-header">
          <div>
            <h2>Deck Plans</h2>
            <p class="admin-muted">Research missing ships in bulk, then use Rapid Review — or continue ship-by-ship. Nothing is published automatically.</p>
          </div>
        </div>
        ${renderBusyBanner()}
        ${!busy && message ? `<div class="admin-message ${esc(messageTone)}" role="status">${esc(message)}</div>` : ""}
        ${renderCards()}
        ${renderToolbar()}
        ${renderCoverage()}
        ${renderFilters()}
        ${reviewShip ? renderReviewPanel(reviewShip) : ""}
        <h3 class="deck-plans-list-heading">Ships</h3>
        ${renderTable()}
        ${renderLinePicker()}
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
      endBusy();
      if (typeof global.renderAdmin === "function") global.renderAdmin();
      const ok = window.confirm(
        `Replace approved deck plan?\n\nCurrent:\n${data.current_url}\n\nNew:\n${data.new_url}\n\nThe previous source will be kept in history.`
      );
      if (!ok) {
        message = "Approval cancelled — existing approved source unchanged.";
        messageTone = "info";
        return { cancelled: true };
      }
      beginBusy("approve", "Replacing approved deck plan… saving…", {
        shipId,
        candidateId
      });
      return approveFlow(shipId, candidateId, true);
    }
    upsertShip(data.ship);
    message = `Approved deck plan for ${data.ship.name}.`;
    messageTone = "success";
    if (reviewShipId === shipId && viewMode !== "rapid") await loadHistory(shipId);
    try {
      const dash = await api("dashboard");
      cards = dash.cards || cards;
    } catch {
      // Non-fatal — approval already saved
    }
    return data;
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
      if (isBusy()) return;
      reviewShipId = shipId;
      lastDiagnostics = null;
      const ship = ships.find((s) => s.id === shipId);
      editDraft = {
        shipId,
        url: ship?.deck_plan_url || "",
        sourceType: ship?.deck_plan_source_type || "official_page",
        notes: ship?.deck_plan_notes || ""
      };
      try {
        await loadHistory(shipId);
      } catch {
        historyRows = [];
      }
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    closeReview() {
      if (isBusy()) return;
      reviewShipId = "";
      lastDiagnostics = null;
      historyRows = [];
      editDraft = { shipId: "", url: "", sourceType: "", notes: "" };
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    captureEditDraft(shipId) {
      readEditFormIntoDraft(shipId);
    },
    async find(shipId, force) {
      if (busy || bulkRunning) return;
      findingShipId = shipId;
      beginBusy("find", force ? "Searching again (forced)…" : "Finding official deck-plan sources…", {
        shipId
      });
      try {
        const data = await api("find", { ship_id: shipId, force: force === true });
        upsertShip(data.ship);
        lastDiagnostics = data.diagnostics || null;
        reviewShipId = shipId;
        editDraft = {
          shipId,
          url: data.ship.deck_plan_url || editDraft.url || "",
          sourceType: data.ship.deck_plan_source_type || "official_page",
          notes: data.ship.deck_plan_notes || ""
        };
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
        try {
          const dash = await api("dashboard");
          cards = dash.cards || cards;
        } catch {
          /* ignore */
        }
      } catch (error) {
        message = error.message || "Find failed";
        messageTone = "error";
      } finally {
        findingShipId = "";
        endBusy();
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async approve(shipId, candidateId) {
      if (isBusy()) return;
      beginBusy("approve", "Approving deck plan… saving to ship…", {
        shipId,
        candidateId
      });
      try {
        await approveFlow(shipId, candidateId, false);
      } catch (error) {
        message = error.message || "Approve failed";
        messageTone = "error";
      } finally {
        endBusy();
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    useCandidate(url, sourceType) {
      editDraft = {
        shipId: reviewShipId || editDraft.shipId,
        url: url || "",
        sourceType: sourceType || "official_page",
        notes: editDraft.notes || ""
      };
      message = "Candidate loaded into the edit form — adjust if needed, then Save & Approve Source.";
      messageTone = "info";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
      requestAnimationFrame(() => {
        document.getElementById("deck-plan-edit-url")?.focus();
      });
    },
    async saveManual(shipId, confirmReplace) {
      if (isBusy() && confirmReplace !== true) return;
      readEditFormIntoDraft(shipId);
      const url = String(editDraft.url || "").trim();
      const sourceType = String(editDraft.sourceType || "").trim();
      const notes = String(editDraft.notes || "").trim();
      if (!url) {
        message = "Enter a deck plan source URL before saving.";
        messageTone = "error";
        if (typeof global.renderAdmin === "function") global.renderAdmin();
        return;
      }

      beginBusy("save", "Saving deck plan source…", { shipId });
      try {
        const data = await api("save_manual", {
          ship_id: shipId,
          url,
          source_type: sourceType,
          notes: notes || undefined,
          confirm_replace: confirmReplace === true
        });
        if (data.requires_confirmation) {
          endBusy();
          if (typeof global.renderAdmin === "function") global.renderAdmin();
          const ok = window.confirm(
            `Replace approved deck plan?\n\nCurrent:\n${data.current_url}\n\nNew:\n${data.new_url}\n\nThe previous source will be kept in history.`
          );
          if (!ok) {
            message = "Save cancelled — existing approved source unchanged.";
            messageTone = "info";
            if (typeof global.renderAdmin === "function") global.renderAdmin();
            return;
          }
          return global.DeckPlansAdmin.saveManual(shipId, true);
        }
        upsertShip(data.ship);
        editDraft = {
          shipId,
          url: data.ship.deck_plan_url || url,
          sourceType: data.ship.deck_plan_source_type || sourceType,
          notes: data.ship.deck_plan_notes || notes
        };
        message = `Saved and approved deck plan for ${data.ship.name}.`;
        messageTone = "success";
        if (reviewShipId === shipId) await loadHistory(shipId);
        try {
          const dash = await api("dashboard");
          cards = dash.cards || cards;
        } catch {
          /* ignore */
        }
      } catch (error) {
        message = error.message || "Save failed";
        messageTone = "error";
      } finally {
        endBusy();
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async reject(shipId, candidateId) {
      if (isBusy()) return;
      beginBusy("reject", "Rejecting candidate…", { shipId, candidateId });
      try {
        const data = await api("reject_candidate", {
          ship_id: shipId,
          candidate_id: candidateId
        });
        upsertShip(data.ship);
        message = "Candidate rejected.";
        messageTone = "info";
        if (reviewShipId === shipId) await loadHistory(shipId);
      } catch (error) {
        message = error.message || "Reject failed";
        messageTone = "error";
      } finally {
        endBusy();
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async reverify(shipId) {
      if (isBusy()) return;
      beginBusy("reverify", "Reverifying approved source…", { shipId });
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
        endBusy();
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async markStatus(shipId, status) {
      if (isBusy()) return;
      beginBusy("mark", `Updating status to ${statusLabel(status)}…`, {
        shipId,
        candidateId: status
      });
      try {
        const data = await api("mark_status", { ship_id: shipId, status });
        upsertShip(data.ship);
        message = `Marked as ${statusLabel(status)}.`;
        messageTone = "info";
        if (reviewShipId === shipId) await loadHistory(shipId);
        try {
          const dash = await api("dashboard");
          cards = dash.cards || cards;
        } catch {
          /* ignore */
        }
      } catch (error) {
        message = error.message || "Status update failed";
        messageTone = "error";
      } finally {
        endBusy();
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async clearCandidates(shipId) {
      if (isBusy()) return;
      beginBusy("clear", "Clearing candidates…", { shipId });
      try {
        const data = await api("clear_candidates", { ship_id: shipId });
        upsertShip(data.ship);
        message = "Candidates cleared.";
        messageTone = "info";
      } catch (error) {
        message = error.message || "Clear failed";
        messageTone = "error";
      } finally {
        endBusy();
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async runCoverageAudit() {
      if (isBusy()) return;
      beginBusy("audit", "Running coverage audit…");
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
        endBusy();
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
      message = "Research cancellation requested…";
      messageTone = "info";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    async startBulkFind() {
      if (bulkRunning || busy) return;
      if (!lines.length) {
        message = "Cruise lines not loaded yet — wait a moment and try again.";
        messageTone = "error";
        if (typeof global.renderAdmin === "function") global.renderAdmin();
        return;
      }

      const picked = await promptLinePicker({
        purpose: "research",
        title: "Research Missing Deck Plans",
        body: "Select the cruise lines to research. Unchecked lines are skipped to save search resources."
      });
      if (!picked || !picked.length) return;

      pendingLineIds = picked;
      saveStoredLineIds(picked);

      bulkRunning = true;
      bulkCancel = false;
      bulkProgress = {
        done: 0,
        total: 0,
        current: "",
        candidatesFound: 0,
        shipsWithCandidates: 0,
        failed: 0,
        error: "",
        stopped: false
      };
      message = `Starting research for ${picked.length} cruise line${picked.length === 1 ? "" : "s"}…`;
      messageTone = "info";
      if (typeof global.renderAdmin === "function") global.renderAdmin();

      try {
        const list = await api("list_missing_for_bulk", {
          cruise_line_ids: picked
        });
        const queue = list.ships || [];
        bulkProgress.total = queue.length;
        if (!queue.length) {
          message = "No missing ships to research for the selected cruise lines.";
          messageTone = "info";
          return;
        }

        for (const ship of queue) {
          if (bulkCancel) {
            bulkProgress.stopped = true;
            break;
          }
          bulkProgress.current = `${ship.cruise_line_name || ""} ${ship.name}`.trim();
          message = `Researching ${bulkProgress.done + 1}/${bulkProgress.total} — ${bulkProgress.current}`;
          messageTone = "info";
          if (typeof global.renderAdmin === "function") global.renderAdmin();
          try {
            const data = await api("find", { ship_id: ship.id, force: false });
            upsertShip(data.ship);
            const n = data.candidates?.length || 0;
            bulkProgress.candidatesFound += n;
            if (n > 0) bulkProgress.shipsWithCandidates += 1;
          } catch (error) {
            bulkProgress.failed += 1;
            bulkProgress.error = error.message || "Find failed";
            if (/unauthor|forbidden|not configured|401|403/i.test(bulkProgress.error)) {
              bulkProgress.stopped = true;
              message = `Research stopped: ${bulkProgress.error}`;
              messageTone = "error";
              break;
            }
          }
          bulkProgress.done += 1;
          if (typeof global.renderAdmin === "function") global.renderAdmin();
        }

        if (!bulkProgress.stopped || bulkCancel) {
          message = bulkCancel
            ? `Research cancelled after ${bulkProgress.done}/${bulkProgress.total} ships (${bulkProgress.shipsWithCandidates} ready for review).`
            : `Research finished. ${bulkProgress.done} ships processed; ${bulkProgress.shipsWithCandidates} with candidates ready for Rapid Review.`;
          messageTone = bulkCancel ? "info" : "success";
        }
        try {
          const dash = await api("dashboard");
          cards = dash.cards || cards;
        } catch {
          /* ignore */
        }
        await refreshList();
      } catch (error) {
        message = error.message || "Research failed";
        messageTone = "error";
      } finally {
        bulkRunning = false;
        bulkCancel = false;
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },

    async startRapidReview() {
      if (bulkRunning) return;
      if (!lines.length) {
        message = "Cruise lines not loaded yet — wait a moment and try again.";
        messageTone = "error";
        if (typeof global.renderAdmin === "function") global.renderAdmin();
        return;
      }

      const picked = await promptLinePicker({
        purpose: "rapid",
        title: "Rapid Review — select cruise lines",
        body: "Choose which lines to review. Your last selection is remembered."
      });
      if (!picked || !picked.length) return;

      pendingLineIds = picked;
      saveStoredLineIds(picked);

      beginBusy("queue", "Loading review queue…");
      try {
        const data = await api("list_review_queue", {
          cruise_line_ids: picked
        });
        rapidQueue = (data.queue || []).filter((s) => !rapidSkippedIds.has(s.id));
        if (!rapidQueue.length && (data.queue || []).length) {
          rapidSkippedIds = new Set();
          rapidQueue = data.queue || [];
        }
        rapidIndex = 0;
        rapidSessionStats = { approved: 0, rejected: 0, skipped: 0 };
        viewMode = "rapid";
        reviewShipId = "";
        message = rapidQueue.length
          ? `Rapid Review ready — ${rapidQueue.length} ship${rapidQueue.length === 1 ? "" : "s"} across ${picked.length} line${picked.length === 1 ? "" : "s"}.`
          : "No ships with candidates for the selected lines. Run Research Missing Deck Plans first.";
        messageTone = rapidQueue.length ? "success" : "info";
        bindRapidKeys();
      } catch (error) {
        message = error.message || "Failed to load review queue";
        messageTone = "error";
      } finally {
        endBusy();
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },

    linePickerToggle(lineId, checked) {
      if (!linePicker) return;
      if (checked) linePicker.selectedIds.add(lineId);
      else linePicker.selectedIds.delete(lineId);
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    linePickerSelectAll() {
      if (!linePicker) return;
      linePicker.selectedIds = new Set(lines.map((line) => line.id));
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    linePickerClear() {
      if (!linePicker) return;
      linePicker.selectedIds = new Set();
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    linePickerCancel() {
      closeLinePicker(null);
    },
    linePickerConfirm() {
      if (!linePicker) return;
      const ids = [...linePicker.selectedIds];
      if (!ids.length) return;
      closeLinePicker(ids);
    },

    exitRapidReview() {
      if (isBusy()) return;
      viewMode = "list";
      unbindRapidKeys();
      message = "";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
      ensureLoaded({ quiet: true });
    },

    rapidOpenFull() {
      const ship = currentRapidShip();
      if (!ship) return;
      viewMode = "list";
      unbindRapidKeys();
      reviewShipId = ship.id;
      editDraft = {
        shipId: ship.id,
        url: ship.deck_plan_url || ship.candidates?.[0]?.url || "",
        sourceType: ship.deck_plan_source_type || ship.candidates?.[0]?.source_type || "official_page",
        notes: ship.deck_plan_notes || ""
      };
      upsertShip(ship);
      loadHistory(ship.id).finally(() => {
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      });
    },

    async rapidApprove() {
      if (isBusy()) return;
      const ship = currentRapidShip();
      const top = ship?.candidates?.[0];
      if (!ship || !top) return;
      beginBusy("approve", `Approving ${ship.name}…`, {
        shipId: ship.id,
        candidateId: top.id || top.url
      });
      try {
        const result = await approveFlow(ship.id, top.id || top.url, false);
        if (result?.cancelled) return;
        rapidSessionStats.approved += 1;
        advanceRapidQueue();
        message = `Approved ${ship.name}. Next ship loaded.`;
        messageTone = "success";
      } catch (error) {
        message = error.message || "Approve failed";
        messageTone = "error";
      } finally {
        endBusy();
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },

    async rapidReject() {
      if (isBusy()) return;
      const ship = currentRapidShip();
      const top = ship?.candidates?.[0];
      if (!ship || !top) return;
      beginBusy("reject", `Rejecting candidate for ${ship.name}…`, {
        shipId: ship.id,
        candidateId: top.id || top.url
      });
      try {
        const data = await api("reject_candidate", {
          ship_id: ship.id,
          candidate_id: top.id || top.url
        });
        rapidSessionStats.rejected += 1;
        upsertShip(data.ship);
        // If more candidates remain, stay on ship; else advance
        if (data.ship.candidates?.length) {
          rapidQueue[rapidIndex] = data.ship;
          message = `Rejected candidate — ${data.ship.candidates.length} remaining for ${ship.name}.`;
          messageTone = "info";
        } else {
          advanceRapidQueue();
          message = `Rejected last candidate for ${ship.name}. Next ship loaded.`;
          messageTone = "info";
        }
      } catch (error) {
        message = error.message || "Reject failed";
        messageTone = "error";
      } finally {
        endBusy();
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },

    rapidSkip() {
      if (isBusy()) return;
      const ship = currentRapidShip();
      if (!ship) return;
      rapidSessionStats.skipped += 1;
      rapidSkippedIds.add(ship.id);
      advanceRapidQueue();
      message = `Skipped ${ship.name}. Next ship loaded.`;
      messageTone = "info";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    }
  };

  function advanceRapidQueue() {
    rapidQueue.splice(rapidIndex, 1);
    if (rapidIndex >= rapidQueue.length) rapidIndex = Math.max(0, rapidQueue.length - 1);
  }

  function onRapidKeydown(event) {
    if (viewMode !== "rapid" || isBusy()) return;
    const tag = String(event.target?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    const key = String(event.key || "").toLowerCase();
    if (key === "a") {
      event.preventDefault();
      global.DeckPlansAdmin.rapidApprove();
    } else if (key === "r") {
      event.preventDefault();
      global.DeckPlansAdmin.rapidReject();
    } else if (key === "s") {
      event.preventDefault();
      global.DeckPlansAdmin.rapidSkip();
    }
  }

  function bindRapidKeys() {
    document.removeEventListener("keydown", onRapidKeydown);
    document.addEventListener("keydown", onRapidKeydown);
  }

  function unbindRapidKeys() {
    document.removeEventListener("keydown", onRapidKeydown);
  }
})(typeof window !== "undefined" ? window : globalThis);
