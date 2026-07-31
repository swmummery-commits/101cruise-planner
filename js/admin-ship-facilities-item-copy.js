/**
 * Admin item-level ship facilities copy modal.
 */
(function () {
  "use strict";

  let modalContext = null;

  function baseApi() {
    return window.CiShipFacilities || null;
  }

  function itemApi() {
    return window.CiShipFacilitiesItemCopy || null;
  }

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function getShips() {
    return window.ciCruiseShips || [];
  }

  function getLines() {
    return window.ciCruiseLines || [];
  }

  function getSourceShip() {
    const ctx = modalContext;
    if (!ctx) return null;
    return getShips().find(function (ship) { return ship.id === ctx.sourceShipId; }) || ctx.sourceShip || null;
  }

  function getDraftClass() {
    const el = document.getElementById("ciShipClass");
    const base = baseApi();
    const raw = String(el && el.value || modalContext && modalContext.shipClass || "");
    return base ? base.normalizeShipClass(raw) : raw.trim() || null;
  }

  function getLineId(sourceShip) {
    const draft = String(document.getElementById("ciShipLineId") && document.getElementById("ciShipLineId").value || "");
    return draft.trim() || (sourceShip && sourceShip.cruise_line_id) || "";
  }

  function sourceExclusiveItems() {
    const itemCopy = itemApi();
    const source = getSourceShip();
    if (!itemCopy || !source) return [];
    return itemCopy.listSourceExclusiveAreas(source.facilities && source.facilities.exclusive_areas);
  }

  function sourceSpecialtyItems() {
    const itemCopy = itemApi();
    const source = getSourceShip();
    if (!itemCopy || !source) return [];
    return itemCopy.listSourceSpecialtyFeatures(source.facilities && source.facilities.specialty_features);
  }

  function readTargetScope() {
    const checked = document.querySelector('input[name="ciItemCopyScope"]:checked');
    const itemCopy = itemApi();
    if (!checked || !itemCopy) return itemCopy ? itemCopy.TARGET_SCOPE_SAME_CLASS : "same_class";
    return checked.value === itemCopy.TARGET_SCOPE_FLEET
      ? itemCopy.TARGET_SCOPE_FLEET
      : itemCopy.TARGET_SCOPE_SAME_CLASS;
  }

  function eligibleTargets() {
    const itemCopy = itemApi();
    const source = getSourceShip();
    if (!itemCopy || !source) return [];
    const scope = readTargetScope();
    const lineId = getLineId(source);
    const draftSource = { ...source, cruise_line_id: lineId || source.cruise_line_id };
    return itemCopy.resolveCopyTargets(getShips(), draftSource, scope, getDraftClass());
  }

  function visibleTargets() {
    const itemCopy = itemApi();
    const source = getSourceShip();
    if (!itemCopy || !source) return [];
    const all = eligibleTargets();
    const search = String(document.getElementById("ciItemCopyTargetSearch") && document.getElementById("ciItemCopyTargetSearch").value || "");
    const classFilter = String(document.getElementById("ciItemCopyClassFilter") && document.getElementById("ciItemCopyClassFilter").value || "all");
    if (readTargetScope() !== itemCopy.TARGET_SCOPE_FLEET) {
      if (!search.trim()) return all;
      const q = itemCopy.normalizeCompareText(search);
      return all.filter(function (ship) {
        return itemCopy.normalizeCompareText(ship.name).includes(q);
      });
    }
    return itemCopy.filterFleetTargets(all, getLineId(source), { search: search, classFilter: classFilter });
  }

  function readSelectedSourceKeys() {
    const exclusive = [...document.querySelectorAll(".ci-item-copy-source-ea:checked")].map(function (el) { return el.value; });
    const specialty = [...document.querySelectorAll(".ci-item-copy-source-sf:checked")].map(function (el) { return el.value; });
    return { exclusive: exclusive, specialty: specialty };
  }

  function readSelectedTargetIds() {
    return [...document.querySelectorAll(".ci-item-copy-target:checked")].map(function (el) { return el.value; }).filter(Boolean);
  }

  function buildSelectedItemsPayload() {
    const keys = readSelectedSourceKeys();
    const exclusiveItems = sourceExclusiveItems();
    const specialtyItems = sourceSpecialtyItems();
    return {
      exclusive_areas: exclusiveItems
        .filter(function (item) { return keys.exclusive.includes(item.source_key); })
        .map(function (item) { return { source_key: item.source_key, name: item.name }; }),
      specialty_features: specialtyItems
        .filter(function (item) { return keys.specialty.includes(item.source_key); })
        .map(function (item) { return { source_key: item.source_key, value: item.value }; })
    };
  }

  function readConflictResolutions() {
    const rows = [];
    document.querySelectorAll(".ci-item-copy-conflict-choice:checked").forEach(function (el) {
      rows.push({
        target_ship_id: el.getAttribute("data-target-id"),
        source_key: el.getAttribute("data-source-key"),
        action: el.value
      });
    });
    return rows;
  }

  function buildPlans() {
    const itemCopy = itemApi();
    const source = getSourceShip();
    if (!itemCopy || !source) return [];
    const selectedItems = buildSelectedItemsPayload();
    const targetIds = new Set(readSelectedTargetIds());
    const targets = getShips().filter(function (ship) { return targetIds.has(ship.id); });
    return itemCopy.buildCopyPlans({
      sourceFacilities: source.facilities,
      targets: targets,
      selectedItems: selectedItems,
      conflictResolutions: readConflictResolutions()
    });
  }

  function renderSourceExclusiveItem(item) {
    const preview = item.legacy
      ? `<span class="ci-item-copy-legacy-tag">Legacy text</span>`
      : (item.description
        ? `<span class="ci-item-copy-desc-preview">${esc(item.description)}</span>`
        : "");
    return `
      <label class="ci-check-control ci-item-copy-source-item">
        <input type="checkbox" class="ci-item-copy-source-ea" value="${esc(item.source_key)}">
        <span class="ci-item-copy-source-item-body">
          <strong>${esc(item.name)}</strong>
          ${preview}
        </span>
      </label>`;
  }

  function renderSourceSpecialtyItem(item) {
    return `
      <label class="ci-check-control ci-item-copy-source-item">
        <input type="checkbox" class="ci-item-copy-source-sf" value="${esc(item.source_key)}">
        <span class="ci-item-copy-source-item-body"><strong>${esc(item.value)}</strong></span>
      </label>`;
  }

  function renderConflictBlock(plan, row) {
    const sourceItem = row.sourceItem;
    const targetEntry = row.comparison.targetEntry || {};
    const targetDescription = targetEntry.description || "";
    const keepChecked = row.plannedAction === "keep_existing" ? " checked" : "";
    const replaceChecked = row.plannedAction === "replace" ? " checked" : "";
    return `
      <div class="ci-item-copy-conflict-card" data-target-id="${esc(plan.targetShipId)}" data-source-key="${esc(row.source_key)}">
        <p class="admin-small"><strong>${esc(plan.targetShipName)}</strong> · ${esc(sourceItem.name)}</p>
        <div class="ci-item-copy-conflict-grid">
          <div>
            <p class="admin-small">Source</p>
            <p>${esc(sourceItem.name)}</p>
            <p class="ci-item-copy-desc-preview">${esc(sourceItem.description || "—")}</p>
          </div>
          <div>
            <p class="admin-small">Target</p>
            <p>${esc(sourceItem.name)}</p>
            <p class="ci-item-copy-desc-preview">${esc(targetDescription || "—")}</p>
          </div>
        </div>
        <fieldset class="ci-item-copy-conflict-choices">
          <legend class="admin-visually-hidden">Conflict decision for ${esc(sourceItem.name)} on ${esc(plan.targetShipName)}</legend>
          <label class="ci-check-control">
            <input type="radio" class="ci-item-copy-conflict-choice" name="conf-${esc(plan.targetShipId)}-${esc(row.source_key)}" value="keep_target" data-target-id="${esc(plan.targetShipId)}" data-source-key="${esc(row.source_key)}"${keepChecked}>
            Keep existing
          </label>
          <label class="ci-check-control">
            <input type="radio" class="ci-item-copy-conflict-choice" name="conf-${esc(plan.targetShipId)}-${esc(row.source_key)}" value="replace_source" data-target-id="${esc(plan.targetShipId)}" data-source-key="${esc(row.source_key)}"${replaceChecked}>
            Replace existing
          </label>
        </fieldset>
      </div>`;
  }

  function renderTargetRow(ship, plan) {
    const itemCopy = itemApi();
    const source = getSourceShip();
    const isCurrent = source && ship.id === source.id;
    const cls = ship.ship_class ? esc(ship.ship_class) : "Unassigned";
    const status = plan ? itemCopy.targetComparisonStatusLabel(plan.items) : "—";
    return `
      <label class="ci-check-control ci-item-copy-target-row">
        <input type="checkbox" class="ci-item-copy-target" value="${esc(ship.id)}">
        <span class="ci-item-copy-target-body">
          <span class="ci-item-copy-target-name">${esc(ship.name)}${isCurrent ? " <span class=\"ci-item-copy-current-tag\">Current ship</span>" : ""}</span>
          <span class="ci-item-copy-target-meta">${cls}</span>
          <span class="ci-item-copy-target-status">${esc(status)}</span>
        </span>
      </label>`;
  }

  function renderTargetTable(ships, plansById) {
    const rows = ships.map(function (ship) {
      return renderTargetRow(ship, plansById[ship.id]);
    }).join("");
    return `<div class="ci-item-copy-target-list">${rows}</div>`;
  }

  function renderReview(plans) {
    const itemCopy = itemApi();
    if (!plans.length) return `<p class="admin-small">Select source items and target ships to review changes.</p>`;
    return plans.map(function (plan) {
      const summary = plan.summary;
      const lines = [];
      if (summary.addCount) lines.push(`${summary.addCount} item${summary.addCount === 1 ? "" : "s"} will be added`);
      if (summary.skipIdenticalCount) lines.push(`${summary.skipIdenticalCount} identical item${summary.skipIdenticalCount === 1 ? "" : "s"} will be skipped`);
      if (summary.conflictCount) lines.push(`${summary.conflictCount} conflict${summary.conflictCount === 1 ? "" : "s"} need${summary.conflictCount === 1 ? "s" : ""} a decision`);
      if (summary.noChanges) lines.push("No changes");
      const itemLabels = (plan.items || []).map(function (row) {
        const label = row.sourceItem.name || row.sourceItem.value;
        if (row.plannedAction === "add") return `${esc(label)} — Will add`;
        if (row.plannedAction === "skip_identical") return `${esc(label)} — Already identical`;
        if (row.plannedAction === "keep_existing") return `${esc(label)} — Keep existing`;
        if (row.plannedAction === "replace") return `${esc(label)} — Replace existing`;
        if (row.comparison.status === "different") return `${esc(label)} — Different description`;
        return esc(label);
      }).join("<br>");
      return `
        <div class="ci-item-copy-review-card">
          <p class="admin-small"><strong>${esc(plan.targetShipName)}</strong></p>
          <p class="admin-small">${esc(lines.join(" · ") || "No changes")}</p>
          <div class="admin-small ci-item-copy-review-items">${itemLabels}</div>
        </div>`;
    }).join("");
  }

  function renderConflictSection(plans) {
    const blocks = [];
    plans.forEach(function (plan) {
      (plan.items || []).forEach(function (row) {
        if (row.comparison.status === "different") blocks.push(renderConflictBlock(plan, row));
      });
    });
    if (!blocks.length) return "";
    return `
      <section class="ci-item-copy-section">
        <h5>Exclusive area conflicts</h5>
        ${blocks.join("")}
      </section>`;
  }

  function renderClassFilterOptions() {
    const itemCopy = itemApi();
    const source = getSourceShip();
    if (!itemCopy || !source) return "";
    const options = itemCopy.listFleetClassFilterOptions(getShips(), getLineId(source));
    return [`<option value="all">All classes</option>`]
      .concat(options.map(function (cls) {
        return `<option value="${esc(cls)}">${esc(cls)}</option>`;
      }))
      .join("");
  }

  function renderModalBody() {
    const itemCopy = itemApi();
    const source = getSourceShip();
    const line = getLines().find(function (row) { return row.id === getLineId(source); });
    const exclusiveItems = sourceExclusiveItems();
    const specialtyItems = sourceSpecialtyItems();
    const scope = modalContext && modalContext.targetScope || itemCopy.TARGET_SCOPE_SAME_CLASS;
    const sameClassDisabled = !getDraftClass();
    const targets = eligibleTargets();
    const visible = visibleTargets();
    const plans = buildPlans();
    const plansById = Object.fromEntries(plans.map(function (plan) { return [plan.targetShipId, plan]; }));
    const totals = itemCopy.summarizeAllPlans(plans);
    const fleetScope = scope === itemCopy.TARGET_SCOPE_FLEET;

    return `
      <div class="ci-facilities-copy-modal-head">
        <h4 id="ciItemCopyTitle">Copy ship facilities</h4>
        <button type="button" class="admin-button secondary small" id="ciItemCopyClose">Close</button>
      </div>
      <div class="ci-facilities-copy-modal-body">
        <p class="admin-small"><strong>Source ship:</strong> ${esc(source && source.name || "—")}</p>
        <p class="admin-small"><strong>Cruise line:</strong> ${esc(line && line.name || "—")}</p>

        <section class="ci-item-copy-section">
          <div class="ci-item-copy-section-head">
            <h5>Exclusive Areas</h5>
            <div class="ci-item-copy-mini-toolbar">
              <button type="button" class="admin-button secondary small" data-select="ea-all">Select all</button>
              <button type="button" class="admin-button secondary small" data-clear="ea-all">Clear all</button>
            </div>
          </div>
          <div class="ci-item-copy-source-list">${exclusiveItems.map(renderSourceExclusiveItem).join("") || `<p class="admin-small">No exclusive areas on this ship.</p>`}</div>
        </section>

        <section class="ci-item-copy-section">
          <div class="ci-item-copy-section-head">
            <h5>Specialty Features</h5>
            <div class="ci-item-copy-mini-toolbar">
              <button type="button" class="admin-button secondary small" data-select="sf-all">Select all</button>
              <button type="button" class="admin-button secondary small" data-clear="sf-all">Clear all</button>
            </div>
          </div>
          <div class="ci-item-copy-source-list">${specialtyItems.map(renderSourceSpecialtyItem).join("") || `<p class="admin-small">No specialty features on this ship.</p>`}</div>
        </section>

        <div class="ci-item-copy-global-toolbar">
          <button type="button" class="admin-button secondary small" data-select="all-items">Select all items</button>
          <button type="button" class="admin-button secondary small" data-clear="all-items">Clear all items</button>
        </div>

        <section class="ci-item-copy-section">
          <h5>Target scope</h5>
          <div class="ci-item-copy-scope-row">
            <label class="ci-check-control">
              <input type="radio" name="ciItemCopyScope" value="${itemCopy.TARGET_SCOPE_SAME_CLASS}"${scope === itemCopy.TARGET_SCOPE_SAME_CLASS ? " checked" : ""}${sameClassDisabled ? " disabled" : ""}>
              Same class
            </label>
            <label class="ci-check-control">
              <input type="radio" name="ciItemCopyScope" value="${itemCopy.TARGET_SCOPE_FLEET}"${scope === itemCopy.TARGET_SCOPE_FLEET ? " checked" : ""}>
              Entire cruise-line fleet
            </label>
          </div>
          ${sameClassDisabled ? `<p class="ci-facility-warning">This ship has no class assigned. Same-class copying is unavailable — use the fleet option.</p>` : ""}
          ${!targets.length ? `<p class="ci-facility-warning">No eligible target ships for the selected scope.</p>` : ""}
        </section>

        <section class="ci-item-copy-section">
          <div class="ci-item-copy-section-head">
            <h5>Target ships</h5>
            <div class="ci-item-copy-mini-toolbar">
              <button type="button" class="admin-button secondary small" data-select="targets-visible">Select all visible</button>
              <button type="button" class="admin-button secondary small" data-clear="targets-all">Clear all</button>
            </div>
          </div>
          <div class="ci-item-copy-target-filters">
            <label class="admin-field ci-item-copy-search-field">
              <span>Search ships</span>
              <input type="search" id="ciItemCopyTargetSearch" placeholder="Search by ship name" value="${esc(modalContext && modalContext.search || "")}">
            </label>
            ${fleetScope ? `
              <label class="admin-field">
                <span>Class filter</span>
                <select id="ciItemCopyClassFilter">${renderClassFilterOptions()}</select>
              </label>` : ""}
          </div>
          ${renderTargetTable(visible, plansById)}
        </section>

        <section class="ci-item-copy-section">
          <h5>Review</h5>
          <div id="ciItemCopyReview">${renderReview(plans)}</div>
        </section>

        <div id="ciItemCopyConflicts">${renderConflictSection(plans)}</div>
      </div>
      <div class="ci-facilities-copy-modal-footer">
        <p class="admin-small" id="ciItemCopySummary">${esc(buildFooterSummary(totals, plans))}</p>
        <div class="admin-actions-row ci-facilities-copy-modal-actions">
          <button type="button" class="admin-button secondary small" id="ciItemCopyCancel">Cancel</button>
          <button type="button" class="admin-button small" id="ciItemCopySubmit">${esc(itemCopy.itemCopySubmitLabel({
            selectedTargetCount: readSelectedTargetIds().length,
            totals: totals,
            awaitingConfirmation: false,
            showingConfirmation: false
          }))}</button>
        </div>
        <div id="ciItemCopyResultPanel"></div>
      </div>`;
  }

  function buildFooterSummary(totals, plans) {
    const sourceKeys = readSelectedSourceKeys();
    const targetCount = readSelectedTargetIds().length;
    const sourceCount = sourceKeys.exclusive.length + sourceKeys.specialty.length;
    if (!sourceCount && !targetCount) return "Select source items and target ships.";
    if (!sourceCount) return "Select at least one source item.";
    if (!targetCount) return "Select at least one target ship.";
    if (totals.noChanges) return "All selected items are already identical or set to keep existing — no changes to copy.";
    return `${totals.addCount} addition${totals.addCount === 1 ? "" : "s"}, ${totals.replaceCount} replacement${totals.replaceCount === 1 ? "" : "s"}, ${totals.skipIdenticalCount} identical skipped, ${totals.keepExistingCount} retained across ${plans.length} ship${plans.length === 1 ? "" : "s"}.`;
  }

  function rerenderModal() {
    const overlay = document.getElementById("ciItemFacilitiesCopyOverlay");
    if (!overlay || !modalContext) return;
    const modal = overlay.querySelector(".ci-facilities-copy-modal");
    if (!modal) return;
    const selectedEa = new Set(readSelectedSourceKeys().exclusive);
    const selectedSf = new Set(readSelectedSourceKeys().specialty);
    const selectedTargets = new Set(readSelectedTargetIds());
    const conflictRes = readConflictResolutions();
    modalContext.selectedEa = [...selectedEa];
    modalContext.selectedSf = [...selectedSf];
    modalContext.selectedTargets = [...selectedTargets];
    modalContext.conflictResolutions = conflictRes;
    modalContext.search = String(document.getElementById("ciItemCopyTargetSearch") && document.getElementById("ciItemCopyTargetSearch").value || "");
    modalContext.classFilter = String(document.getElementById("ciItemCopyClassFilter") && document.getElementById("ciItemCopyClassFilter").value || "all");
    modal.innerHTML = renderModalBody();
    restoreSelections();
    bindModalEvents();
    updateSubmitState();
  }

  function restoreSelections() {
    const ctx = modalContext || {};
    (ctx.selectedEa || []).forEach(function (key) {
      const el = document.querySelector(`.ci-item-copy-source-ea[value="${CSS.escape(key)}"]`);
      if (el) el.checked = true;
    });
    (ctx.selectedSf || []).forEach(function (key) {
      const el = document.querySelector(`.ci-item-copy-source-sf[value="${CSS.escape(key)}"]`);
      if (el) el.checked = true;
    });
    (ctx.selectedTargets || []).forEach(function (id) {
      const el = document.querySelector(`.ci-item-copy-target[value="${CSS.escape(id)}"]`);
      if (el) el.checked = true;
    });
    (ctx.conflictResolutions || []).forEach(function (row) {
      const el = document.querySelector(
        `.ci-item-copy-conflict-choice[data-target-id="${CSS.escape(row.target_ship_id)}"][data-source-key="${CSS.escape(row.source_key)}"][value="${CSS.escape(row.action)}"]`
      );
      if (el) el.checked = true;
    });
    const search = document.getElementById("ciItemCopyTargetSearch");
    if (search && ctx.search) search.value = ctx.search;
    const classFilter = document.getElementById("ciItemCopyClassFilter");
    if (classFilter && ctx.classFilter) classFilter.value = ctx.classFilter;
  }

  function updateSubmitState() {
    const itemCopy = itemApi();
    const submit = document.getElementById("ciItemCopySubmit");
    if (!itemCopy || !submit) return;
    const plans = buildPlans();
    const totals = itemCopy.summarizeAllPlans(plans);
    const sourceCount = readSelectedSourceKeys().exclusive.length + readSelectedSourceKeys().specialty.length;
    const targetCount = readSelectedTargetIds().length;
    const awaiting = modalContext && modalContext.awaitingConfirmation;
    const canSubmit = itemCopy.itemCopyCanSubmit({
      selectedSourceCount: sourceCount,
      selectedTargetCount: targetCount,
      plans: plans,
      awaitingConfirmation: awaiting
    });
    submit.disabled = !canSubmit;
    submit.setAttribute("aria-disabled", canSubmit ? "false" : "true");
    submit.textContent = itemCopy.itemCopySubmitLabel({
      selectedTargetCount: targetCount,
      totals: totals,
      awaitingConfirmation: awaiting,
      showingConfirmation: awaiting
    });
    const summary = document.getElementById("ciItemCopySummary");
    if (summary) summary.textContent = buildFooterSummary(totals, plans);
  }

  function bindModalEvents() {
    const overlay = document.getElementById("ciItemFacilitiesCopyOverlay");
    if (!overlay) return;

    overlay.querySelector("#ciItemCopyClose") && overlay.querySelector("#ciItemCopyClose").addEventListener("click", closeModal);
    overlay.querySelector("#ciItemCopyCancel") && overlay.querySelector("#ciItemCopyCancel").addEventListener("click", closeModal);

    overlay.querySelectorAll(".ci-item-copy-source-ea, .ci-item-copy-source-sf, .ci-item-copy-target, .ci-item-copy-conflict-choice")
      .forEach(function (el) {
        el.addEventListener("change", function () {
          if (modalContext) modalContext.awaitingConfirmation = false;
          rerenderModal();
        });
      });

    overlay.querySelectorAll('input[name="ciItemCopyScope"]').forEach(function (el) {
      el.addEventListener("change", function () {
        if (!modalContext) return;
        modalContext.targetScope = readTargetScope();
        modalContext.selectedTargets = [];
        modalContext.conflictResolutions = [];
        modalContext.awaitingConfirmation = false;
        rerenderModal();
      });
    });

    const search = overlay.querySelector("#ciItemCopyTargetSearch");
    if (search) {
      search.addEventListener("input", function () {
        if (modalContext) modalContext.search = search.value;
        rerenderModal();
      });
    }
    const classFilter = overlay.querySelector("#ciItemCopyClassFilter");
    if (classFilter) {
      classFilter.addEventListener("change", function () {
        if (modalContext) modalContext.classFilter = classFilter.value;
        rerenderModal();
      });
    }

    overlay.querySelector("[data-select='ea-all']") && overlay.querySelector("[data-select='ea-all']").addEventListener("click", function () {
      overlay.querySelectorAll(".ci-item-copy-source-ea").forEach(function (el) { el.checked = true; });
      rerenderModal();
    });
    overlay.querySelector("[data-clear='ea-all']") && overlay.querySelector("[data-clear='ea-all']").addEventListener("click", function () {
      overlay.querySelectorAll(".ci-item-copy-source-ea").forEach(function (el) { el.checked = false; });
      rerenderModal();
    });
    overlay.querySelector("[data-select='sf-all']") && overlay.querySelector("[data-select='sf-all']").addEventListener("click", function () {
      overlay.querySelectorAll(".ci-item-copy-source-sf").forEach(function (el) { el.checked = true; });
      rerenderModal();
    });
    overlay.querySelector("[data-clear='sf-all']") && overlay.querySelector("[data-clear='sf-all']").addEventListener("click", function () {
      overlay.querySelectorAll(".ci-item-copy-source-sf").forEach(function (el) { el.checked = false; });
      rerenderModal();
    });
    overlay.querySelector("[data-select='all-items']") && overlay.querySelector("[data-select='all-items']").addEventListener("click", function () {
      overlay.querySelectorAll(".ci-item-copy-source-ea, .ci-item-copy-source-sf").forEach(function (el) { el.checked = true; });
      rerenderModal();
    });
    overlay.querySelector("[data-clear='all-items']") && overlay.querySelector("[data-clear='all-items']").addEventListener("click", function () {
      overlay.querySelectorAll(".ci-item-copy-source-ea, .ci-item-copy-source-sf").forEach(function (el) { el.checked = false; });
      rerenderModal();
    });
    overlay.querySelector("[data-select='targets-visible']") && overlay.querySelector("[data-select='targets-visible']").addEventListener("click", function () {
      overlay.querySelectorAll(".ci-item-copy-target").forEach(function (el) { el.checked = true; });
      rerenderModal();
    });
    overlay.querySelector("[data-clear='targets-all']") && overlay.querySelector("[data-clear='targets-all']").addEventListener("click", function () {
      overlay.querySelectorAll(".ci-item-copy-target").forEach(function (el) { el.checked = false; });
      rerenderModal();
    });

    overlay.querySelector("#ciItemCopySubmit") && overlay.querySelector("#ciItemCopySubmit").addEventListener("click", onSubmitClick);
  }

  function renderResultPanel(data) {
    const itemCopy = itemApi();
    const panel = document.getElementById("ciItemCopyResultPanel");
    if (!panel) return;
    const rows = (data.results || []).map(function (row) {
      if (!row.ok) return `<p class="ci-item-copy-result-fail"><strong>${esc(row.name)}</strong> — ${esc(row.error || "Failed")}</p>`;
      const result = row.result || itemCopy.buildResultRow(row.name, row.items, {});
      const lines = [];
      if (result.added && result.added.length) lines.push(`Added: ${esc(result.added.join(", "))}`);
      if (result.replaced && result.replaced.length) lines.push(`Replaced: ${esc(result.replaced.join(", "))}`);
      if (result.skipped_identical && result.skipped_identical.length) lines.push(`Already present: ${esc(result.skipped_identical.join(", "))}`);
      if (result.kept_existing && result.kept_existing.length) lines.push(`Kept existing: ${esc(result.kept_existing.join(", "))}`);
      return `<div class="ci-item-copy-result-card"><strong>${esc(row.name)}</strong><br>${lines.join("<br>") || "Updated"}</div>`;
    }).join("");
    panel.innerHTML = `<div class="ci-item-copy-result-wrap"><p><strong>Copy complete</strong></p>${rows}</div>`;
  }

  function applySuccessToLocalShips(data) {
    const results = Array.isArray(data.results) ? data.results : [];
    const ships = getShips();
    results.forEach(function (row) {
      if (!row.ok || !row.id || !row.facilities) return;
      const idx = ships.findIndex(function (ship) { return ship.id === row.id; });
      if (idx >= 0) {
        ships[idx] = { ...ships[idx], facilities: row.facilities };
      }
    });
    if (window.syncCiCatalogueWindowState) window.syncCiCatalogueWindowState();
    if (window.refreshCiShipMasterList) window.refreshCiShipMasterList();
  }

  async function onSubmitClick() {
    const itemCopy = itemApi();
    const source = getSourceShip();
    if (!itemCopy || !source || !window.adminAuthHeaders) return;

    const plans = buildPlans();
    const totals = itemCopy.summarizeAllPlans(plans);
    const selectedItems = buildSelectedItemsPayload();
    const targetIds = readSelectedTargetIds();
    const conflictResolutions = readConflictResolutions();
    const line = getLines().find(function (row) { return row.id === getLineId(source); });

    if (totals.noChanges) {
      updateSubmitState();
      return;
    }

    if (!modalContext.awaitingConfirmation) {
      modalContext.awaitingConfirmation = true;
      const exclusiveNames = selectedItems.exclusive_areas.map(function (row) { return row.name; });
      const specialtyValues = selectedItems.specialty_features.map(function (row) { return row.value; });
      const targetNames = targetIds.map(function (id) {
        return getShips().find(function (ship) { return ship.id === id; });
      }).filter(Boolean).map(function (ship) { return ship.name; });
      const confirmed = window.confirm(itemCopy.itemCopyConfirmMessage({
        sourceShipName: source.name,
        cruiseLineName: line && line.name,
        targetScope: readTargetScope(),
        targetNames: targetNames,
        exclusiveNames: exclusiveNames,
        specialtyValues: specialtyValues,
        totals: totals
      }));
      if (!confirmed) {
        modalContext.awaitingConfirmation = false;
        updateSubmitState();
        return;
      }
    }

    const submit = document.getElementById("ciItemCopySubmit");
    if (submit) {
      submit.disabled = true;
      submit.textContent = "Copying…";
    }

    const payload = {
      source_ship_id: source.id,
      target_scope: readTargetScope(),
      target_ship_ids: targetIds,
      selected_items: selectedItems,
      conflict_resolutions: conflictResolutions
    };

    try {
      const headers = await window.adminAuthHeaders();
      const response = await fetch("/.netlify/functions/ci-ship-facilities-copy", {
        method: "POST",
        headers: headers,
        body: JSON.stringify(payload)
      });
      const data = await response.json().catch(function () { return {}; });
      if (!response.ok || data.success === false) {
        const panel = document.getElementById("ciItemCopyResultPanel");
        if (panel) panel.innerHTML = `<p class="ci-item-copy-result-fail">${esc(data.detail || data.error || "Copy failed.")}</p>`;
        if (window.setCiAutosaveStatus) window.setCiAutosaveStatus("Facilities copy failed", "error");
        modalContext.awaitingConfirmation = false;
        updateSubmitState();
        return;
      }
      applySuccessToLocalShips(data);
      renderResultPanel(data);
      modalContext.awaitingConfirmation = false;
      modalContext.copyComplete = true;
      if (window.setCiAutosaveStatus) window.setCiAutosaveStatus("Facilities copy complete", "saved");
      rerenderModal();
    } catch (error) {
      const panel = document.getElementById("ciItemCopyResultPanel");
      if (panel) panel.innerHTML = `<p class="ci-item-copy-result-fail">${esc(String(error.message || error))}</p>`;
      modalContext.awaitingConfirmation = false;
      updateSubmitState();
    }
  }

  function closeModal() {
    const overlay = document.getElementById("ciItemFacilitiesCopyOverlay");
    if (overlay) overlay.remove();
    modalContext = null;
  }

  function canOpenCopy(ship) {
    const itemCopy = itemApi();
    if (!itemCopy || !ship || !ship.id || !ship.cruise_line_id) return false;
    const hasItems = itemCopy.listSourceExclusiveAreas(ship.facilities && ship.facilities.exclusive_areas).length
      || itemCopy.listSourceSpecialtyFeatures(ship.facilities && ship.facilities.specialty_features).length;
    if (!hasItems) return false;
    const fleetTargets = itemCopy.listFleetCopyTargets(getShips(), ship);
    return fleetTargets.length > 0;
  }

  function openModal(options) {
    const itemCopy = itemApi();
    if (!itemCopy) return;
    closeModal();
    const sourceId = options && options.sourceShipId
      || document.getElementById("ciShipId") && document.getElementById("ciShipId").value
      || window.editingCiShipId;
    const sourceShip = (options && options.ships || getShips()).find(function (ship) { return ship.id === sourceId; });
    if (!sourceShip) return;

    modalContext = {
      sourceShipId: sourceId,
      sourceShip: sourceShip,
      shipClass: getDraftClass(),
      targetScope: getDraftClass() ? itemCopy.TARGET_SCOPE_SAME_CLASS : itemCopy.TARGET_SCOPE_FLEET,
      selectedEa: [],
      selectedSf: [],
      selectedTargets: [],
      conflictResolutions: [],
      search: "",
      classFilter: "all",
      awaitingConfirmation: false,
      copyComplete: false
    };

    const overlay = document.createElement("div");
    overlay.id = "ciItemFacilitiesCopyOverlay";
    overlay.className = "ci-facilities-copy-overlay ci-item-copy-overlay";
    overlay.innerHTML = `<div class="ci-facilities-copy-modal ci-item-copy-modal" role="dialog" aria-modal="true" aria-labelledby="ciItemCopyTitle">${renderModalBody()}</div>`;
    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) closeModal();
    });
    document.body.appendChild(overlay);
    bindModalEvents();
    updateSubmitState();
  }

  window.CiShipFacilitiesItemCopyAdmin = {
    open: openModal,
    close: closeModal,
    canOpenCopy: canOpenCopy
  };

  window.openCiSameClassFacilitiesCopyModal = function () {
    openModal();
  };
  window.closeCiSameClassFacilitiesCopyModal = closeModal;
})();
