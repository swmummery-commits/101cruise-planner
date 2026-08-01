/**
 * Replace class facilities template sections on per-ship facilities (EA + SF only).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CiShipClassFacilitiesReplace = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function () {
  "use strict";

  function trim(value) {
    return String(value == null ? "" : value).trim();
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function canonicalExclusiveAreas(list) {
    if (!Array.isArray(list)) return [];
    return list.map(function (entry) {
      if (isPlainObject(entry)) {
        const name = trim(entry.name || entry.label || "");
        const description = trim(entry.description || "");
        if (!name && !description) return null;
        const item = { name: name || description };
        if (name && description) item.description = description;
        return item;
      }
      const text = trim(entry);
      return text ? { name: text } : null;
    }).filter(Boolean);
  }

  function canonicalSpecialtyFeatures(list) {
    if (!Array.isArray(list)) return [];
    return list.map(function (entry) {
      if (isPlainObject(entry)) {
        return trim(entry.name || entry.label || entry.value || entry.description || "");
      }
      return trim(entry);
    }).filter(Boolean);
  }

  function templateSections(template) {
    const tpl = template && typeof template === "object" ? template : {};
    return {
      exclusive_areas: Array.isArray(tpl.exclusive_areas) ? deepClone(tpl.exclusive_areas) : [],
      specialty_features: Array.isArray(tpl.specialty_features) ? deepClone(tpl.specialty_features) : []
    };
  }

  function sectionsEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function compareShipFacilitiesToTemplate(shipFacilities, template) {
    const fac = shipFacilities && typeof shipFacilities === "object" ? shipFacilities : {};
    const tplSections = templateSections(template);
    const shipEa = canonicalExclusiveAreas(fac.exclusive_areas);
    const shipSf = canonicalSpecialtyFeatures(fac.specialty_features);
    const tplEa = canonicalExclusiveAreas(tplSections.exclusive_areas);
    const tplSf = canonicalSpecialtyFeatures(tplSections.specialty_features);
    const eaMatches = sectionsEqual(shipEa, tplEa);
    const sfMatches = sectionsEqual(shipSf, tplSf);
    return {
      matches: eaMatches && sfMatches,
      eaMatches: eaMatches,
      sfMatches: sfMatches
    };
  }

  function applyClassTemplateToFacilities(existingFacilities, template) {
    const facilities = {
      ...(existingFacilities && typeof existingFacilities === "object" ? existingFacilities : {})
    };
    const before = compareShipFacilitiesToTemplate(facilities, template);
    const tplSections = templateSections(template);
    facilities.exclusive_areas = tplSections.exclusive_areas;
    facilities.specialty_features = tplSections.specialty_features;
    return {
      facilities: facilities,
      changed: !before.matches,
      comparison: before
    };
  }

  function summarizeApplyPreview(ships, template) {
    const rows = [];
    let matchingCount = 0;
    let willChangeCount = 0;
    (Array.isArray(ships) ? ships : []).forEach(function (ship) {
      const applied = applyClassTemplateToFacilities(ship && ship.facilities, template);
      const comparison = applied.comparison;
      if (applied.changed) willChangeCount += 1;
      else matchingCount += 1;
      rows.push({
        shipId: ship && ship.id,
        shipName: ship && ship.name,
        status: applied.changed ? "will_change" : "matching",
        eaMatches: comparison.eaMatches,
        sfMatches: comparison.sfMatches,
        willClearEa: !comparison.eaMatches && canonicalExclusiveAreas(ship && ship.facilities && ship.facilities.exclusive_areas).length > 0 && !canonicalExclusiveAreas(templateSections(template).exclusive_areas).length,
        willClearSf: !comparison.sfMatches && canonicalSpecialtyFeatures(ship && ship.facilities && ship.facilities.specialty_features).length > 0 && !canonicalSpecialtyFeatures(templateSections(template).specialty_features).length
      });
    });
    return {
      rows: rows,
      aggregate: {
        ships: rows.length,
        matchingCount: matchingCount,
        willChangeCount: willChangeCount,
        hasChanges: willChangeCount > 0
      }
    };
  }

  function templatesPayloadEqual(a, b) {
    const left = templateSections(a);
    const right = templateSections(b);
    return sectionsEqual(canonicalExclusiveAreas(left.exclusive_areas), canonicalExclusiveAreas(right.exclusive_areas))
      && sectionsEqual(canonicalSpecialtyFeatures(left.specialty_features), canonicalSpecialtyFeatures(right.specialty_features));
  }

  return {
    canonicalExclusiveAreas,
    canonicalSpecialtyFeatures,
    compareShipFacilitiesToTemplate,
    applyClassTemplateToFacilities,
    summarizeApplyPreview,
    templatesPayloadEqual,
    templateSections
  };
});
