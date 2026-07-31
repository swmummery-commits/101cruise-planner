/**
 * Cruise Intelligence ship facilities — Exclusive Areas and Specialty Features.
 * Shared by Admin editor, My Cruise Your Ship renderer, and Admin copy API.
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

  /**
   * Presentation-only split for long legacy strings with a comma.
   * Does not mutate stored records.
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

  /**
   * Detect already-fragmented legacy exclusive-area arrays (e.g. Celebrity Millennium).
   */
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

  /**
   * Load exclusive areas for compact Admin editor rows.
   */
  function loadExclusiveAreasForAdmin(raw) {
    if (!Array.isArray(raw)) return [];
    const rows = [];
    raw.forEach(function (entry) {
      if (isPlainObject(entry)) {
        const name = trim(entry.name);
        const description = trim(entry.description);
        if (!name && !description) return;
        rows.push({
          name: name || description,
          description: name ? description : "",
          showDescription: Boolean(name ? description : false)
        });
        return;
      }
      const suggested = suggestLegacyExclusiveString(trim(entry));
      rows.push({
        name: suggested.name,
        description: suggested.description,
        showDescription: Boolean(suggested.description),
        suggestedSplit: suggested.suggested
      });
    });
    return rows;
  }

  /**
   * Serialize Admin exclusive-area rows for facilities.exclusive_areas storage.
   */
  function serializeExclusiveAreasFromAdmin(rows) {
    if (!Array.isArray(rows)) return [];
    return rows
      .map(function (row) {
        const name = trim(row && row.name);
        const description = trim(row && row.description);
        if (!name) return null;
        const item = { name: name };
        if (description) item.description = description;
        return item;
      })
      .filter(Boolean);
  }

  function loadSpecialtyFeaturesForAdmin(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map(function (entry) {
        return trim(entry);
      })
      .filter(Boolean)
      .map(function (label) {
        return { label: label };
      });
  }

  function serializeSpecialtyFeaturesFromAdmin(rows) {
    if (!Array.isArray(rows)) return [];
    return rows
      .map(function (row) {
        return trim(row && row.label);
      })
      .filter(Boolean);
  }

  function normalizeExclusiveAreasForDisplay(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map(function (entry) {
        if (isPlainObject(entry)) {
          const name = trim(entry.name);
          const description = trim(entry.description);
          if (!name && !description) return null;
          return {
            name: name || description,
            description: name && description ? description : "",
            legacyString: false
          };
        }
        const text = trim(entry);
        if (!text) return null;
        return { name: text, description: "", legacyString: true };
      })
      .filter(Boolean);
  }

  function normalizeSpecialtyFeaturesForDisplay(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map(function (entry) {
        if (isPlainObject(entry)) {
          const label = trim(entry.name || entry.label || entry.description);
          return label || null;
        }
        const text = trim(entry);
        return text || null;
      })
      .filter(Boolean);
  }

  function exclusiveAreasAsLabels(raw) {
    return normalizeExclusiveAreasForDisplay(raw).map(function (item) {
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

  /**
   * Same-class copy targets from in-memory ship catalogue rows.
   */
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

  /**
   * Merge copied facility sections into an existing facilities object.
   */
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

  return {
    normalizeShipClass,
    shipClassesMatch,
    suggestLegacyExclusiveString,
    detectFragmentedLegacyExclusiveAreas,
    loadExclusiveAreasForAdmin,
    serializeExclusiveAreasFromAdmin,
    loadSpecialtyFeaturesForAdmin,
    serializeSpecialtyFeaturesFromAdmin,
    normalizeExclusiveAreasForDisplay,
    normalizeSpecialtyFeaturesForDisplay,
    exclusiveAreasAsLabels,
    mergeFacilitiesFromEditors,
    listSameClassCopyTargets,
    mergeFacilitiesCopy,
    validateSameClassCopyRequest
  };
});
