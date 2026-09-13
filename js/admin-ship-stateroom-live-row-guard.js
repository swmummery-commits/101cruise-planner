/**
 * Stateroom live-row integrity guard.
 *
 * Keeps every visible stateroom field intact across Add / Remove / Move and
 * makes the complete visible row authoritative when a ship is saved.
 * A blank Count is valid: it must never cause the room type, room size or
 * balcony size to be discarded.
 */
(function (global) {
  "use strict";

  function rowRenderer() {
    return typeof global.renderCiStateroomRow === "function"
      ? global.renderCiStateroomRow
      : (typeof renderCiStateroomRow === "function" ? renderCiStateroomRow : null);
  }

  function updateTotals() {
    if (typeof global.updateCiStateroomTotals === "function") {
      global.updateCiStateroomTotals();
      return;
    }
    try {
      if (typeof updateCiStateroomTotals === "function") updateCiStateroomTotals();
    } catch (_) {}
  }

  function normaliseSize(raw) {
    if (raw === null || raw === undefined) return "";
    const text = String(raw).trim().replace(/[–—]/g, "-");
    if (!text) return "";

    const single = text.match(/^(\d+(?:\.\d+)?)$/);
    if (single) {
      const value = Number(single[1]);
      return Number.isFinite(value) && value > 0 ? value : "";
    }

    const range = text.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
    if (!range) return text;
    const min = Number(range[1]);
    const max = Number(range[2]);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0 || max < min) return text;
    return min === max ? min : `${min}-${max}`;
  }

  function normaliseLabel(value) {
    return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
  }

  function captureLiveRows() {
    const root = document.getElementById("ciStateroomBreakdown");
    if (!root) return [];

    const rows = [];
    root.querySelectorAll(".ci-stateroom-row").forEach((row) => {
      const label = String(row.querySelector(".ci-stateroom-label")?.value || "").trim();
      const countInput = row.querySelector(".ci-stateroom-count");
      const sqmInput = row.querySelector(".ci-stateroom-sqm");
      const balconyInput = row.querySelector(".ci-stateroom-balcony-sqm");

      const countRaw = String(countInput?.value || "").trim();
      const sqmRaw = String(sqmInput?.value || "").trim();
      const balconyRaw = String(balconyInput?.value || "").trim();

      // A row needs a room type, but Count is deliberately optional.
      if (!label) return;

      const item = {
        label,
        count: countRaw === "" ? null : (/^\d+$/.test(countRaw) ? Number(countRaw) : countRaw),
        sqm: sqmRaw
      };

      if (balconyRaw !== "") item.balcony_sqm = balconyRaw;
      if (sqmInput?.dataset?.sizeSource) item.sqm_source = sqmInput.dataset.sizeSource;
      if (balconyInput?.dataset?.sizeSource) item.balcony_sqm_source = balconyInput.dataset.sizeSource;

      rows.push(item);
    });
    return rows;
  }

  function toPersistedRows(rows) {
    return (Array.isArray(rows) ? rows : []).map((row) => {
      const item = {
        label: String(row?.label || "").trim(),
        count: row?.count === "" || row?.count === null || row?.count === undefined
          ? null
          : Number(row.count)
      };

      const sqm = normaliseSize(row?.sqm);
      const balconySqm = normaliseSize(row?.balcony_sqm);
      if (sqm !== "") item.sqm = sqm;
      if (balconySqm !== "") item.balcony_sqm = balconySqm;
      if (row?.sqm_source) item.sqm_source = String(row.sqm_source);
      if (row?.balcony_sqm_source) item.balcony_sqm_source = String(row.balcony_sqm_source);
      return item;
    }).filter((row) => row.label);
  }

  function rebuild(rows) {
    const root = document.getElementById("ciStateroomBreakdown");
    const render = rowRenderer();
    if (!root || !render) return;
    root.innerHTML = (rows || []).map((row, index) => render(row, index)).join("");
    updateTotals();
  }

  function addRow() {
    const rows = captureLiveRows();
    rows.push({ label: "", count: null, sqm: "", balcony_sqm: "" });
    rebuild(rows);
  }

  function removeRow(index) {
    const rows = captureLiveRows();
    if (index < 0 || index >= rows.length) return;
    rows.splice(index, 1);
    rebuild(rows);
  }

  function moveRow(index, delta) {
    const rows = captureLiveRows();
    const next = index + delta;
    if (index < 0 || index >= rows.length || next < 0 || next >= rows.length) return;
    const [item] = rows.splice(index, 1);
    rows.splice(next, 0, item);
    rebuild(rows);
  }

  function currentShipId() {
    const domId = String(document.getElementById("ciShipId")?.value || "").trim();
    if (domId) return domId;
    try {
      return String(editingCiShipId || "").trim();
    } catch (_) {
      return "";
    }
  }

  function comparableRow(row) {
    return {
      label: normaliseLabel(row?.label),
      count: row?.count === "" || row?.count === null || row?.count === undefined ? null : Number(row.count),
      sqm: normaliseSize(row?.sqm),
      balcony_sqm: normaliseSize(row?.balcony_sqm),
      sqm_source: String(row?.sqm_source || ""),
      balcony_sqm_source: String(row?.balcony_sqm_source || "")
    };
  }

  function rowsMatch(expected, actual) {
    const left = (Array.isArray(expected) ? expected : []).map(comparableRow);
    const right = (Array.isArray(actual) ? actual : []).map(comparableRow);
    return JSON.stringify(left) === JSON.stringify(right);
  }

  async function persistAndVerifyFullRows(shipId, rows) {
    const db = global.supabaseClient;
    if (!db || !shipId) throw new Error("Ship database connection is not available.");

    const persistedRows = toPersistedRows(rows);
    const result = await db
      .from("ci_cruise_ships")
      .update({ stateroom_breakdown: persistedRows })
      .eq("id", shipId)
      .select("stateroom_breakdown")
      .single();

    if (result.error) throw new Error(result.error.message);
    const verifiedRows = Array.isArray(result.data?.stateroom_breakdown)
      ? result.data.stateroom_breakdown
      : [];

    if (!rowsMatch(persistedRows, verifiedRows)) {
      throw new Error("The database did not return the complete stateroom row data after saving.");
    }

    try {
      const index = ciCruiseShips.findIndex((ship) => String(ship.id) === String(shipId));
      if (index >= 0) {
        ciCruiseShips[index] = {
          ...ciCruiseShips[index],
          stateroom_breakdown: verifiedRows
        };
      }
    } catch (_) {}

    return verifiedRows;
  }

  // Inline onclick handlers resolve these names from window, so replacing them
  // here guarantees the extended fields survive every user-initiated rebuild.
  global.addCiStateroomRow = addRow;
  global.removeCiStateroomRow = removeRow;
  global.moveCiStateroomRow = moveRow;

  // Expose capture for diagnostics / future stateroom extensions.
  global.captureCiStateroomRowsWithSizes = captureLiveRows;

  // Final integrity layer for ship save. Existing save logic historically
  // filtered out rows with a blank Count. Capture the complete live grid before
  // that save runs, then write and read back the complete rows afterwards.
  try {
    if (typeof persistCiShip === "function") {
      const originalPersistCiShip = persistCiShip;
      persistCiShip = async function persistCiShipWithFullStateroomRows(options) {
        const capturedRows = captureLiveRows();
        const shipIdBefore = currentShipId();
        const result = await originalPersistCiShip(options);
        if (result === false) return false;

        const shipId = currentShipId() || shipIdBefore;
        if (!shipId) return result;

        try {
          await persistAndVerifyFullRows(shipId, capturedRows);
          try {
            ciAutosaveStatus = "Saved";
          } catch (_) {}
        } catch (error) {
          console.error("Stateroom full-row save verification failed", error);
          try {
            ciAutosaveStatus = "Save failed";
            ciMessage = `Stateroom details were not fully saved: ${error.message || error}`;
            ciMessageTone = "error";
            if (typeof global.renderCiAdmin === "function") global.renderCiAdmin();
          } catch (_) {}
          return false;
        }

        return result;
      };
      global.persistCiShip = persistCiShip;
    }
  } catch (error) {
    console.error("Could not install stateroom full-row save integrity guard", error);
  }
})(typeof window !== "undefined" ? window : globalThis);