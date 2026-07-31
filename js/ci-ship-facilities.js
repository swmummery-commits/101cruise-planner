/**
 * Cruise Intelligence ship facilities — Exclusive Areas and Specialty Features.
 * Shared by Admin editor and My Cruise Your Ship renderer.
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

  /**
   * Load exclusive areas for Admin row editor.
   * Legacy strings become one row each — never split on punctuation.
   */
  function loadExclusiveAreasForAdmin(raw) {
    if (!Array.isArray(raw)) return [];
    const rows = [];
    raw.forEach(function (entry) {
      if (isPlainObject(entry)) {
        const name = trim(entry.name);
        const description = trim(entry.description);
        if (!name && !description) return;
        rows.push({ name: name || description, description: name ? description : "" });
        return;
      }
      const text = trim(entry);
      if (text) rows.push({ name: text, description: "" });
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

  /**
   * Load specialty features for Admin row editor (one stored item per row).
   */
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

  /**
   * Serialize Admin specialty-feature rows.
   */
  function serializeSpecialtyFeaturesFromAdmin(rows) {
    if (!Array.isArray(rows)) return [];
    return rows
      .map(function (row) {
        return trim(row && row.label);
      })
      .filter(Boolean);
  }

  /**
   * Customer-facing exclusive areas for My Ship.
   * Legacy strings render as one chip each; objects use name + optional description.
   */
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

  /**
   * Customer-facing specialty features — one chip per stored array element.
   */
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

  /**
   * Flat labels for APIs that expect string arrays (research facts, etc.).
   */
  function exclusiveAreasAsLabels(raw) {
    return normalizeExclusiveAreasForDisplay(raw).map(function (item) {
      return item.name;
    });
  }

  /**
   * Merge facilities from Admin DOM helpers into an existing facilities object.
   * Preserves unknown JSON keys on existingFacilities.
   */
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

  return {
    loadExclusiveAreasForAdmin,
    serializeExclusiveAreasFromAdmin,
    loadSpecialtyFeaturesForAdmin,
    serializeSpecialtyFeaturesFromAdmin,
    normalizeExclusiveAreasForDisplay,
    normalizeSpecialtyFeaturesForDisplay,
    exclusiveAreasAsLabels,
    mergeFacilitiesFromEditors
  };
});
