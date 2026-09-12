/**
 * Cruise line newsletter room-type selector enhancements.
 *
 * Keeps Administration → Stateroom Types manual ordering intact, while making
 * the Cruise Lines → Room Types checklist easier to scan and allowing admins
 * to create/select a missing canonical room type without leaving the line.
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
      String(a?.name || "").localeCompare(String(b?.name || ""), "en", {
        sensitivity: "base",
        numeric: true
      })
    );
  }

  function checkedTypeIds() {
    return new Set(
      Array.from(document.querySelectorAll(".ci-line-stateroom-type-cb:checked"))
        .map((el) => String(el.value || "").trim())
        .filter(Boolean)
    );
  }

  function rerender() {
    if (typeof global.renderCiAdmin === "function") {
      global.renderCiAdmin();
      return;
    }
    if (typeof global.renderAdmin === "function") global.renderAdmin();
  }

  function applyCheckedTypeIds(ids) {
    const selected = ids instanceof Set ? ids : new Set(ids || []);
    document.querySelectorAll(".ci-line-stateroom-type-cb").forEach((el) => {
      el.checked = selected.has(String(el.value || ""));
    });
    if (typeof global.updateCiLineSaveButtonState === "function") {
      global.updateCiLineSaveButtonState();
    }
  }

  function messageHtml() {
    if (!addMessage) return "";
    const klass =
      addMessageTone === "error"
        ? "admin-error"
        : addMessageTone === "success"
          ? "admin-success"
          : addMessageTone === "running"
            ? "admin-running"
            : "";
    return `<div class="admin-message ${klass}">${escapeHtml(addMessage)}</div>`;
  }

  function addFormHtml() {
    if (!addOpen) return messageHtml();
    return `
      <div class="admin-field" style="margin-top:12px; max-width:520px;">
        <label for="ciLineNewRoomType">New room type</label>
        <input
          id="ciLineNewRoomType"
          type="text"
          maxlength="120"
          autocomplete="off"
          placeholder="e.g. Ocean Penthouse Suite"
          value="${escapeHtml(addDraft)}"
          oninput="setCiLineNewsletterRoomTypeDraft(this.value)"
          onkeydown="if (event.key === 'Enter') { event.preventDefault(); addCiLineNewsletterRoomType(); }"
          ${addBusy ? "disabled" : ""}
        >
      </div>
      <div class="admin-form-actions" style="margin-top:-8px; margin-bottom:8px;">
        <button type="button" class="admin-button small" onclick="addCiLineNewsletterRoomType()" ${addBusy ? "disabled" : ""}>
          ${addBusy ? "Adding…" : "Add & select"}
        </button>
        <button type="button" class="admin-button secondary small" onclick="cancelCiLineNewsletterRoomTypeAdd()" ${addBusy ? "disabled" : ""}>Cancel</button>
      </div>
      ${messageHtml()}
    `;
  }

  function roomTypeGridHtml(types, assigned) {
    if (!types.length) {
      return `<p class="admin-small">No active room types exist yet. Add the first room type here, or manage the full catalogue under Administration → Stateroom Types.</p>`;
    }
    return `
      <div class="ci-checkbox-row ci-stateroom-type-grid">
        ${types
          .map(
            (type) => `
          <label class="ci-check-control">
            <input type="checkbox" class="ci-line-stateroom-type-cb" value="${escapeHtml(type.id)}" ${assigned.has(String(type.id)) ? "checked" : ""}>
            ${escapeHtml(type.name)}
          </label>
        `
          )
          .join("")}
      </div>
    `;
  }

  // Override only the Cruise Line room-type section. The canonical Stateroom
  // Types page keeps its drag-defined display_order for pricing dropdowns.
  global.renderCiLineStateroomTypesSection = function renderCiLineStateroomTypesSectionAlpha(line) {
    if (!line?.id) return "";
    if (stateroomTypesCatalogLoading) {
      return `
        <div class="ci-stateroom-types-panel">
          <h4>Room types for newsletter pricing</h4>
          <p class="admin-muted admin-running-status" role="status">Loading stateroom types…</p>
        </div>`;
    }
    if (stateroomTypesLoadError) {
      return `
        <div class="ci-stateroom-types-panel">
          <h4>Room types for newsletter pricing</h4>
          <div class="admin-message admin-error">${escapeHtml(stateroomTypesLoadError)}</div>
          <button type="button" class="admin-button secondary small" onclick="loadStateroomTypesForPricing({ rerender: true })">Retry</button>
        </div>`;
    }

    const types = alphaTypes(stateroomTypesActive);
    const assigned = new Set((cruiseLineStateroomAllocations[line.id] || []).map(String));

    return `
      <div class="ci-stateroom-types-panel">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
          <h4 style="margin-bottom:0;">Room types for newsletter pricing</h4>
          <button type="button" class="admin-button secondary small" onclick="openCiLineNewsletterRoomTypeAdd()" ${addBusy ? "disabled" : ""}>+ Add room type</button>
        </div>
        <p class="admin-small" style="margin-top:8px;">Select the room types available when entering newsletter prices for this cruise line. Leave all unchecked to allow every active type. Room types are shown A–Z.</p>
        ${addFormHtml()}
        ${roomTypeGridHtml(types, assigned)}
      </div>`;
  };

  global.openCiLineNewsletterRoomTypeAdd = function openCiLineNewsletterRoomTypeAdd() {
    if (addBusy) return;
    addOpen = true;
    addMessage = "";
    addMessageTone = "";
    rerender();
    setTimeout(() => document.getElementById("ciLineNewRoomType")?.focus(), 0);
  };

  global.cancelCiLineNewsletterRoomTypeAdd = function cancelCiLineNewsletterRoomTypeAdd() {
    if (addBusy) return;
    addOpen = false;
    addDraft = "";
    addMessage = "";
    addMessageTone = "";
    rerender();
  };

  global.setCiLineNewsletterRoomTypeDraft = function setCiLineNewsletterRoomTypeDraft(value) {
    addDraft = String(value ?? "");
  };

  global.addCiLineNewsletterRoomType = async function addCiLineNewsletterRoomType() {
    const svc = global.StateroomTypesService;
    if (!svc || addBusy) return;

    const input = document.getElementById("ciLineNewRoomType");
    addDraft = String(input?.value ?? addDraft ?? "");
    const requestedName = svc.trimName(addDraft);
    if (!requestedName) {
      addMessage = "Enter a room type name.";
      addMessageTone = "error";
      addOpen = true;
      rerender();
      setTimeout(() => document.getElementById("ciLineNewRoomType")?.focus(), 0);
      return;
    }

    const selectedBefore = checkedTypeIds();
    addBusy = true;
    if (input) input.disabled = true;
    const addButton = document.querySelector('[onclick="addCiLineNewsletterRoomType()"]');
    if (addButton) addButton.disabled = true;

    try {
      const allTypes = await svc.listAllStateroomTypes();
      const normalized = svc.normalizeName(requestedName);
      let target = (allTypes || []).find((row) => svc.normalizeName(row?.name) === normalized) || null;
      let outcome = "selected";

      if (target?.is_active === false) {
        const validation = svc.validateStateroomTypeInput({
          name: target.name,
          is_active: true,
          existingRows: allTypes,
          editingId: target.id
        });
        if (!validation.ok) throw new Error(validation.error);
        target = await svc.updateStateroomType(target.id, validation.payload);
        outcome = "reactivated";
      } else if (!target) {
        const validation = svc.buildCreatePayload({
          name: requestedName,
          is_active: true,
          existingRows: allTypes
        });
        if (!validation.ok) throw new Error(validation.error);
        target = await svc.createStateroomType(validation.payload);
        outcome = "created";
      }

      if (!target?.id) throw new Error("The room type was saved but no room type id was returned.");

      selectedBefore.add(String(target.id));
      await global.loadStateroomTypesForPricing({ rerender: false });

      addOpen = false;
      addDraft = "";
      addMessageTone = "success";
      addMessage =
        outcome === "created"
          ? `“${target.name || requestedName}” was added and selected. Click Save line to save this cruise-line selection.`
          : outcome === "reactivated"
            ? `“${target.name || requestedName}” already existed but was inactive. It has been reactivated and selected. Click Save line to save this cruise-line selection.`
            : `“${target.name || requestedName}” already exists and has been selected. Click Save line to save this cruise-line selection.`;

      addBusy = false;
      rerender();
      setTimeout(() => applyCheckedTypeIds(selectedBefore), 0);
    } catch (error) {
      addBusy = false;
      addOpen = true;
      addMessage = error?.message || "Could not add the room type.";
      addMessageTone = "error";
      rerender();
      setTimeout(() => {
        applyCheckedTypeIds(selectedBefore);
        document.getElementById("ciLineNewRoomType")?.focus();
      }, 0);
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
