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
    summary.changeCount = summary.newCount + summary.replaceCount;
    return summary;
  }

  function applyClassButtonLabel({ selectedCount, changeCount } = {}) {
    const count = Number(selectedCount) || 0;
    const changes = Number(changeCount) || 0;
    if (count <= 0) return "Apply class";
    if (changes <= 0) return "No changes to apply";
    return `Apply class to ${count} ship${count === 1 ? "" : "s"}`;
  }

  function canApplyClassAssignment({ selectedCount, shipClass, changeCount, replaceCount, replacementConfirmed }) {
    const count = Number(selectedCount) || 0;
    const changes = Number(changeCount) || 0;
    if (count <= 0) return false;
    if (!normalizeShipClassInput(shipClass)) return false;
    if (changes <= 0) return false;
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
    let changeCount = 0;
    for (const shipId of unique) {
      const ship = fleet.find(function (row) {
        return row && row.id === shipId;
      });
      if (!ship) return { ok: false, error: "SHIP_NOT_FOUND", detail: shipId };
      if (ship.cruise_line_id !== lineId) return { ok: false, error: "TARGET_LINE_MISMATCH", detail: shipId };
      selected.push(ship);
      const row = classifyAssignment(ship, nextClass);
      if (row.kind === "replace") replaceCount += 1;
      if (row.kind === "replace" || row.kind === "new") changeCount += 1;
    }
    if (changeCount === 0) {
      return { ok: false, error: "NO_CHANGES_TO_APPLY", changeCount: 0 };
    }
    if (replaceCount > 0 && !replacementConfirmed) {
      return { ok: false, error: "REPLACEMENT_NOT_CONFIRMED", replaceCount: replaceCount };
    }
    return {
      ok: true,
      cruiseLineId: lineId,
      shipClass: nextClass,
      shipIds: unique,
      selected: selected,
      replaceCount: replaceCount,
      changeCount: changeCount
    };
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

  function reconcileBulkAssignResults(submittedShipIds, results) {
    const submitted = [];
    const seen = new Set();
    (Array.isArray(submittedShipIds) ? submittedShipIds : []).forEach(function (id) {
      const shipId = trim(id);
      if (!shipId || seen.has(shipId)) return;
      seen.add(shipId);
      submitted.push(shipId);
    });

    const byId = new Map();
    const duplicateResultIds = [];
    (Array.isArray(results) ? results : []).forEach(function (row) {
      if (!row || !row.id) return;
      if (byId.has(row.id)) duplicateResultIds.push(row.id);
      else byId.set(row.id, row);
    });

    const reconciled = submitted.map(function (shipId) {
      const row = byId.get(shipId);
      if (!row) {
        return { id: shipId, outcome: "missing", ok: false, error: "RESULT_MISSING" };
      }
      return row;
    });

    const extraResultIds = [];
    byId.forEach(function (_row, shipId) {
      if (!submitted.includes(shipId)) extraResultIds.push(shipId);
    });

    const updated = reconciled.filter(function (row) {
      return row.outcome === "updated";
    });
    const unchanged = reconciled.filter(function (row) {
      return row.outcome === "unchanged";
    });
    const failed = reconciled.filter(function (row) {
      return row.outcome === "failed" || row.outcome === "missing";
    });

    return {
      ok: duplicateResultIds.length === 0 && extraResultIds.length === 0 && failed.length === 0,
      submitted_count: submitted.length,
      updated_count: updated.length,
      unchanged_count: unchanged.length,
      failed_count: failed.length,
      updated: updated,
      unchanged: unchanged,
      failed: failed,
      duplicate_result_ids: duplicateResultIds,
      extra_result_ids: extraResultIds,
      results: reconciled
    };
  }

  function formatAssignResultMessage(reconciled) {
    const data = reconciled || {};
    const updatedNames = (data.updated || []).map(function (row) {
      return row.name;
    }).filter(Boolean);
    const unchangedNames = (data.unchanged || []).map(function (row) {
      return row.name;
    }).filter(Boolean);
    let message = `Updated ${data.updated_count || 0}, unchanged ${data.unchanged_count || 0}`;
    if (data.failed_count) message += `, failed ${data.failed_count}`;
    if (updatedNames.length) message += `. Updated: ${updatedNames.join(", ")}`;
    if (unchangedNames.length) message += `. Unchanged: ${unchangedNames.join(", ")}`;
    return message;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function formatResultNameSuffix(rows) {
    const names = (Array.isArray(rows) ? rows : [])
      .map(function (row) {
        return row && row.name;
      })
      .filter(Boolean);
    return names.length ? ` — ${names.map(escapeHtml).join(", ")}` : "";
  }

  function formatAssignResultPanelHtml(reconciled) {
    const data = reconciled || {};
    if (!data.submitted_count && !data.updated_count && !data.unchanged_count && !data.failed_count) {
      return "";
    }
    const lines = [];
    if (data.updated_count) {
      lines.push(`<li>Updated ${data.updated_count}${formatResultNameSuffix(data.updated)}</li>`);
    }
    if (data.unchanged_count) {
      lines.push(`<li>Unchanged ${data.unchanged_count}${formatResultNameSuffix(data.unchanged)}</li>`);
    }
    if (data.failed_count) {
      const failedSuffix = (data.failed || [])
        .map(function (row) {
          const name = escapeHtml(row.name || "Untitled");
          return row.error ? `${name} (${escapeHtml(row.error)})` : name;
        })
        .join(", ");
      lines.push(`<li>Failed ${data.failed_count}${failedSuffix ? ` — ${failedSuffix}` : ""}</li>`);
    }
    if (!lines.length) return "";
    return `
      <div class="ci-bulk-class-result-panel">
        <p class="admin-small"><strong>Assignment complete</strong></p>
        <ul class="ci-bulk-class-summary-list">${lines.join("")}</ul>
      </div>`;
  }

  function applyBulkClassResultsToFleet(fleet, results) {
    const ships = Array.isArray(fleet) ? fleet.map(function (ship) {
      return { ...ship };
    }) : [];
    (Array.isArray(results) ? results : []).forEach(function (row) {
      if (!row || !row.id || row.outcome !== "updated") return;
      const idx = ships.findIndex(function (ship) {
        return ship.id === row.id;
      });
      if (idx < 0) return;
      ships[idx] = { ...ships[idx], ship_class: row.new_class ?? null };
    });
    return ships;
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
    reconcileBulkAssignResults,
    formatAssignResultMessage,
    formatAssignResultPanelHtml,
    applyBulkClassResultsToFleet,
    formatStatusLabel
  };
});
