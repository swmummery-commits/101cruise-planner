/**
 * Ship stateroom size extensions.
 * Adds Balcony Size and class-level size defaults while preserving ship overrides.
 */
(function (global) {
  "use strict";

  let classDefaultsLoadKey = "";

  function esc(value) {
    if (typeof global.esc === "function") return global.esc(value);
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function parseSize(raw) {
    if (raw === null || raw === undefined) return "";
    const text = String(raw).trim().replace(/[–—]/g, "-");
    if (!text) return "";

    const single = text.match(/^(\d+(?:\.\d+)?)$/);
    if (single) {
      const value = Number(single[1]);
      return Number.isFinite(value) && value > 0 ? value : "";
    }

    const range = text.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
    if (!range) return "";
    const min = Number(range[1]);
    const max = Number(range[2]);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0 || max < min) return "";
    return min === max ? min : `${min}-${max}`;
  }

  function sizeValue(raw) {
    const parsed = parseSize(raw);
    return parsed === "" ? "" : String(parsed);
  }

  function currentLineId() {
    try {
      return String(document.getElementById("ciShipLineId")?.value || "").trim();
    } catch (_) {
      return "";
    }
  }

  function currentShipId() {
    try {
      return String(editingCiShipId || document.getElementById("ciShipId")?.value || "").trim();
    } catch (_) {
      return String(document.getElementById("ciShipId")?.value || "").trim();
    }
  }

  function currentShipClass() {
    return String(document.getElementById("ciShipClass")?.value || "").trim();
  }

  function rawRows(raw) {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (_) {
        return [];
      }
    }
    return [];
  }

  function normalizeLabel(value) {
    return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
  }

  // Preserve the new balcony/source fields when the legacy normalizer rebuilds rows.
  if (typeof normalizeCiStateroomBreakdown === "function") {
    const originalNormalize = normalizeCiStateroomBreakdown;
    normalizeCiStateroomBreakdown = function normalizeCiStateroomBreakdownWithSizes(raw) {
      const normalized = originalNormalize(raw);
      const sourceRows = rawRows(raw);
      if (!Array.isArray(normalized) || !sourceRows.length) return normalized;

      const unused = new Set(sourceRows.map((_row, index) => index));
      return normalized.map((row, index) => {
        const key = normalizeLabel(row && row.label);
        let sourceIndex = sourceRows.findIndex((candidate, candidateIndex) =>
          unused.has(candidateIndex) && candidate && typeof candidate === "object" && normalizeLabel(candidate.label) === key
        );
        if (sourceIndex < 0 && unused.has(index)) sourceIndex = index;
        const source = sourceIndex >= 0 ? sourceRows[sourceIndex] : null;
        if (sourceIndex >= 0) unused.delete(sourceIndex);
        if (!source || typeof source !== "object") return row;

        const merged = { ...row };
        if (Object.prototype.hasOwnProperty.call(source, "balcony_sqm")) merged.balcony_sqm = source.balcony_sqm;
        if (source.sqm_source) merged.sqm_source = source.sqm_source;
        if (source.balcony_sqm_source) merged.balcony_sqm_source = source.balcony_sqm_source;
        return merged;
      });
    };
  }

  // Extend the canonical row without replacing its cruise-line room-type selector.
  if (typeof renderCiStateroomRow === "function") {
    const originalRenderRow = renderCiStateroomRow;
    renderCiStateroomRow = function renderCiStateroomRowWithBalcony(row, index) {
      let html = originalRenderRow(row, index);
      const sqmSource = String(row && row.sqm_source || "").trim();
      const balconySource = String(row && row.balcony_sqm_source || "").trim();
      const balconyValue = sizeValue(row && row.balcony_sqm);

      html = html.replace(
        'class="ci-stateroom-sqm"',
        `class="ci-stateroom-sqm" data-size-source="${esc(sqmSource)}"`
      );

      const removeNeedle = `<button type="button" class="admin-button secondary small" onclick="removeCiStateroomRow(${index})">Remove</button>`;
      const balconyInput = `<input type="text" inputmode="decimal" class="ci-stateroom-balcony-sqm" data-size-source="${esc(balconySource)}" value="${esc(balconyValue)}" placeholder="Balcony size" title="Balcony size in m². Enter one size (5) or a range (4-8). Leave blank if unknown or not applicable." oninput="this.setCustomValidity('');this.dataset.sizeSource='ship';updateCiStateroomTotals()">`;
      return html.replace(removeNeedle, `${balconyInput}${removeNeedle}`);
    };
  }

  document.addEventListener("input", function (event) {
    if (event.target && event.target.classList && event.target.classList.contains("ci-stateroom-sqm")) {
      event.target.dataset.sizeSource = "ship";
    }
  }, true);

  function validateSizeInputs() {
    const configs = [
      { selector: "input.ci-stateroom-sqm", label: "room" },
      { selector: "input.ci-stateroom-balcony-sqm", label: "balcony" }
    ];
    for (const config of configs) {
      for (const input of Array.from(document.querySelectorAll(config.selector))) {
        input.setCustomValidity("");
        const raw = String(input.value || "").trim();
        if (!raw || parseSize(raw) !== "") continue;
        input.setCustomValidity(`Enter the ${config.label} size as one number such as 26, or a range such as 25-85.`);
        input.reportValidity();
        input.focus();
        return false;
      }
    }
    return true;
  }

  function captureExtendedSizeRows() {
    return Array.from(document.querySelectorAll(".ci-stateroom-row")).map((row) => {
      const label = String(row.querySelector(".ci-stateroom-label")?.value || "").trim();
      const sqmInput = row.querySelector(".ci-stateroom-sqm");
      const balconyInput = row.querySelector(".ci-stateroom-balcony-sqm");
      const sqmRaw = String(sqmInput?.value || "").trim();
      const balconyRaw = String(balconyInput?.value || "").trim();
      const item = { label };
      const sqm = sqmRaw ? parseSize(sqmRaw) : "";
      const balconySqm = balconyRaw ? parseSize(balconyRaw) : "";
      if (sqm !== "") item.sqm = sqm;
      if (balconySqm !== "") item.balcony_sqm = balconySqm;
      if (sqmInput?.dataset?.sizeSource) item.sqm_source = sqmInput.dataset.sizeSource;
      if (balconyInput?.dataset?.sizeSource) item.balcony_sqm_source = balconyInput.dataset.sizeSource;
      return item;
    }).filter((row) => row.label);
  }

  async function persistExtendedSizeFields(shipId, captured) {
    const db = global.supabaseClient;
    if (!db || !shipId || !Array.isArray(captured)) return;

    const result = await db.from("ci_cruise_ships")
      .select("stateroom_breakdown")
      .eq("id", shipId)
      .single();
    if (result.error) throw new Error(result.error.message);

    const savedRows = rawRows(result.data && result.data.stateroom_breakdown).map((row) => ({ ...(row || {}) }));
    const capturedByLabel = new Map(captured.map((row) => [normalizeLabel(row.label), row]));

    savedRows.forEach((row) => {
      const extra = capturedByLabel.get(normalizeLabel(row.label));
      if (!extra) return;

      if (Object.prototype.hasOwnProperty.call(extra, "balcony_sqm")) row.balcony_sqm = extra.balcony_sqm;
      else delete row.balcony_sqm;

      if (extra.sqm_source) row.sqm_source = extra.sqm_source;
      else delete row.sqm_source;

      if (extra.balcony_sqm_source) row.balcony_sqm_source = extra.balcony_sqm_source;
      else delete row.balcony_sqm_source;
    });

    const update = await db.from("ci_cruise_ships")
      .update({ stateroom_breakdown: savedRows })
      .eq("id", shipId);
    if (update.error) throw new Error(update.error.message);

    try {
      const index = ciCruiseShips.findIndex((ship) => String(ship.id) === String(shipId));
      if (index >= 0) ciCruiseShips[index] = { ...ciCruiseShips[index], stateroom_breakdown: savedRows };
    } catch (_) {}
  }

  // Persist balcony size and inheritance markers after the existing ship save.
  if (typeof persistCiShip === "function") {
    const originalPersist = persistCiShip;
    persistCiShip = async function persistCiShipWithExtendedSizes(options) {
      if (!validateSizeInputs()) return false;
      const captured = captureExtendedSizeRows();
      const result = await originalPersist(options);
      if (result === false) return false;

      const shipId = currentShipId();
      if (shipId) {
        try {
          await persistExtendedSizeFields(shipId, captured);
        } catch (error) {
          console.error("Could not save room/balcony size details", error);
          try {
            ciMessage = `Ship saved, but room/balcony size details could not be updated: ${error.message || error}`;
            ciMessageTone = "error";
            if (typeof global.renderCiAdmin === "function") global.renderCiAdmin();
          } catch (_) {}
          return false;
        }
      }
      return result;
    };
  }

  async function adminAccessToken() {
    const db = global.supabaseClient;
    if (!db || !db.auth) return "";
    const result = await db.auth.getSession();
    return String(result?.data?.session?.access_token || "");
  }

  function clearInheritedDomValues() {
    document.querySelectorAll(".ci-stateroom-sqm, .ci-stateroom-balcony-sqm").forEach((input) => {
      if (input.dataset.sizeSource !== "class") return;
      input.value = "";
      input.dataset.sizeSource = "";
    });
  }

  function applyDefaultsToDom(defaultRows) {
    const defaults = new Map((Array.isArray(defaultRows) ? defaultRows : []).map((row) => [normalizeLabel(row && row.label), row]));
    document.querySelectorAll(".ci-stateroom-row").forEach((row) => {
      const label = String(row.querySelector(".ci-stateroom-label")?.value || "").trim();
      const classRow = defaults.get(normalizeLabel(label));
      if (!classRow) return;

      [
        { selector: ".ci-stateroom-sqm", value: classRow.sqm },
        { selector: ".ci-stateroom-balcony-sqm", value: classRow.balcony_sqm }
      ].forEach((config) => {
        const input = row.querySelector(config.selector);
        if (!input) return;
        const source = String(input.dataset.sizeSource || "");
        const current = String(input.value || "").trim();
        const classValue = sizeValue(config.value);

        if (source === "ship") return;
        if (!source && current && classValue && sizeValue(current) !== classValue) {
          input.dataset.sizeSource = "ship";
          return;
        }
        if (classValue) input.value = classValue;
        else if (source === "class") input.value = "";
        input.dataset.sizeSource = "class";
      });
    });
  }

  async function loadClassDefaultsIntoEditor() {
    const cruiseLineId = currentLineId();
    const className = currentShipClass();
    if (!cruiseLineId || !className || !document.querySelector(".ci-stateroom-row")) return;

    const requestKey = `${cruiseLineId}::${className.toLowerCase()}`;
    classDefaultsLoadKey = requestKey;
    try {
      const token = await adminAccessToken();
      if (!token) return;
      const query = new URLSearchParams({ cruise_line_id: cruiseLineId, class_name: className });
      const response = await fetch(`/.netlify/functions/ci-ship-class-stateroom-sizes?${query.toString()}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await response.json().catch(() => ({}));
      if (classDefaultsLoadKey !== requestKey) return;
      if (!response.ok || !data.success) return;
      applyDefaultsToDom(data.stateroom_sizes || []);
    } catch (_error) {
      // Existing ship-level values remain usable if class defaults cannot be loaded.
    }
  }

  global.saveCiShipClassStateroomSizes = async function () {
    if (!validateSizeInputs()) return;
    const cruiseLineId = currentLineId();
    const className = currentShipClass();
    const shipId = currentShipId();
    const message = document.getElementById("ciShipClassSizeMessage");

    if (!cruiseLineId || !className) {
      if (message) {
        message.className = "admin-message admin-error";
        message.textContent = "A cruise line and ship class are required before class defaults can be saved.";
      }
      return;
    }

    const rows = captureExtendedSizeRows().map((row) => ({
      label: row.label,
      ...(Object.prototype.hasOwnProperty.call(row, "sqm") ? { sqm: row.sqm } : {}),
      ...(Object.prototype.hasOwnProperty.call(row, "balcony_sqm") ? { balcony_sqm: row.balcony_sqm } : {})
    }));

    if (message) {
      message.className = "admin-message admin-running";
      message.textContent = "Saving class room sizes…";
    }

    try {
      const token = await adminAccessToken();
      if (!token) throw new Error("Admin session is not available.");
      const response = await fetch("/.netlify/functions/ci-ship-class-stateroom-sizes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          cruise_line_id: cruiseLineId,
          class_name: className,
          source_ship_id: shipId,
          stateroom_sizes: rows
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        throw new Error(data.detail || data.error || `HTTP ${response.status}`);
      }

      document.querySelectorAll(".ci-stateroom-sqm, .ci-stateroom-balcony-sqm").forEach((input) => {
        input.dataset.sizeSource = "class";
      });

      if (message) {
        message.className = "admin-message admin-success";
        const count = Number(data.class_ship_count || 0);
        message.textContent = `Saved as defaults for ${className}. ${count} ship${count === 1 ? "" : "s"} in this class now use these defaults unless individually overridden.`;
      }
    } catch (error) {
      if (message) {
        message.className = "admin-message admin-error";
        message.textContent = error.message || "Could not save class room sizes.";
      }
    }
  };

  if (typeof renderCiStateroomEditor === "function") {
    const originalRenderEditor = renderCiStateroomEditor;
    renderCiStateroomEditor = function renderCiStateroomEditorWithClassSizes(ship) {
      const html = originalRenderEditor(ship);
      const className = String(ship && ship.ship_class || "").trim();
      setTimeout(() => loadClassDefaultsIntoEditor(), 0);
      if (!className) return `${html}<p class="admin-small" style="margin-top:8px;">Add a ship class to use class-level room and balcony size defaults.</p>`;
      return `${html}
        <div class="ci-stateroom-class-size-tools" style="margin-top:12px;padding-top:12px;border-top:1px solid #eee;">
          <button type="button" class="admin-button secondary small" onclick="saveCiShipClassStateroomSizes()">Save sizes as ${esc(className)} class defaults</button>
          <div class="admin-small" style="margin-top:5px;">Room Size and Balcony Size apply to other ships in this class unless that ship has its own size entered.</div>
          <div id="ciShipClassSizeMessage" class="admin-message"></div>
        </div>`;
    };
  }

  document.addEventListener("change", function (event) {
    if (!event.target || (event.target.id !== "ciShipClass" && event.target.id !== "ciShipLineId")) return;
    classDefaultsLoadKey = "";
    clearInheritedDomValues();
    setTimeout(() => loadClassDefaultsIntoEditor(), 0);
  }, true);

  const style = document.createElement("style");
  style.textContent = `
    .ci-stateroom-row {
      grid-template-columns: minmax(0, 1.4fr) minmax(72px, .35fr) minmax(105px, .5fr) minmax(105px, .5fr) auto;
    }
    @media (max-width: 720px) {
      .ci-stateroom-row { grid-template-columns: 1fr; }
    }
  `;
  document.head.appendChild(style);
})(typeof window !== "undefined" ? window : globalThis);
