/**
 * Bulk ship class assignment — shared Admin UI, tests, and Netlify helpers.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CiShipClassBulk = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function () {
  "use strict";

  function trim(value) {
    return String(value == null ? "" : value).trim();
  }

  /** Preserve display text; reject empty. */
  function normalizeShipClassInput(value) {
    const text = trim(value);
    return text || null;
  }

  /** Comparison key: trim, collapse spaces, lowercase. */
  function normalizeClassKey(value) {
    return trim(value).replace(/\s+/g, " ").toLowerCase();
  }

  function shipClassesEquivalent(a, b) {
    const left = normalizeClassKey(a || "");
    const right = normalizeClassKey(b || "");
    if (!left || !right) return false;
    return left === right;
  }

  function isUnassignedClass(value) {
    return !normalizeClassKey(value || "");
  }

  function listDistinctClassesForLine(ships, cruiseLineId) {
    if (!Array.isArray(ships) || !cruiseLineId) return [];
    const seen = new Map();
    ships.forEach(function (ship) {
      if (!ship || ship.cruise_line_id !== cruiseLineId) return;
      const cls = normalizeShipClassInput(ship.ship_class);
      if (!cls) return;
      const key = normalizeClassKey(cls);
      if (!seen.has(key)) seen.set(key, cls);
    });
    return Array.from(seen.values()).sort(function (a, b) {
      return a.localeCompare(b, undefined, { sensitivity: "base" });
    });
  }

  function listFleetShipsForLine(ships, cruiseLineId) {
    if (!Array.isArray(ships) || !cruiseLineId) return [];
    return ships
      .filter(function (ship) {
        return ship && ship.cruise_line_id === cruiseLineId;
      })
      .slice()
      .sort(function (a, b) {
        return String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });
      });
  }

  function normalizeStatusFilter(value) {
    const key = trim(value).toLowerCase();
    if (key === "dry_dock" || key === "dry dock") return "dry_dock";
    if (key === "retired") return "retired";
    if (key === "all") return "all";
    return "active";
  }

  function shipMatchesStatusFilter(ship, statusFilter) {
    const filter = normalizeStatusFilter(statusFilter);
    const status = trim(ship && ship.status).toLowerCase() || "active";
    if (filter === "all") return true;
    if (filter === "active") return status === "active" || (!ship.status && ship.active !== false);
    if (filter === "dry_dock") return status === "under_construction" || status === "dry_dock";
    if (filter === "retired") return status === "retired" || ship.active === false;
    return true;
  }

  function normalizeClassFilter(value) {
    const key = trim(value).toLowerCase();
    if (key === "unassigned") return "unassigned";
    if (key === "already_this" || key === "already this class") return "already_this";
    if (key === "different_class" || key === "different class") return "different_class";
    return "all";
  }

  function shipMatchesClassFilter(ship, classFilter, proposedClass) {
    const filter = normalizeClassFilter(classFilter);
    const current = ship && ship.ship_class;
    if (filter === "all") return true;
    if (filter === "unassigned") return isUnassignedClass(current);
    if (filter === "already_this") return shipClassesEquivalent(current, proposedClass);
    if (filter === "different_class") return !isUnassignedClass(current) && !shipClassesEquivalent(current, proposedClass);
    return true;
  }

  function filterFleetShips(ships, cruiseLineId, options) {
    const opts = options || {};
    const proposedClass = opts.proposedClass != null ? opts.proposedClass : "";
    const search = trim(opts.search).toLowerCase();
    return listFleetShipsForLine(ships, cruiseLineId).filter(function (ship) {
      if (!shipMatchesStatusFilter(ship, opts.statusFilter || "active")) return false;
      if (!shipMatchesClassFilter(ship, opts.classFilter || "all", proposedClass)) return false;
      if (!search) return true;
      return String(ship.name || "").toLowerCase().includes(search);
    });
  }

  function classifyAssignment(ship, proposedClass) {
    const current = ship && ship.ship_class;
    const next = normalizeShipClassInput(proposedClass);
    if (!next) return { kind: "invalid", currentClass: current || null };
    if (isUnassignedClass(current)) return { kind: "new", currentClass: null, nextClass: next };
    if (shipClassesEquivalent(current, next)) return { kind: "unchanged", currentClass: current, nextClass: next };
    return { kind: "replace", currentClass: current, nextClass: next };
  }

  function buildAssignmentSummary(selectedShips, proposedClass) {
    const summary = {
      selectedCount: 0,
      unassignedCount: 0,
      unchangedCount: 0,
      replaceCount: 0,
      newCount: 0,
      shipNames: [],
      replaceShips: [],
      unchangedShips: [],
      newShips: []
    };
    if (!Array.isArray(selectedShips)) return summary;
    selectedShips.forEach(function (ship) {
      if (!ship) return;
      summary.selectedCount += 1;
      summary.shipNames.push(ship.name || "Untitled");
      const row = classifyAssignment(ship, proposedClass);
      if (row.kind === "unchanged") {
        summary.unchangedCount += 1;
        summary.unchangedShips.push(ship.name || "Untitled");
      } else if (row.kind === "replace") {
        summary.replaceCount += 1;
        summary.replaceShips.push({ name: ship.name || "Untitled", currentClass: row.currentClass });
      } else if (row.kind === "new") {
        summary.newCount += 1;
        summary.unassignedCount += 1;
        summary.newShips.push(ship.name || "Untitled");
      }
    });
    return summary;
  }

  function applyClassButtonLabel(selectedCount) {
    const count = Number(selectedCount) || 0;
    if (count <= 0) return "Apply class";
    return `Apply class to ${count} ship${count === 1 ? "" : "s"}`;
  }

  function canApplyClassAssignment({ selectedCount, shipClass, replaceCount, replacementConfirmed }) {
    const count = Number(selectedCount) || 0;
    if (count <= 0) return false;
    if (!normalizeShipClassInput(shipClass)) return false;
    if ((Number(replaceCount) || 0) > 0 && !replacementConfirmed) return false;
    return true;
  }

  function canClearClassAssignment({ selectedCount, shipsWithClassCount }) {
    const count = Number(selectedCount) || 0;
    if (count <= 0) return false;
    return (Number(shipsWithClassCount) || 0) > 0;
  }

  function buildAssignConfirmMessage({ cruiseLineName, shipClass, summary }) {
    const s = summary || {};
    const names = (s.shipNames || []).join("\n");
    return [
      `Assign ship class on ${cruiseLineName || "this cruise line"}`,
      "",
      `Proposed class: ${shipClass}`,
      `Selected ships: ${s.selectedCount || 0}`,
      `Receiving new class: ${s.newCount || 0}`,
      `Changing from another class: ${s.replaceCount || 0}`,
      `Already unchanged: ${s.unchangedCount || 0}`,
      "",
      names,
      "",
      "Only ship_class will be updated on the selected ships."
    ].join("\n");
  }

  function buildClearConfirmMessage({ cruiseLineName, summary }) {
    const names = (summary && summary.shipNames || []).join("\n");
    return [
      `Clear ship class on ${cruiseLineName || "this cruise line"}`,
      "",
      `Selected ships with a class: ${(summary && summary.shipsWithClassCount) || 0}`,
      "",
      names,
      "",
      "Only ship_class will be set to null on the selected ships."
    ].join("\n");
  }

  function validateBulkAssignRequest({ cruiseLineId, shipIds, shipClass, ships, replacementConfirmed }) {
    const lineId = trim(cruiseLineId);
    const nextClass = normalizeShipClassInput(shipClass);
    if (!lineId) return { ok: false, error: "CRUISE_LINE_REQUIRED" };
    if (!nextClass) return { ok: false, error: "EMPTY_CLASS" };
    if (!Array.isArray(shipIds) || !shipIds.length) return { ok: false, error: "NO_SHIPS_SELECTED" };
    const unique = [];
    const seen = new Set();
    for (const id of shipIds) {
      const shipId = trim(id);
      if (!shipId) continue;
      if (seen.has(shipId)) return { ok: false, error: "DUPLICATE_SHIP_ID", detail: shipId };
      seen.add(shipId);
      unique.push(shipId);
    }
    if (!unique.length) return { ok: false, error: "NO_SHIPS_SELECTED" };

    const fleet = Array.isArray(ships) ? ships : [];
    const selected = [];
    let replaceCount = 0;
    for (const shipId of unique) {
      const ship = fleet.find(function (row) {
        return row && row.id === shipId;
      });
      if (!ship) return { ok: false, error: "SHIP_NOT_FOUND", detail: shipId };
      if (ship.cruise_line_id !== lineId) return { ok: false, error: "TARGET_LINE_MISMATCH", detail: shipId };
      selected.push(ship);
      const row = classifyAssignment(ship, nextClass);
      if (row.kind === "replace") replaceCount += 1;
    }
    if (replaceCount > 0 && !replacementConfirmed) {
      return { ok: false, error: "REPLACEMENT_NOT_CONFIRMED", replaceCount: replaceCount };
    }
    return { ok: true, cruiseLineId: lineId, shipClass: nextClass, shipIds: unique, selected: selected, replaceCount: replaceCount };
  }

  function validateBulkClearRequest({ cruiseLineId, shipIds, ships }) {
    const lineId = trim(cruiseLineId);
    if (!lineId) return { ok: false, error: "CRUISE_LINE_REQUIRED" };
    if (!Array.isArray(shipIds) || !shipIds.length) return { ok: false, error: "NO_SHIPS_SELECTED" };
    const unique = [];
    const seen = new Set();
    for (const id of shipIds) {
      const shipId = trim(id);
      if (!shipId) continue;
      if (seen.has(shipId)) return { ok: false, error: "DUPLICATE_SHIP_ID", detail: shipId };
      seen.add(shipId);
      unique.push(shipId);
    }
    if (!unique.length) return { ok: false, error: "NO_SHIPS_SELECTED" };

    const fleet = Array.isArray(ships) ? ships : [];
    const selected = [];
    for (const shipId of unique) {
      const ship = fleet.find(function (row) {
        return row && row.id === shipId;
      });
      if (!ship) return { ok: false, error: "SHIP_NOT_FOUND", detail: shipId };
      if (ship.cruise_line_id !== lineId) return { ok: false, error: "TARGET_LINE_MISMATCH", detail: shipId };
      selected.push(ship);
    }
    return { ok: true, cruiseLineId: lineId, shipIds: unique, selected: selected };
  }

  function planBulkAssignResults(selectedShips, proposedClass) {
    const results = [];
    selectedShips.forEach(function (ship) {
      const row = classifyAssignment(ship, proposedClass);
      results.push({
        id: ship.id,
        name: ship.name || "Untitled",
        old_class: row.currentClass || null,
        new_class: row.nextClass || null,
        outcome: row.kind === "unchanged" ? "unchanged" : "updated"
      });
    });
    return results;
  }

  function planBulkClearResults(selectedShips) {
    return selectedShips.map(function (ship) {
      const hadClass = !isUnassignedClass(ship.ship_class);
      return {
        id: ship.id,
        name: ship.name || "Untitled",
        old_class: ship.ship_class || null,
        new_class: null,
        outcome: hadClass ? "updated" : "unchanged"
      };
    });
  }

  function formatStatusLabel(ship) {
    const status = trim(ship && ship.status).toLowerCase() || "active";
    if (status === "under_construction") return "Dry dock";
    if (status === "dry_dock") return "Dry dock";
    if (status === "retired") return "Retired";
    return "Active";
  }

  return {
    trim,
    normalizeShipClassInput,
    normalizeClassKey,
    shipClassesEquivalent,
    isUnassignedClass,
    listDistinctClassesForLine,
    listFleetShipsForLine,
    normalizeStatusFilter,
    shipMatchesStatusFilter,
    normalizeClassFilter,
    shipMatchesClassFilter,
    filterFleetShips,
    classifyAssignment,
    buildAssignmentSummary,
    applyClassButtonLabel,
    canApplyClassAssignment,
    canClearClassAssignment,
    buildAssignConfirmMessage,
    buildClearConfirmMessage,
    validateBulkAssignRequest,
    validateBulkClearRequest,
    planBulkAssignResults,
    planBulkClearResults,
    formatStatusLabel
  };
});
