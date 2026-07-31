/**
 * Admin bulk ship class assignment modal — shared fleet + individual-ship entry.
 */
(function () {
  "use strict";

  let modalContext = null;

  function api() {
    return window.CiShipClassBulk || null;
  }

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function getLines() {
    return window.ciCruiseLines || [];
  }

  function getShips() {
    return window.ciCruiseShips || [];
  }

  function getContext() {
    return modalContext;
  }

  function closeModal() {
    const overlay = document.getElementById("ciBulkShipClassOverlay");
    if (overlay) overlay.remove();
    modalContext = null;
  }

  function readClassInput() {
    return String(document.getElementById("ciBulkShipClassInput")?.value || modalContext?.shipClass || "");
  }

  function readSelectedIds() {
    return [...document.querySelectorAll(".ci-bulk-class-target:checked")].map((el) => el.value).filter(Boolean);
  }

  function visibleShips() {
    const bulk = api();
    const ctx = modalContext;
    if (!bulk || !ctx) return [];
    return bulk.filterFleetShips(getShips(), ctx.cruiseLineId, {
      search: String(document.getElementById("ciBulkClassSearch")?.value || ctx.search || ""),
      statusFilter: String(document.getElementById("ciBulkClassStatusFilter")?.value || ctx.statusFilter || "active"),
      classFilter: String(document.getElementById("ciBulkClassClassFilter")?.value || ctx.classFilter || "all"),
      proposedClass: readClassInput()
    });
  }

  function selectedShipRows() {
    const ids = new Set(modalContext?.selectedIds || readSelectedIds());
    return getShips().filter((ship) => ids.has(ship.id));
  }

  function buildSummary() {
    const bulk = api();
    if (!bulk) return null;
    return bulk.buildAssignmentSummary(selectedShipRows(), readClassInput());
  }

  function renderProposedCell(ship, proposedClass) {
    const bulk = api();
    if (!bulk) return "—";
    const row = bulk.classifyAssignment(ship, proposedClass);
    if (row.kind === "unchanged") return `<span class="ci-bulk-class-tag is-unchanged">No change</span>`;
    if (row.kind === "replace") {
      return `<span class="ci-bulk-class-tag is-replace">Will replace “${esc(row.currentClass)}”</span>`;
    }
    if (row.kind === "new") return `<span class="ci-bulk-class-tag is-new">${esc(row.nextClass)}</span>`;
    return `<span class="ci-bulk-class-tag is-new">${esc(proposedClass || "—")}</span>`;
  }

  function renderTableRows(ships, proposedClass, selectedIds) {
    const bulk = api();
    return ships
      .map((ship) => {
        const checked = selectedIds.has(ship.id) ? " checked" : "";
        const current = bulk.isUnassignedClass(ship.ship_class)
          ? `<span class="ci-bulk-class-muted">Unassigned</span>`
          : esc(ship.ship_class);
        const sourceMark = modalContext?.sourceShipId === ship.id ? `<span class="ci-bulk-class-source">Current ship</span>` : "";
        return `
          <tr class="ci-bulk-class-row" data-ship-id="${esc(ship.id)}">
            <td class="ci-bulk-class-check"><label class="ci-check-control"><input type="checkbox" class="ci-bulk-class-target" value="${esc(ship.id)}"${checked}></label></td>
            <td class="ci-bulk-class-name">${esc(ship.name || "Untitled")}${sourceMark}</td>
            <td>${esc(bulk.formatStatusLabel(ship))}</td>
            <td>${current}</td>
            <td>${renderProposedCell(ship, proposedClass)}</td>
          </tr>
          <tr class="ci-bulk-class-card" data-ship-id="${esc(ship.id)}">
            <td colspan="5">
              <label class="ci-check-control ci-bulk-class-card-head">
                <input type="checkbox" class="ci-bulk-class-target" value="${esc(ship.id)}"${checked}>
                <strong>${esc(ship.name || "Untitled")}</strong>${sourceMark}
              </label>
              <div class="ci-bulk-class-card-meta">
                <span>${esc(bulk.formatStatusLabel(ship))}</span>
                <span>Current: ${current}</span>
                <span>${renderProposedCell(ship, proposedClass)}</span>
              </div>
            </td>
          </tr>`;
      })
      .join("");
  }

  function persistSelection() {
    if (!modalContext) return;
    modalContext.selectedIds = readSelectedIds();
  }

  function selectedIdSet() {
    const ids = modalContext?.selectedIds || [];
    return new Set(ids);
  }

  function renderModal() {
    const bulk = api();
    const ctx = modalContext;
    if (!bulk || !ctx) return;
    const overlay = document.getElementById("ciBulkShipClassOverlay");
    if (!overlay) return;

    persistSelection();
    const inputEl = document.getElementById("ciBulkShipClassInput");
    const proposedClass = inputEl ? inputEl.value : (ctx.shipClass || "");
    ctx.shipClass = proposedClass;
    ctx.search = String(document.getElementById("ciBulkClassSearch")?.value || ctx.search || "");
    ctx.statusFilter = String(document.getElementById("ciBulkClassStatusFilter")?.value || ctx.statusFilter || "active");
    ctx.classFilter = String(document.getElementById("ciBulkClassClassFilter")?.value || ctx.classFilter || "all");

    const ships = bulk.filterFleetShips(getShips(), ctx.cruiseLineId, {
      search: ctx.search,
      statusFilter: ctx.statusFilter,
      classFilter: ctx.classFilter,
      proposedClass
    });
    const selectedIds = selectedIdSet();
    const selectedRows = getShips().filter((ship) => selectedIds.has(ship.id));
    const summary = bulk.buildAssignmentSummary(selectedRows, proposedClass);
    const suggestions = bulk.listDistinctClassesForLine(getShips(), ctx.cruiseLineId);
    const shipsWithClass = selectedShipRows().filter((ship) => !bulk.isUnassignedClass(ship.ship_class)).length;
    const replacementRequired = summary.replaceCount > 0;
    const replacementConfirmed = Boolean(document.getElementById("ciBulkClassReplaceConfirm")?.checked);
    const applyDisabled = !bulk.canApplyClassAssignment({
      selectedCount: summary.selectedCount,
      shipClass: proposedClass,
      replaceCount: summary.replaceCount,
      replacementConfirmed
    });
    const clearDisabled = !bulk.canClearClassAssignment({
      selectedCount: summary.selectedCount,
      shipsWithClassCount: shipsWithClass
    });

    overlay.innerHTML = `
      <div class="ci-bulk-class-modal" role="dialog" aria-modal="true" aria-labelledby="ciBulkClassTitle">
        <div class="ci-bulk-class-modal-head">
          <h4 id="ciBulkClassTitle">Assign ship class</h4>
          <button type="button" class="admin-button secondary small" onclick="CiBulkShipClassAdmin.close()">Close</button>
        </div>
        <div class="ci-bulk-class-modal-body">
          <p class="admin-small"><strong>Cruise line:</strong> ${esc(ctx.cruiseLineName)}</p>
          <div class="admin-field">
            <label for="ciBulkShipClassInput">Ship class</label>
            <input id="ciBulkShipClassInput" type="text" list="ciBulkClassSuggestions" value="${esc(proposedClass)}" placeholder="e.g. Millennium class">
            <datalist id="ciBulkClassSuggestions">${suggestions.map((item) => `<option value="${esc(item)}"></option>`).join("")}</datalist>
          </div>
          <div class="ci-bulk-class-toolbar">
            <input id="ciBulkClassSearch" type="search" placeholder="Search ships…" value="${esc(document.getElementById("ciBulkClassSearch")?.value || ctx.search || "")}">
            <select id="ciBulkClassStatusFilter">
              <option value="active" ${(document.getElementById("ciBulkClassStatusFilter")?.value || ctx.statusFilter) === "active" ? "selected" : ""}>Active</option>
              <option value="dry_dock" ${(document.getElementById("ciBulkClassStatusFilter")?.value || ctx.statusFilter) === "dry_dock" ? "selected" : ""}>Dry dock</option>
              <option value="retired" ${(document.getElementById("ciBulkClassStatusFilter")?.value || ctx.statusFilter) === "retired" ? "selected" : ""}>Retired</option>
              <option value="all" ${(document.getElementById("ciBulkClassStatusFilter")?.value || ctx.statusFilter) === "all" ? "selected" : ""}>All</option>
            </select>
            <select id="ciBulkClassClassFilter">
              <option value="all" ${(document.getElementById("ciBulkClassClassFilter")?.value || ctx.classFilter) === "all" ? "selected" : ""}>All classes</option>
              <option value="unassigned" ${(document.getElementById("ciBulkClassClassFilter")?.value || ctx.classFilter) === "unassigned" ? "selected" : ""}>Unassigned</option>
              <option value="already_this" ${(document.getElementById("ciBulkClassClassFilter")?.value || ctx.classFilter) === "already_this" ? "selected" : ""}>Already this class</option>
              <option value="different_class" ${(document.getElementById("ciBulkClassClassFilter")?.value || ctx.classFilter) === "different_class" ? "selected" : ""}>Different class</option>
            </select>
          </div>
          <div class="ci-bulk-class-selection-tools">
            <button type="button" class="admin-button secondary small" onclick="CiBulkShipClassAdmin.selectAllVisible()">Select all visible</button>
            <button type="button" class="admin-button secondary small" onclick="CiBulkShipClassAdmin.clearAll()">Clear all</button>
            <button type="button" class="admin-button secondary small" onclick="CiBulkShipClassAdmin.selectUnassigned()">Select unassigned</button>
          </div>
          <div class="ci-bulk-class-table-wrap">
            <table class="ci-bulk-class-table" aria-label="Fleet ships">
              <thead>
                <tr>
                  <th scope="col">Select</th>
                  <th scope="col">Ship</th>
                  <th scope="col">Status</th>
                  <th scope="col">Current class</th>
                  <th scope="col">Proposed class</th>
                </tr>
              </thead>
              <tbody>${ships.length ? renderTableRows(ships, proposedClass, selectedIds) : `<tr><td colspan="5"><p class="admin-small">No ships match these filters.</p></td></tr>`}</tbody>
            </table>
          </div>
          <div class="ci-bulk-class-summary">
            <p class="admin-small"><strong>Assignment summary</strong></p>
            <ul class="ci-bulk-class-summary-list">
              <li>${summary.selectedCount} selected</li>
              <li>${summary.newCount} receiving a new class</li>
              <li>${summary.replaceCount} changing from another class</li>
              <li>${summary.unchangedCount} already unchanged</li>
            </ul>
          </div>
          ${replacementRequired ? `
            <label class="ci-check-control ci-bulk-class-warning">
              <input type="checkbox" id="ciBulkClassReplaceConfirm"${replacementConfirmed ? " checked" : ""}>
              I understand that existing class assignments will be replaced.
            </label>` : ""}
          <p class="admin-small" id="ciBulkClassResult"></p>
        </div>
        <div class="ci-bulk-class-modal-footer">
          <div class="admin-actions-row ci-bulk-class-modal-actions">
            <button type="button" class="admin-button secondary small" onclick="CiBulkShipClassAdmin.close()">Cancel</button>
            <button type="button" class="admin-button secondary small" onclick="CiBulkShipClassAdmin.clearSelected()"${clearDisabled ? " disabled" : ""}>Clear class from selected ships</button>
            <button type="button" class="admin-button small" id="ciBulkClassApplyBtn" onclick="CiBulkShipClassAdmin.apply()"${applyDisabled ? " disabled" : ""}>${esc(bulk.applyClassButtonLabel(summary.selectedCount))}</button>
          </div>
        </div>
      </div>`;

    overlay.querySelectorAll(
      "#ciBulkShipClassInput, #ciBulkClassSearch, #ciBulkClassStatusFilter, #ciBulkClassClassFilter, #ciBulkClassReplaceConfirm"
    ).forEach((el) => {
      el.addEventListener("change", () => renderModal());
      if (el.matches("input[type='search'], input[type='text']")) {
        el.addEventListener("input", () => renderModal());
      }
    });
    overlay.querySelectorAll(".ci-bulk-class-target").forEach((el) => {
      el.addEventListener("change", () => renderModal());
    });
  }

  function openModal(options) {
    closeModal();
    const bulk = api();
    const opts = options || {};
    const cruiseLineId = String(opts.cruiseLineId || "").trim();
    const line = getLines().find((row) => row.id === cruiseLineId);
    if (!bulk || !line) return;

    modalContext = {
      cruiseLineId,
      cruiseLineName: line.name,
      sourceShipId: opts.sourceShipId || null,
      shipClass: opts.prefilledClass != null ? String(opts.prefilledClass) : "",
      search: "",
      statusFilter: "active",
      classFilter: "all",
      selectedIds: Array.isArray(opts.preselectedShipIds) ? opts.preselectedShipIds.slice() : []
    };

    const overlay = document.createElement("div");
    overlay.id = "ciBulkShipClassOverlay";
    overlay.className = "ci-bulk-class-overlay";
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeModal();
    });
    document.body.appendChild(overlay);
    renderModal();
  }

  function selectAllVisible() {
    const bulk = api();
    if (!bulk || !modalContext) return;
    const visible = bulk.filterFleetShips(getShips(), modalContext.cruiseLineId, {
      search: modalContext.search,
      statusFilter: modalContext.statusFilter,
      classFilter: modalContext.classFilter,
      proposedClass: modalContext.shipClass
    });
    const ids = new Set(modalContext.selectedIds || []);
    visible.forEach((ship) => ids.add(ship.id));
    modalContext.selectedIds = [...ids];
    renderModal();
  }

  function clearAll() {
    if (!modalContext) return;
    modalContext.selectedIds = [];
    renderModal();
  }

  function selectUnassigned() {
    const bulk = api();
    if (!bulk || !modalContext) return;
    modalContext.selectedIds = bulk
      .filterFleetShips(getShips(), modalContext.cruiseLineId, {
        search: modalContext.search,
        statusFilter: modalContext.statusFilter,
        classFilter: modalContext.classFilter,
        proposedClass: modalContext.shipClass
      })
      .filter((ship) => bulk.isUnassignedClass(ship.ship_class))
      .map((ship) => ship.id);
    renderModal();
  }

  async function apply() {
    const bulk = api();
    const ctx = modalContext;
    if (!bulk || !ctx) return;
    const shipClass = readClassInput();
    const selected = selectedShipRows();
    const summary = bulk.buildAssignmentSummary(selected, shipClass);
    const replacementConfirmed = Boolean(document.getElementById("ciBulkClassReplaceConfirm")?.checked);
    const validation = bulk.validateBulkAssignRequest({
      cruiseLineId: ctx.cruiseLineId,
      shipIds: selected.map((ship) => ship.id),
      shipClass,
      ships: getShips(),
      replacementConfirmed
    });
    if (!validation.ok) {
      const resultEl = document.getElementById("ciBulkClassResult");
      if (resultEl) resultEl.textContent = validation.error === "REPLACEMENT_NOT_CONFIRMED" ? "Confirm replacement before applying." : "Selection is not ready to apply.";
      renderModal();
      return;
    }
    const confirmed = window.confirm(
      bulk.buildAssignConfirmMessage({
        cruiseLineName: ctx.cruiseLineName,
        shipClass: bulk.normalizeShipClassInput(shipClass),
        summary
      })
    );
    if (!confirmed) {
      const resultEl = document.getElementById("ciBulkClassResult");
      if (resultEl) resultEl.textContent = "Assignment cancelled.";
      return;
    }

    const resultEl = document.getElementById("ciBulkClassResult");
    if (resultEl) resultEl.textContent = "Applying class…";
    try {
      const headers = await window.adminAuthHeaders();
      const response = await fetch("/.netlify/functions/ci-ship-class-bulk-assign", {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: "assign",
          cruise_line_id: ctx.cruiseLineId,
          ship_class: bulk.normalizeShipClassInput(shipClass),
          ship_ids: selected.map((ship) => ship.id),
          replacement_confirmed: replacementConfirmed
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) {
        if (resultEl) resultEl.textContent = data.detail || data.error || "Bulk class assignment failed.";
        return;
      }
      window.applyCiBulkClassAssignmentResults(data.results || []);
      const updated = Number(data.updated_count) || 0;
      const unchanged = Number(data.unchanged_count) || 0;
      const failed = Number(data.failed_count) || 0;
      const names = (data.results || [])
        .filter((row) => row.outcome === "updated")
        .map((row) => row.name)
        .join(", ");
      if (resultEl) {
        resultEl.textContent = `Updated ${updated}, unchanged ${unchanged}${failed ? `, failed ${failed}` : ""}${names ? `: ${names}` : ""}.`;
      }
      if (typeof window.setCiAutosaveStatus === "function") {
        window.setCiAutosaveStatus("Ship classes updated", "saved");
      }
    } catch (error) {
      if (resultEl) resultEl.textContent = String(error.message || error);
    }
  }

  async function clearSelected() {
    const bulk = api();
    const ctx = modalContext;
    if (!bulk || !ctx) return;
    const selected = selectedShipRows();
    const withClass = selected.filter((ship) => !bulk.isUnassignedClass(ship.ship_class));
    if (!withClass.length) return;
    const summary = {
      selectedCount: selected.length,
      shipsWithClassCount: withClass.length,
      shipNames: withClass.map((ship) => ship.name || "Untitled")
    };
    const confirmed = window.confirm(
      bulk.buildClearConfirmMessage({ cruiseLineName: ctx.cruiseLineName, summary })
    );
    if (!confirmed) {
      const resultEl = document.getElementById("ciBulkClassResult");
      if (resultEl) resultEl.textContent = "Clear class cancelled.";
      return;
    }
    const resultEl = document.getElementById("ciBulkClassResult");
    if (resultEl) resultEl.textContent = "Clearing class…";
    try {
      const headers = await window.adminAuthHeaders();
      const response = await fetch("/.netlify/functions/ci-ship-class-bulk-assign", {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: "clear",
          cruise_line_id: ctx.cruiseLineId,
          ship_ids: selected.map((ship) => ship.id)
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) {
        if (resultEl) resultEl.textContent = data.detail || data.error || "Clear class failed.";
        return;
      }
      window.applyCiBulkClassAssignmentResults(data.results || []);
      const updated = Number(data.updated_count) || 0;
      const unchanged = Number(data.unchanged_count) || 0;
      const failed = Number(data.failed_count) || 0;
      if (resultEl) {
        resultEl.textContent = `Cleared ${updated}, unchanged ${unchanged}${failed ? `, failed ${failed}` : ""}.`;
      }
      if (typeof window.setCiAutosaveStatus === "function") {
        window.setCiAutosaveStatus("Ship classes cleared", "saved");
      }
      renderModal();
    } catch (error) {
      if (resultEl) resultEl.textContent = String(error.message || error);
    }
  }

  window.CiBulkShipClassAdmin = {
    open: openModal,
    close: closeModal,
    selectAllVisible,
    clearAll,
    selectUnassigned,
    apply,
    clearSelected,
    getContext
  };
})();
