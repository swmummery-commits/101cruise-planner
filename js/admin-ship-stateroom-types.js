/**
 * Ship stateroom integration for the canonical Stateroom Types catalogue.
 * The breakdown dropdown lists room types already allocated to the ship's
 * cruise line. Adding a name selects that existing type, or creates it and
 * allocates it to this cruise line only. Other cruise lines and other ships
 * are left unchanged.
 */
(function (global) {
  "use strict";

  const ADD_NEW_VALUE = "__add_new_stateroom_type__";
  let renderedLineId = "";
  let inlineAddSelect = null;
  let inlineAddPreviousValue = "";
  let addBusy = false;

  function escapeHtml(value) {
    if (typeof global.esc === "function") return global.esc(value);
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function parseStateroomSqm(raw) {
    if (raw === null || raw === undefined) return "";
    const text = String(raw).trim().replace(/[–—]/g, "-");
    if (!text) return "";

    const singleMatch = text.match(/^(\d+(?:\.\d+)?)$/);
    if (singleMatch) {
      const value = Number(singleMatch[1]);
      return Number.isFinite(value) && value > 0 ? value : "";
    }

    const rangeMatch = text.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
    if (!rangeMatch) return "";

    const min = Number(rangeMatch[1]);
    const max = Number(rangeMatch[2]);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0 || max < min) return "";
    if (min === max) return min;
    return `${min}-${max}`;
  }

  function roomSizeInputValue(row) {
    const parsed = parseStateroomSqm(row?.sqm);
    if (parsed !== "") return String(parsed);
    const min = Number(row?.sqm_min);
    const max = Number(row?.sqm_max);
    if (Number.isFinite(min) && min > 0 && Number.isFinite(max) && max >= min) {
      return min === max ? String(min) : `${min}-${max}`;
    }
    return "";
  }

  function validateRoomSizeInputs() {
    const inputs = Array.from(document.querySelectorAll("input.ci-stateroom-sqm"));
    for (const input of inputs) {
      input.setCustomValidity("");
      const raw = String(input.value || "").trim();
      if (!raw) continue;
      if (parseStateroomSqm(raw) !== "") continue;
      input.setCustomValidity("Enter a room size such as 26 or a range such as 25-85. The second number must be the same as or larger than the first.");
      input.reportValidity();
      input.focus();
      return false;
    }
    return true;
  }

  global.parseCiStateroomSqm = parseStateroomSqm;

  function service() { return global.StateroomTypesService || null; }
  function currentLineId() {
    return String(document.getElementById("ciShipLineId")?.value || renderedLineId || "").trim();
  }
  function currentShipId() {
    try {
      return String(editingCiShipId || document.getElementById("ciShipId")?.value || "").trim();
    } catch (_) {
      return String(document.getElementById("ciShipId")?.value || "").trim();
    }
  }
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
    const html = selectOptions(currentLabel).map((option) =>
      `<option value="${escapeHtml(option.value)}" ${option.selected ? "selected" : ""}>${escapeHtml(option.label)}</option>`
    ).join("");
    if (!currentLineId()) return html;
    return `${html}<option value="${ADD_NEW_VALUE}">＋ Add new room type…</option>`;
  }

  function refreshStateroomSelects() {
    document.querySelectorAll("select.ci-stateroom-label").forEach((select) => {
      if (select === inlineAddSelect && addBusy) return;
      const current = select.value && select.value !== ADD_NEW_VALUE
        ? select.value
        : (select.dataset.currentValue || select.dataset.previousValue || "");
      select.innerHTML = renderOptions(current);
      if (Array.from(select.options).some((opt) => opt.value === current)) select.value = current;
      select.dataset.currentValue = select.value || current || "";
    });
  }

  function removeInlineAddEditor({ restore = true } = {}) {
    document.querySelector(".ci-stateroom-inline-add")?.remove();
    if (restore && inlineAddSelect && document.body.contains(inlineAddSelect)) {
      const restoreValue = inlineAddPreviousValue || inlineAddSelect.dataset.currentValue || "";
      if (Array.from(inlineAddSelect.options).some((opt) => opt.value === restoreValue)) inlineAddSelect.value = restoreValue;
      else inlineAddSelect.value = "";
    }
    inlineAddSelect = null;
    inlineAddPreviousValue = "";
    addBusy = false;
  }

  function inlineAddMessage(message, tone = "") {
    const el = document.getElementById("ciShipInlineStateroomMessage");
    if (!el) return;
    el.className = `admin-message ${tone === "error" ? "admin-error" : tone === "success" ? "admin-success" : tone === "running" ? "admin-running" : ""}`;
    el.textContent = message || "";
  }

  function openInlineAddEditor(select) {
    if (!select || addBusy) return;
    removeInlineAddEditor({ restore: true });
    inlineAddSelect = select;
    inlineAddPreviousValue = String(select.dataset.previousValue || select.dataset.currentValue || "").trim();
    const restoreValue = inlineAddPreviousValue;
    if (Array.from(select.options).some((opt) => opt.value === restoreValue)) select.value = restoreValue;
    else select.value = "";

    const row = select.closest(".ci-stateroom-row");
    if (!row) return;
    row.insertAdjacentHTML("afterend", `
      <div class="ci-stateroom-inline-add" style="margin:8px 0 12px 0;padding:12px;border:1px solid #d8dee8;border-radius:10px;background:#f8fafc;">
        <div class="admin-field" style="margin:0;max-width:560px;">
          <label for="ciShipInlineNewStateroomType"><strong>Add a new room type</strong></label>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <input id="ciShipInlineNewStateroomType" type="text" maxlength="120" autocomplete="off" placeholder="e.g. Ocean Penthouse Suite" style="min-width:280px;flex:1;"
              onkeydown="if(event.key==='Enter'){event.preventDefault();saveCiShipInlineStateroomType();}">
            <button type="button" class="admin-button small" onclick="saveCiShipInlineStateroomType()">Add & select</button>
            <button type="button" class="admin-button secondary small" onclick="cancelCiShipInlineStateroomType()">Cancel</button>
          </div>
          <div id="ciShipInlineStateroomMessage" class="admin-message" style="margin-top:6px;"></div>
          <div class="admin-small" style="margin-top:5px;">An existing room type is selected as-is. A new name is added to the catalogue and to this cruise line only.</div>
        </div>
      </div>`);
    setTimeout(() => document.getElementById("ciShipInlineNewStateroomType")?.focus(), 0);
  }

  global.handleCiShipStateroomTypeChange = function (select) {
    if (!select) return;
    if (select.value === ADD_NEW_VALUE) {
      openInlineAddEditor(select);
      return;
    }
    select.dataset.currentValue = select.value || "";
    select.dataset.previousValue = select.value || "";
    if (inlineAddSelect === select) removeInlineAddEditor({ restore: false });
  };

  global.cancelCiShipInlineStateroomType = function () {
    if (addBusy) return;
    removeInlineAddEditor({ restore: true });
  };

  async function selectInlineStateroomType() {
    const svc = service();
    if (!svc || addBusy || !inlineAddSelect) return;

    const lineId = currentLineId();
    if (!lineId) {
      inlineAddMessage("Select a cruise line first.", "error");
      return;
    }
    const requestedName = svc.trimName(document.getElementById("ciShipInlineNewStateroomType")?.value || "");
    if (!requestedName) {
      inlineAddMessage("Enter a room type name.", "error");
      document.getElementById("ciShipInlineNewStateroomType")?.focus();
      return;
    }

    addBusy = true;
    inlineAddMessage("Adding room type…", "running");
    const input = document.getElementById("ciShipInlineNewStateroomType");
    if (input) input.disabled = true;
    document.querySelectorAll(".ci-stateroom-inline-add button").forEach((button) => { button.disabled = true; });

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
        types.push(target);
      }
      if (!target?.id) throw new Error("The room type was saved but no id was returned.");

      const allocations = await svc.loadCruiseLineStateroomAllocations();
      const alreadyAllocated = new Set((allocations?.[lineId] || []).map(String)).has(String(target.id));
      const updatedMap = alreadyAllocated
        ? allocations
        : await svc.addCruiseLineStateroomType(lineId, target.id);
      try { cruiseLineStateroomAllocations = updatedMap; } catch (_) {}
      try { stateroomTypesActive = svc.sortStateroomTypes(types); } catch (_) {}

      const targetSelect = inlineAddSelect;
      addBusy = false;
      refreshStateroomSelects();
      if (targetSelect && document.body.contains(targetSelect)) {
        targetSelect.value = target.name;
        targetSelect.dataset.currentValue = target.name;
        targetSelect.dataset.previousValue = target.name;
      }
      if (typeof global.updateCiStateroomTotals === "function") global.updateCiStateroomTotals();
      else if (typeof updateCiStateroomTotals === "function") updateCiStateroomTotals();

      const name = target.name || requestedName;
      const message = created
        ? `Created “${name}”, allocated it to this cruise line, and selected it. Other cruise lines were not changed.`
        : alreadyAllocated
          ? `“${name}” is already allocated to this cruise line and is now selected.`
          : `“${name}” is already in the catalogue. It was allocated to this cruise line and selected. Other cruise lines were not changed.`;
      inlineAddMessage(message, "success");

      setTimeout(() => {
        if (inlineAddSelect === targetSelect) removeInlineAddEditor({ restore: false });
      }, 1100);
    } catch (error) {
      addBusy = false;
      inlineAddMessage(error?.message || "Could not add the room type.", "error");
      if (input) input.disabled = false;
      document.querySelectorAll(".ci-stateroom-inline-add button").forEach((button) => { button.disabled = false; });
    }
  }

  global.saveCiShipInlineStateroomType = async function () {
    const run = () => selectInlineStateroomType();
    if (global.AdminLoading?.withSaving) {
      return global.AdminLoading.withSaving(run, {
        key: "ci-ship-inline-room-type",
        supportMessage: "Saving room type…"
      });
    }
    return run();
  };

  if (typeof renderCiStateroomRow === "function") {
    renderCiStateroomRow = function renderCiStateroomRowCanonical(row, index) {
      const countVal = row?.count === "" || row?.count == null ? "" : String(row.count);
      const sqmVal = roomSizeInputValue(row);
      const current = String(row?.label || "");
      return `
        <div class="ci-stateroom-row" data-index="${index}">
          <select class="ci-stateroom-label" data-current-value="${escapeHtml(current)}"
            onfocus="this.dataset.previousValue=this.value"
            onchange="handleCiShipStateroomTypeChange(this);updateCiStateroomTotals()">
            ${renderOptions(current)}
          </select>
          <input type="number" min="0" step="1" class="ci-stateroom-count" value="${escapeHtml(countVal)}" placeholder="Count" oninput="updateCiStateroomTotals()">
          <input type="text" inputmode="decimal" class="ci-stateroom-sqm" value="${escapeHtml(sqmVal)}" placeholder="e.g. 26 or 25-85" title="Room size in m². Enter one size (26) or a range (25-85)." oninput="this.setCustomValidity('');updateCiStateroomTotals()">
          <button type="button" class="admin-button secondary small" onclick="removeCiStateroomRow(${index})">Remove</button>
        </div>`;
    };
  }

  if (typeof renderCiStateroomEditor === "function") {
    const originalRenderEditor = renderCiStateroomEditor;
    renderCiStateroomEditor = function renderCiStateroomEditorCanonical(ship) {
      renderedLineId = String(ship?.cruise_line_id || "").trim();
      return `${originalRenderEditor(ship)}
        <p class="admin-small" style="margin-top:8px;">Choose a room type above, or select <strong>＋ Add new room type…</strong> inside the dropdown to create one without leaving this ship.</p>`;
    };
  }

  function captureShipTypeSelection() {
    const svc = service();
    const byName = new Map(allTypes().map((type) => [svc?.normalizeName(type?.name), type]));
    const rows = Array.from(document.querySelectorAll("select.ci-stateroom-label"));
    const selected = [];
    let allCanonical = true;
    rows.forEach((select, index) => {
      const label = String(select.value || "").trim();
      if (!label || label === ADD_NEW_VALUE) return;
      const type = byName.get(svc?.normalizeName(label));
      if (!type?.id) { allCanonical = false; return; }
      selected.push({ id: String(type.id), label: type.name, display_order: index + 1 });
    });
    const deduped = [];
    const seen = new Set();
    for (const item of selected) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      deduped.push(item);
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
      if (!validateRoomSizeInputs()) return false;
      const snapshot = captureShipTypeSelection();
      const result = await originalPersistCiShip(options);
      if (result === false) return false;
      const shipId = currentShipId();
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
      if (typeof global.loadStateroomTypesForPricing === "function") {
        await global.loadStateroomTypesForPricing({ rerender: false });
      }
    } catch (_) {}
    refreshStateroomSelects();
  }, true);

  global.refreshCiShipStateroomTypeSelects = refreshStateroomSelects;
})(typeof window !== "undefined" ? window : globalThis);
