/**
 * Admin class facilities template modal — cruise line scope.
 * All template load/save/apply goes through authenticated Netlify functions.
 */
(function () {
  "use strict";

  const STEP_EDIT = "edit";
  const STEP_CONFIRM = "confirm";
  const STEP_RESULT = "result";

  let modalContext = null;

  function tplApi() {
    return window.CiShipClassFacilitiesTemplate || null;
  }

  function facApi() {
    return window.CiShipFacilities || null;
  }

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function trim(value) {
    return String(value == null ? "" : value).trim();
  }

  function getShips() {
    return window.ciCruiseShips || [];
  }

  function getLines() {
    return window.ciCruiseLines || [];
  }

  function getTemplates() {
    return window.ciShipClassFacilityTemplates || [];
  }

  function featureAdminApi() {
    return window.CiShipFeatureAdmin || null;
  }

  function featuresSvc() {
    return window.CruiseLineFeaturesService || null;
  }

  function getLineCatalogue() {
    return window.ciCruiseLineFeatures || [];
  }

  function usesCatalogueMode() {
    const catalogue = getLineCatalogue();
    return Boolean(featuresSvc() && catalogue.length);
  }

  function readSelectedFeatureIds() {
    const overlay = document.getElementById("ciClassFacilitiesTemplateOverlay");
    if (!overlay) return modalContext?.selectedFeatureIds || [];
    return [...overlay.querySelectorAll(".ci-class-tpl-feature-cb:checked")]
      .map(function (el) { return String(el.value || "").trim(); })
      .filter(Boolean);
  }

  function deriveSelectionFromPayload(payload) {
    const svc = featuresSvc();
    const catalogue = getLineCatalogue();
    if (!svc || !catalogue.length) return [];
    return svc.deriveSelectedIdsFromTemplate(catalogue, payload);
  }

  function mergeSelectionWithImportedRows(eaRows, sfRows) {
    const svc = featuresSvc();
    const catalogue = getLineCatalogue();
    if (!svc || !catalogue.length) return readSelectedFeatureIds();
    const names = new Set();
    (eaRows || []).forEach(function (row) {
      const key = svc.normalizeName(row?.name);
      if (key) names.add(`exclusive_area:${key}`);
    });
    (sfRows || []).forEach(function (row) {
      const key = svc.normalizeName(row?.name || row?.label);
      if (key) names.add(`specialty_feature:${key}`);
    });
    const selected = new Set(readSelectedFeatureIds());
    catalogue.forEach(function (row) {
      const key = `${row.feature_type}:${svc.normalizeName(row.name)}`;
      if (names.has(key)) selected.add(String(row.id));
    });
    return [...selected];
  }

  function bindClassTplFeatureList(root, rebuildFn) {
    const admin = featureAdminApi();
    if (!admin || !root) return;
    admin.bindFeatureList(root, {
      onShowDescription(index) {
        const rows = admin.readFeatureRowsFromRoot(root);
        if (!rows[index]) return;
        rows[index].showDescription = true;
        rebuildFn(rows);
      },
      onRemove(index) {
        const rows = admin.readFeatureRowsFromRoot(root);
        rows.splice(index, 1);
        rebuildFn(rows);
      },
      onMove(index, delta) {
        const rows = admin.readFeatureRowsFromRoot(root);
        const next = index + delta;
        if (next < 0 || next >= rows.length) return;
        const copy = rows.slice();
        const [item] = copy.splice(index, 1);
        copy.splice(next, 0, item);
        rebuildFn(copy);
      }
    });
  }

  function readExclusiveRows() {
    const admin = featureAdminApi();
    const root = document.getElementById("ciClassTplExclusiveList");
    return admin ? admin.readFeatureRowsFromRoot(root) : [];
  }

  function readSpecialtyRows() {
    const admin = featureAdminApi();
    const root = document.getElementById("ciClassTplSpecialtyList");
    return admin ? admin.readFeatureRowsFromRoot(root) : [];
  }

  function serializeTemplatePayload() {
    const svc = featuresSvc();
    const catalogue = getLineCatalogue();
    if (svc && catalogue.length) {
      return svc.buildTemplatePayloadFromCatalogue(catalogue, readSelectedFeatureIds());
    }
    const fac = facApi();
    if (!fac) return { exclusive_areas: [], specialty_features: [] };
    return {
      exclusive_areas: fac.serializeExclusiveAreasFromAdmin(readExclusiveRows()),
      specialty_features: fac.serializeSpecialtyFeaturesFromAdmin(readSpecialtyRows())
    };
  }

  function rebuildExclusiveDom(rows) {
    const admin = featureAdminApi();
    const root = document.getElementById("ciClassTplExclusiveList");
    if (!admin || !root) return;
    const list = rows.length ? rows : [{
      name: "",
      description: "",
      icon_key: window.CiShipFeatureIcons?.FALLBACK_KEY || "sparkles",
      showDescription: false,
      needsDescription: false
    }];
    admin.rebuildFeatureList(root, list, {
      prefix: "ciClassTplEa",
      cardClass: "ci-ship-feature-card ci-class-tpl-ea-card",
      sectionLabel: "Exclusive area"
    });
    bindClassTplFeatureList(root, rebuildExclusiveDom);
  }

  function rebuildSpecialtyDom(rows) {
    const admin = featureAdminApi();
    const root = document.getElementById("ciClassTplSpecialtyList");
    if (!admin || !root) return;
    const list = rows.length ? rows : [{
      name: "",
      description: "",
      icon_key: window.CiShipFeatureIcons?.FALLBACK_KEY || "sparkles",
      showDescription: false,
      needsDescription: false
    }];
    admin.rebuildFeatureList(root, list, {
      prefix: "ciClassTplSf",
      cardClass: "ci-ship-feature-card ci-class-tpl-sf-card",
      sectionLabel: "Specialty feature"
    });
    bindClassTplFeatureList(root, rebuildSpecialtyDom);
  }

  function loadEditorFromPayload(payload) {
    if (usesCatalogueMode()) {
      modalContext.selectedFeatureIds = deriveSelectionFromPayload(payload);
      modalContext.orphanItems = featuresSvc().orphanTemplateItems(getLineCatalogue(), payload);
      return;
    }
    const fac = facApi();
    if (!fac) return;
    rebuildExclusiveDom(fac.loadExclusiveAreasForAdmin(payload && payload.exclusive_areas));
    rebuildSpecialtyDom(fac.loadSpecialtyFeaturesForAdmin(payload && payload.specialty_features));
  }

  function renderCatalogueSection(featureType, title, selectedIds) {
    const svc = featuresSvc();
    const iconApi = window.CiShipFeatureIcons;
    const items = svc
      ? svc.listActiveFeaturesFromRows(svc.filterByType(getLineCatalogue(), featureType))
      : [];
    const selected = new Set((selectedIds || []).map(String));
    if (!items.length) {
      return `
        <section class="ci-item-copy-section">
          <div class="ci-item-copy-section-head"><h5>${esc(title)}</h5></div>
          <p class="admin-small">No ${title.toLowerCase()} in this line's catalogue yet. Add them on the cruise line page under <strong>Ship features catalogue</strong>.</p>
        </section>`;
    }
    const checks = items.map(function (row) {
      const svg = iconApi ? iconApi.renderIconSvg(row.icon_key, "ci-class-tpl-feature-icon") : "";
      return `
        <label class="ci-check-control ci-class-tpl-feature-item">
          <input type="checkbox" class="ci-class-tpl-feature-cb" value="${esc(row.id)}" data-feature-type="${esc(featureType)}" ${selected.has(String(row.id)) ? "checked" : ""}>
          <span class="ci-class-tpl-feature-item-body">
            ${svg}
            <span><strong>${esc(row.name)}</strong>${row.description ? `<span class="ci-item-copy-desc-preview">${esc(row.description)}</span>` : ""}</span>
          </span>
        </label>`;
    }).join("");
    return `
      <section class="ci-item-copy-section">
        <div class="ci-item-copy-section-head"><h5>${esc(title)}</h5></div>
        <div class="ci-class-tpl-feature-list">${checks}</div>
      </section>`;
  }

  function renderOrphanWarning() {
    const orphans = modalContext?.orphanItems || [];
    if (!orphans.length) return "";
    const labels = orphans.map(function (item) { return item.name; }).join(", ");
    return `<p class="admin-small ci-class-tpl-warning">Saved template includes ${orphans.length} item${orphans.length === 1 ? "" : "s"} not in this line's catalogue (${esc(labels)}). Add them to the catalogue or they will drop off when you save.</p>`;
  }

  function currentTemplateRecord() {
    const api = tplApi();
    if (!api || !modalContext) return null;
    const key = api.normalizeClassKey(modalContext.className);
    return getTemplates().find(function (row) {
      return row.cruise_line_id === modalContext.cruiseLineId && api.templateClassKey(row) === key;
    }) || null;
  }

  function savedTemplatePayload() {
    const api = tplApi();
    return api ? api.templatePayloadFromRecord(currentTemplateRecord()) : { exclusive_areas: [], specialty_features: [] };
  }

  function buildViewModel() {
    const api = tplApi();
    if (!api || !modalContext) return null;
    const payload = serializeTemplatePayload();
    const saved = currentTemplateRecord();
    const savedPayload = api.templatePayloadFromRecord(saved);
    const applyPreview = api.buildApplyPreview({
      ships: getShips(),
      cruiseLineId: modalContext.cruiseLineId,
      className: modalContext.className,
      template: savedPayload
    });
    const classShips = api.listShipsInClass(getShips(), modalContext.cruiseLineId, modalContext.className, { activeOnly: false });
    const hasUnsavedDraft = api.draftDiffersFromSaved(payload, saved);
    return {
      line: getLines().find(function (row) { return row.id === modalContext.cruiseLineId; }),
      className: modalContext.className,
      classShips: classShips,
      payload: payload,
      savedPayload: savedPayload,
      hasSavedTemplate: Boolean(saved),
      hasUnsavedDraft: hasUnsavedDraft,
      applyPreview: applyPreview,
      savedTemplate: saved
    };
  }

  function formatTemplateList(items, emptyLabel) {
    if (!Array.isArray(items) || !items.length) return emptyLabel;
    return items.map(function (item) {
      if (item && typeof item === "object") {
        const name = trim(item.name || item.label || "");
        const description = trim(item.description || "");
        return description ? `${name} — ${description}` : name;
      }
      return trim(item);
    }).join(", ");
  }

  function renderClassImportPanel(sourceClassName) {
    const api = tplApi();
    const fac = facApi();
    if (!api || !fac || !modalContext || !trim(sourceClassName)) {
      return `<p class="admin-small">Choose another class to preview items you can copy into this template.</p>`;
    }
    const resolved = api.resolveClassTemplatePayload({
      templates: getTemplates(),
      ships: getShips(),
      cruiseLineId: modalContext.cruiseLineId,
      className: sourceClassName
    });
    const eaRows = fac.loadExclusiveAreasForAdmin(resolved.payload.exclusive_areas);
    const sfRows = fac.loadSpecialtyFeaturesForAdmin(resolved.payload.specialty_features);
    if (!eaRows.length && !sfRows.length) {
      return `<p class="admin-small">No Exclusive Areas or Specialty Features found for <strong>${esc(sourceClassName)}</strong>.</p>`;
    }
    const sourceNote = resolved.source === "saved"
      ? `Using saved template for ${esc(sourceClassName)}.`
      : resolved.source === "ship"
        ? `Using live facilities from ${esc(resolved.shipName)} (no saved template for ${esc(sourceClassName)} yet).`
        : "";
    const eaItems = eaRows.map(function (row, index) {
      return `
        <label class="ci-check-control ci-item-copy-source-item">
          <input type="checkbox" class="ci-class-tpl-import-ea" value="${index}" checked>
          <span class="ci-item-copy-source-item-body"><strong>${esc(row.name)}</strong>${row.description ? `<span class="ci-item-copy-desc-preview">${esc(row.description)}</span>` : ""}</span>
        </label>`;
    }).join("");
    const sfItems = sfRows.map(function (row, index) {
      return `
        <label class="ci-check-control ci-item-copy-source-item">
          <input type="checkbox" class="ci-class-tpl-import-sf" value="${index}" checked>
          <span class="ci-item-copy-source-item-body"><strong>${esc(row.name || row.label)}</strong>${row.description ? `<span class="ci-item-copy-desc-preview">${esc(row.description)}</span>` : ""}</span>
        </label>`;
    }).join("");
    modalContext.classImportSource = {
      className: sourceClassName,
      eaRows: eaRows,
      sfRows: sfRows
    };
    return `
      ${sourceNote ? `<p class="admin-small">${sourceNote}</p>` : ""}
      ${eaRows.length ? `
        <p class="admin-small"><strong>Exclusive Areas</strong></p>
        <div class="ci-item-copy-source-list">${eaItems}</div>` : ""}
      ${sfRows.length ? `
        <p class="admin-small"><strong>Specialty Features</strong></p>
        <div class="ci-item-copy-source-list">${sfItems}</div>` : ""}
      <div class="admin-actions-row">
        <button type="button" class="admin-button secondary small" data-action="import-class-selected">Import selected</button>
      </div>`;
  }

  function renderEditBody(vm) {
    const api = tplApi();
    const importOptions = vm.classShips.map(function (ship) {
      return `<option value="${esc(ship.id)}">${esc(ship.name)}</option>`;
    }).join("");
    const otherClasses = api
      ? api.listDistinctClassesForLine(getShips(), modalContext.cruiseLineId).filter(function (name) {
        return !api.shipClassesMatch(name, vm.className);
      })
      : [];
    const classImportOptions = otherClasses.map(function (className) {
      return `<option value="${esc(className)}">${esc(className)}</option>`;
    }).join("");
    const selectedImportClass = modalContext.classImportClass || "";
    const catalogueMode = usesCatalogueMode();
    const selectedIds = modalContext.selectedFeatureIds || deriveSelectionFromPayload(savedTemplatePayload());
    return `
      <div class="ci-class-tpl-meta">
        <p class="admin-small"><strong>Cruise line:</strong> ${esc(vm.line && vm.line.name || "—")}</p>
        <p class="admin-small"><strong>Class:</strong> ${esc(vm.className)}</p>
        <p class="admin-small"><strong>Ships in class:</strong> ${vm.classShips.length} (${vm.applyPreview.targets.length} active for apply)</p>
        ${catalogueMode ? `<p class="admin-small">Tick the features that belong on every ship in this class. Names, descriptions, and icons come from the line catalogue.</p>` : ""}
        ${vm.hasUnsavedDraft ? `<p class="admin-small ci-class-tpl-warning">You have unsaved changes. Save the template before applying.</p>` : ""}
        ${catalogueMode ? renderOrphanWarning() : ""}
      </div>
      <div class="ci-class-tpl-import admin-actions-row">
        <label class="admin-small">Import from ship
          <select id="ciClassTplImportShip">
            <option value="">Choose a ship…</option>
            ${importOptions}
          </select>
        </label>
        <button type="button" class="admin-button secondary small" data-action="import-ship">Import EA + SF</button>
      </div>
      <div class="ci-class-tpl-import-class ci-class-tpl-import-row">
        <label class="admin-small">Import from class
          <select id="ciClassTplImportClass">
            <option value="">Choose a class…</option>
            ${classImportOptions}
          </select>
        </label>
        <div id="ciClassTplImportClassPanel" class="ci-class-tpl-import-class-panel">${selectedImportClass ? renderClassImportPanel(selectedImportClass) : `<p class="admin-small">Copy selected items from another class template into this editor.</p>`}</div>
      </div>
      ${catalogueMode ? `
        ${renderCatalogueSection("exclusive_area", "Exclusive Areas", selectedIds)}
        ${renderCatalogueSection("specialty_feature", "Specialty Features", selectedIds)}
      ` : `
      <section class="ci-item-copy-section">
        <div class="ci-item-copy-section-head">
          <h5>Exclusive Areas</h5>
        </div>
        <div id="ciClassTplExclusiveList"></div>
        <div class="ci-item-copy-section-foot">
          <button type="button" class="admin-button secondary small" data-action="ea-add">Add area</button>
        </div>
      </section>
      <section class="ci-item-copy-section">
        <div class="ci-item-copy-section-head">
          <h5>Specialty Features</h5>
        </div>
        <div id="ciClassTplSpecialtyList"></div>
        <div class="ci-item-copy-section-foot">
          <button type="button" class="admin-button secondary small" data-action="sf-add">Add feature</button>
        </div>
      </section>`}
      <p class="admin-small ci-item-copy-preserve-note">Applying replaces the complete Exclusive Areas and Specialty Features sections on each active ship in this class. Scalar facilities (pools, spa, etc.) are never changed. Import only prefills the editor — it does not save or apply. Import from class adds selected items without removing what is already selected.</p>`;
  }

  function renderConfirmBody(vm) {
    const agg = vm.applyPreview.preview.aggregate;
    const savedPayload = vm.savedPayload;
    const eaLabel = formatTemplateList(savedPayload.exclusive_areas, "None — will clear existing Exclusive Areas on affected ships");
    const sfLabel = formatTemplateList(savedPayload.specialty_features, "None — will clear existing Specialty Features on affected ships");
    const shipLines = vm.applyPreview.preview.rows.map(function (row) {
      const status = row.status === "matching" ? "Already matching" : "Will change";
      const extras = [];
      if (row.willClearEa) extras.push("clears EA");
      if (row.willClearSf) extras.push("clears SF");
      const detail = extras.length ? `${status} (${extras.join(", ")})` : status;
      return `<li><strong>${esc(row.shipName)}</strong> — ${esc(detail)}</li>`;
    }).join("");
    const clearWarnings = [];
    if (!savedPayload.exclusive_areas.length && vm.applyPreview.preview.rows.some(function (row) { return row.willClearEa; })) {
      clearWarnings.push("The saved template has no Exclusive Areas. Applying will clear existing Exclusive Areas on ships that currently have them.");
    }
    if (!savedPayload.specialty_features.length && vm.applyPreview.preview.rows.some(function (row) { return row.willClearSf; })) {
      clearWarnings.push("The saved template has no Specialty Features. Applying will clear existing Specialty Features on ships that currently have them.");
    }
    return `
      <p class="admin-small">Apply the saved class template to <strong>${esc(vm.className)}</strong> on <strong>${esc(vm.line && vm.line.name || "—")}</strong>.</p>
      <ul class="ci-bulk-class-summary-list">
        <li><strong>Template Exclusive Areas:</strong> ${esc(eaLabel)}</li>
        <li><strong>Template Specialty Features:</strong> ${esc(sfLabel)}</li>
        <li>${agg.ships} active ship${agg.ships === 1 ? "" : "s"}</li>
        <li>${agg.willChangeCount} will change</li>
        <li>${agg.matchingCount} already matching</li>
      </ul>
      ${clearWarnings.map(function (text) {
        return `<p class="admin-small ci-class-tpl-warning">${esc(text)}</p>`;
      }).join("")}
      <p class="admin-small"><strong>Target ships</strong></p>
      <ul class="ci-bulk-class-summary-list">${shipLines || "<li>No active ships in this class.</li>"}</ul>
      <p class="admin-small ci-class-tpl-warning">Individual ship customisations in these sections will be replaced.</p>
      <label class="ci-class-tpl-ack">
        <input type="checkbox" id="ciClassTplApplyAck">
        I understand this will replace the current Exclusive Areas and Specialty Features on the affected ships.
      </label>`;
  }

  function renderResultBody() {
    const result = modalContext.lastResult || {};
    if (result.error) {
      return `<p class="admin-small ci-item-copy-result-fail">${esc(result.error)}</p>`;
    }
    const updated = (result.updated || []).map(function (row) {
      return `<li><strong>${esc(row.name)}</strong> — updated</li>`;
    }).join("");
    const unchanged = (result.unchanged || []).map(function (row) {
      return `<li><strong>${esc(row.name)}</strong> — already matching</li>`;
    }).join("");
    const failedRows = Array.isArray(result.failed) ? result.failed : [];
    const failed = failedRows.map(function (row) {
      return `<li class="ci-item-copy-result-fail"><strong>${esc(row.name)}</strong> — ${esc(row.error || "Failed")}</li>`;
    }).join("");
    return `
      <div class="ci-item-copy-result-wrap">
        <p class="admin-small"><strong>Apply complete</strong></p>
        ${updated ? `<p class="admin-small">Updated ships</p><ul class="ci-bulk-class-summary-list">${updated}</ul>` : ""}
        ${unchanged ? `<p class="admin-small">Already matching</p><ul class="ci-bulk-class-summary-list">${unchanged}</ul>` : ""}
        ${failedRows.length ? `<p class="admin-small">Failed ships</p><ul class="ci-bulk-class-summary-list">${failed}</ul>` : ""}
      </div>`;
  }

  function renderFooter(vm) {
    const step = modalContext.step;
    if (step === STEP_RESULT) {
      return `<div class="admin-actions-row ci-bulk-class-modal-actions ci-item-copy-footer"><button type="button" class="admin-button small" data-action="close-result">Close</button></div>`;
    }
    if (step === STEP_CONFIRM) {
      const noTargets = !vm.applyPreview.targets.length;
      const noChanges = !vm.applyPreview.preview.aggregate.hasChanges;
      const needsSave = !vm.hasSavedTemplate || vm.hasUnsavedDraft;
      return `
        <p class="admin-small">${noTargets ? "No active ships in this class." : noChanges ? "All active ships already match the saved template." : needsSave ? "Save the template before applying." : "Confirm to replace EA and SF on active ships in this class."}</p>
        <div class="admin-actions-row ci-bulk-class-modal-actions ci-item-copy-footer">
          <button type="button" class="admin-button secondary small" data-action="back">Back</button>
          <button type="button" class="admin-button secondary small" data-action="cancel">Cancel</button>
          <button type="button" class="admin-button small" data-action="confirm-apply"${noTargets || noChanges || needsSave ? " disabled aria-disabled=\"true\"" : " disabled"}>Apply to class ships</button>
        </div>`;
    }
    return `
      <p class="admin-small">Save the template without changing ships, or apply the saved template as a separate action.</p>
      <div class="admin-actions-row ci-bulk-class-modal-actions ci-item-copy-footer">
        <button type="button" class="admin-button secondary small" data-action="cancel">Cancel</button>
        <button type="button" class="admin-button secondary small" data-action="save-template">Save template</button>
        <button type="button" class="admin-button small" data-action="continue-apply"${vm.hasSavedTemplate && !vm.hasUnsavedDraft && vm.applyPreview.targets.length ? "" : " disabled aria-disabled=\"true\""}>Apply saved template…</button>
      </div>`;
  }

  function stepTitle(step) {
    if (step === STEP_CONFIRM) return "Apply class template";
    if (step === STEP_RESULT) return "Apply complete";
    return "Class facilities template";
  }

  function renderModal() {
    if (!modalContext) return;
    const overlay = document.getElementById("ciClassFacilitiesTemplateOverlay");
    if (!overlay) return;
    try {
      const vm = buildViewModel();
      if (!vm) return;
      modalContext.draftPayload = vm.payload;
      const step = modalContext.step;
      let body = "";
      if (step === STEP_EDIT) body = renderEditBody(vm);
      else if (step === STEP_CONFIRM) body = renderConfirmBody(vm);
      else if (step === STEP_RESULT) body = renderResultBody();

      overlay.innerHTML = `
        <div class="ci-bulk-class-modal ci-item-copy-modal ci-class-tpl-modal" role="dialog" aria-modal="true">
          <div class="ci-bulk-class-modal-head">
            <h4>${esc(stepTitle(step))} — ${esc(modalContext.className)}</h4>
            <button type="button" class="admin-button secondary small" data-action="header-close">Close</button>
          </div>
          <div class="ci-bulk-class-modal-body">${body}</div>
          <div class="ci-bulk-class-modal-footer">${renderFooter(vm)}</div>
        </div>`;

      if (step === STEP_EDIT) {
        if (usesCatalogueMode()) {
          if (!modalContext.editorLoaded) {
            loadEditorFromPayload(savedTemplatePayload());
            modalContext.editorLoaded = true;
          }
        } else if (modalContext.editorLoaded) {
          loadEditorFromPayload(modalContext.draftPayload);
        } else {
          loadEditorFromPayload(savedTemplatePayload());
          modalContext.editorLoaded = true;
        }
        const classSelect = document.getElementById("ciClassTplImportClass");
        if (classSelect && modalContext.classImportClass) {
          classSelect.value = modalContext.classImportClass;
        }
      }
      bindModalEvents();
    } catch (error) {
      console.error("CiShipClassFacilitiesTemplateAdmin render failed", error);
      overlay.innerHTML = `
        <div class="ci-bulk-class-modal ci-item-copy-modal"><div class="ci-bulk-class-modal-body"><p class="ci-item-copy-result-fail">${esc(error.message || error)}</p></div>
        <div class="ci-bulk-class-modal-footer"><button type="button" class="admin-button small" data-action="header-close">Close</button></div></div>`;
      bindModalEvents();
    }
  }

  function persistEditorDraft() {
    if (usesCatalogueMode()) {
      modalContext.selectedFeatureIds = readSelectedFeatureIds();
    }
    modalContext.draftPayload = serializeTemplatePayload();
  }

  function goToStep(step) {
    if (!modalContext) return;
    if (step !== STEP_EDIT) persistEditorDraft();
    modalContext.step = step;
    renderModal();
  }

  function closeModal() {
    const overlay = document.getElementById("ciClassFacilitiesTemplateOverlay");
    if (overlay) overlay.remove();
    modalContext = null;
    if (window.refreshCiLineShipClassesSection) window.refreshCiLineShipClassesSection();
  }

  function withSavingOverlay(fn, supportMessage) {
    if (window.AdminLoading?.withSaving) {
      return window.AdminLoading.withSaving(fn, {
        key: "ci-class-template",
        supportMessage: supportMessage || ""
      });
    }
    return fn();
  }

  async function saveTemplate() {
    const api = tplApi();
    if (!api || !modalContext || !window.adminAuthHeaders) return;
    persistEditorDraft();
    return withSavingOverlay(async function () {
      try {
        const headers = await window.adminAuthHeaders({ "Content-Type": "application/json" });
        const response = await fetch("/.netlify/functions/ci-ship-class-facilities-save", {
          method: "POST",
          headers: headers,
          body: JSON.stringify({
            cruise_line_id: modalContext.cruiseLineId,
            class_name: modalContext.className,
            exclusive_areas: modalContext.draftPayload.exclusive_areas,
            specialty_features: modalContext.draftPayload.specialty_features
          })
        });
        const data = await response.json().catch(function () { return {}; });
        if (!response.ok || data.success === false) {
          if (window.setCiAutosaveStatus) window.setCiAutosaveStatus(data.detail || data.error || "Template save failed", "error");
          return;
        }
        upsertTemplateLocal(data.template);
        if (window.setCiAutosaveStatus) window.setCiAutosaveStatus("Class template saved", "saved");
        renderModal();
      } catch (error) {
        if (window.setCiAutosaveStatus) window.setCiAutosaveStatus(String(error.message || error), "error");
      }
    }, "Saving class template…");
  }

  function upsertTemplateLocal(row) {
    if (!row || !row.id) return;
    if (window.mergeCiShipClassFacilityTemplate) {
      window.mergeCiShipClassFacilityTemplate(row);
      return;
    }
    const api = tplApi();
    const key = api ? api.templateClassKey(row) : row.class_key;
    const list = getTemplates().filter(function (item) {
      return !(item.cruise_line_id === row.cruise_line_id && api.templateClassKey(item) === key);
    });
    list.push(row);
    window.ciShipClassFacilityTemplates = list;
  }

  async function applyTemplate() {
    if (!modalContext || !window.adminAuthHeaders) return;
    const ack = document.getElementById("ciClassTplApplyAck");
    if (!ack || !ack.checked) return;
    return withSavingOverlay(async function () {
      const btn = document.querySelector("[data-action='confirm-apply']");
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Applying…";
      }
      try {
        const headers = await window.adminAuthHeaders({ "Content-Type": "application/json" });
        const response = await fetch("/.netlify/functions/ci-ship-class-facilities-apply", {
          method: "POST",
          headers: headers,
          body: JSON.stringify({
            cruise_line_id: modalContext.cruiseLineId,
            class_name: modalContext.className
          })
        });
        const data = await response.json().catch(function () { return {}; });
        if (!response.ok || data.success === false) {
          modalContext.lastResult = { error: data.detail || data.error || "Apply failed." };
          goToStep(STEP_RESULT);
          return;
        }
        applyShipUpdatesLocal(data.updated || []);
        modalContext.lastResult = data;
        if (window.setCiAutosaveStatus) window.setCiAutosaveStatus("Class template applied", "saved");
        goToStep(STEP_RESULT);
      } catch (error) {
        modalContext.lastResult = { error: String(error.message || error) };
        goToStep(STEP_RESULT);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = "Apply to ships";
        }
      }
    }, "Applying class template to ships…");
  }

  function applyShipUpdatesLocal(updatedRows) {
    updatedRows.forEach(function (row) {
      if (!row.id || !row.facilities) return;
      const idx = getShips().findIndex(function (ship) { return ship.id === row.id; });
      if (idx >= 0) {
        window.ciCruiseShips[idx] = { ...window.ciCruiseShips[idx], facilities: row.facilities };
      }
    });
    if (window.syncCiCatalogueWindowState) window.syncCiCatalogueWindowState();
    if (window.refreshCiShipMasterList) window.refreshCiShipMasterList();
  }

  function bindModalEvents() {
    const overlay = document.getElementById("ciClassFacilitiesTemplateOverlay");
    if (!overlay) return;
    overlay.querySelector("[data-action='header-close']")?.addEventListener("click", closeModal);
    overlay.querySelector("[data-action='cancel']")?.addEventListener("click", closeModal);
    overlay.querySelector("[data-action='close-result']")?.addEventListener("click", closeModal);
    overlay.querySelector("[data-action='back']")?.addEventListener("click", function () {
      goToStep(STEP_EDIT);
    });
    overlay.querySelector("[data-action='save-template']")?.addEventListener("click", function (event) {
      if (event.currentTarget.disabled) return;
      saveTemplate();
    });
    overlay.querySelector("[data-action='continue-apply']")?.addEventListener("click", function (event) {
      if (event.currentTarget.disabled) return;
      goToStep(STEP_CONFIRM);
    });
    overlay.querySelector("#ciClassTplApplyAck")?.addEventListener("change", function () {
      const btn = overlay.querySelector("[data-action='confirm-apply']");
      if (!btn || btn.hasAttribute("aria-disabled")) return;
      btn.disabled = !this.checked;
    });
    overlay.querySelector("[data-action='confirm-apply']")?.addEventListener("click", function (event) {
      if (event.currentTarget.disabled) return;
      applyTemplate();
    });
    overlay.querySelector("[data-action='import-ship']")?.addEventListener("click", function () {
      const api = tplApi();
      const shipId = String(document.getElementById("ciClassTplImportShip")?.value || "");
      if (!api || !shipId) return;
      const ship = getShips().find(function (row) { return row.id === shipId; });
      if (!ship) return;
      const payload = api.extractTemplateFromShip(ship);
      if (usesCatalogueMode()) {
        modalContext.selectedFeatureIds = mergeSelectionWithImportedRows(
          facApi()?.loadExclusiveAreasForAdmin(payload.exclusive_areas) || [],
          facApi()?.loadSpecialtyFeaturesForAdmin(payload.specialty_features) || []
        );
        modalContext.orphanItems = featuresSvc().orphanTemplateItems(getLineCatalogue(), payload);
        modalContext.editorLoaded = true;
        persistEditorDraft();
        renderModal();
      } else {
        loadEditorFromPayload(payload);
        modalContext.editorLoaded = true;
        persistEditorDraft();
      }
    });
    overlay.querySelector("#ciClassTplImportClass")?.addEventListener("change", function () {
      modalContext.classImportClass = trim(this.value);
      const panel = document.getElementById("ciClassTplImportClassPanel");
      if (!panel) return;
      panel.innerHTML = modalContext.classImportClass
        ? renderClassImportPanel(modalContext.classImportClass)
        : `<p class="admin-small">Copy selected items from another class template into this editor.</p>`;
    });
    overlay.querySelector("[data-action='ea-add']")?.addEventListener("click", function () {
      const rows = readExclusiveRows();
      rows.push({
        name: "",
        description: "",
        icon_key: window.CiShipFeatureIcons?.FALLBACK_KEY || "sparkles",
        showDescription: false,
        needsDescription: false
      });
      rebuildExclusiveDom(rows);
    });
    overlay.addEventListener("click", function (event) {
      const btn = event.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-action");
      if (action === "import-class-selected") {
        const api = tplApi();
        const source = modalContext.classImportSource;
        if (!api || !source) return;
        const eaIndexes = [...overlay.querySelectorAll(".ci-class-tpl-import-ea:checked")].map(function (el) {
          return Number(el.value);
        });
        const sfIndexes = [...overlay.querySelectorAll(".ci-class-tpl-import-sf:checked")].map(function (el) {
          return Number(el.value);
        });
        const selectedEa = eaIndexes.map(function (index) { return source.eaRows[index]; }).filter(Boolean);
        const selectedSf = sfIndexes.map(function (index) { return source.sfRows[index]; }).filter(Boolean);
        if (usesCatalogueMode()) {
          modalContext.selectedFeatureIds = mergeSelectionWithImportedRows(selectedEa, selectedSf);
          modalContext.editorLoaded = true;
          persistEditorDraft();
          renderModal();
          if (window.setCiAutosaveStatus) {
            window.setCiAutosaveStatus(`Imported ${selectedEa.length} area(s) and ${selectedSf.length} feature(s) from ${source.className || "class"}`, "saved");
          }
          return;
        }
        const mergedEa = api.mergeExclusiveAreaRows(readExclusiveRows().filter(function (row) { return trim(row.name); }), selectedEa);
        const mergedSf = api.mergeSpecialtyRows(readSpecialtyRows().filter(function (row) { return trim(row.name || row.label); }), selectedSf);
        rebuildExclusiveDom(mergedEa.length ? mergedEa : [{
          name: "",
          description: "",
          icon_key: window.CiShipFeatureIcons?.FALLBACK_KEY || "sparkles",
          showDescription: false,
          needsDescription: false
        }]);
        rebuildSpecialtyDom(mergedSf.length ? mergedSf : [{
          name: "",
          description: "",
          icon_key: window.CiShipFeatureIcons?.FALLBACK_KEY || "sparkles",
          showDescription: false,
          needsDescription: false
        }]);
        modalContext.editorLoaded = true;
        persistEditorDraft();
        if (window.setCiAutosaveStatus) {
          window.setCiAutosaveStatus(`Imported ${selectedEa.length} area(s) and ${selectedSf.length} feature(s) from ${source.className || "class"}`, "saved");
        }
        return;
      }
      if (action === "sf-add") {
        const rows = readSpecialtyRows();
        rows.push({
          name: "",
          description: "",
          icon_key: window.CiShipFeatureIcons?.FALLBACK_KEY || "sparkles",
          showDescription: false,
          needsDescription: false
        });
        rebuildSpecialtyDom(rows);
      }
    });
  }

  function openModal(options) {
    const api = tplApi();
    if (!api || !options || !options.cruiseLineId || !options.className) return;
    closeModal();
    modalContext = {
      cruiseLineId: options.cruiseLineId,
      className: options.className,
      step: STEP_EDIT,
      editorLoaded: false,
      draftPayload: { exclusive_areas: [], specialty_features: [] },
      lastResult: null,
      classImportClass: "",
      classImportSource: null,
      selectedFeatureIds: [],
      orphanItems: []
    };
    const overlay = document.createElement("div");
    overlay.id = "ciClassFacilitiesTemplateOverlay";
    overlay.className = "ci-bulk-class-overlay ci-item-copy-overlay";
    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) closeModal();
    });
    document.body.appendChild(overlay);
    renderModal();
  }

  window.CiShipClassFacilitiesTemplateAdmin = {
    open: openModal,
    close: closeModal
  };

  window.openCiClassFacilitiesTemplateModal = function (className) {
    const lineId = document.getElementById("ciLineId")?.value || window.editingCiLineId;
    if (!lineId || !className) return;
    window.CiShipClassFacilitiesTemplateAdmin.open({ cruiseLineId: lineId, className: className });
  };
})();
