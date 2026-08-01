/**
 * Class facilities templates — list rows, validation, sync status, apply preview.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CiShipClassFacilitiesTemplate = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function () {
  "use strict";

  function trim(value) {
    return String(value == null ? "" : value).trim();
  }

  function getClassBulk() {
    if (typeof module !== "undefined" && module.exports) {
      try {
        return require("./ci-ship-class-bulk.js");
      } catch (_error) {
        return null;
      }
    }
    return (typeof window !== "undefined" && window.CiShipClassBulk) || null;
  }

  function getReplace() {
    if (typeof module !== "undefined" && module.exports) {
      try {
        return require("./ci-ship-class-facilities-replace.js");
      } catch (_error) {
        return null;
      }
    }
    return (typeof window !== "undefined" && window.CiShipClassFacilitiesReplace) || null;
  }

  function normalizeClassKey(className) {
    const bulk = getClassBulk();
    if (bulk && bulk.normalizeClassKey) return bulk.normalizeClassKey(className);
    return trim(className).replace(/\s+/g, " ").toLowerCase();
  }

  function shipClassesMatch(a, b) {
    const bulk = getClassBulk();
    if (bulk && bulk.shipClassesEquivalent) return bulk.shipClassesEquivalent(a, b);
    return normalizeClassKey(a) === normalizeClassKey(b);
  }

  function listDistinctClassesForLine(ships, cruiseLineId) {
    const bulk = getClassBulk();
    if (bulk && bulk.listDistinctClassesForLine) {
      return bulk.listDistinctClassesForLine(ships, cruiseLineId);
    }
    return [];
  }

  function listShipsInClass(ships, cruiseLineId, className, options) {
    const opts = options || {};
    const activeOnly = opts.activeOnly !== false;
    return (Array.isArray(ships) ? ships : []).filter(function (ship) {
      if (!ship || ship.cruise_line_id !== cruiseLineId) return false;
      if (activeOnly && ship.active === false) return false;
      return shipClassesMatch(ship.ship_class, className);
    }).sort(function (a, b) {
      return String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });
    });
  }

  function countUnassignedActiveShips(ships, cruiseLineId) {
    return (Array.isArray(ships) ? ships : []).filter(function (ship) {
      if (!ship || ship.cruise_line_id !== cruiseLineId) return false;
      if (ship.active === false) return false;
      return !trim(ship.ship_class);
    }).length;
  }

  function templateClassKey(row) {
    if (!row) return "";
    return row.class_key || row.class_name_key || "";
  }

  function indexTemplatesByClassKey(templates) {
    const map = Object.create(null);
    (Array.isArray(templates) ? templates : []).forEach(function (row) {
      const key = templateClassKey(row);
      if (!key) return;
      map[key] = row;
    });
    return map;
  }

  function templatePayloadFromFacilities(facilities) {
    const fac = facilities && typeof facilities === "object" ? facilities : {};
    return {
      exclusive_areas: Array.isArray(fac.exclusive_areas) ? fac.exclusive_areas.slice() : [],
      specialty_features: Array.isArray(fac.specialty_features) ? fac.specialty_features.slice() : []
    };
  }

  function templatePayloadFromRecord(record) {
    if (!record) return { exclusive_areas: [], specialty_features: [] };
    return {
      exclusive_areas: Array.isArray(record.exclusive_areas) ? record.exclusive_areas.slice() : [],
      specialty_features: Array.isArray(record.specialty_features) ? record.specialty_features.slice() : []
    };
  }

  function validateTemplatePayload(payload) {
    const exclusive = Array.isArray(payload && payload.exclusive_areas) ? payload.exclusive_areas : [];
    const specialty = Array.isArray(payload && payload.specialty_features) ? payload.specialty_features : [];
    return {
      ok: true,
      payload: { exclusive_areas: exclusive, specialty_features: specialty }
    };
  }

  function buildClassSyncSummary({ ships, cruiseLineId, className, template }) {
    const replace = getReplace();
    const activeShips = listShipsInClass(ships, cruiseLineId, className, { activeOnly: true });
    if (!template) {
      return {
        statusLabel: "Template not set",
        templateStatus: "Template not set",
        matchingCount: 0,
        customisedCount: 0,
        activeCount: activeShips.length
      };
    }
    let matchingCount = 0;
    let customisedCount = 0;
    activeShips.forEach(function (ship) {
      const comparison = replace
        ? replace.compareShipFacilitiesToTemplate(ship.facilities, template)
        : { matches: false };
      if (comparison.matches) matchingCount += 1;
      else customisedCount += 1;
    });
    const activeCount = activeShips.length;
    let statusLabel;
    if (!activeCount) {
      statusLabel = "No active ships";
    } else if (matchingCount === activeCount) {
      statusLabel = `All ${activeCount} ship${activeCount === 1 ? "" : "s"} match template`;
    } else {
      statusLabel = `${matchingCount} ship${matchingCount === 1 ? "" : "s"} match · ${customisedCount} individually customised`;
    }
    return {
      statusLabel: statusLabel,
      templateStatus: "Saved",
      matchingCount: matchingCount,
      customisedCount: customisedCount,
      activeCount: activeCount
    };
  }

  function buildClassShipRows({ ships, cruiseLineId, templates }) {
    const byKey = indexTemplatesByClassKey(templates);
    return listDistinctClassesForLine(ships, cruiseLineId).map(function (className) {
      const key = normalizeClassKey(className);
      const template = byKey[key] || null;
      const allClassShips = listShipsInClass(ships, cruiseLineId, className, { activeOnly: false });
      const activeShips = listShipsInClass(ships, cruiseLineId, className, { activeOnly: true });
      const sync = buildClassSyncSummary({
        ships: ships,
        cruiseLineId: cruiseLineId,
        className: className,
        template: template
      });
      return {
        className: className,
        classKey: key,
        shipCount: allClassShips.length,
        activeShipCount: activeShips.length,
        memberShipNames: allClassShips.map(function (ship) { return ship.name; }),
        activeMemberShipNames: activeShips.map(function (ship) { return ship.name; }),
        templateId: template && template.id ? template.id : null,
        templateEaCount: template && Array.isArray(template.exclusive_areas) ? template.exclusive_areas.length : null,
        templateSfCount: template && Array.isArray(template.specialty_features) ? template.specialty_features.length : null,
        hasTemplate: Boolean(template),
        templateStatus: sync.templateStatus,
        syncStatusLabel: sync.statusLabel,
        matchingCount: sync.matchingCount,
        customisedCount: sync.customisedCount,
        updatedAt: template && template.updated_at ? template.updated_at : null
      };
    });
  }

  function listLineShips(ships, cruiseLineId) {
    return (Array.isArray(ships) ? ships : []).filter(function (ship) {
      return ship && ship.cruise_line_id === cruiseLineId;
    });
  }

  function listActiveLineShips(ships, cruiseLineId) {
    return listLineShips(ships, cruiseLineId).filter(function (ship) {
      return ship.active !== false;
    });
  }

  function buildLineFleetSummary({ ships, cruiseLineId, templates }) {
    const lineShips = listLineShips(ships, cruiseLineId);
    const activeShips = listActiveLineShips(ships, cruiseLineId);
    const classRows = buildClassShipRows({ ships: ships, cruiseLineId: cruiseLineId, templates: templates });
    const unassignedActiveCount = countUnassignedActiveShips(ships, cruiseLineId);
    const assignmentCounts = Object.create(null);
    classRows.forEach(function (row) {
      listShipsInClass(ships, cruiseLineId, row.className, { activeOnly: true }).forEach(function (ship) {
        if (!ship || !ship.id) return;
        assignmentCounts[ship.id] = (assignmentCounts[ship.id] || 0) + 1;
      });
    });
    const classifiedActiveCount = Object.keys(assignmentCounts).length;
    const duplicateAssignmentCount = Object.values(assignmentCounts).filter(function (count) {
      return count > 1;
    }).length;
    return {
      totalShipCount: lineShips.length,
      activeShipCount: activeShips.length,
      inactiveShipCount: lineShips.length - activeShips.length,
      publicShipCount: activeShips.length,
      unassignedActiveCount: unassignedActiveCount,
      classifiedActiveCount: classifiedActiveCount,
      classRows: classRows,
      activeFleetReconciles: classifiedActiveCount + unassignedActiveCount === activeShips.length,
      hasDuplicateClassMembership: duplicateAssignmentCount > 0
    };
  }

  function assertLineFleetInvariants(summary) {
    const errors = [];
    if (!summary || typeof summary !== "object") {
      return { ok: false, errors: ["MISSING_SUMMARY"] };
    }
    if (!summary.activeFleetReconciles) {
      errors.push("ACTIVE_FLEET_MISMATCH");
    }
    if (summary.hasDuplicateClassMembership) {
      errors.push("DUPLICATE_CLASS_MEMBERSHIP");
    }
    (summary.classRows || []).forEach(function (row) {
      if ((row.activeMemberShipNames || []).length !== row.activeShipCount) {
        errors.push("MEMBER_COUNT_MISMATCH:" + row.className);
      }
      if (row.hasTemplate && row.matchingCount + row.customisedCount !== row.activeShipCount) {
        errors.push("SYNC_COUNT_MISMATCH:" + row.className);
      }
    });
    return { ok: errors.length === 0, errors: errors };
  }

  function buildUpsertRecord({ cruiseLineId, className, exclusiveAreas, specialtyFeatures }) {
    const class_name = trim(className);
    const class_key = normalizeClassKey(class_name);
    if (!cruiseLineId || !class_name || !class_key) {
      return { ok: false, error: "INVALID_CLASS" };
    }
    const validation = validateTemplatePayload({
      exclusive_areas: exclusiveAreas,
      specialty_features: specialtyFeatures
    });
    if (!validation.ok) return validation;
    return {
      ok: true,
      record: {
        cruise_line_id: cruiseLineId,
        class_name: class_name,
        class_key: class_key,
        exclusive_areas: validation.payload.exclusive_areas,
        specialty_features: validation.payload.specialty_features,
        updated_at: new Date().toISOString()
      }
    };
  }

  function buildApplyPreview({ ships, cruiseLineId, className, template }) {
    const replace = getReplace();
    const targets = listShipsInClass(ships, cruiseLineId, className, { activeOnly: true });
    if (!replace || !replace.summarizeApplyPreview) {
      return { targets: targets, preview: { rows: [], aggregate: { ships: 0, matchingCount: 0, willChangeCount: 0, hasChanges: false } } };
    }
    return {
      targets: targets,
      preview: replace.summarizeApplyPreview(targets, template)
    };
  }

  function extractTemplateFromShip(ship) {
    return templatePayloadFromFacilities(ship && ship.facilities);
  }

  function draftDiffersFromSaved(draft, savedRecord) {
    const replace = getReplace();
    if (!replace || !replace.templatesPayloadEqual) return false;
    return !replace.templatesPayloadEqual(draft, templatePayloadFromRecord(savedRecord));
  }

  function templateRecordForClass(templates, cruiseLineId, className) {
    const key = normalizeClassKey(className);
    return (Array.isArray(templates) ? templates : []).find(function (row) {
      return row.cruise_line_id === cruiseLineId && templateClassKey(row) === key;
    }) || null;
  }

  function resolveClassTemplatePayload({ templates, ships, cruiseLineId, className }) {
    const saved = templateRecordForClass(templates, cruiseLineId, className);
    if (saved) {
      return {
        payload: templatePayloadFromRecord(saved),
        source: "saved",
        className: className
      };
    }
    const classShips = listShipsInClass(ships, cruiseLineId, className, { activeOnly: false });
    const ship = classShips[0];
    if (ship) {
      return {
        payload: extractTemplateFromShip(ship),
        source: "ship",
        className: className,
        shipName: ship.name || "Ship"
      };
    }
    return {
      payload: { exclusive_areas: [], specialty_features: [] },
      source: "none",
      className: className
    };
  }

  function normalizeExclusiveName(name) {
    return trim(name).toLowerCase();
  }

  function normalizeSpecialtyLabel(label) {
    return trim(label).toLowerCase();
  }

  function mergeExclusiveAreaRows(currentRows, incomingRows) {
    const current = Array.isArray(currentRows) ? currentRows : [];
    const incoming = Array.isArray(incomingRows) ? incomingRows : [];
    const seen = new Set(
      current
        .map(function (row) { return normalizeExclusiveName(row && row.name); })
        .filter(Boolean)
    );
    const merged = current.slice();
    incoming.forEach(function (row) {
      const key = normalizeExclusiveName(row && row.name);
      if (!key || seen.has(key)) return;
      seen.add(key);
      merged.push({
        name: trim(row.name),
        description: trim(row.description),
        showDescription: Boolean(row.showDescription || row.description)
      });
    });
    return merged;
  }

  function mergeSpecialtyRows(currentRows, incomingRows) {
    const current = Array.isArray(currentRows) ? currentRows : [];
    const incoming = Array.isArray(incomingRows) ? incomingRows : [];
    const seen = new Set(
      current
        .map(function (row) { return normalizeSpecialtyLabel(row && row.label); })
        .filter(Boolean)
    );
    const merged = current.slice();
    incoming.forEach(function (row) {
      const key = normalizeSpecialtyLabel(row && row.label);
      if (!key || seen.has(key)) return;
      seen.add(key);
      merged.push({ label: trim(row.label) });
    });
    return merged;
  }

  return {
    normalizeClassKey,
    shipClassesMatch,
    listDistinctClassesForLine,
    listShipsInClass,
    countUnassignedActiveShips,
    templateClassKey,
    indexTemplatesByClassKey,
    templatePayloadFromFacilities,
    templatePayloadFromRecord,
    validateTemplatePayload,
    buildClassSyncSummary,
    buildClassShipRows,
    buildLineFleetSummary,
    assertLineFleetInvariants,
    listLineShips,
    listActiveLineShips,
    buildUpsertRecord,
    buildApplyPreview,
    extractTemplateFromShip,
    draftDiffersFromSaved,
    templateRecordForClass,
    resolveClassTemplatePayload,
    mergeExclusiveAreaRows,
    mergeSpecialtyRows
  };
});
