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
  let message = "";
  let messageTone = "";
  let editingId = null;
  let creating = false;
  let draft = emptyDraft();

  function emptyDraft() {
    return {
      name: "",
      display_order: "10",
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
      display_order: String(row?.display_order ?? 0),
      is_active: row?.is_active !== false
    };
  }

  function readDraftFromDom() {
    const get = (id) => document.getElementById(id)?.value;
    draft = {
      name: String(get("stateroomTypeName") || "").trim(),
      display_order: String(get("stateroomTypeDisplayOrder") ?? "").trim(),
      is_active: String(get("stateroomTypeActive") || "true") !== "false"
    };
    return draft;
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
    const svc = service();
    draft = {
      name: "",
      display_order: String(svc ? svc.nextDisplayOrder(stateroomTypes) : 10),
      is_active: true
    };
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
    const validation = svc.validateStateroomTypeInput({
      name: draft.name,
      display_order: draft.display_order,
      is_active: draft.is_active,
      existingRows: stateroomTypes,
      editingId
    });
    if (!validation.ok) {
      setMessage(validation.error, "error");
      rerender();
      return;
    }

    saving = true;
    setMessage("Saving stateroom type…", "running");
    rerender();
    try {
      if (editingId) {
        await svc.updateStateroomType(editingId, validation.payload);
        setMessage("Stateroom type saved.", "success");
      } else {
        await svc.createStateroomType(validation.payload);
        setMessage("Stateroom type created.", "success");
      }
      await ensureLoaded({ force: true, quiet: true });
      if (typeof global.loadStateroomTypesForPricing === "function") {
        await global.loadStateroomTypesForPricing();
      }
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
      if (typeof global.loadStateroomTypesForPricing === "function") {
        await global.loadStateroomTypesForPricing();
      }
    } catch (error) {
      setMessage(error.message || "Could not delete stateroom type.", "error");
    } finally {
      saving = false;
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
        <div class="admin-grid compact">
          <div class="admin-field">
            <label for="stateroomTypeDisplayOrder">Display Order</label>
            <input id="stateroomTypeDisplayOrder" type="number" step="1" value="${esc(draft.display_order)}">
          </div>
          <div class="admin-field">
            <label for="stateroomTypeActive">Active</label>
            <select id="stateroomTypeActive">
              <option value="true" ${draft.is_active ? "selected" : ""}>Active</option>
              <option value="false" ${!draft.is_active ? "selected" : ""}>Inactive</option>
            </select>
          </div>
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
      <div class="admin-reference-list">
        ${rows
          .map(
            (row) => `
          <div class="admin-list-item compact-item">
            <div class="admin-list-top">
              <div>
                <strong>${esc(row.name)}</strong>
                <div class="admin-small">Display order: ${esc(row.display_order ?? 0)}</div>
                ${
                  row.is_active !== false
                    ? `<span class="admin-pill">Active</span>`
                    : `<span class="admin-pill inactive">Inactive</span>`
                }
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
            <button type="button" class="admin-button" onclick="StateroomTypesAdmin.startCreate()" ${loading || saving ? "disabled" : ""}>Add Stateroom Type</button>
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
    deleteStateroomType
  };
})(typeof window !== "undefined" ? window : globalThis);
