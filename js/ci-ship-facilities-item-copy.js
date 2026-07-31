/**
 * Item-level ship facilities copy — shared by Admin UI, tests, and Netlify handler.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CiShipFacilitiesItemCopy = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function () {
  "use strict";

  const TARGET_SCOPE_SAME_CLASS = "same_class";
  const TARGET_SCOPE_FLEET = "fleet";

  function trim(value) {
    return String(value == null ? "" : value).trim();
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function normalizeCompareText(value) {
    return trim(value).replace(/\s+/g, " ").toLowerCase();
  }

  function normalizeShipClass(value) {
    const text = trim(value);
    return text || null;
  }

  function shipClassesMatch(a, b) {
    const left = normalizeShipClass(a);
    const right = normalizeShipClass(b);
    if (!left || !right) return false;
    return left.toLowerCase() === right.toLowerCase();
  }

  function collapseSpaces(value) {
    return trim(value).replace(/\s+/g, " ");
  }

  function makeExclusiveAreaSourceKey(entry) {
    if (isPlainObject(entry)) {
      const name = collapseSpaces(entry.name);
      return `ea:name:${normalizeCompareText(name)}`;
    }
    const text = collapseSpaces(entry);
    return `ea:legacy:${normalizeCompareText(text)}`;
  }

  function makeSpecialtyFeatureSourceKey(value) {
    return `sf:${normalizeCompareText(value)}`;
  }

  function exclusiveAreaStorageEntry(entry) {
    if (isPlainObject(entry)) {
      const name = collapseSpaces(entry.name);
      if (!name) return null;
      const item = { name: name };
      const description = collapseSpaces(entry.description);
      if (description) item.description = description;
      return item;
    }
    const text = collapseSpaces(entry);
    return text || null;
  }

  function descriptionsEquivalent(a, b) {
    return normalizeCompareText(a) === normalizeCompareText(b);
  }

  function listSourceExclusiveAreas(raw) {
    if (!Array.isArray(raw)) return [];
    const items = [];
    raw.forEach(function (entry) {
      if (isPlainObject(entry)) {
        const name = collapseSpaces(entry.name);
        const description = collapseSpaces(entry.description);
        if (!name && !description) return;
        const storage = exclusiveAreaStorageEntry(entry);
        if (!storage) return;
        items.push({
          source_key: makeExclusiveAreaSourceKey(entry),
          kind: "structured",
          name: isPlainObject(storage) ? storage.name : String(storage),
          description: isPlainObject(storage) ? (storage.description || "") : "",
          legacy: false,
          storage: storage
        });
        return;
      }
      const text = collapseSpaces(entry);
      if (!text) return;
      items.push({
        source_key: makeExclusiveAreaSourceKey(entry),
        kind: "legacy",
        name: text,
        description: "",
        legacy: true,
        storage: text
      });
    });
    return items;
  }

  function listSourceSpecialtyFeatures(raw) {
    if (!Array.isArray(raw)) return [];
    const items = [];
    raw.forEach(function (entry) {
      const value = isPlainObject(entry)
        ? collapseSpaces(entry.name || entry.label || entry.description)
        : collapseSpaces(entry);
      if (!value) return;
      items.push({
        source_key: makeSpecialtyFeatureSourceKey(value),
        value: value,
        storage: value
      });
    });
    return items;
  }

  function listFleetCopyTargets(ships, sourceShip) {
    const sourceId = sourceShip && sourceShip.id;
    const lineId = sourceShip && sourceShip.cruise_line_id;
    if (!lineId || !Array.isArray(ships)) return [];
    return ships
      .filter(function (ship) {
        if (!ship || ship.id === sourceId) return false;
        if (ship.active === false) return false;
        return ship.cruise_line_id === lineId;
      })
      .slice()
      .sort(function (a, b) {
        return String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });
      });
  }

  function listSameClassCopyTargets(ships, sourceShip, draftClass) {
    const sourceId = sourceShip && sourceShip.id;
    const lineId = sourceShip && sourceShip.cruise_line_id;
    const shipClass = normalizeShipClass(draftClass != null ? draftClass : sourceShip && sourceShip.ship_class);
    if (!lineId || !shipClass || !Array.isArray(ships)) return [];
    return ships
      .filter(function (ship) {
        if (!ship || ship.id === sourceId) return false;
        if (ship.active === false) return false;
        if (ship.cruise_line_id !== lineId) return false;
        return shipClassesMatch(ship.ship_class, shipClass);
      })
      .slice()
      .sort(function (a, b) {
        return String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });
      });
  }

  function resolveCopyTargets(ships, sourceShip, targetScope, draftClass) {
    if (targetScope === TARGET_SCOPE_FLEET) {
      return listFleetCopyTargets(ships, sourceShip);
    }
    return listSameClassCopyTargets(ships, sourceShip, draftClass);
  }

  function findStructuredExclusiveIndex(raw, normalizedName) {
    if (!Array.isArray(raw)) return -1;
    for (let i = 0; i < raw.length; i += 1) {
      const entry = raw[i];
      if (!isPlainObject(entry)) continue;
      if (normalizeCompareText(entry.name) === normalizedName) return i;
    }
    return -1;
  }

  function findLegacyExclusiveIndex(raw, normalizedText) {
    if (!Array.isArray(raw)) return -1;
    for (let i = 0; i < raw.length; i += 1) {
      const entry = raw[i];
      if (isPlainObject(entry)) continue;
      if (normalizeCompareText(entry) === normalizedText) return i;
    }
    return -1;
  }

  function findSpecialtyIndex(raw, normalizedValue) {
    if (!Array.isArray(raw)) return -1;
    for (let i = 0; i < raw.length; i += 1) {
      const entry = raw[i];
      const text = isPlainObject(entry)
        ? collapseSpaces(entry.name || entry.label || entry.description)
        : collapseSpaces(entry);
      if (normalizeCompareText(text) === normalizedValue) return i;
    }
    return -1;
  }

  function compareExclusiveAreaOnTarget(sourceItem, targetFacilities) {
    const raw = targetFacilities && targetFacilities.exclusive_areas;
    if (sourceItem.legacy) {
      const normalized = normalizeCompareText(sourceItem.name);
      const idx = findLegacyExclusiveIndex(raw, normalized);
      if (idx < 0) return { status: "missing" };
      return { status: "identical", targetIndex: idx };
    }
    const normalizedName = normalizeCompareText(sourceItem.name);
    const idx = findStructuredExclusiveIndex(raw, normalizedName);
    if (idx < 0) return { status: "missing" };
    const targetEntry = raw[idx];
    const targetDescription = isPlainObject(targetEntry) ? trim(targetEntry.description) : "";
    if (descriptionsEquivalent(sourceItem.description, targetDescription)) {
      return {
        status: "identical",
        targetIndex: idx,
        targetEntry: targetEntry
      };
    }
    return {
      status: "different",
      targetIndex: idx,
      targetEntry: targetEntry
    };
  }

  function compareSpecialtyFeatureOnTarget(sourceItem, targetFacilities) {
    const raw = targetFacilities && targetFacilities.specialty_features;
    const normalized = normalizeCompareText(sourceItem.value);
    const idx = findSpecialtyIndex(raw, normalized);
    if (idx < 0) return { status: "missing" };
    return { status: "identical", targetIndex: idx };
  }

  function defaultConflictAction() {
    return "keep_target";
  }

  function resolveConflictAction(conflictResolutions, targetShipId, sourceKey) {
    const rows = Array.isArray(conflictResolutions) ? conflictResolutions : [];
    const match = rows.find(function (row) {
      return row && row.target_ship_id === targetShipId && row.source_key === sourceKey;
    });
    const action = match && trim(match.action);
    if (action === "replace_source") return "replace_source";
    return defaultConflictAction();
  }

  function compareTargetShip(sourceFacilities, targetFacilities, selectedItems, conflictResolutions, targetShipId) {
    const exclusiveSelections = Array.isArray(selectedItems && selectedItems.exclusive_areas)
      ? selectedItems.exclusive_areas
      : [];
    const specialtySelections = Array.isArray(selectedItems && selectedItems.specialty_features)
      ? selectedItems.specialty_features
      : [];
    const sourceExclusive = listSourceExclusiveAreas(sourceFacilities && sourceFacilities.exclusive_areas);
    const sourceSpecialty = listSourceSpecialtyFeatures(sourceFacilities && sourceFacilities.specialty_features);
    const exclusiveByKey = Object.fromEntries(sourceExclusive.map(function (item) {
      return [item.source_key, item];
    }));
    const specialtyByKey = Object.fromEntries(sourceSpecialty.map(function (item) {
      return [item.source_key, item];
    }));

    const items = [];
    exclusiveSelections.forEach(function (sel) {
      const sourceItem = exclusiveByKey[sel && sel.source_key];
      if (!sourceItem) return;
      const comparison = compareExclusiveAreaOnTarget(sourceItem, targetFacilities);
      let plannedAction = "add";
      if (comparison.status === "identical") plannedAction = "skip_identical";
      else if (comparison.status === "different") {
        plannedAction = resolveConflictAction(conflictResolutions, targetShipId, sourceItem.source_key) === "replace_source"
          ? "replace"
          : "keep_existing";
      }
      items.push({
        category: "exclusive_areas",
        source_key: sourceItem.source_key,
        sourceItem: sourceItem,
        comparison: comparison,
        plannedAction: plannedAction
      });
    });
    specialtySelections.forEach(function (sel) {
      const sourceItem = specialtyByKey[sel && sel.source_key];
      if (!sourceItem) return;
      const comparison = compareSpecialtyFeatureOnTarget(sourceItem, targetFacilities);
      items.push({
        category: "specialty_features",
        source_key: sourceItem.source_key,
        sourceItem: sourceItem,
        comparison: comparison,
        plannedAction: comparison.status === "identical" ? "skip_identical" : "add"
      });
    });
    return items;
  }

  function summarizeTargetPlan(items) {
    const summary = {
      addCount: 0,
      replaceCount: 0,
      skipIdenticalCount: 0,
      keepExistingCount: 0,
      conflictCount: 0,
      unresolvedConflictCount: 0
    };
    items.forEach(function (row) {
      if (row.comparison.status === "different") summary.conflictCount += 1;
      if (row.plannedAction === "add") summary.addCount += 1;
      else if (row.plannedAction === "replace") summary.replaceCount += 1;
      else if (row.plannedAction === "skip_identical") summary.skipIdenticalCount += 1;
      else if (row.plannedAction === "keep_existing") summary.keepExistingCount += 1;
    });
    summary.noChanges = summary.addCount === 0 && summary.replaceCount === 0;
    return summary;
  }

  function summarizeAllPlans(plans) {
    const totals = {
      addCount: 0,
      replaceCount: 0,
      skipIdenticalCount: 0,
      keepExistingCount: 0,
      conflictCount: 0
    };
    (Array.isArray(plans) ? plans : []).forEach(function (plan) {
      const summary = plan.summary || summarizeTargetPlan(plan.items || []);
      totals.addCount += summary.addCount;
      totals.replaceCount += summary.replaceCount;
      totals.skipIdenticalCount += summary.skipIdenticalCount;
      totals.keepExistingCount += summary.keepExistingCount;
      totals.conflictCount += summary.conflictCount;
    });
    totals.noChanges = totals.addCount === 0 && totals.replaceCount === 0;
    return totals;
  }

  function buildCopyPlans({ sourceFacilities, targets, selectedItems, conflictResolutions }) {
    return (Array.isArray(targets) ? targets : []).map(function (target) {
      const items = compareTargetShip(
        sourceFacilities,
        target.facilities,
        selectedItems,
        conflictResolutions,
        target.id
      );
      return {
        targetShipId: target.id,
        targetShipName: target.name,
        items: items,
        summary: summarizeTargetPlan(items)
      };
    });
  }

  function applyItemLevelCopyToFacilities(existingFacilities, planItems) {
    const facilities = {
      ...(existingFacilities && typeof existingFacilities === "object" ? existingFacilities : {})
    };
    const exclusive = Array.isArray(facilities.exclusive_areas) ? facilities.exclusive_areas.slice() : [];
    const specialty = Array.isArray(facilities.specialty_features) ? facilities.specialty_features.slice() : [];
    const outcomes = [];

    (Array.isArray(planItems) ? planItems : []).forEach(function (row) {
      const sourceItem = row.sourceItem;
      const action = row.plannedAction;
      if (action === "skip_identical") {
        outcomes.push({ source_key: row.source_key, outcome: "skipped_identical" });
        return;
      }
      if (action === "keep_existing") {
        outcomes.push({ source_key: row.source_key, outcome: "kept_existing" });
        return;
      }
      if (row.category === "specialty_features") {
        if (action !== "add") return;
        specialty.push(sourceItem.storage);
        outcomes.push({ source_key: row.source_key, outcome: "added" });
        return;
      }
      if (action === "add") {
        if (sourceItem.legacy) exclusive.push(sourceItem.storage);
        else exclusive.push(sourceItem.storage);
        outcomes.push({ source_key: row.source_key, outcome: "added" });
        return;
      }
      if (action === "replace" && !sourceItem.legacy) {
        const idx = findStructuredExclusiveIndex(exclusive, normalizeCompareText(sourceItem.name));
        if (idx >= 0) {
          exclusive[idx] = sourceItem.storage;
          outcomes.push({ source_key: row.source_key, outcome: "replaced" });
        } else {
          outcomes.push({ source_key: row.source_key, outcome: "failed", error: "TARGET_MATCH_LOST" });
        }
      }
    });

    if (exclusive.length) facilities.exclusive_areas = exclusive;
    else delete facilities.exclusive_areas;
    if (specialty.length) facilities.specialty_features = specialty;
    else delete facilities.specialty_features;

    return { facilities: facilities, outcomes: outcomes };
  }

  function resolveSelectedItemsFromSource(sourceFacilities, selectedItems) {
    const sourceExclusive = listSourceExclusiveAreas(sourceFacilities && sourceFacilities.exclusive_areas);
    const sourceSpecialty = listSourceSpecialtyFeatures(sourceFacilities && sourceFacilities.specialty_features);
    const exclusiveByKey = Object.fromEntries(sourceExclusive.map(function (item) {
      return [item.source_key, item];
    }));
    const specialtyByKey = Object.fromEntries(sourceSpecialty.map(function (item) {
      return [item.source_key, item];
    }));

    const resolved = { exclusive_areas: [], specialty_features: [] };
    const invalidKeys = [];

    (Array.isArray(selectedItems && selectedItems.exclusive_areas) ? selectedItems.exclusive_areas : []).forEach(function (sel) {
      const key = sel && sel.source_key;
      const item = exclusiveByKey[key];
      if (!item) {
        invalidKeys.push(key);
        return;
      }
      if (sel.name && normalizeCompareText(sel.name) !== normalizeCompareText(item.name)) {
        invalidKeys.push(key);
        return;
      }
      resolved.exclusive_areas.push({ source_key: item.source_key, name: item.name });
    });

    (Array.isArray(selectedItems && selectedItems.specialty_features) ? selectedItems.specialty_features : []).forEach(function (sel) {
      const key = sel && sel.source_key;
      const item = specialtyByKey[key];
      if (!item) {
        invalidKeys.push(key);
        return;
      }
      if (sel.value && normalizeCompareText(sel.value) !== normalizeCompareText(item.value)) {
        invalidKeys.push(key);
        return;
      }
      resolved.specialty_features.push({ source_key: item.source_key, value: item.value });
    });

    return { resolved: resolved, invalidKeys: invalidKeys };
  }

  function validateItemLevelCopyRequest({
    sourceShip,
    targetShips,
    targetScope,
    selectedItems,
    conflictResolutions,
    sourceFacilities
  }) {
    if (!sourceShip || !sourceShip.id || !sourceShip.cruise_line_id) {
      return { ok: false, error: "SOURCE_SHIP_INCOMPLETE" };
    }
    if (sourceShip.active === false) {
      return { ok: false, error: "SOURCE_INACTIVE" };
    }
    const scope = targetScope === TARGET_SCOPE_FLEET ? TARGET_SCOPE_FLEET : TARGET_SCOPE_SAME_CLASS;
    const shipClass = normalizeShipClass(sourceShip.ship_class);
    if (scope === TARGET_SCOPE_SAME_CLASS && !shipClass) {
      return { ok: false, error: "SOURCE_CLASS_REQUIRED" };
    }
    if (!Array.isArray(targetShips) || !targetShips.length) {
      return { ok: false, error: "NO_TARGETS" };
    }

    const ids = targetShips.map(function (t) { return t && t.id; }).filter(Boolean);
    if (new Set(ids).size !== ids.length) {
      return { ok: false, error: "DUPLICATE_TARGETS" };
    }

    for (const target of targetShips) {
      if (!target || target.id === sourceShip.id) {
        return { ok: false, error: "SOURCE_IN_TARGETS" };
      }
      if (target.cruise_line_id !== sourceShip.cruise_line_id) {
        return { ok: false, error: "TARGET_LINE_MISMATCH" };
      }
      if (target.active === false) {
        return { ok: false, error: "TARGET_INACTIVE" };
      }
      if (scope === TARGET_SCOPE_SAME_CLASS && !shipClassesMatch(target.ship_class, shipClass)) {
        return { ok: false, error: "TARGET_CLASS_MISMATCH" };
      }
    }

    const itemResolution = resolveSelectedItemsFromSource(sourceFacilities, selectedItems);
    if (itemResolution.invalidKeys.length) {
      return { ok: false, error: "INVALID_SELECTED_ITEMS", detail: itemResolution.invalidKeys };
    }
    const resolved = itemResolution.resolved;
    if (!resolved.exclusive_areas.length && !resolved.specialty_features.length) {
      return { ok: false, error: "NO_ITEMS_SELECTED" };
    }

    const plans = buildCopyPlans({
      sourceFacilities: sourceFacilities,
      targets: targetShips.map(function (target) {
        return { id: target.id, name: target.name, facilities: target.facilities };
      }),
      selectedItems: resolved,
      conflictResolutions: conflictResolutions
    });

    const conflictRows = [];
    plans.forEach(function (plan) {
      (plan.items || []).forEach(function (row) {
        if (row.comparison.status !== "different") return;
        conflictRows.push({
          target_ship_id: plan.targetShipId,
          source_key: row.source_key
        });
      });
    });
    const resolutionRows = Array.isArray(conflictResolutions) ? conflictResolutions : [];
    const targetIdSet = new Set(targetShips.map(function (target) { return target.id; }));
    for (const resolution of resolutionRows) {
      if (!targetIdSet.has(resolution.target_ship_id)) {
        return { ok: false, error: "INVALID_CONFLICT_RESOLUTION" };
      }
      const valid = conflictRows.some(function (row) {
        return row.target_ship_id === resolution.target_ship_id && row.source_key === resolution.source_key;
      });
      if (!valid) {
        return { ok: false, error: "INVALID_CONFLICT_RESOLUTION" };
      }
      const action = trim(resolution.action);
      if (action !== "keep_target" && action !== "replace_source") {
        return { ok: false, error: "INVALID_CONFLICT_ACTION" };
      }
    }

    const totals = summarizeAllPlans(plans);
    if (totals.noChanges) {
      return { ok: false, error: "NO_CHANGES" };
    }

    return {
      ok: true,
      targetScope: scope,
      shipClass: shipClass,
      resolvedItems: resolved,
      plans: plans
    };
  }

  function targetComparisonStatusLabel(items) {
    const summary = summarizeTargetPlan(items);
    if (summary.noChanges && summary.skipIdenticalCount > 0) return "All selected items already identical";
    const parts = [];
    if (summary.addCount) parts.push(`${summary.addCount} to add`);
    if (summary.skipIdenticalCount) parts.push(`${summary.skipIdenticalCount} identical`);
    if (summary.conflictCount) parts.push(`${summary.conflictCount} conflict${summary.conflictCount === 1 ? "" : "s"}`);
    return parts.length ? parts.join(" · ") : "No changes";
  }

  function itemCopyCanSubmit({ selectedSourceCount, selectedTargetCount, plans, awaitingConfirmation }) {
    if (awaitingConfirmation) return true;
    if ((Number(selectedSourceCount) || 0) <= 0) return false;
    if ((Number(selectedTargetCount) || 0) <= 0) return false;
    const totals = summarizeAllPlans(plans);
    if (totals.noChanges) return false;
    return true;
  }

  function itemCopySubmitLabel({ selectedTargetCount, totals, awaitingConfirmation, showingConfirmation }) {
    if (showingConfirmation) return "Confirm copy";
    if (totals && totals.noChanges) return "No changes to copy";
    const count = Number(selectedTargetCount) || 0;
    if (count <= 0) return "Copy to selected ships";
    return `Copy to ${count} selected ship${count === 1 ? "" : "s"}`;
  }

  function itemCopyConfirmMessage({
    sourceShipName,
    cruiseLineName,
    targetScope,
    targetNames,
    exclusiveNames,
    specialtyValues,
    totals
  }) {
    const scopeLabel = targetScope === TARGET_SCOPE_FLEET
      ? "Entire cruise-line fleet"
      : "Same class";
    const lines = [
      "Copy selected ship facilities?",
      "",
      `Source ship: ${sourceShipName || "—"}`,
      `Cruise line: ${cruiseLineName || "—"}`,
      `Target scope: ${scopeLabel}`,
      "",
      "Target ships:",
      ...(Array.isArray(targetNames) ? targetNames : []).map(function (name) { return `• ${name}`; }),
      "",
      "Exclusive Areas:",
      ...(Array.isArray(exclusiveNames) && exclusiveNames.length
        ? exclusiveNames.map(function (name) { return `• ${name}`; })
        : ["• (none selected)"]),
      "",
      "Specialty Features:",
      ...(Array.isArray(specialtyValues) && specialtyValues.length
        ? specialtyValues.map(function (value) { return `• ${value}`; })
        : ["• (none selected)"]),
      "",
      `Additions: ${totals.addCount}`,
      `Replacements: ${totals.replaceCount}`,
      `Identical items skipped: ${totals.skipIdenticalCount}`,
      `Target versions retained: ${totals.keepExistingCount}`,
      "",
      "Unrelated target facilities will be preserved. Only the selected items will be merged into each target ship."
    ];
    return lines.join("\n");
  }

  function formatResultSummary(resultRows) {
    return (Array.isArray(resultRows) ? resultRows : []).map(function (row) {
      const parts = [];
      if (row.added && row.added.length) parts.push(`Added: ${row.added.join(", ")}`);
      if (row.replaced && row.replaced.length) parts.push(`Replaced: ${row.replaced.join(", ")}`);
      if (row.skipped_identical && row.skipped_identical.length) parts.push(`Already present: ${row.skipped_identical.join(", ")}`);
      if (row.kept_existing && row.kept_existing.length) parts.push(`Kept existing: ${row.kept_existing.join(", ")}`);
      if (row.failed && row.failed.length) parts.push(`Failed: ${row.failed.join(", ")}`);
      return { name: row.name, lines: parts, ok: row.ok !== false };
    });
  }

  function buildResultRow(targetName, outcomes, sourceItemsByKey) {
    const added = [];
    const replaced = [];
    const skipped_identical = [];
    const kept_existing = [];
    const failed = [];
    (Array.isArray(outcomes) ? outcomes : []).forEach(function (outcome) {
      const sourceItem = sourceItemsByKey[outcome.source_key];
      const label = sourceItem
        ? (sourceItem.name || sourceItem.value || outcome.source_key)
        : outcome.source_key;
      if (outcome.outcome === "added") added.push(label);
      else if (outcome.outcome === "replaced") replaced.push(label);
      else if (outcome.outcome === "skipped_identical") skipped_identical.push(label);
      else if (outcome.outcome === "kept_existing") kept_existing.push(label);
      else if (outcome.outcome === "failed") failed.push(label);
    });
    return {
      name: targetName,
      added: added,
      replaced: replaced,
      skipped_identical: skipped_identical,
      kept_existing: kept_existing,
      failed: failed,
      ok: !failed.length
    };
  }

  function filterFleetTargets(ships, cruiseLineId, filters) {
    const search = normalizeCompareText(filters && filters.search);
    const classFilter = trim(filters && filters.classFilter);
    return (Array.isArray(ships) ? ships : []).filter(function (ship) {
      if (classFilter && classFilter !== "all") {
        const cls = normalizeShipClass(ship.ship_class) || "Unassigned";
        if (cls !== classFilter) return false;
      }
      if (search && !normalizeCompareText(ship.name).includes(search)) return false;
      return true;
    });
  }

  function listFleetClassFilterOptions(ships, cruiseLineId) {
    const classes = new Set();
    listFleetCopyTargets(ships, { cruise_line_id: cruiseLineId }).forEach(function (ship) {
      classes.add(normalizeShipClass(ship.ship_class) || "Unassigned");
    });
    return [...classes].sort(function (a, b) {
      return a.localeCompare(b, undefined, { sensitivity: "base" });
    });
  }

  function isItemLevelCopyPayload(body) {
    return Boolean(body && body.selected_items && typeof body.selected_items === "object");
  }

  function planItemLabel(row) {
    return row && row.sourceItem ? (row.sourceItem.name || row.sourceItem.value || row.source_key) : "";
  }

  function buildPlanTargetBreakdown(plan) {
    const breakdown = {
      willAdd: [],
      willReplace: [],
      alreadyIdentical: [],
      keepTarget: []
    };
    (plan && plan.items ? plan.items : []).forEach(function (row) {
      const label = planItemLabel(row);
      if (!label) return;
      if (row.plannedAction === "add") breakdown.willAdd.push(label);
      else if (row.plannedAction === "replace") breakdown.willReplace.push(label);
      else if (row.plannedAction === "skip_identical") breakdown.alreadyIdentical.push(label);
      else if (row.plannedAction === "keep_existing") breakdown.keepTarget.push(label);
    });
    return breakdown;
  }

  function planHasConflicts(plans) {
    return (Array.isArray(plans) ? plans : []).some(function (plan) {
      return (plan.items || []).some(function (row) {
        return row.comparison && row.comparison.status === "different";
      });
    });
  }

  function buildConfirmationSummary({
    sourceShipName,
    cruiseLineName,
    targetScope,
    exclusiveItems,
    specialtyItems,
    plans
  }) {
    const perTarget = (Array.isArray(plans) ? plans : []).map(function (plan) {
      const breakdown = buildPlanTargetBreakdown(plan);
      return {
        targetShipId: plan.targetShipId,
        targetShipName: plan.targetShipName,
        willAdd: breakdown.willAdd.slice(),
        willReplace: breakdown.willReplace.slice(),
        alreadyIdentical: breakdown.alreadyIdentical.slice(),
        keepTarget: breakdown.keepTarget.slice(),
        addCount: breakdown.willAdd.length,
        replaceCount: breakdown.willReplace.length,
        skipIdenticalCount: breakdown.alreadyIdentical.length,
        keepExistingCount: breakdown.keepTarget.length
      };
    });
    const aggregates = summarizeAllPlans(plans);
    const summary = {
      sourceShipName: sourceShipName || "—",
      cruiseLineName: cruiseLineName || "—",
      targetScope: targetScope,
      targetScopeLabel: targetScope === TARGET_SCOPE_FLEET ? "Entire cruise-line fleet" : "Same class",
      exclusiveAreas: (Array.isArray(exclusiveItems) ? exclusiveItems : []).map(function (item) { return item.name; }),
      specialtyFeatures: (Array.isArray(specialtyItems) ? specialtyItems : []).map(function (item) { return item.value; }),
      targetShipNames: perTarget.map(function (row) { return row.targetShipName; }),
      perTarget: perTarget,
      aggregates: aggregates
    };
    assertConfirmationTotalsReconcile(summary);
    return summary;
  }

  function assertConfirmationTotalsReconcile(summary) {
    const perTarget = summary && summary.perTarget ? summary.perTarget : [];
    const aggregates = summary && summary.aggregates ? summary.aggregates : {};
    const addSum = perTarget.reduce(function (sum, row) { return sum + (row.addCount || 0); }, 0);
    const replaceSum = perTarget.reduce(function (sum, row) { return sum + (row.replaceCount || 0); }, 0);
    const skipSum = perTarget.reduce(function (sum, row) { return sum + (row.skipIdenticalCount || 0); }, 0);
    const keepSum = perTarget.reduce(function (sum, row) { return sum + (row.keepExistingCount || 0); }, 0);
    if (
      addSum !== aggregates.addCount ||
      replaceSum !== aggregates.replaceCount ||
      skipSum !== aggregates.skipIdenticalCount ||
      keepSum !== aggregates.keepExistingCount
    ) {
      throw new Error("CONFIRMATION_TOTALS_MISMATCH");
    }
    return true;
  }

  function canContinueToReview({ selectedSourceCount, selectedTargetCount, plans }) {
    if ((Number(selectedSourceCount) || 0) <= 0) return false;
    if ((Number(selectedTargetCount) || 0) <= 0) return false;
    const totals = summarizeAllPlans(plans);
    if (totals.noChanges) return false;
    return true;
  }

  function conflictsAreResolved(plans, conflictResolutions) {
    if (!planHasConflicts(plans)) return true;
    const rows = [];
    (plans || []).forEach(function (plan) {
      (plan.items || []).forEach(function (item) {
        if (item.comparison && item.comparison.status === "different") {
          rows.push({ target_ship_id: plan.targetShipId, source_key: item.source_key });
        }
      });
    });
    return rows.every(function (row) {
      return (Array.isArray(conflictResolutions) ? conflictResolutions : []).some(function (resolution) {
        return resolution.target_ship_id === row.target_ship_id && resolution.source_key === row.source_key;
      });
    });
  }

  function buildSourceItemsByKey(sourceFacilities) {
    const map = {};
    listSourceExclusiveAreas(sourceFacilities && sourceFacilities.exclusive_areas).forEach(function (item) {
      map[item.source_key] = item;
    });
    listSourceSpecialtyFeatures(sourceFacilities && sourceFacilities.specialty_features).forEach(function (item) {
      map[item.source_key] = item;
    });
    return map;
  }

  function plannedActionToTerminalOutcome(action) {
    if (action === "add") return "added";
    if (action === "replace") return "replaced";
    if (action === "skip_identical") return "skipped_identical";
    if (action === "keep_existing") return "kept_existing";
    return null;
  }

  function expectedOutcomesFromPlans(plans) {
    const rows = [];
    (Array.isArray(plans) ? plans : []).forEach(function (plan) {
      (plan.items || []).forEach(function (item) {
        const outcome = plannedActionToTerminalOutcome(item.plannedAction);
        if (!outcome) return;
        rows.push({
          target_ship_id: plan.targetShipId,
          target_ship_name: plan.targetShipName,
          source_key: item.source_key,
          expected_outcome: outcome
        });
      });
    });
    return rows;
  }

  function normalizeResultOutcomes(resultRow) {
    return Array.isArray(resultRow && resultRow.outcomes)
      ? resultRow.outcomes
      : (Array.isArray(resultRow && resultRow.items) ? resultRow.items : []);
  }

  function assertResultOutcomesReconcile({ plans, results, sourceFacilities }) {
    const expected = expectedOutcomesFromPlans(plans);
    const resultByTarget = Object.fromEntries((Array.isArray(results) ? results : []).map(function (row) {
      return [row.id, row];
    }));
    const seen = new Set();

    expected.forEach(function (exp) {
      const result = resultByTarget[exp.target_ship_id];
      if (!result) {
        throw new Error("RESULT_TARGET_MISSING:" + exp.target_ship_id);
      }
      const outcomes = normalizeResultOutcomes(result);
      const matches = outcomes.filter(function (row) {
        return row.source_key === exp.source_key;
      });
      if (!matches.length) {
        throw new Error("RESULT_OUTCOME_MISSING:" + exp.target_ship_id + ":" + exp.source_key);
      }
      if (matches.length > 1) {
        throw new Error("RESULT_OUTCOME_DUPLICATE:" + exp.target_ship_id + ":" + exp.source_key);
      }
      const pairKey = exp.target_ship_id + ":" + exp.source_key;
      if (seen.has(pairKey)) {
        throw new Error("RESULT_OUTCOME_DUPLICATE:" + pairKey);
      }
      seen.add(pairKey);
      const actual = matches[0].outcome;
      if (actual === "failed") return;
      if (actual !== exp.expected_outcome) {
        throw new Error("RESULT_OUTCOME_MISMATCH:" + pairKey + ":" + actual + "!==" + exp.expected_outcome);
      }
    });

    const expectedByTarget = {};
    expected.forEach(function (exp) {
      if (!expectedByTarget[exp.target_ship_id]) expectedByTarget[exp.target_ship_id] = new Set();
      expectedByTarget[exp.target_ship_id].add(exp.source_key);
    });

    (Array.isArray(results) ? results : []).forEach(function (result) {
      if (!result || !result.id) {
        throw new Error("RESULT_TARGET_UNKNOWN");
      }
      if (!expectedByTarget[result.id]) {
        throw new Error("RESULT_TARGET_UNKNOWN:" + result.id);
      }
      normalizeResultOutcomes(result).forEach(function (outcome) {
        if (!expectedByTarget[result.id].has(outcome.source_key)) {
          throw new Error("RESULT_UNKNOWN_SOURCE_KEY:" + result.id + ":" + outcome.source_key);
        }
      });
    });

    const aggregates = summarizeAllPlans(plans);
    const resultTotals = { added: 0, replaced: 0, skipped_identical: 0, kept_existing: 0, failed: 0 };
    expected.forEach(function (exp) {
      const result = resultByTarget[exp.target_ship_id];
      const outcome = normalizeResultOutcomes(result).find(function (row) {
        return row.source_key === exp.source_key;
      });
      const terminal = outcome ? outcome.outcome : exp.expected_outcome;
      if (terminal === "added") resultTotals.added += 1;
      else if (terminal === "replaced") resultTotals.replaced += 1;
      else if (terminal === "skipped_identical") resultTotals.skipped_identical += 1;
      else if (terminal === "kept_existing") resultTotals.kept_existing += 1;
      else if (terminal === "failed") resultTotals.failed += 1;
    });

    if (
      resultTotals.added !== aggregates.addCount ||
      resultTotals.replaced !== aggregates.replaceCount ||
      resultTotals.skipped_identical !== aggregates.skipIdenticalCount ||
      resultTotals.kept_existing !== aggregates.keepExistingCount
    ) {
      throw new Error("RESULT_TOTALS_MISMATCH");
    }

    return true;
  }

  function reconcileResultRows({ plans, results, sourceFacilities }) {
    const sourceItemsByKey = buildSourceItemsByKey(sourceFacilities);
    const planByTarget = Object.fromEntries((Array.isArray(plans) ? plans : []).map(function (plan) {
      return [plan.targetShipId, plan];
    }));
    return (Array.isArray(results) ? results : []).map(function (row) {
      const outcomes = normalizeResultOutcomes(row);
      const result = buildResultRow(row.name, outcomes, sourceItemsByKey);
      return { ...row, outcomes: outcomes, items: outcomes, result: result, plan: planByTarget[row.id] || null };
    });
  }

  function formatAggregateOperationSummary(totals, targetCount, options) {
    const opts = options || {};
    const sourceCount = Number(opts.sourceCount) || 0;
    const ships = Number(targetCount) || 0;
    if (!sourceCount) {
      return { text: "Select source items and target ships.", noChanges: true, canContinue: false };
    }
    if (!ships) {
      return { text: "Select at least one target ship.", noChanges: true, canContinue: false };
    }
    if (totals.noChanges) {
      return {
        text: "All selected items are already identical or set to keep existing — no changes to copy.",
        noChanges: true,
        canContinue: false
      };
    }
    const parts = [];
    if (totals.addCount) parts.push(`${totals.addCount} addition${totals.addCount === 1 ? "" : "s"}`);
    if (totals.replaceCount) parts.push(`${totals.replaceCount} replacement${totals.replaceCount === 1 ? "" : "s"}`);
    if (totals.skipIdenticalCount) {
      parts.push(`${totals.skipIdenticalCount} identical skip${totals.skipIdenticalCount === 1 ? "" : "s"}`);
    }
    if (totals.keepExistingCount) {
      parts.push(`${totals.keepExistingCount} retained`);
    }
    return {
      text: `${parts.join(" · ")} across ${ships} ship${ships === 1 ? "" : "s"}`,
      noChanges: false,
      canContinue: true
    };
  }

  return {
    TARGET_SCOPE_SAME_CLASS,
    TARGET_SCOPE_FLEET,
    normalizeCompareText,
    makeExclusiveAreaSourceKey,
    makeSpecialtyFeatureSourceKey,
    listSourceExclusiveAreas,
    listSourceSpecialtyFeatures,
    listFleetCopyTargets,
    listSameClassCopyTargets,
    resolveCopyTargets,
    compareExclusiveAreaOnTarget,
    compareSpecialtyFeatureOnTarget,
    resolveConflictAction,
    compareTargetShip,
    summarizeTargetPlan,
    summarizeAllPlans,
    buildCopyPlans,
    applyItemLevelCopyToFacilities,
    resolveSelectedItemsFromSource,
    validateItemLevelCopyRequest,
    targetComparisonStatusLabel,
    itemCopyCanSubmit,
    itemCopySubmitLabel,
    itemCopyConfirmMessage,
    formatResultSummary,
    buildResultRow,
    filterFleetTargets,
    listFleetClassFilterOptions,
    isItemLevelCopyPayload,
    planItemLabel,
    buildPlanTargetBreakdown,
    planHasConflicts,
    buildConfirmationSummary,
    assertConfirmationTotalsReconcile,
    canContinueToReview,
    conflictsAreResolved,
    buildSourceItemsByKey,
    plannedActionToTerminalOutcome,
    expectedOutcomesFromPlans,
    normalizeResultOutcomes,
    assertResultOutcomesReconcile,
    reconcileResultRows,
    formatAggregateOperationSummary
  };
});
