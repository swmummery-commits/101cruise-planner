/**
 * Administration → Stateroom Types.
 * Canonical room-type catalogue plus explicit cruise-line allocations.
 */
(function (global) {
  "use strict";

  let stateroomTypes = [];
  let cruiseLines = [];
  let allocations = {};
  let loaded = false;
  let loading = false;
  let loadError = "";
  let savingKey = "";
  let creating = false;
  let editingId = null;
  let draftName = "";
  let message = "";
  let messageTone = "";

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

  function svc() { return global.StateroomTypesService || null; }
  function client() { return global.supabaseClient || global.getAdminSupabaseClient?.() || null; }
  function rerender() { if (typeof global.renderAdmin === "function") global.renderAdmin(); }
  function alphaTypes() { return svc()?.sortStateroomTypes(stateroomTypes) || stateroomTypes.slice(); }
  function alphaLines() {
    return cruiseLines.slice().sort((a, b) => String(a?.name || "").localeCompare(String(b?.name || ""), "en", { sensitivity: "base", numeric: true }));
  }
  function setMessage(text, tone = "") { message = text || ""; messageTone = tone || ""; }

  async function ensureLoaded({ force = false, quiet = false } = {}) {
    if (loading) return;
    if (loaded && !force) return;
    const service = svc();
    const supabase = client();
    if (!service || !supabase) {
      loadError = "Stateroom type services are not available.";
      if (!quiet) rerender();
      return;
    }
    loading = true;
    loadError = "";
    if (!quiet) rerender();
    try {
      const [types, allocationMap, lineResult] = await Promise.all([
        service.listAllStateroomTypes(),
        service.loadCruiseLineStateroomAllocations(),
        supabase.from("ci_cruise_lines").select("id,name").order("name", { ascending: true })
      ]);
      if (lineResult.error) throw new Error(lineResult.error.message || "Could not load cruise lines.");
      stateroomTypes = types || [];
      allocations = allocationMap || {};
      cruiseLines = lineResult.data || [];
      loaded = true;
    } catch (error) {
      loadError = error?.message || "Could not load stateroom types.";
    } finally {
      loading = false;
      rerender();
    }
  }

  function retryLoad() { return ensureLoaded({ force: true }); }
  function startCreate() {
    creating = true; editingId = null; draftName = ""; setMessage(""); rerender();
    setTimeout(() => document.getElementById("stateroomTypeName")?.focus(), 0);
  }
  function startEdit(id) {
    const row = stateroomTypes.find((item) => String(item.id) === String(id));
    if (!row) return;
    creating = false; editingId = row.id; draftName = row.name || ""; setMessage(""); rerender();
    setTimeout(() => document.getElementById("stateroomTypeName")?.focus(), 0);
  }
  function cancelEdit() { creating = false; editingId = null; draftName = ""; setMessage(""); rerender(); }

  async function saveStateroomType() {
    const service = svc();
    if (!service || savingKey) return;
    const name = service.trimName(document.getElementById("stateroomTypeName")?.value ?? draftName);
    const validation = editingId
      ? service.validateStateroomTypeInput({ name, existingRows: stateroomTypes, editingId })
      : service.buildCreatePayload({ name, existingRows: stateroomTypes });
    if (!validation.ok) { setMessage(validation.error, "error"); rerender(); return; }
    savingKey = "type"; setMessage("Saving stateroom type…", "running"); rerender();
    try {
      if (editingId) await service.updateStateroomType(editingId, validation.payload);
      else await service.createStateroomType(validation.payload);
      creating = false; editingId = null; draftName = "";
      await ensureLoaded({ force: true, quiet: true });
      if (typeof global.loadStateroomTypesForPricing === "function") await global.loadStateroomTypesForPricing({ rerender: false });
      setMessage("Stateroom type saved.", "success");
    } catch (error) {
      setMessage(error?.message || "Could not save stateroom type.", "error");
    } finally {
      savingKey = ""; rerender();
    }
  }

  async function deleteStateroomType(id) {
    const service = svc();
    if (!service || savingKey) return;
    const row = stateroomTypes.find((item) => String(item.id) === String(id));
    if (!row) return;
    if (!global.confirm(`Delete stateroom type “${row.name}”? Only unused types can be deleted.`)) return;
    savingKey = `delete:${id}`; setMessage("Checking and deleting…", "running"); rerender();
    try {
      await service.deleteStateroomType(id);
      await ensureLoaded({ force: true, quiet: true });
      if (typeof global.loadStateroomTypesForPricing === "function") await global.loadStateroomTypesForPricing({ rerender: false });
      setMessage(`Deleted “${row.name}”.`, "success");
    } catch (error) {
      setMessage(error?.message || "Could not delete stateroom type.", "error");
    } finally {
      savingKey = ""; rerender();
    }
  }

  async function toggleAllocation(lineId, typeId, checked) {
    const service = svc();
    if (!service || !lineId || !typeId || savingKey) return;
    const current = new Set((allocations[lineId] || []).map(String));
    if (checked) current.add(String(typeId)); else current.delete(String(typeId));
    allocations[lineId] = [...current];
    savingKey = `allocation:${lineId}`; setMessage("Saving cruise-line allocation…", "running"); rerender();
    try {
      allocations = await service.saveCruiseLineStateroomTypes(lineId, [...current]);
      if (typeof global.loadStateroomTypesForPricing === "function") await global.loadStateroomTypesForPricing({ rerender: false });
      setMessage("Cruise-line allocation saved.", "success");
    } catch (error) {
      setMessage(error?.message || "Could not save cruise-line allocation.", "error");
      try { allocations = await service.loadCruiseLineStateroomAllocations(); } catch (_) {}
    } finally {
      savingKey = ""; rerender();
    }
  }

  function messageHtml() {
    if (!message) return "";
    const klass = messageTone === "error" ? "admin-error" : messageTone === "success" ? "admin-success" : messageTone === "running" ? "admin-running" : "";
    return `<div class="admin-message ${klass}">${esc(message)}</div>`;
  }

  function renderForm() {
    if (!creating && !editingId) return "";
    return `
      <div class="admin-card">
        <h3>${editingId ? "Edit Stateroom Type" : "Add Stateroom Type"}</h3>
        <div class="admin-field">
          <label for="stateroomTypeName">Stateroom Type Name</label>
          <input id="stateroomTypeName" type="text" maxlength="120" value="${esc(draftName)}" placeholder="e.g. Balcony" onkeydown="if(event.key==='Enter'){event.preventDefault();StateroomTypesAdmin.saveStateroomType();}">
        </div>
        <p class="admin-small">Every type added here is available for allocation. Cruise-line availability is controlled by the checkboxes below.</p>
        <div class="admin-form-actions">
          <button type="button" class="admin-button" onclick="StateroomTypesAdmin.saveStateroomType()" ${savingKey ? "disabled" : ""}>Save</button>
          <button type="button" class="admin-button secondary" onclick="StateroomTypesAdmin.cancelEdit()" ${savingKey ? "disabled" : ""}>Cancel</button>
        </div>
      </div>`;
  }

  function renderTypeCard(type, lines) {
    const boxes = lines.map((line) => {
      const selected = new Set((allocations[line.id] || []).map(String));
      const checked = selected.has(String(type.id));
      return `
        <label class="ci-check-control" title="${esc(line.name)}">
          <input type="checkbox" ${checked ? "checked" : ""} ${savingKey ? "disabled" : ""}
            onchange="StateroomTypesAdmin.toggleAllocation('${esc(line.id)}','${esc(type.id)}',this.checked)">
          ${esc(line.name)}
        </label>`;
    }).join("");
    return `
      <div class="admin-list-item compact-item stateroom-type-row" data-stateroom-type-id="${esc(type.id)}">
        <div class="admin-list-top" style="align-items:flex-start; gap:16px;">
          <div style="min-width:180px; padding-top:4px;"><strong>${esc(type.name)}</strong></div>
          <div class="admin-inline-actions">
            <button type="button" class="admin-button secondary small" onclick="StateroomTypesAdmin.startEdit('${esc(type.id)}')" ${savingKey ? "disabled" : ""}>Edit</button>
            <button type="button" class="admin-button secondary small" onclick="StateroomTypesAdmin.deleteStateroomType('${esc(type.id)}')" ${savingKey ? "disabled" : ""}>Delete</button>
          </div>
        </div>
        <div style="margin-top:10px;">
          <div class="admin-small" style="font-weight:600; margin-bottom:6px;">Cruise lines using this room type</div>
          <div class="ci-checkbox-row ci-stateroom-type-grid">${boxes || `<span class="admin-small">No cruise lines found.</span>`}</div>
        </div>
      </div>`;
  }

  function renderPanel() {
    if (!loaded && !loading && !loadError) setTimeout(() => ensureLoaded({ quiet: true }), 0);
    const rows = alphaTypes();
    const lines = alphaLines();
    return `
      <div class="admin-card">
        <div class="admin-list-top">
          <div>
            <p class="admin-nav-eyebrow">Administration</p>
            <h3>Stateroom Types</h3>
            <p class="admin-muted">This is the single master list used by cruise lines, ships and pricing. Types and cruise lines are shown A–Z. Tick the cruise lines that use each type.</p>
          </div>
          <button type="button" class="admin-button" onclick="StateroomTypesAdmin.startCreate()" ${loading || savingKey ? "disabled" : ""}>Add Stateroom Type</button>
        </div>
        ${messageHtml()}
      </div>
      ${renderForm()}
      <div class="admin-card">
        <h3>Stateroom Types</h3>
        ${loading ? `<p class="admin-muted admin-running-status">Loading stateroom types…</p>` : ""}
        ${loadError ? `<div class="admin-message admin-error">${esc(loadError)}</div><button type="button" class="admin-button secondary" onclick="StateroomTypesAdmin.retryLoad()">Retry</button>` : ""}
        ${!loading && !loadError && !rows.length ? `<p class="admin-muted">No stateroom types have been created yet.</p>` : ""}
        ${!loading && !loadError ? `<div class="admin-reference-list">${rows.map((type) => renderTypeCard(type, lines)).join("")}</div>` : ""}
      </div>`;
  }

  global.StateroomTypesAdmin = { renderPanel, ensureLoaded, retryLoad, startCreate, startEdit, cancelEdit, saveStateroomType, deleteStateroomType, toggleAllocation };
})(typeof window !== "undefined" ? window : globalThis);
