/**
 * Cruise Database → Cruise Lines → Room Types.
 * Uses the canonical Administration → Stateroom Types catalogue.
 */
(function (global) {
  "use strict";

  let addOpen = false;
  let addDraft = "";
  let addBusy = false;
  let addMessage = "";
  let addMessageTone = "";

  function escapeHtml(value) {
    if (typeof global.esc === "function") return global.esc(value);
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function alphaTypes(rows) {
    return (Array.isArray(rows) ? rows.slice() : []).sort((a, b) =>
      String(a?.name || "").localeCompare(String(b?.name || ""), "en", { sensitivity: "base", numeric: true })
    );
  }

  function checkedTypeIds() {
    return new Set(Array.from(document.querySelectorAll(".ci-line-stateroom-type-cb:checked"))
      .map((el) => String(el.value || "").trim()).filter(Boolean));
  }

  function rerender() {
    if (typeof global.renderCiAdmin === "function") global.renderCiAdmin();
    else if (typeof global.renderAdmin === "function") global.renderAdmin();
  }

  function applyCheckedTypeIds(ids) {
    const selected = ids instanceof Set ? ids : new Set(ids || []);
    document.querySelectorAll(".ci-line-stateroom-type-cb").forEach((el) => {
      el.checked = selected.has(String(el.value || ""));
    });
    if (typeof global.updateCiLineSaveButtonState === "function") global.updateCiLineSaveButtonState();
  }

  function messageHtml() {
    if (!addMessage) return "";
    const klass = addMessageTone === "error" ? "admin-error" : addMessageTone === "success" ? "admin-success" : addMessageTone === "running" ? "admin-running" : "";
    return `<div class="admin-message ${klass}">${escapeHtml(addMessage)}</div>`;
  }

  function addFormHtml() {
    if (!addOpen) return messageHtml();
    return `
      <div class="admin-field" style="margin-top:12px; max-width:520px;">
        <label for="ciLineNewRoomType">New stateroom type</label>
        <input id="ciLineNewRoomType" type="text" maxlength="120" autocomplete="off"
          placeholder="e.g. Ocean Penthouse Suite" value="${escapeHtml(addDraft)}"
          oninput="setCiLineNewsletterRoomTypeDraft(this.value)"
          onkeydown="if(event.key==='Enter'){event.preventDefault();addCiLineNewsletterRoomType();}" ${addBusy ? "disabled" : ""}>
      </div>
      <div class="admin-form-actions" style="margin-top:-8px; margin-bottom:8px;">
        <button type="button" class="admin-button small" onclick="addCiLineNewsletterRoomType()" ${addBusy ? "disabled" : ""}>${addBusy ? "Adding…" : "Add & select"}</button>
        <button type="button" class="admin-button secondary small" onclick="cancelCiLineNewsletterRoomTypeAdd()" ${addBusy ? "disabled" : ""}>Cancel</button>
      </div>
      ${messageHtml()}`;
  }

  function roomTypeGridHtml(types, assigned) {
    if (!types.length) return `<p class="admin-small">No stateroom types exist yet. Add the first type here or under Administration → Stateroom Types.</p>`;
    return `
      <div class="ci-checkbox-row ci-stateroom-type-grid">
        ${types.map((type) => `
          <label class="ci-check-control">
            <input type="checkbox" class="ci-line-stateroom-type-cb" value="${escapeHtml(type.id)}" ${assigned.has(String(type.id)) ? "checked" : ""}>
            ${escapeHtml(type.name)}
          </label>`).join("")}
      </div>`;
  }

  global.renderCiLineStateroomTypesSection = function renderCiLineStateroomTypesSectionCanonical(line) {
    if (!line?.id) return "";
    if (stateroomTypesCatalogLoading) {
      return `<div class="ci-stateroom-types-panel"><h4>Room Types</h4><p class="admin-muted admin-running-status">Loading stateroom types…</p></div>`;
    }
    if (stateroomTypesLoadError) {
      return `<div class="ci-stateroom-types-panel"><h4>Room Types</h4><div class="admin-message admin-error">${escapeHtml(stateroomTypesLoadError)}</div><button type="button" class="admin-button secondary small" onclick="loadStateroomTypesForPricing({rerender:true})">Retry</button></div>`;
    }

    const types = alphaTypes(stateroomTypesActive);
    const assigned = new Set((cruiseLineStateroomAllocations[line.id] || []).map(String));
    return `
      <div class="ci-stateroom-types-panel">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
          <h4 style="margin-bottom:0;">Room Types</h4>
          <button type="button" class="admin-button secondary small" onclick="openCiLineNewsletterRoomTypeAdd()" ${addBusy ? "disabled" : ""}>+ Add room type</button>
        </div>
        <p class="admin-small" style="margin-top:8px;">These are the canonical stateroom types available to this cruise line. Checked means available; unchecked means not available. Types are shown A–Z.</p>
        ${addFormHtml()}
        ${roomTypeGridHtml(types, assigned)}
      </div>`;
  };

  global.openCiLineNewsletterRoomTypeAdd = function () {
    if (addBusy) return;
    addOpen = true; addMessage = ""; addMessageTone = ""; rerender();
    setTimeout(() => document.getElementById("ciLineNewRoomType")?.focus(), 0);
  };

  global.cancelCiLineNewsletterRoomTypeAdd = function () {
    if (addBusy) return;
    addOpen = false; addDraft = ""; addMessage = ""; addMessageTone = ""; rerender();
  };

  global.setCiLineNewsletterRoomTypeDraft = function (value) { addDraft = String(value ?? ""); };

  global.addCiLineNewsletterRoomType = async function () {
    const service = global.StateroomTypesService;
    if (!service || addBusy) return;
    const input = document.getElementById("ciLineNewRoomType");
    addDraft = String(input?.value ?? addDraft ?? "");
    const requestedName = service.trimName(addDraft);
    if (!requestedName) {
      addMessage = "Enter a room type name."; addMessageTone = "error"; addOpen = true; rerender();
      setTimeout(() => document.getElementById("ciLineNewRoomType")?.focus(), 0);
      return;
    }

    const selectedBefore = checkedTypeIds();
    addBusy = true;
    try {
      const allTypes = await service.listAllStateroomTypes();
      const key = service.normalizeName(requestedName);
      let target = allTypes.find((row) => service.normalizeName(row?.name) === key) || null;
      let created = false;
      if (!target) {
        const validation = service.buildCreatePayload({ name: requestedName, existingRows: allTypes });
        if (!validation.ok) throw new Error(validation.error);
        target = await service.createStateroomType(validation.payload);
        created = true;
      }
      if (!target?.id) throw new Error("The room type was saved but no id was returned.");
      selectedBefore.add(String(target.id));
      await global.loadStateroomTypesForPricing({ rerender: false });
      addOpen = false; addDraft = ""; addBusy = false; addMessageTone = "success";
      addMessage = created
        ? `“${target.name || requestedName}” was added to the master list and selected. Click Save line to save this cruise-line allocation.`
        : `“${target.name || requestedName}” already exists and has been selected. Click Save line to save this cruise-line allocation.`;
      rerender();
      setTimeout(() => applyCheckedTypeIds(selectedBefore), 0);
    } catch (error) {
      addBusy = false; addOpen = true; addMessage = error?.message || "Could not add the room type."; addMessageTone = "error"; rerender();
      setTimeout(() => { applyCheckedTypeIds(selectedBefore); document.getElementById("ciLineNewRoomType")?.focus(); }, 0);
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
