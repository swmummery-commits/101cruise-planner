/**
 * Ship stateroom integration for the canonical Stateroom Types catalogue.
 * Replaces free-text cabin-type entry with cruise-line-filtered canonical selects,
 * while preserving legacy labels until an admin deliberately reconciles them.
 */
(function (global) {
  "use strict";

  let renderedLineId = "";
  let addOpen = false;
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

  function service() { return global.StateroomTypesService || null; }
  function currentLineId() { return String(document.getElementById("ciShipLineId")?.value || renderedLineId || "").trim(); }
  function allTypes() {
    try { return Array.isArray(stateroomTypesActive) ? stateroomTypesActive : []; } catch (_) { return []; }
  }
  function allocationMap() {
    try { return cruiseLineStateroomAllocations || {}; } catch (_) { return {}; }
  }

  function selectOptions(currentLabel) {
    const svc = service();
    if (!svc) return [{ value: currentLabel || "", label: currentLabel || "Select room type", selected: true }];
    return svc.buildRoomTypeSelectOptionsForCruiseLine(allTypes(), currentLineId(), allocationMap(), currentLabel);
  }

  function renderOptions(currentLabel) {
    return selectOptions(currentLabel).map((option) =>
      `<option value="${escapeHtml(option.value)}" ${option.selected ? "selected" : ""}>${escapeHtml(option.label)}</option>`
    ).join("");
  }

  function refreshStateroomSelects() {
    document.querySelectorAll("select.ci-stateroom-label").forEach((select) => {
      const current = select.value || select.dataset.currentValue || "";
      select.innerHTML = renderOptions(current);
      if (Array.from(select.options).some((opt) => opt.value === current)) select.value = current;
    });
  }

  function messageHtml() {
    if (!addMessage) return "";
    const klass = addMessageTone === "error" ? "admin-error" : addMessageTone === "success" ? "admin-success" : addMessageTone === "running" ? "admin-running" : "";
    return `<div class="admin-message ${klass}" style="margin-top:8px;">${escapeHtml(addMessage)}</div>`;
  }

  function addPanelHtml() {
    return `
      <div class="ci-stateroom-canonical-tools" style="margin-top:10px;">
        <div class="admin-actions-row">
          <button type="button" class="admin-button secondary small" onclick="toggleCiShipStateroomTypeAdd()" ${addBusy ? "disabled" : ""}>+ Add new room type</button>
        </div>
        ${addOpen ? `
          <div class="admin-field" style="max-width:520px;margin-top:10px;">
            <label for="ciShipNewStateroomType">New stateroom type</label>
            <input id="ciShipNewStateroomType" type="text" maxlength="120" autocomplete="off" placeholder="e.g. Ocean Penthouse Suite"
              onkeydown="if(event.key==='Enter'){event.preventDefault();saveCiShipNewStateroomType();}" ${addBusy ? "disabled" : ""}>
          </div>
          <div class="admin-form-actions" style="margin-top:-8px;">
            <button type="button" class="admin-button small" onclick="saveCiShipNewStateroomType()" ${addBusy ? "disabled" : ""}>${addBusy ? "Adding…" : "Add & select"}</button>
            <button type="button" class="admin-button secondary small" onclick="cancelCiShipStateroomTypeAdd()" ${addBusy ? "disabled" : ""}>Cancel</button>
          </div>` : ""}
        ${messageHtml()}
        <p class="admin-small" style="margin-top:8px;">Room types come from Administration → Stateroom Types. The selected cruise line controls which types appear here.</p>
      </div>`;
  }

  if (typeof renderCiStateroomRow === "function") {
    renderCiStateroomRow = function renderCiStateroomRowCanonical(row, index) {
      const countVal = row?.count === "" || row?.count == null ? "" : String(row.count);
      const sqmVal = row?.sqm === "" || row?.sqm == null ? "" : String(row.sqm);
      const current = String(row?.label || "");
      return `
        <div class="ci-stateroom-row" data-index="${index}">
          <select class="ci-stateroom-label" data-current-value="${escapeHtml(current)}" onchange="updateCiStateroomTotals()">
            ${renderOptions(current)}
          </select>
          <input type="number" min="0" step="1" class="ci-stateroom-count" value="${escapeHtml(countVal)}" placeholder="Count" oninput="updateCiStateroomTotals()">
          <input type="number" min="0" step="0.1" class="ci-stateroom-sqm" value="${escapeHtml(sqmVal)}" placeholder="m²" oninput="updateCiStateroomTotals()">
          <button type="button" class="admin-button secondary small" onclick="removeCiStateroomRow(${index})">Remove</button>
        </div>`;
    };
  }

  if (typeof renderCiStateroomEditor === "function") {
    const originalRenderEditor = renderCiStateroomEditor;
    renderCiStateroomEditor = function renderCiStateroomEditorCanonical(ship) {
      renderedLineId = String(ship?.cruise_line_id || "").trim();
      return `${originalRenderEditor(ship)}${addPanelHtml()}`;
    };
  }

  global.toggleCiShipStateroomTypeAdd = function () {
    if (addBusy) return;
    addOpen = !addOpen; addMessage = ""; addMessageTone = "";
    if (typeof global.renderCiAdmin === "function") global.renderCiAdmin();
    setTimeout(() => document.getElementById("ciShipNewStateroomType")?.focus(), 0);
  };

  global.cancelCiShipStateroomTypeAdd = function () {
    if (addBusy) return;
    addOpen = false; addMessage = ""; addMessageTone = "";
    if (typeof global.renderCiAdmin === "function") global.renderCiAdmin();
  };

  global.saveCiShipNewStateroomType = async function () {
    const svc = service();
    if (!svc || addBusy) return;
    const lineId = currentLineId();
    if (!lineId) {
      addMessage = "Select a cruise line first."; addMessageTone = "error";
      if (typeof global.renderCiAdmin === "function") global.renderCiAdmin();
      return;
    }
    const requestedName = svc.trimName(document.getElementById("ciShipNewStateroomType")?.value || "");
    if (!requestedName) {
      addMessage = "Enter a room type name."; addMessageTone = "error";
      if (typeof global.renderCiAdmin === "function") global.renderCiAdmin();
      return;
    }

    addBusy = true; addMessage = "Adding room type…"; addMessageTone = "running";
    try {
      const types = await svc.listAllStateroomTypes();
      const key = svc.normalizeName(requestedName);
      let target = types.find((row) => svc.normalizeName(row?.name) === key) || null;
      let created = false;
      if (!target) {
        const validation = svc.buildCreatePayload({ name: requestedName, existingRows: types });
        if (!validation.ok) throw new Error(validation.error);
        target = await svc.createStateroomType(validation.payload);
        created = true;
      }
      if (!target?.id) throw new Error("The room type was saved but no id was returned.");

      const existingIds = new Set((allocationMap()[lineId] || []).map(String));
      existingIds.add(String(target.id));
      const updatedMap = await svc.saveCruiseLineStateroomTypes(lineId, [...existingIds]);
      try { cruiseLineStateroomAllocations = updatedMap; } catch (_) {}
      const refreshedTypes = await svc.listAllStateroomTypes();
      try { stateroomTypesActive = refreshedTypes; } catch (_) {}

      addOpen = false; addBusy = false;
      addMessage = created
        ? `“${target.name || requestedName}” was added to the master list, allocated to this cruise line and selected for this ship.`
        : `“${target.name || requestedName}” already existed. It is now allocated to this cruise line and selected for this ship.`;
      addMessageTone = "success";

      if (typeof addCiStateroomRow === "function") addCiStateroomRow();
      refreshStateroomSelects();
      const rows = Array.from(document.querySelectorAll("select.ci-stateroom-label"));
      const last = rows[rows.length - 1];
      if (last) {
        last.value = target.name;
        last.dataset.currentValue = target.name;
        last.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const tools = document.querySelector(".ci-stateroom-canonical-tools");
      if (tools) {
        tools.querySelector(".admin-message")?.remove();
        tools.insertAdjacentHTML("beforeend", messageHtml());
      }
    } catch (error) {
      addBusy = false; addOpen = true; addMessage = error?.message || "Could not add the room type."; addMessageTone = "error";
      if (typeof global.renderCiAdmin === "function") global.renderCiAdmin();
    }
  };

  function captureShipTypeSelection() {
    const svc = service();
    const byName = new Map(allTypes().map((type) => [svc?.normalizeName(type?.name), type]));
    const rows = Array.from(document.querySelectorAll("select.ci-stateroom-label"));
    const selected = [];
    let allCanonical = true;
    rows.forEach((select, index) => {
      const label = String(select.value || "").trim();
      if (!label) return;
      const type = byName.get(svc?.normalizeName(label));
      if (!type?.id) { allCanonical = false; return; }
      selected.push({ id: String(type.id), label: type.name, display_order: index + 1 });
    });
    const deduped = [];
    const seen = new Set();
    for (const item of selected) {
      if (seen.has(item.id)) continue;
      seen.add(item.id); deduped.push(item);
    }
    return { selected: deduped, allCanonical };
  }

  async function syncShipTypeLinks(shipId, snapshot) {
    const db = global.supabaseClient;
    if (!db || !shipId || !snapshot) return;
    if (snapshot.allCanonical) {
      const del = await db.from("ship_stateroom_types").delete().eq("ship_id", shipId);
      if (del.error) throw new Error(del.error.message);
    }
    if (!snapshot.selected.length) return;
    const result = await db.from("ship_stateroom_types").upsert(snapshot.selected.map((item) => ({
      ship_id: shipId,
      stateroom_type_id: item.id,
      source_label: item.label,
      display_order: item.display_order
    })), { onConflict: "ship_id,stateroom_type_id" });
    if (result.error) throw new Error(result.error.message);
  }

  if (typeof persistCiShip === "function") {
    const originalPersistCiShip = persistCiShip;
    persistCiShip = async function persistCiShipWithCanonicalTypes(options) {
      const snapshot = captureShipTypeSelection();
      const result = await originalPersistCiShip(options);
      if (result === false) return false;
      let shipId = "";
      try { shipId = String(editingCiShipId || document.getElementById("ciShipId")?.value || ""); } catch (_) {}
      if (shipId) {
        try {
          await syncShipTypeLinks(shipId, snapshot);
        } catch (error) {
          console.error("Could not sync canonical ship stateroom types", error);
          try {
            ciMessage = `Ship saved, but canonical room-type links could not be updated: ${error.message || error}`;
            ciMessageTone = "error";
            if (typeof global.renderCiAdmin === "function") global.renderCiAdmin();
          } catch (_) {}
        }
      }
      return result;
    };
  }

  document.addEventListener("change", async function (event) {
    if (event.target?.id !== "ciShipLineId") return;
    renderedLineId = String(event.target.value || "").trim();
    try {
      if (typeof global.loadStateroomTypesForPricing === "function") await global.loadStateroomTypesForPricing({ rerender: false });
    } catch (_) {}
    refreshStateroomSelects();
  }, true);

  setTimeout(() => {
    if (typeof global.loadStateroomTypesForPricing === "function") global.loadStateroomTypesForPricing({ rerender: false }).catch(() => {});
  }, 0);
})(typeof window !== "undefined" ? window : globalThis);
