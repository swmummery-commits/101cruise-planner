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
    buildUpsertRecord,
    buildApplyPreview,
    extractTemplateFromShip,
    draftDiffersFromSaved
  };
});
