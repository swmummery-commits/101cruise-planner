/**
 * Admin item-level ship facilities copy modal.
 */
(function () {
  "use strict";

  const STEP_SELECT = "select";
  const STEP_CONFLICTS = "conflicts";
  const STEP_CONFIRM = "confirm";
  const STEP_RESULT = "result";

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

  function normalizeFacilities(facilities) {
    if (!facilities) return {};
    if (typeof facilities === "string") {
      try {
        const parsed = JSON.parse(facilities);
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch (_error) {
        return {};
      }
    }
    return typeof facilities === "object" ? facilities : {};
  }

  function normalizeShipId(value) {
    return String(value == null ? "" : value).trim();
  }

  function getSourceShip() {
    const ctx = modalContext;
    if (!ctx) return null;
    const sourceId = normalizeShipId(ctx.sourceShipId);
    const fromList = getShips().find(function (ship) {
      return normalizeShipId(ship && ship.id) === sourceId;
    });
    const ship = fromList || ctx.sourceShip || null;
    if (!ship) return null;
    return {
      ...ship,
      facilities: normalizeFacilities(ship.facilities)
    };
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
    const lineId = getLineId(source);
    const draftSource = { ...source, cruise_line_id: lineId || source.cruise_line_id };
    return itemCopy.resolveCopyTargets(getShips(), draftSource, readTargetScope(), getDraftClass());
  }

  function visibleTargets() {
    const itemCopy = itemApi();
    const source = getSourceShip();
    if (!itemCopy || !source) return [];
    const all = eligibleTargets();
    const search = String(document.getElementById("ciItemCopyTargetSearch") && document.getElementById("ciItemCopyTargetSearch").value || modalContext && modalContext.search || "");
    const classFilter = String(document.getElementById("ciItemCopyClassFilter") && document.getElementById("ciItemCopyClassFilter").value || modalContext && modalContext.classFilter || "all");
    const filters = { search: search, classFilter: classFilter };
    if (readTargetScope() !== itemCopy.TARGET_SCOPE_FLEET && !search.trim()) return all;
    return itemCopy.filterFleetTargets(all, getLineId(source), filters);
  }

  function readSelectedSourceKeys() {
    if (modalContext && modalContext.step !== STEP_SELECT) {
      return { exclusive: modalContext.selectedEa || [], specialty: modalContext.selectedSf || [] };
    }
    return {
      exclusive: [...document.querySelectorAll(".ci-item-copy-source-ea:checked")].map(function (el) { return el.value; }),
      specialty: [...document.querySelectorAll(".ci-item-copy-source-sf:checked")].map(function (el) { return el.value; })
    };
  }

  function readSelectedTargetIds() {
    if (modalContext && modalContext.step !== STEP_SELECT) {
      return modalContext.selectedTargets || [];
    }
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
    if (modalContext && modalContext.step !== STEP_CONFLICTS && modalContext.step !== STEP_SELECT) {
      return modalContext.conflictResolutions || [];
    }
    const rows = [];
    document.querySelectorAll(".ci-item-copy-conflict-choice:checked").forEach(function (el) {
      rows.push({
        target_ship_id: el.getAttribute("data-target-id"),
        source_key: el.getAttribute("data-source-key"),
        action: el.value
      });
    });
    if (rows.length) return rows;
    return modalContext && modalContext.conflictResolutions ? modalContext.conflictResolutions : [];
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

  function persistFormState() {
    if (!modalContext) return;
    if (modalContext.step === STEP_SELECT) {
      modalContext.selectedEa = readSelectedSourceKeys().exclusive;
      modalContext.selectedSf = readSelectedSourceKeys().specialty;
      modalContext.selectedTargets = readSelectedTargetIds();
      modalContext.targetScope = readTargetScope();
      modalContext.search = String(document.getElementById("ciItemCopyTargetSearch") && document.getElementById("ciItemCopyTargetSearch").value || "");
      modalContext.classFilter = String(document.getElementById("ciItemCopyClassFilter") && document.getElementById("ciItemCopyClassFilter").value || "all");
    }
    if (modalContext.step === STEP_CONFLICTS) {
      modalContext.conflictResolutions = readConflictResolutions();
    }
  }

  function buildViewModel() {
    const itemCopy = itemApi();
    const source = getSourceShip();
    const line = getLines().find(function (row) { return row.id === getLineId(source); });
    if (!itemCopy || !source) return null;

    const exclusiveItems = sourceExclusiveItems();
    const specialtyItems = sourceSpecialtyItems();
    const keys = readSelectedSourceKeys();
    const selectedExclusive = exclusiveItems.filter(function (item) { return keys.exclusive.includes(item.source_key); });
    const selectedSpecialty = specialtyItems.filter(function (item) { return keys.specialty.includes(item.source_key); });
    const plans = buildPlans();
    const totals = itemCopy.summarizeAllPlans(plans);
    const conflictResolutions = readConflictResolutions();
    const step = modalContext.step;
    const confirmation = step === STEP_CONFIRM
      ? itemCopy.buildConfirmationSummary({
        sourceShipName: source.name,
        cruiseLineName: line && line.name,
        targetScope: modalContext.targetScope || readTargetScope(),
        exclusiveItems: selectedExclusive,
        specialtyItems: selectedSpecialty,
        plans: plans
      })
      : null;

    return {
      source,
      line,
      exclusiveItems,
      specialtyItems,
      selectedExclusive,
      selectedSpecialty,
      plans,
      plansById: Object.fromEntries(plans.map(function (plan) { return [plan.targetShipId, plan]; })),
      totals,
      confirmation,
      hasConflicts: itemCopy.planHasConflicts(plans),
      conflictsResolved: itemCopy.conflictsAreResolved(plans, conflictResolutions),
      sourceCount: keys.exclusive.length + keys.specialty.length,
      targetCount: readSelectedTargetIds().length,
      canContinue: itemCopy.canContinueToReview({
        selectedSourceCount: keys.exclusive.length + keys.specialty.length,
        selectedTargetCount: readSelectedTargetIds().length,
        plans: plans
      })
    };
  }

  function renderSourceExclusiveItem(item, checked) {
    const preview = item.legacy
      ? `<span class="ci-item-copy-legacy-tag">Legacy text</span>`
      : (item.description ? `<span class="ci-item-copy-desc-preview">${esc(item.description)}</span>` : "");
    return `
      <label class="ci-check-control ci-item-copy-source-item">
        <input type="checkbox" class="ci-item-copy-source-ea" value="${esc(item.source_key)}"${checked ? " checked" : ""}>
        <span class="ci-item-copy-source-item-body">
          <strong>${esc(item.name)}</strong>
          ${preview}
        </span>
      </label>`;
  }

  function renderSourceSpecialtyItem(item, checked) {
    return `
      <label class="ci-check-control ci-item-copy-source-item">
        <input type="checkbox" class="ci-item-copy-source-sf" value="${esc(item.source_key)}"${checked ? " checked" : ""}>
        <span class="ci-item-copy-source-item-body"><strong>${esc(item.value)}</strong></span>
      </label>`;
  }

  function renderTargetTableRows(ships, plansById, selectedIds) {
    const itemCopy = itemApi();
    const source = getSourceShip();
    return ships.map(function (ship) {
      const checked = selectedIds.has(ship.id) ? " checked" : "";
      const cls = ship.ship_class ? esc(ship.ship_class) : `<span class="ci-bulk-class-muted">Unassigned</span>`;
      const plan = plansById[ship.id];
      const status = plan ? esc(itemCopy.targetComparisonStatusLabel(plan.items)) : "—";
      const sourceMark = source && ship.id === source.id ? `<span class="ci-bulk-class-source">Current ship</span>` : "";
      return `
        <tr class="ci-item-copy-row" data-ship-id="${esc(ship.id)}">
          <td class="ci-item-copy-check"><label class="ci-check-control"><input type="checkbox" class="ci-item-copy-target" value="${esc(ship.id)}"${checked}></label></td>
          <td class="ci-item-copy-name">${esc(ship.name)}${sourceMark}</td>
          <td>${cls}</td>
          <td>${status}</td>
        </tr>
        <tr class="ci-item-copy-card" data-ship-id="${esc(ship.id)}">
          <td colspan="4">
            <label class="ci-check-control ci-item-copy-card-head">
              <input type="checkbox" class="ci-item-copy-target" value="${esc(ship.id)}"${checked}>
              <strong>${esc(ship.name)}</strong>${sourceMark}
            </label>
            <div class="ci-item-copy-card-meta">
              <span>${ship.ship_class ? esc(ship.ship_class) : "Unassigned"}</span>
              <span>${status}</span>
            </div>
          </td>
        </tr>`;
    }).join("");
  }

  function renderClassFilterOptions(selected) {
    const itemCopy = itemApi();
    const source = getSourceShip();
    if (!itemCopy || !source) return "";
    const options = itemCopy.listFleetClassFilterOptions(getShips(), getLineId(source));
    return [`<option value="all"${selected === "all" ? " selected" : ""}>All classes</option>`]
      .concat(options.map(function (cls) {
        return `<option value="${esc(cls)}"${selected === cls ? " selected" : ""}>${esc(cls)}</option>`;
      }))
      .join("");
  }

  function renderSelectBody(vm) {
    const itemCopy = itemApi();
    const ctx = modalContext;
    if (!itemCopy || !ctx) {
      return `<p class="admin-small ci-item-copy-result-fail">Copy module unavailable. Reload the page and try again.</p>`;
    }
    const scope = ctx.targetScope || itemCopy.TARGET_SCOPE_SAME_CLASS;
    const sameClassDisabled = !getDraftClass();
    const selectedEa = new Set(ctx.selectedEa || []);
    const selectedSf = new Set(ctx.selectedSf || []);
    const visible = visibleTargets();
    const fleetScope = scope === itemCopy.TARGET_SCOPE_FLEET;

    return `
      <p class="admin-small"><strong>Source ship:</strong> ${esc(vm.source.name)}</p>
      <p class="admin-small"><strong>Cruise line:</strong> ${esc(vm.line && vm.line.name || "—")}</p>

      <div class="ci-item-copy-global-toolbar ci-bulk-class-selection-tools">
        <button type="button" class="admin-button secondary small" data-action="select-all-items">Select all items</button>
        <button type="button" class="admin-button secondary small" data-action="clear-all-items">Clear all items</button>
      </div>

      <section class="ci-item-copy-section">
        <div class="ci-item-copy-section-head">
          <h5>Exclusive Areas</h5>
          <div class="ci-bulk-class-selection-tools">
            <button type="button" class="admin-button secondary small" data-action="select-ea-all">Select all</button>
            <button type="button" class="admin-button secondary small" data-action="clear-ea-all">Clear all</button>
          </div>
        </div>
        <div class="ci-item-copy-source-list">${vm.exclusiveItems.map(function (item) {
          return renderSourceExclusiveItem(item, selectedEa.has(item.source_key));
        }).join("") || `<p class="admin-small">No exclusive areas on this ship.</p>`}</div>
      </section>

      <section class="ci-item-copy-section">
        <div class="ci-item-copy-section-head">
          <h5>Specialty Features</h5>
          <div class="ci-bulk-class-selection-tools">
            <button type="button" class="admin-button secondary small" data-action="select-sf-all">Select all</button>
            <button type="button" class="admin-button secondary small" data-action="clear-sf-all">Clear all</button>
          </div>
        </div>
        <div class="ci-item-copy-source-list">${vm.specialtyItems.map(function (item) {
          return renderSourceSpecialtyItem(item, selectedSf.has(item.source_key));
        }).join("") || `<p class="admin-small">No specialty features on this ship.</p>`}</div>
      </section>

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
      </section>

      <section class="ci-item-copy-section">
        <div class="ci-item-copy-section-head">
          <h5>Target ships</h5>
          <div class="ci-bulk-class-selection-tools">
            <button type="button" class="admin-button secondary small" data-action="select-targets-visible">Select all visible</button>
            <button type="button" class="admin-button secondary small" data-action="clear-targets-all">Clear all</button>
          </div>
        </div>
        <div class="ci-bulk-class-toolbar ci-item-copy-target-filters">
          <input id="ciItemCopyTargetSearch" type="search" placeholder="Search ships…" value="${esc(ctx.search || "")}">
          ${fleetScope ? `<select id="ciItemCopyClassFilter">${renderClassFilterOptions(ctx.classFilter || "all")}</select>` : ""}
        </div>
        <div class="ci-bulk-class-table-wrap">
          <table class="ci-bulk-class-table ci-item-copy-table" aria-label="Target ships">
            <thead>
              <tr>
                <th scope="col">Select</th>
                <th scope="col">Ship</th>
                <th scope="col">Class</th>
                <th scope="col">Selected items</th>
              </tr>
            </thead>
            <tbody id="ciItemCopyTargetBody">${visible.length
              ? renderTargetTableRows(visible, vm.plansById, new Set(ctx.selectedTargets || []))
              : `<tr><td colspan="4"><p class="admin-small">No eligible target ships for the selected scope.</p></td></tr>`}</tbody>
          </table>
        </div>
      </section>`;
  }

  function renderConflictBlock(plan, row) {
    const sourceItem = row.sourceItem;
    const targetEntry = row.comparison.targetEntry || {};
    const keepChecked = row.plannedAction === "keep_existing" ? " checked" : "";
    const replaceChecked = row.plannedAction === "replace" ? " checked" : "";
    return `
      <div class="ci-item-copy-conflict-card">
        <p class="admin-small"><strong>${esc(plan.targetShipName)}</strong> · ${esc(sourceItem.name)}</p>
        <div class="ci-item-copy-conflict-grid">
          <div class="ci-item-copy-conflict-panel">
            <p class="admin-small">Source</p>
            <p>${esc(sourceItem.name)}</p>
            <p class="ci-item-copy-desc-preview">${esc(sourceItem.description || "—")}</p>
          </div>
          <div class="ci-item-copy-conflict-panel">
            <p class="admin-small">Target</p>
            <p>${esc(sourceItem.name)}</p>
            <p class="ci-item-copy-desc-preview">${esc(targetEntry.description || "—")}</p>
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

  function renderConflictsBody(vm) {
    const blocks = [];
    vm.plans.forEach(function (plan) {
      (plan.items || []).forEach(function (row) {
        if (row.comparison.status === "different") blocks.push(renderConflictBlock(plan, row));
      });
    });
    return `
      <p class="admin-small">Resolve description conflicts before continuing to the final review.</p>
      ${blocks.join("") || `<p class="admin-small">No conflicts require a decision.</p>`}`;
  }

  function renderConfirmList(title, items) {
    if (!items.length) return "";
    return `
      <p class="admin-small ci-item-copy-confirm-group-title">${esc(title)}</p>
      <ul class="ci-bulk-class-summary-list">${items.map(function (item) { return `<li>${esc(item)}</li>`; }).join("")}</ul>`;
  }

  function renderConfirmTargetCard(row) {
    return `
      <div class="ci-item-copy-confirm-card">
        <p class="admin-small"><strong>${esc(row.targetShipName)}</strong></p>
        ${renderConfirmList("Will add:", row.willAdd)}
        ${renderConfirmList("Will replace:", row.willReplace)}
        ${renderConfirmList("Already identical:", row.alreadyIdentical)}
        ${renderConfirmList("Keep target version:", row.keepTarget)}
      </div>`;
  }

  function renderConfirmBody(vm) {
    const itemCopy = itemApi();
    const c = vm.confirmation;
    if (!c) {
      return `<p class="admin-small ci-item-copy-result-fail">Could not build confirmation summary. Go back and try again.</p>`;
    }
    const aggregateLines = itemCopy ? itemCopy.formatAggregateTotalsLines(c.aggregates) : [];
    return `
      <div class="ci-item-copy-confirm-meta">
        <p class="admin-small"><strong>Source ship:</strong> ${esc(c.sourceShipName)}</p>
        <p class="admin-small"><strong>Cruise line:</strong> ${esc(c.cruiseLineName)}</p>
        <p class="admin-small"><strong>Scope:</strong> ${esc(c.targetScopeLabel)}</p>
      </div>
      ${renderConfirmList("Target ships", c.targetShipNames)}
      ${renderConfirmList("Exclusive Areas", c.exclusiveAreas)}
      ${renderConfirmList("Specialty Features", c.specialtyFeatures)}
      <div class="ci-item-copy-confirm-targets">${c.perTarget.map(renderConfirmTargetCard).join("")}</div>
      <div class="ci-item-copy-confirm-aggregates">
        <p class="admin-small"><strong>Aggregate totals</strong></p>
        <ul class="ci-bulk-class-summary-list">
          ${aggregateLines.map(function (line) { return `<li>${line}</li>`; }).join("")}
        </ul>
      </div>
      <p class="admin-small ci-item-copy-preserve-note">Unrelated target facilities will be preserved.</p>`;
  }

  function renderResultBody(vm) {
    const data = modalContext.lastResult || {};
    const itemCopy = itemApi();
    const source = getSourceShip();
    const plans = modalContext.lastPlans || vm.plans || [];
    const reconciled = itemCopy.reconcileResultRows({
      plans: plans,
      results: data.results || [],
      sourceFacilities: source && source.facilities
    });
    const cards = reconciled.map(function (row) {
      if (!row.ok) {
        return `<div class="ci-item-copy-result-card is-failed"><p class="admin-small"><strong>Failed — ${esc(row.name)}</strong></p><p class="ci-item-copy-result-fail">${esc(row.error || "Copy failed")}</p></div>`;
      }
      const result = row.result || { added: [], replaced: [], skipped_identical: [], kept_existing: [] };
      return `
        <div class="ci-item-copy-result-card">
          <p class="admin-small"><strong>${esc(row.name)}</strong></p>
          ${renderConfirmList("Added", result.added || [])}
          ${renderConfirmList("Replaced", result.replaced || [])}
          ${renderConfirmList("Already present", result.skipped_identical || [])}
          ${renderConfirmList("Kept existing", result.kept_existing || [])}
          ${renderConfirmList("Failed", result.failed || [])}
        </div>`;
    }).join("");
    return `<div class="ci-item-copy-result-wrap"><p class="admin-small"><strong>Copy complete</strong></p>${cards}</div>`;
  }

  function footerSummaryText(vm) {
    const itemCopy = itemApi();
    if (!itemCopy) return "";
    if (modalContext.step === STEP_CONFIRM) {
      if (!vm.confirmation || vm.confirmation.aggregates.noChanges) {
        return "All selected items are already identical or set to keep existing — no changes to copy.";
      }
      const totals = vm.confirmation.aggregates;
      return itemCopy.formatReadyToCopySummary(totals);
    }
    if (modalContext.step === STEP_CONFLICTS) {
      const summary = itemCopy.formatAggregateOperationSummary(vm.totals, vm.targetCount, { sourceCount: vm.sourceCount });
      return vm.hasConflicts
        ? `${summary.text}. Choose keep or replace for each conflicting exclusive area.`
        : summary.text;
    }
    return itemCopy.formatAggregateOperationSummary(vm.totals, vm.targetCount, { sourceCount: vm.sourceCount }).text;
  }

  function continueDisabledForStep(vm) {
    if (modalContext.step === STEP_SELECT) {
      return !vm.canContinue || vm.sourceCount <= 0 || vm.targetCount <= 0 || vm.totals.noChanges;
    }
    if (modalContext.step === STEP_CONFLICTS) {
      return !vm.conflictsResolved || vm.totals.noChanges;
    }
    return false;
  }

  function renderFooter(vm) {
    const step = modalContext.step;
    if (step === STEP_RESULT) {
      return `
        <div class="admin-actions-row ci-bulk-class-modal-actions ci-item-copy-footer" data-footer-step="result">
          <button type="button" class="admin-button small" data-action="close-result">Close</button>
        </div>`;
    }
    if (step === STEP_CONFIRM) {
      const itemCopy = itemApi();
      const noChanges = !vm.confirmation || vm.confirmation.aggregates.noChanges;
      const readyText = itemCopy && vm.confirmation
        ? itemCopy.formatReadyToCopySummary(vm.confirmation.aggregates)
        : "";
      return `
        <p class="admin-small" id="ciItemCopySummary">${noChanges
          ? "All selected items are already identical or set to keep existing — no changes to copy."
          : esc(readyText)}</p>
        <div class="admin-actions-row ci-bulk-class-modal-actions ci-item-copy-footer" data-footer-step="confirm">
          <button type="button" class="admin-button secondary small" data-action="back">Back</button>
          <button type="button" class="admin-button secondary small" data-action="cancel">Cancel</button>
          <button type="button" class="admin-button small" data-action="confirm-copy"${noChanges ? " disabled aria-disabled=\"true\"" : ""}>${noChanges ? "No changes to copy" : "Confirm copy"}</button>
        </div>`;
    }
    if (step === STEP_CONFLICTS) {
      const disabled = continueDisabledForStep(vm);
      return `
        <p class="admin-small" id="ciItemCopySummary">${esc(footerSummaryText(vm))}</p>
        <div class="admin-actions-row ci-bulk-class-modal-actions ci-item-copy-footer" data-footer-step="conflicts">
          <button type="button" class="admin-button secondary small" data-action="back">Back</button>
          <button type="button" class="admin-button secondary small" data-action="cancel">Cancel</button>
          <button type="button" class="admin-button small" data-action="continue-conflicts"${disabled ? " disabled aria-disabled=\"true\"" : ""}>Continue to review</button>
        </div>`;
    }
    const disabled = continueDisabledForStep(vm);
    return `
      <p class="admin-small" id="ciItemCopySummary">${esc(footerSummaryText(vm))}</p>
      <div class="admin-actions-row ci-bulk-class-modal-actions ci-item-copy-footer" data-footer-step="select">
        <button type="button" class="admin-button secondary small" data-action="cancel">Cancel</button>
        <button type="button" class="admin-button small" data-action="continue-select"${disabled ? " disabled aria-disabled=\"true\"" : ""}>Continue to review</button>
      </div>`;
  }

  function stepTitle(step) {
    if (step === STEP_CONFLICTS) return "Resolve exclusive area conflicts";
    if (step === STEP_CONFIRM) return "Review and confirm copy";
    if (step === STEP_RESULT) return "Copy complete";
    return "Copy ship facilities";
  }

  function renderModalFailure(message) {
    const overlay = document.getElementById("ciItemFacilitiesCopyOverlay");
    if (!overlay || !modalContext) return;
    overlay.innerHTML = `
      <div class="ci-bulk-class-modal ci-item-copy-modal" role="dialog" aria-modal="true" aria-labelledby="ciItemCopyTitle">
        <div class="ci-bulk-class-modal-head">
          <h4 id="ciItemCopyTitle">Copy ship facilities</h4>
          <button type="button" class="admin-button secondary small" data-action="header-close">Close</button>
        </div>
        <div class="ci-bulk-class-modal-body">
          <p class="admin-small ci-item-copy-result-fail">${esc(message || "Could not open copy dialog.")}</p>
        </div>
        <div class="ci-bulk-class-modal-footer">
          <div class="admin-actions-row ci-bulk-class-modal-actions ci-item-copy-footer" data-footer-step="select">
            <button type="button" class="admin-button small" data-action="header-close">Close</button>
          </div>
        </div>
      </div>`;
    bindModalEvents();
  }

  function renderModal() {
    if (!modalContext) return;
    const overlay = document.getElementById("ciItemFacilitiesCopyOverlay");
    if (!overlay) return;
    try {
      const vm = buildViewModel();
      if (!vm) {
        renderModalFailure("Could not load the current ship for copying. Close, reload the ship editor, and try again.");
        return;
      }
      const step = modalContext.step;
      let body = "";
      if (step === STEP_SELECT) body = renderSelectBody(vm);
      else if (step === STEP_CONFLICTS) body = renderConflictsBody(vm);
      else if (step === STEP_CONFIRM) body = renderConfirmBody(vm);
      else if (step === STEP_RESULT) body = renderResultBody(vm);

      overlay.innerHTML = `
        <div class="ci-bulk-class-modal ci-item-copy-modal" role="dialog" aria-modal="true" aria-labelledby="ciItemCopyTitle">
          <div class="ci-bulk-class-modal-head">
            <h4 id="ciItemCopyTitle">${esc(stepTitle(step))}</h4>
            <button type="button" class="admin-button secondary small" data-action="header-close">Close</button>
          </div>
          <div class="ci-bulk-class-modal-body">${body}</div>
          <div class="ci-bulk-class-modal-footer">${renderFooter(vm)}</div>
        </div>`;
      bindModalEvents();
    } catch (error) {
      console.error("CiShipFacilitiesItemCopyAdmin render failed", error);
      renderModalFailure(error && error.message ? error.message : "Copy dialog failed to open.");
    }
  }

  function refreshModalContent() {
    persistFormState();
    renderModal();
  }

  function goToStep(step) {
    if (!modalContext) return;
    persistFormState();
    modalContext.step = step;
    renderModal();
  }

  function bindCheckboxGroup(root, selector) {
    root.querySelectorAll(selector).forEach(function (el) {
      el.addEventListener("change", refreshModalContent);
    });
  }

  function bindModalEvents() {
    const overlay = document.getElementById("ciItemFacilitiesCopyOverlay");
    if (!overlay) return;

    overlay.querySelector("[data-action='header-close']")?.addEventListener("click", closeModal);
    overlay.querySelector("[data-action='cancel']")?.addEventListener("click", closeModal);
    overlay.querySelector("[data-action='close-result']")?.addEventListener("click", closeModal);
    overlay.querySelector("[data-action='back']")?.addEventListener("click", function () {
      if (!modalContext) return;
      if (modalContext.step === STEP_CONFIRM) {
        const vm = buildViewModel();
        goToStep(vm && vm.hasConflicts ? STEP_CONFLICTS : STEP_SELECT);
      } else if (modalContext.step === STEP_CONFLICTS) {
        goToStep(STEP_SELECT);
      }
    });
    overlay.querySelector("[data-action='continue-select']")?.addEventListener("click", function (event) {
      if (event.currentTarget.disabled) {
        event.preventDefault();
        return;
      }
      const vm = buildViewModel();
      if (!vm || !vm.canContinue || vm.sourceCount <= 0 || vm.targetCount <= 0 || vm.totals.noChanges) return;
      modalContext.hasConflictsOnPath = vm.hasConflicts;
      goToStep(vm.hasConflicts ? STEP_CONFLICTS : STEP_CONFIRM);
    });
    overlay.querySelector("[data-action='continue-conflicts']")?.addEventListener("click", function (event) {
      if (event.currentTarget.disabled) {
        event.preventDefault();
        return;
      }
      const vm = buildViewModel();
      if (!vm || !vm.conflictsResolved || vm.totals.noChanges) return;
      goToStep(STEP_CONFIRM);
    });
    overlay.querySelector("[data-action='confirm-copy']")?.addEventListener("click", onConfirmCopy);

    bindCheckboxGroup(overlay, ".ci-item-copy-source-ea, .ci-item-copy-source-sf, .ci-item-copy-target, .ci-item-copy-conflict-choice");
    overlay.querySelectorAll('input[name="ciItemCopyScope"]').forEach(function (el) {
      el.addEventListener("change", function () {
        modalContext.targetScope = readTargetScope();
        modalContext.selectedTargets = [];
        modalContext.conflictResolutions = [];
        refreshModalContent();
      });
    });
    overlay.querySelector("#ciItemCopyTargetSearch")?.addEventListener("input", refreshModalContent);
    overlay.querySelector("#ciItemCopyClassFilter")?.addEventListener("change", refreshModalContent);

    const actions = {
      "select-ea-all": function () { overlay.querySelectorAll(".ci-item-copy-source-ea").forEach(function (el) { el.checked = true; }); },
      "clear-ea-all": function () { overlay.querySelectorAll(".ci-item-copy-source-ea").forEach(function (el) { el.checked = false; }); },
      "select-sf-all": function () { overlay.querySelectorAll(".ci-item-copy-source-sf").forEach(function (el) { el.checked = true; }); },
      "clear-sf-all": function () { overlay.querySelectorAll(".ci-item-copy-source-sf").forEach(function (el) { el.checked = false; }); },
      "select-all-items": function () { overlay.querySelectorAll(".ci-item-copy-source-ea, .ci-item-copy-source-sf").forEach(function (el) { el.checked = true; }); },
      "clear-all-items": function () { overlay.querySelectorAll(".ci-item-copy-source-ea, .ci-item-copy-source-sf").forEach(function (el) { el.checked = false; }); },
      "select-targets-visible": function () { overlay.querySelectorAll(".ci-item-copy-target").forEach(function (el) { el.checked = true; }); },
      "clear-targets-all": function () { overlay.querySelectorAll(".ci-item-copy-target").forEach(function (el) { el.checked = false; }); }
    };
    Object.keys(actions).forEach(function (key) {
      overlay.querySelector(`[data-action='${key}']`)?.addEventListener("click", function () {
        actions[key]();
        refreshModalContent();
      });
    });
  }

  function applySuccessToLocalShips(data) {
    const results = Array.isArray(data.results) ? data.results : [];
    const ships = getShips();
    results.forEach(function (row) {
      if (!row.ok || !row.id || !row.facilities) return;
      const idx = ships.findIndex(function (ship) { return ship.id === row.id; });
      if (idx >= 0) ships[idx] = { ...ships[idx], facilities: row.facilities };
    });
    if (window.syncCiCatalogueWindowState) window.syncCiCatalogueWindowState();
    if (window.refreshCiShipMasterList) window.refreshCiShipMasterList();
  }

  async function onConfirmCopy() {
    const itemCopy = itemApi();
    const source = getSourceShip();
    const vm = buildViewModel();
    if (!itemCopy || !source || !vm || !vm.confirmation || vm.confirmation.aggregates.noChanges || !window.adminAuthHeaders) return;

    const payload = {
      source_ship_id: source.id,
      target_scope: modalContext.targetScope,
      target_ship_ids: readSelectedTargetIds(),
      selected_items: buildSelectedItemsPayload(),
      conflict_resolutions: readConflictResolutions()
    };
    modalContext.lastPlans = vm.plans.slice();
    const confirmBtn = document.querySelector("[data-action='confirm-copy']");
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = "Copying…";
    }
    try {
      const headers = await window.adminAuthHeaders();
      const response = await fetch("/.netlify/functions/ci-ship-facilities-copy", {
        method: "POST",
        headers: headers,
        body: JSON.stringify(payload)
      });
      const data = await response.json().catch(function () { return {}; });
      if (!response.ok || data.success === false) {
        if (window.setCiAutosaveStatus) window.setCiAutosaveStatus("Facilities copy failed", "error");
        modalContext.resultError = data.detail || data.error || "Copy failed.";
        goToStep(STEP_RESULT);
        return;
      }
      applySuccessToLocalShips(data);
      const reconciled = itemCopy.reconcileResultRows({
        plans: modalContext.lastPlans,
        results: data.results || [],
        sourceFacilities: source.facilities
      });
      itemCopy.assertResultOutcomesReconcile({
        plans: modalContext.lastPlans,
        results: reconciled,
        sourceFacilities: source.facilities
      });
      modalContext.lastResult = { ...data, results: reconciled };
      modalContext.resultError = null;
      if (window.setCiAutosaveStatus) window.setCiAutosaveStatus("Facilities copy complete", "saved");
      goToStep(STEP_RESULT);
    } catch (error) {
      modalContext.lastResult = { results: [{ ok: false, name: "Copy request", error: String(error.message || error) }] };
      goToStep(STEP_RESULT);
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
    return itemCopy.listFleetCopyTargets(getShips(), ship).length > 0;
  }

  function resolveOpenSourceShip(options) {
    const opts = options || {};
    const sourceId = normalizeShipId(
      opts.sourceShipId
      || (document.getElementById("ciShipId") && document.getElementById("ciShipId").value)
      || window.editingCiShipId
    );
    if (!sourceId) return null;
    const provided = opts.sourceShip && normalizeShipId(opts.sourceShip.id) === sourceId
      ? opts.sourceShip
      : null;
    const fromList = (Array.isArray(opts.ships) ? opts.ships : getShips()).find(function (ship) {
      return normalizeShipId(ship && ship.id) === sourceId;
    });
    const ship = provided || fromList || null;
    if (!ship) return null;
    return {
      ...ship,
      id: ship.id,
      facilities: normalizeFacilities(ship.facilities)
    };
  }

  function openModal(options) {
    const itemCopy = itemApi();
    if (!itemCopy) return;
    closeModal();
    const sourceShip = resolveOpenSourceShip(options);
    if (!sourceShip) {
      if (window.setCiAutosaveStatus) {
        window.setCiAutosaveStatus("Could not open facilities copy for this ship.", "error");
      }
      return;
    }

    modalContext = {
      sourceShipId: normalizeShipId(sourceShip.id),
      sourceShip: sourceShip,
      shipClass: getDraftClass(),
      targetScope: getDraftClass() ? itemCopy.TARGET_SCOPE_SAME_CLASS : itemCopy.TARGET_SCOPE_FLEET,
      step: STEP_SELECT,
      selectedEa: [],
      selectedSf: [],
      selectedTargets: [],
      conflictResolutions: [],
      search: "",
      classFilter: "all",
      hasConflictsOnPath: false,
      lastResult: null,
      lastPlans: [],
      resultError: null
    };

    const overlay = document.createElement("div");
    overlay.id = "ciItemFacilitiesCopyOverlay";
    overlay.className = "ci-bulk-class-overlay ci-item-copy-overlay";
    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) closeModal();
    });
    document.body.appendChild(overlay);
    renderModal();
  }

  window.CiShipFacilitiesItemCopyAdmin = {
    open: openModal,
    close: closeModal,
    canOpenCopy: canOpenCopy,
    STEP_SELECT: STEP_SELECT,
    STEP_CONFLICTS: STEP_CONFLICTS,
    STEP_CONFIRM: STEP_CONFIRM,
    STEP_RESULT: STEP_RESULT
  };

  window.openCiSameClassFacilitiesCopyModal = function () {
    openModal();
  };
  window.closeCiSameClassFacilitiesCopyModal = closeModal;
})();
