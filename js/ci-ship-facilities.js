/**
 * Cruise Intelligence ship facilities — Exclusive Areas and Specialty Features.
 * Shared by Admin editor, My Ship renderer, class templates, and copy tools.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CiShipFacilities = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function () {
  "use strict";

  function trim(value) {
    return String(value == null ? "" : value).trim();
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function getIconsApi() {
    const root = typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : null;
    if (root && root.CiShipFeatureIcons) return root.CiShipFeatureIcons;
    if (typeof module !== "undefined" && module.exports) {
      try {
        return require("./ci-ship-feature-icons.js");
      } catch (_error) {
        return null;
      }
    }
    return null;
  }

  function resolveIconKey(name, explicitIconKey) {
    const icons = getIconsApi();
    if (icons && icons.resolveShipFeatureIconKey) {
      return icons.resolveShipFeatureIconKey(name, explicitIconKey);
    }
    const key = trim(explicitIconKey);
    return key || "sparkles";
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

  function isPlausibleShortExclusiveName(namePart) {
    const name = trim(namePart);
    if (!name || name.length > 60) return false;
    if (/\.\s/.test(name)) return false;
    if (name.split(/\s+/).length > 8) return false;
    return true;
  }

  const LEGACY_PROSE_STARTERS = [
    "a ",
    "an ",
    "the ",
    "featuring ",
    "offering ",
    "providing ",
    "designed ",
    "reserved ",
    "available ",
    "exclusive ",
    "private ",
    "located ",
    "includes ",
    "with "
  ];

  function remainderReadsAsProse(descPart) {
    const desc = trim(descPart);
    if (!desc) return false;
    const lower = desc.toLowerCase();
    const startsWithProse = LEGACY_PROSE_STARTERS.some(function (starter) {
      return lower.startsWith(starter);
    });
    if (!startsWithProse) return false;
    if (desc.length < 24 && desc.split(/\s+/).length < 5) return false;
    return true;
  }

  function capitalizeDescriptionLead(text) {
    const desc = trim(text);
    if (!desc) return "";
    return desc.charAt(0).toUpperCase() + desc.slice(1);
  }

  /**
   * Render-time only — splits legacy whole-string entries for customer display.
   * Never used for Admin load, serialize, compare, or persistence.
   */
  function inferLegacyDisplayFromString(text) {
    const full = trim(text);
    if (!full) {
      return { name: "", description: "" };
    }
    const commaIdx = full.indexOf(",");
    if (commaIdx < 0) {
      return { name: full, description: "" };
    }
    const namePart = trim(full.slice(0, commaIdx));
    const descPart = trim(full.slice(commaIdx + 1));
    if (!namePart || !descPart || !isPlausibleShortExclusiveName(namePart)) {
      return { name: full, description: "" };
    }
    if (!remainderReadsAsProse(descPart)) {
      return { name: full, description: "" };
    }
    return {
      name: namePart,
      description: capitalizeDescriptionLead(descPart)
    };
  }

  /**
   * Optional Admin hint only — never applied automatically during normalisation.
   */
  function suggestLegacyExclusiveString(text) {
    const full = trim(text);
    if (!full) {
      return { name: "", description: "", suggested: false };
    }
    const commaIdx = full.indexOf(",");
    if (commaIdx < 0 || full.length < 40) {
      return { name: full, description: "", suggested: false };
    }
    const namePart = trim(full.slice(0, commaIdx));
    const descPart = trim(full.slice(commaIdx + 1));
    if (!namePart || !descPart || !isPlausibleShortExclusiveName(namePart)) {
      return { name: full, description: "", suggested: false };
    }
    return { name: namePart, description: descPart, suggested: true };
  }

  function detectFragmentedLegacyExclusiveAreas(raw) {
    if (!Array.isArray(raw) || raw.length < 4) return false;
    if (raw.some(function (entry) {
      return isPlainObject(entry);
    })) {
      return false;
    }
    const strings = raw.map(function (entry) {
      return trim(entry);
    }).filter(Boolean);
    if (strings.length < 4) return false;
    return strings.some(function (entry) {
      return /^a\s/i.test(entry) || /^and\s/i.test(entry) || /^dedicated\s/i.test(entry);
    });
  }

  function normalizeShipFeatureEntry(entry) {
    if (isPlainObject(entry)) {
      const name = trim(entry.name || entry.label || "");
      const description = trim(entry.description || "");
      if (!name && !description) return null;
      const resolvedName = name || description;
      const item = {
        name: resolvedName,
        description: name && description ? description : "",
        icon_key: resolveIconKey(resolvedName, entry.icon_key)
      };
      Object.keys(entry).forEach(function (key) {
        if (key === "name" || key === "label" || key === "description" || key === "icon_key") return;
        item[key] = entry[key];
      });
      return item;
    }
    if (typeof entry === "string" || typeof entry === "number") {
      const text = trim(entry);
      if (!text) return null;
      return {
        name: text,
        description: "",
        icon_key: resolveIconKey(text),
        legacyString: true
      };
    }
    return null;
  }

  function normalizeShipFeatureList(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeShipFeatureEntry).filter(Boolean);
  }

  function canonicalShipFeatureItem(item) {
    if (!item) return null;
    return {
      name: trim(item.name),
      description: trim(item.description),
      icon_key: resolveIconKey(item.name, item.icon_key)
    };
  }

  function canonicalShipFeatureList(raw) {
    return normalizeShipFeatureList(raw).map(canonicalShipFeatureItem).filter(Boolean);
  }

  function shipFeatureListsEqual(leftRaw, rightRaw) {
    const left = canonicalShipFeatureList(leftRaw);
    const right = canonicalShipFeatureList(rightRaw);
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function loadShipFeaturesForAdmin(raw) {
    return normalizeShipFeatureList(raw).map(function (item) {
      return {
        name: item.name,
        description: item.description,
        icon_key: item.icon_key,
        showDescription: Boolean(item.description),
        needsDescription: !item.description
      };
    });
  }

  function loadExclusiveAreasForAdmin(raw) {
    return loadShipFeaturesForAdmin(raw);
  }

  function loadSpecialtyFeaturesForAdmin(raw) {
    return loadShipFeaturesForAdmin(raw).map(function (row) {
      return {
        name: row.name,
        description: row.description,
        icon_key: row.icon_key,
        showDescription: row.showDescription,
        needsDescription: row.needsDescription,
        label: row.name
      };
    });
  }

  function serializeShipFeaturesFromAdmin(rows) {
    if (!Array.isArray(rows)) return [];
    return rows
      .map(function (row) {
        const name = trim(row && (row.name || row.label));
        if (!name) return null;
        const description = trim(row && row.description);
        const icon_key = resolveIconKey(name, row && row.icon_key);
        const item = { name: name, icon_key: icon_key };
        if (description) item.description = description;
        return item;
      })
      .filter(Boolean);
  }

  function serializeExclusiveAreasFromAdmin(rows) {
    return serializeShipFeaturesFromAdmin(rows);
  }

  function serializeSpecialtyFeaturesFromAdmin(rows) {
    return serializeShipFeaturesFromAdmin(rows);
  }

  function normalizeExclusiveAreasForDisplay(raw) {
    return normalizeShipFeatureList(raw).map(function (item) {
      if (item.legacyString && !trim(item.description)) {
        const inferred = inferLegacyDisplayFromString(item.name);
        return {
          name: inferred.name,
          description: inferred.description,
          icon_key: resolveIconKey(inferred.name, item.icon_key),
          legacyString: true
        };
      }
      return {
        name: item.name,
        description: item.description,
        icon_key: item.icon_key,
        legacyString: Boolean(item.legacyString)
      };
    });
  }

  function normalizeSpecialtyFeaturesForDisplay(raw) {
    return normalizeExclusiveAreasForDisplay(raw);
  }

  function exclusiveAreasAsLabels(raw) {
    return normalizeShipFeatureList(raw).map(function (item) {
      return item.name;
    });
  }

  function mergeFacilitiesFromEditors(existingFacilities, exclusiveRows, specialtyRows, scalarPatch) {
    const facilities = {
      ...(existingFacilities && typeof existingFacilities === "object" ? existingFacilities : {})
    };
    Object.assign(facilities, scalarPatch || {});

    const exclusive = serializeExclusiveAreasFromAdmin(exclusiveRows);
    const specialty = serializeSpecialtyFeaturesFromAdmin(specialtyRows);

    if (exclusive.length) facilities.exclusive_areas = exclusive;
    else delete facilities.exclusive_areas;

    if (specialty.length) facilities.specialty_features = specialty;
    else delete facilities.specialty_features;

    return facilities;
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

  function mergeFacilitiesCopy(existingFacilities, patch) {
    const facilities = {
      ...(existingFacilities && typeof existingFacilities === "object" ? existingFacilities : {})
    };
    const copyExclusive = Boolean(patch && patch.copy_exclusive_areas);
    const copySpecialty = Boolean(patch && patch.copy_specialty_features);

    if (copyExclusive) {
      const exclusive = Array.isArray(patch.exclusive_areas) ? patch.exclusive_areas : [];
      if (exclusive.length) facilities.exclusive_areas = exclusive;
      else delete facilities.exclusive_areas;
    }
    if (copySpecialty) {
      const specialty = Array.isArray(patch.specialty_features) ? patch.specialty_features : [];
      if (specialty.length) facilities.specialty_features = specialty;
      else delete facilities.specialty_features;
    }
    return facilities;
  }

  function validateSameClassCopyRequest({ sourceShip, targetShips, draftClass }) {
    const shipClass = normalizeShipClass(draftClass != null ? draftClass : sourceShip && sourceShip.ship_class);
    if (!sourceShip || !sourceShip.id || !sourceShip.cruise_line_id || !shipClass) {
      return { ok: false, error: "SOURCE_SHIP_INCOMPLETE" };
    }
    if (!Array.isArray(targetShips) || !targetShips.length) {
      return { ok: false, error: "NO_TARGETS" };
    }
    for (const target of targetShips) {
      if (!target || target.id === sourceShip.id) {
        return { ok: false, error: "SOURCE_IN_TARGETS" };
      }
      if (target.cruise_line_id !== sourceShip.cruise_line_id) {
        return { ok: false, error: "TARGET_LINE_MISMATCH" };
      }
      if (!shipClassesMatch(target.ship_class, shipClass)) {
        return { ok: false, error: "TARGET_CLASS_MISMATCH" };
      }
      if (target.active === false) {
        return { ok: false, error: "TARGET_INACTIVE" };
      }
    }
    return { ok: true, shipClass: shipClass };
  }

  function sameClassCopyButtonLabel(selectedCount) {
    const count = Number(selectedCount) || 0;
    if (count <= 0) return "Copy to selected ships";
    return `Copy to ${count} selected ship${count === 1 ? "" : "s"}`;
  }

  function sameClassCopyCanSubmit({ selectedCount, copyExclusive, copySpecialty }) {
    const count = Number(selectedCount) || 0;
    if (count <= 0) return false;
    return Boolean(copyExclusive || copySpecialty);
  }

  function sameClassCopyConfirmMessage({ selectedCount, targetNames, sections }) {
    const count = Number(selectedCount) || 0;
    const sectionText = (Array.isArray(sections) ? sections : []).filter(Boolean).join(" and ") || "nothing";
    const names = (Array.isArray(targetNames) ? targetNames : []).filter(Boolean);
    const shipList = names.join("\n");
    return `Copy ${sectionText} to ${count} ship${count === 1 ? "" : "s"}?\n\n${shipList}\n\nTarget values for the selected sections will be replaced.`;
  }

  return {
    inferLegacyDisplayFromString: inferLegacyDisplayFromString,
    normalizeShipClass: normalizeShipClass,
    shipClassesMatch: shipClassesMatch,
    suggestLegacyExclusiveString: suggestLegacyExclusiveString,
    detectFragmentedLegacyExclusiveAreas: detectFragmentedLegacyExclusiveAreas,
    normalizeShipFeatureEntry: normalizeShipFeatureEntry,
    normalizeShipFeatureList: normalizeShipFeatureList,
    canonicalShipFeatureItem: canonicalShipFeatureItem,
    canonicalShipFeatureList: canonicalShipFeatureList,
    shipFeatureListsEqual: shipFeatureListsEqual,
    loadShipFeaturesForAdmin: loadShipFeaturesForAdmin,
    loadExclusiveAreasForAdmin: loadExclusiveAreasForAdmin,
    loadSpecialtyFeaturesForAdmin: loadSpecialtyFeaturesForAdmin,
    serializeShipFeaturesFromAdmin: serializeShipFeaturesFromAdmin,
    serializeExclusiveAreasFromAdmin: serializeExclusiveAreasFromAdmin,
    serializeSpecialtyFeaturesFromAdmin: serializeSpecialtyFeaturesFromAdmin,
    normalizeExclusiveAreasForDisplay: normalizeExclusiveAreasForDisplay,
    normalizeSpecialtyFeaturesForDisplay: normalizeSpecialtyFeaturesForDisplay,
    exclusiveAreasAsLabels: exclusiveAreasAsLabels,
    mergeFacilitiesFromEditors: mergeFacilitiesFromEditors,
    listSameClassCopyTargets: listSameClassCopyTargets,
    mergeFacilitiesCopy: mergeFacilitiesCopy,
    validateSameClassCopyRequest: validateSameClassCopyRequest,
    sameClassCopyButtonLabel: sameClassCopyButtonLabel,
    sameClassCopyCanSubmit: sameClassCopyCanSubmit,
    sameClassCopyConfirmMessage: sameClassCopyConfirmMessage,
    normalizeCompareText: normalizeCompareText
  };
});
