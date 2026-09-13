/**
 * Preserve all live stateroom row fields across Add / Remove / Move rebuilds.
 *
 * The legacy row rebuild only serialised room type, count and room size.
 * Balcony size is added by admin-ship-stateroom-sizes.js, so a rebuild could
 * silently discard unsaved balcony values. These handlers serialise the full
 * live row before rebuilding it.
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

      // Keep the same rule as the existing editor: a row needs a room type.
      if (!label) return;

      const item = {
        label,
        count: countRaw === "" ? "" : (/^\d+$/.test(countRaw) ? Number(countRaw) : countRaw),
        sqm: sqmRaw
      };

      if (balconyRaw !== "") item.balcony_sqm = balconyRaw;
      if (sqmInput?.dataset?.sizeSource) item.sqm_source = sqmInput.dataset.sizeSource;
      if (balconyInput?.dataset?.sizeSource) item.balcony_sqm_source = balconyInput.dataset.sizeSource;

      rows.push(item);
    });
    return rows;
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
    rows.push({ label: "", count: "", sqm: "", balcony_sqm: "" });
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

  // Inline onclick handlers resolve these names from window, so replacing them
  // here guarantees the extended fields survive every user-initiated rebuild.
  global.addCiStateroomRow = addRow;
  global.removeCiStateroomRow = removeRow;
  global.moveCiStateroomRow = moveRow;

  // Expose capture for diagnostics / future stateroom extensions.
  global.captureCiStateroomRowsWithSizes = captureLiveRows;
})(typeof window !== "undefined" ? window : globalThis);
