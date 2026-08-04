/**
 * Cruise line ship feature catalogue — Exclusive Areas + Specialty Features.
 * Browser global: CruiseLineFeaturesAdmin
 */
(function (global) {
  "use strict";

  let features = [];
  let loading = false;
  let loadError = "";
  let saving = false;
  let reordering = false;
  let message = "";
  let messageTone = "";
  let activeLineId = "";
  let editingId = null;
  let creatingType = "";
  let draft = emptyDraft();
  let draggedFeatureId = null;
  let dragFromHandle = false;

  function emptyDraft() {
    return {
      name: "",
      description: "",
      icon_key: "sparkles",
      is_active: true
    };
  }

  function esc(value) {
    return typeof global.esc === "function"
      ? global.esc(value)
      : String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#039;");
  }

  function svc() {
    return global.CruiseLineFeaturesService || null;
  }

  function icons() {
    return global.CiShipFeatureIcons || null;
  }

  function featureAdmin() {
    return global.CiShipFeatureAdmin || null;
  }

  function rerender(options) {
    const opts = options && typeof options === "object" ? options : {};
    if (opts.activateFeaturesTab && typeof global.setCiLineTab === "function") {
      try {
        global.setCiLineTab("features");
      } catch (_error) {
        /* ignore */
      }
    }
    try {
      if (typeof global.renderCiAdmin === "function") {
        global.renderCiAdmin();
        return;
      }
      if (typeof global.renderAdmin === "function") {
        global.renderAdmin();
        return;
      }
      console.error("CruiseLineFeaturesAdmin: renderAdmin is not available");
    } catch (error) {
      console.error("CruiseLineFeaturesAdmin: render failed", error);
    }
  }

  function setMessage(text, tone) {
    message = text || "";
    messageTone = tone || "";
  }

  function syncWindowCache() {
    global.ciCruiseLineFeatures = features.slice();
  }

  function sortedFeatures(featureType) {
    const service = svc();
    return service ? service.filterByType(features, featureType) : [];
  }

  function activeFeatures(featureType) {
    const service = svc();
    const rows = service ? service.filterByType(features, featureType) : [];
    return service ? service.listActiveFeaturesFromRows(rows) : rows.filter((row) => row.is_active !== false);
  }

  function featureToDraft(row) {
    return {
      name: row?.name || "",
      description: row?.description || "",
      icon_key: row?.icon_key || "sparkles",
      is_active: row?.is_active !== false
    };
  }

  function readDraftFromDom() {
    const get = (id) => document.getElementById(id)?.value;
    draft = {
      name: String(get("ciLineFeatureName") || "").trim(),
      description: String(get("ciLineFeatureDescription") || "").trim(),
      icon_key: String(document.querySelector("#ciLineFeaturesPanel .ci-ship-feature-icon-key")?.value || draft.icon_key || "sparkles").trim() || "sparkles",
      is_active: String(get("ciLineFeatureActive") || "true") !== "false"
    };
    return draft;
  }

  async function loadForLine(lineId, { rerenderOnComplete = true } = {}) {
    const service = svc();
    activeLineId = String(lineId || "").trim();
    if (!activeLineId || !service) {
      features = [];
      syncWindowCache();
      return;
    }
    loading = true;
    loadError = "";
    if (rerenderOnComplete) rerender();
    try {
      features = await service.listFeaturesForLine(activeLineId);
      syncWindowCache();
    } catch (error) {
      loadError = error.message || "Could not load ship features.";
      features = [];
      syncWindowCache();
    } finally {
      loading = false;
      if (rerenderOnComplete) rerender();
    }
  }

  function startCreate(featureType) {
    const type = String(featureType || "").trim();
    if (type !== "exclusive_area" && type !== "specialty_feature") {
      console.warn("CruiseLineFeaturesAdmin.startCreate: invalid feature type", featureType);
      return;
    }
    creatingType = type;
    editingId = null;
    draft = emptyDraft();
    const iconApi = icons();
    if (iconApi) draft.icon_key = iconApi.FALLBACK_KEY;
    setMessage("", "");
    rerender({ activateFeaturesTab: true });
  }

  function startEdit(id) {
    const featureId = String(id || "").trim();
    const row = features.find((item) => item.id === featureId);
    if (!row) {
      console.warn("CruiseLineFeaturesAdmin.startEdit: feature not found", id);
      return;
    }
    creatingType = "";
    editingId = featureId;
    draft = featureToDraft(row);
    setMessage("", "");
    rerender({ activateFeaturesTab: true });
  }

  function cancelEdit() {
    creatingType = "";
    editingId = null;
    draft = emptyDraft();
    setMessage("", "");
    rerender({ activateFeaturesTab: true });
  }

  function retryLoad() {
    return loadForLine(activeLineId);
  }

  async function saveFeature() {
    const service = svc();
    if (!service || saving || !activeLineId) return;
    readDraftFromDom();
    const row = editingId ? features.find((item) => item.id === editingId) : null;
    const featureType = row?.feature_type || creatingType;
    if (!featureType) return;

    saving = true;
    setMessage("Saving feature…", "running");
    rerender();
    try {
      if (editingId) {
        const validation = service.validateFeatureInput({
          name: draft.name,
          description: draft.description,
          icon_key: draft.icon_key,
          is_active: draft.is_active,
          feature_type: featureType,
          cruise_line_id: activeLineId,
          existingRows: features,
          editingId
        });
        if (!validation.ok) {
          setMessage(validation.error, "error");
          return;
        }
        await service.updateFeature(editingId, validation.payload);
        setMessage("Feature saved.", "success");
      } else {
        const validation = service.buildCreatePayload({
          name: draft.name,
          description: draft.description,
          icon_key: draft.icon_key,
          is_active: draft.is_active,
          feature_type: featureType,
          cruise_line_id: activeLineId,
          existingRows: features
        });
        if (!validation.ok) {
          setMessage(validation.error, "error");
          return;
        }
        await service.createFeature(validation.payload);
        setMessage("Feature created.", "success");
      }
      await loadForLine(activeLineId, { rerenderOnComplete: false });
      creatingType = "";
      editingId = null;
      draft = emptyDraft();
    } catch (error) {
      setMessage(error.message || "Could not save feature.", "error");
    } finally {
      saving = false;
      rerender();
    }
  }

  async function deleteFeature(id) {
    const service = svc();
    if (!service || saving) return;
    const row = features.find((item) => item.id === id);
    if (!row) return;
    const label = row.name || "this feature";
    if (!global.confirm(`Delete “${label}”? Class templates that use it will need updating.`)) return;

    saving = true;
    setMessage("Deleting feature…", "running");
    rerender();
    try {
      await service.deleteFeature(id);
      setMessage(`Deleted “${label}”.`, "success");
      if (editingId === id) cancelEdit();
      await loadForLine(activeLineId, { rerenderOnComplete: false });
    } catch (error) {
      setMessage(error.message || "Could not delete feature.", "error");
    } finally {
      saving = false;
      rerender();
    }
  }

  function onDragHandlePointerDown(event) {
    dragFromHandle = true;
    event.stopPropagation();
  }

  function onDragStart(event, id) {
    if (!dragFromHandle || saving || reordering) {
      event.preventDefault();
      return;
    }
    dragFromHandle = false;
    draggedFeatureId = String(id || "");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedFeatureId);
    event.currentTarget.classList.add("is-dragging");
  }

  function onDragEnd(event) {
    dragFromHandle = false;
    event.currentTarget?.classList.remove("is-dragging");
    const wasDragging = Boolean(draggedFeatureId);
    const featureType = event.currentTarget?.closest("[data-feature-type]")?.getAttribute("data-feature-type");
    draggedFeatureId = null;
    if (wasDragging && featureType) {
      saveOrderFromDom(featureType);
    }
  }

  function allowDrop(event) {
    if (!draggedFeatureId || saving || reordering) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";

    const list = event.currentTarget;
    const dragged = list.querySelector(
      `.ci-line-feature-row[data-feature-id="${CSS.escape(String(draggedFeatureId))}"]`
    );
    if (!dragged || dragged.parentElement !== list) return;

    const cards = Array.from(list.querySelectorAll(".ci-line-feature-row:not(.is-dragging)"));
    const afterElement = cards.find((card) => {
      const rect = card.getBoundingClientRect();
      return event.clientY < rect.top + rect.height / 2;
    });

    if (afterElement) {
      if (dragged.nextSibling !== afterElement) list.insertBefore(dragged, afterElement);
    } else if (list.lastElementChild !== dragged) {
      list.appendChild(dragged);
    }
  }

  function onDrop(event) {
    if (!draggedFeatureId) return;
    event.preventDefault();
  }

  function readOrderedIdsFromDom(featureType) {
    const list = document.getElementById(
      featureType === "exclusive_area" ? "ciLineFeaturesEaList" : "ciLineFeaturesSfList"
    );
    if (!list) return [];
    return Array.from(list.querySelectorAll("[data-feature-id]"))
      .map((el) => el.getAttribute("data-feature-id"))
      .filter(Boolean);
  }

  async function saveOrderFromDom(featureType) {
    const service = svc();
    if (!service || saving || reordering || !activeLineId) return;
    const orderedIds = readOrderedIdsFromDom(featureType);
    const reorder = service.buildReorderPayload(orderedIds);
    if (!reorder.ok) {
      setMessage(reorder.error, "error");
      rerender();
      return;
    }

    reordering = true;
    setMessage("Saving order…", "running");
    rerender();
    try {
      features = await service.reorderFeatures(activeLineId, featureType, orderedIds);
      syncWindowCache();
      setMessage("Order saved.", "success");
    } catch (error) {
      setMessage(error.message || "Could not save feature order.", "error");
      await loadForLine(activeLineId, { rerenderOnComplete: false });
    } finally {
      reordering = false;
      rerender();
    }
  }

  function renderFeatureForm(featureType) {
    const showForm =
      (creatingType === featureType || (editingId && features.find((row) => row.id === editingId)?.feature_type === featureType));
    if (!showForm) return "";

    const title = editingId ? "Edit feature" : featureType === "exclusive_area" ? "Add exclusive area" : "Add specialty feature";
    const admin = featureAdmin();
    const iconRow = admin
      ? admin.renderIconPicker(
          { name: draft.name, icon_key: draft.icon_key },
          0,
          "ciLineFeature"
        )
      : "";

    return `
      <div class="admin-card ci-line-feature-form">
        <h5>${esc(title)}</h5>
        <div class="ci-ship-feature-row-layout">
          ${iconRow}
          <div class="ci-ship-feature-fields">
            <div class="admin-field">
              <label for="ciLineFeatureName">Name</label>
              <input id="ciLineFeatureName" type="text" value="${esc(draft.name)}" placeholder="e.g. Cagney's Steakhouse" maxlength="160">
            </div>
            <div class="admin-field">
              <label for="ciLineFeatureDescription">Description <span class="admin-small">(optional)</span></label>
              <textarea id="ciLineFeatureDescription" rows="2" placeholder="Short detail shown on My Ship">${esc(draft.description)}</textarea>
            </div>
            <div class="admin-field">
              <label for="ciLineFeatureActive">Active</label>
              <select id="ciLineFeatureActive">
                <option value="true" ${draft.is_active ? "selected" : ""}>Active</option>
                <option value="false" ${!draft.is_active ? "selected" : ""}>Inactive</option>
              </select>
            </div>
          </div>
        </div>
        <div class="admin-actions-row">
          <button type="button" class="admin-button small" onclick="CruiseLineFeaturesAdmin.saveFeature()" ${saving ? "disabled" : ""}>Save feature</button>
          <button type="button" class="admin-button secondary small" onclick="CruiseLineFeaturesAdmin.cancelEdit()">Cancel</button>
        </div>
      </div>`;
  }

  function renderFeatureList(featureType, title) {
    const rows = sortedFeatures(featureType);
    const listId = featureType === "exclusive_area" ? "ciLineFeaturesEaList" : "ciLineFeaturesSfList";
    const iconApi = icons();

    const list = rows.length
      ? rows
          .map(function (row) {
            const inactive = row.is_active === false ? " is-inactive" : "";
            const svg = iconApi ? iconApi.renderIconSvg(row.icon_key, "ci-line-feature-icon") : "";
            return `
          <div class="ci-line-feature-row${inactive}" draggable="true" data-feature-id="${esc(row.id)}" data-feature-type="${esc(featureType)}">
            <button type="button" class="ci-drag-handle" aria-label="Drag to reorder" data-ci-line-feature-action="drag-handle">⋮⋮</button>
            <span class="ci-line-feature-icon-wrap">${svg}</span>
            <div class="ci-line-feature-copy">
              <strong>${esc(row.name)}</strong>
              ${row.description ? `<span class="admin-small">${esc(row.description)}</span>` : ""}
              ${row.is_active === false ? `<span class="admin-small ci-line-feature-inactive-tag">Inactive</span>` : ""}
            </div>
            <div class="ci-line-feature-actions">
              <button type="button" class="admin-button secondary small" onclick="CruiseLineFeaturesAdmin.startEdit('${esc(row.id)}')">Edit</button>
              <button type="button" class="admin-button secondary small" onclick="CruiseLineFeaturesAdmin.deleteFeature('${esc(row.id)}')">Delete</button>
            </div>
          </div>`;
          })
          .join("")
      : `<p class="admin-small">No ${title.toLowerCase()} yet. Add branded names for this line (e.g. “The Haven”, “Crown Grill”).</p>`;

    return `
      <div class="ci-line-feature-group">
        <div class="ci-line-feature-group-head">
          <h5>${esc(title)}</h5>
          <button type="button" class="admin-button secondary small" onclick="CruiseLineFeaturesAdmin.startCreate('${esc(featureType)}')" ${saving ? "disabled" : ""}>Add</button>
        </div>
        ${renderFeatureForm(featureType)}
        <div id="${listId}" class="ci-line-feature-list" data-feature-type="${esc(featureType)}">${list}</div>
      </div>`;
  }

  function renderSection(line) {
    if (!line?.id) return "";
    if (loading) {
      return `
        <div class="ci-line-features-panel" id="ciLineFeaturesPanel">
          <h4>Ship features catalogue</h4>
          <p class="admin-muted admin-running-status" role="status">Loading ship features…</p>
        </div>`;
    }
    if (loadError) {
      return `
        <div class="ci-line-features-panel" id="ciLineFeaturesPanel">
          <h4>Ship features catalogue</h4>
          <div class="admin-message admin-error">${esc(loadError)}</div>
          <button type="button" class="admin-button secondary small" onclick="CruiseLineFeaturesAdmin.retryLoad()">Retry</button>
        </div>`;
    }

    const msgClass =
      messageTone === "error"
        ? "admin-error"
        : messageTone === "success"
          ? "admin-success"
          : messageTone === "running"
            ? "admin-running"
            : "";

    return `
      <div class="ci-line-features-panel" id="ciLineFeaturesPanel">
        <h4>Ship features catalogue</h4>
        <p class="admin-small">Define branded Exclusive Areas and Specialty Features once for ${esc(line.name || "this line")}. Class templates then pick from this list with checkboxes.</p>
        ${message ? `<p class="admin-small ${msgClass}">${esc(message)}</p>` : ""}
        ${renderFeatureList("exclusive_area", "Exclusive Areas")}
        ${renderFeatureList("specialty_feature", "Specialty Features")}
      </div>`;
  }

  function bindIconPickers(root) {
    const admin = featureAdmin();
    if (!admin || !root) return;
    const form = root.querySelector(".ci-line-feature-form");
    if (form) {
      form.dataset.featureBound = "";
      admin.bindFeatureList(form, {});
    }
  }

  function afterRender() {
    const panel = document.getElementById("ciLineFeaturesPanel");
    if (!panel) return;
    bindIconPickers(panel);

    panel.querySelectorAll("[data-ci-line-feature-action='drag-handle']").forEach(function (btn) {
      btn.addEventListener("pointerdown", onDragHandlePointerDown);
    });
    panel.querySelectorAll(".ci-line-feature-row").forEach(function (row) {
      row.addEventListener("dragstart", function (event) {
        onDragStart(event, row.getAttribute("data-feature-id"));
      });
      row.addEventListener("dragend", onDragEnd);
    });
    panel.querySelectorAll(".ci-line-feature-list").forEach(function (list) {
      list.addEventListener("dragover", allowDrop);
      list.addEventListener("drop", onDrop);
    });
  }

  global.CruiseLineFeaturesAdmin = {
    renderSection,
    afterRender,
    loadForLine,
    startCreate,
    startEdit,
    cancelEdit,
    saveFeature,
    deleteFeature,
    retryLoad,
    getFeatures: function () {
      return features.slice();
    },
    refreshForActiveLine: function () {
      return loadForLine(activeLineId);
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
