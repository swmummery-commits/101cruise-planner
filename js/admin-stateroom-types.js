/**
 * Admin Stateroom Types reference page.
 * Browser global: StateroomTypesAdmin
 */
(function (global) {
  "use strict";

  let stateroomTypes = [];
  let loading = false;
  let loadError = "";
  let saving = false;
  let reordering = false;
  let message = "";
  let messageTone = "";
  let editingId = null;
  let creating = false;
  let draft = emptyDraft();
  let draggedStateroomTypeId = null;
  let stateroomTypeDragFromHandle = false;

  function emptyDraft() {
    return {
      name: "",
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

  function service() {
    return global.StateroomTypesService || null;
  }

  function rerender() {
    if (typeof global.renderAdmin === "function") global.renderAdmin();
  }

  function setMessage(text, tone) {
    message = text || "";
    messageTone = tone || "";
  }

  function sortedTypes() {
    const svc = service();
    return svc ? svc.sortStateroomTypes(stateroomTypes) : stateroomTypes.slice();
  }

  function typeToDraft(row) {
    return {
      name: row?.name || "",
      is_active: row?.is_active !== false
    };
  }

  function readDraftFromDom() {
    const get = (id) => document.getElementById(id)?.value;
    draft = {
      name: String(get("stateroomTypeName") || "").trim(),
      is_active: String(get("stateroomTypeActive") || "true") !== "false"
    };
    return draft;
  }

  async function refreshPricingTypes() {
    if (typeof global.loadStateroomTypesForPricing === "function") {
      await global.loadStateroomTypesForPricing();
    }
  }

  async function ensureLoaded({ force = false, quiet = false } = {}) {
    if (loading) return;
    if (stateroomTypes.length && !force && !loadError) return;
    const svc = service();
    if (!svc) {
      loadError = "Stateroom types service failed to load.";
      if (!quiet) rerender();
      return;
    }
    loading = true;
    loadError = "";
    if (!quiet) rerender();
    try {
      stateroomTypes = await svc.listAllStateroomTypes();
    } catch (error) {
      loadError = error.message || "Could not load stateroom types.";
      stateroomTypes = [];
    } finally {
      loading = false;
      rerender();
    }
  }

  function retryLoad() {
    return ensureLoaded({ force: true });
  }

  function startCreate() {
    creating = true;
    editingId = null;
    draft = emptyDraft();
    setMessage("", "");
    rerender();
  }

  function startEdit(id) {
    const row = stateroomTypes.find((item) => item.id === id);
    if (!row) return;
    creating = false;
    editingId = id;
    draft = typeToDraft(row);
    setMessage("", "");
    rerender();
  }

  function cancelEdit() {
    creating = false;
    editingId = null;
    draft = emptyDraft();
    setMessage("", "");
    rerender();
  }

  async function saveStateroomType() {
    const svc = service();
    if (!svc || saving) return;
    readDraftFromDom();

    saving = true;
    setMessage("Saving stateroom type…", "running");
    rerender();
    try {
      if (editingId) {
        const validation = svc.validateStateroomTypeInput({
          name: draft.name,
          is_active: draft.is_active,
          existingRows: stateroomTypes,
          editingId
        });
        if (!validation.ok) {
          setMessage(validation.error, "error");
          return;
        }
        await svc.updateStateroomType(editingId, validation.payload);
        setMessage("Stateroom type saved.", "success");
      } else {
        const validation = svc.buildCreatePayload({
          name: draft.name,
          is_active: draft.is_active,
          existingRows: stateroomTypes
        });
        if (!validation.ok) {
          setMessage(validation.error, "error");
          return;
        }
        await svc.createStateroomType(validation.payload);
        setMessage("Stateroom type created.", "success");
      }
      await ensureLoaded({ force: true, quiet: true });
      await refreshPricingTypes();
      creating = false;
      editingId = null;
      draft = emptyDraft();
    } catch (error) {
      setMessage(error.message || "Could not save stateroom type.", "error");
    } finally {
      saving = false;
      rerender();
    }
  }

  async function deleteStateroomType(id) {
    const svc = service();
    if (!svc || saving) return;
    const row = stateroomTypes.find((item) => item.id === id);
    if (!row) return;
    const label = row.name || "this stateroom type";
    if (!global.confirm(`Delete stateroom type “${label}”? This cannot be undone.`)) return;

    saving = true;
    setMessage("Checking usage…", "running");
    rerender();
    try {
      await svc.deleteStateroomType(id);
      setMessage(`Deleted “${label}”.`, "success");
      if (editingId === id) cancelEdit();
      await ensureLoaded({ force: true, quiet: true });
      await refreshPricingTypes();
    } catch (error) {
      setMessage(error.message || "Could not delete stateroom type.", "error");
    } finally {
      saving = false;
      rerender();
    }
  }

  function onDragHandlePointerDown(event) {
    stateroomTypeDragFromHandle = true;
    event.stopPropagation();
  }

  function onDragStart(event, id) {
    if (!stateroomTypeDragFromHandle || saving || reordering) {
      event.preventDefault();
      return;
    }
    stateroomTypeDragFromHandle = false;
    draggedStateroomTypeId = String(id || "");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedStateroomTypeId);
    event.currentTarget.classList.add("is-dragging");
  }

  function onDragEnd(event) {
    stateroomTypeDragFromHandle = false;
    event.currentTarget?.classList.remove("is-dragging");
    const wasDragging = Boolean(draggedStateroomTypeId);
    draggedStateroomTypeId = null;
    if (wasDragging) {
      saveOrderFromDom();
    }
  }

  function allowDrop(event) {
    if (!draggedStateroomTypeId || saving || reordering) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";

    const list = event.currentTarget;
    const dragged = list.querySelector(
      `.stateroom-type-row[data-stateroom-type-id="${CSS.escape(String(draggedStateroomTypeId))}"]`
    );
    if (!dragged || dragged.parentElement !== list) return;

    const cards = Array.from(list.querySelectorAll(".stateroom-type-row:not(.is-dragging)"));
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
    if (!draggedStateroomTypeId) return;
    event.preventDefault();
  }

  function readOrderedIdsFromDom() {
    const list = document.getElementById("stateroomTypesSortList");
    if (!list) return [];
    return Array.from(list.querySelectorAll("[data-stateroom-type-id]"))
      .map((el) => el.getAttribute("data-stateroom-type-id"))
      .filter(Boolean);
  }

  async function saveOrderFromDom() {
    const svc = service();
    if (!svc || saving || reordering) return;
    const orderedIds = readOrderedIdsFromDom();
    const reorder = svc.buildReorderPayload(orderedIds);
    if (!reorder.ok) {
      setMessage(reorder.error, "error");
      rerender();
      return;
    }

    reordering = true;
    setMessage("Saving order…", "running");
    rerender();
    try {
      stateroomTypes = await svc.reorderStateroomTypes(orderedIds);
      await refreshPricingTypes();
      setMessage("Order saved.", "success");
    } catch (error) {
      setMessage(error.message || "Could not save stateroom type order.", "error");
      await ensureLoaded({ force: true, quiet: true });
    } finally {
      reordering = false;
      rerender();
    }
  }

  function renderForm() {
    const showForm = creating || editingId;
    if (!showForm) return "";

    const title = editingId ? "Edit Stateroom Type" : "Add Stateroom Type";
    const msgClass =
      messageTone === "error"
        ? "admin-error"
        : messageTone === "success"
          ? "admin-success"
          : messageTone === "running"
            ? "admin-running"
            : "";

    return `
      <div class="admin-card">
        <h3>${esc(title)}</h3>
        <div class="admin-field">
          <label for="stateroomTypeName">Stateroom Type Name</label>
          <input id="stateroomTypeName" type="text" value="${esc(draft.name)}" placeholder="e.g. Balcony" maxlength="120">
        </div>
        <div class="admin-field">
          <label for="stateroomTypeActive">Active</label>
          <select id="stateroomTypeActive">
            <option value="true" ${draft.is_active ? "selected" : ""}>Active</option>
            <option value="false" ${!draft.is_active ? "selected" : ""}>Inactive</option>
          </select>
        </div>
        <div class="admin-form-actions">
          <button type="button" class="admin-button" onclick="StateroomTypesAdmin.saveStateroomType()" ${saving ? "disabled" : ""}>Save</button>
          <button type="button" class="admin-button secondary" onclick="StateroomTypesAdmin.cancelEdit()" ${saving ? "disabled" : ""}>Cancel</button>
        </div>
        ${message && (creating || editingId) ? `<div class="admin-message ${msgClass}">${esc(message)}</div>` : ""}
      </div>
    `;
  }

  function renderList() {
    const rows = sortedTypes();
    if (loading) {
      return `<p class="admin-muted admin-running-status" role="status">Loading stateroom types…</p>`;
    }
    if (loadError) {
      return `
        <div class="admin-message admin-error">${esc(loadError)}</div>
        <button type="button" class="admin-button secondary" onclick="StateroomTypesAdmin.retryLoad()">Retry</button>
      `;
    }
    if (!rows.length) {
      return `
        <p class="admin-muted">No stateroom types have been created yet.</p>
        <button type="button" class="admin-button" onclick="StateroomTypesAdmin.startCreate()">Add Stateroom Type</button>
      `;
    }

    return `
      <p class="admin-muted">Drag rows to set the order used in pricing dropdowns.</p>
      <div
        class="admin-reference-list stateroom-types-sort-list"
        id="stateroomTypesSortList"
        ondragover="StateroomTypesAdmin.allowDrop(event)"
        ondrop="StateroomTypesAdmin.onDrop(event)"
      >
        ${rows
          .map(
            (row) => `
          <div
            class="admin-list-item compact-item stateroom-type-row"
            data-stateroom-type-id="${esc(row.id)}"
            draggable="true"
            ondragstart="StateroomTypesAdmin.onDragStart(event, '${esc(row.id)}')"
            ondragend="StateroomTypesAdmin.onDragEnd(event)"
          >
            <div class="admin-list-top">
              <div class="stateroom-type-row-main">
                <span
                  class="stateroom-type-drag-handle"
                  role="button"
                  tabindex="0"
                  aria-label="Drag to reorder stateroom type"
                  title="Drag to reorder"
                  onpointerdown="StateroomTypesAdmin.onDragHandlePointerDown(event)"
                >☰</span>
                <div>
                  <strong>${esc(row.name)}</strong>
                  ${
                    row.is_active !== false
                      ? `<span class="admin-pill">Active</span>`
                      : `<span class="admin-pill inactive">Inactive</span>`
                  }
                </div>
              </div>
              <div class="admin-inline-actions">
                <button type="button" class="admin-button secondary small" onclick="StateroomTypesAdmin.startEdit('${esc(row.id)}')">Edit</button>
                <button type="button" class="admin-button secondary small" onclick="StateroomTypesAdmin.deleteStateroomType('${esc(row.id)}')" ${saving ? "disabled" : ""}>Delete</button>
              </div>
            </div>
          </div>
        `
          )
          .join("")}
      </div>
    `;
  }

  function renderPanel() {
    const msgClass =
      messageTone === "error"
        ? "admin-error"
        : messageTone === "success"
          ? "admin-success"
          : messageTone === "running"
            ? "admin-running"
            : "";
    const showTopMessage = message && !creating && !editingId;

    return `
      <div class="admin-card">
        <div class="admin-list-top">
          <div>
            <p class="admin-nav-eyebrow">Administration</p>
            <h3>Stateroom Types</h3>
            <p class="admin-muted">Manage the room types available when entering cruise pricing.</p>
          </div>
          <div>
            <button type="button" class="admin-button" onclick="StateroomTypesAdmin.startCreate()" ${loading || saving || reordering ? "disabled" : ""}>Add Stateroom Type</button>
          </div>
        </div>
        ${showTopMessage ? `<div class="admin-message ${msgClass}">${esc(message)}</div>` : ""}
      </div>
      ${renderForm()}
      <div class="admin-card">
        <h3>Stateroom Types</h3>
        ${renderList()}
      </div>
    `;
  }

  global.StateroomTypesAdmin = {
    renderPanel,
    ensureLoaded,
    retryLoad,
    startCreate,
    startEdit,
    cancelEdit,
    saveStateroomType,
    deleteStateroomType,
    onDragHandlePointerDown,
    onDragStart,
    onDragEnd,
    allowDrop,
    onDrop
  };
})(typeof window !== "undefined" ? window : globalThis);
