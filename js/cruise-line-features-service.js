/**
 * Line-local ship feature catalogue — Exclusive Areas + Specialty Features.
 * Browser global: CruiseLineFeaturesService
 */
(function (global) {
  "use strict";

  const TABLE = "ci_cruise_line_features";
  const SELECT_FIELDS =
    "id,cruise_line_id,feature_type,name,normalized_name,description,icon_key,display_order,is_active,created_at,updated_at";
  const FEATURE_TYPES = Object.freeze({
    EXCLUSIVE_AREA: "exclusive_area",
    SPECIALTY_FEATURE: "specialty_feature"
  });

  function trimName(value) {
    return String(value ?? "").trim();
  }

  function normalizeName(value) {
    return trimName(value).toLowerCase();
  }

  function parseDisplayOrder(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
  }

  function sortFeatures(rows) {
    const list = Array.isArray(rows) ? rows.slice() : [];
    list.sort((a, b) => {
      const orderDiff =
        parseDisplayOrder(a?.display_order, 0) - parseDisplayOrder(b?.display_order, 0);
      if (orderDiff !== 0) return orderDiff;
      return String(a?.name || "").localeCompare(String(b?.name || ""), "en", { sensitivity: "base" });
    });
    return list;
  }

  function filterByType(rows, featureType) {
    return sortFeatures((rows || []).filter((row) => row?.feature_type === featureType));
  }

  function listActiveFeaturesFromRows(rows) {
    return sortFeatures((rows || []).filter((row) => row?.is_active !== false));
  }

  function nextDisplayOrder(rows) {
    const sorted = sortFeatures(rows || []);
    if (!sorted.length) return 10;
    const max = sorted.reduce(
      (acc, row) => Math.max(acc, parseDisplayOrder(row?.display_order, 0)),
      0
    );
    return max + 10;
  }

  function validateFeatureInput({ name, feature_type, existingRows, editingId, cruise_line_id, description, icon_key, is_active }) {
    const trimmed = trimName(name);
    if (!trimmed) {
      return { ok: false, error: "Feature name is required." };
    }
    if (!cruise_line_id) {
      return { ok: false, error: "Cruise line is required." };
    }
    if (!feature_type || !Object.values(FEATURE_TYPES).includes(feature_type)) {
      return { ok: false, error: "Feature type is required." };
    }
    const normalized = normalizeName(trimmed);
    const duplicate = (existingRows || []).some((row) => {
      if (editingId && row?.id === editingId) return false;
      return (
        row?.feature_type === feature_type &&
        normalizeName(row?.name) === normalized
      );
    });
    if (duplicate) {
      return { ok: false, error: "A feature with this name already exists for this line and type." };
    }
    return {
      ok: true,
      payload: {
        cruise_line_id: cruise_line_id,
        feature_type: feature_type,
        name: trimmed,
        normalized_name: normalized,
        description: trimName(description) || null,
        icon_key: trimName(icon_key) || "sparkles",
        is_active: is_active !== false
      }
    };
  }

  function buildCreatePayload(input) {
    const validation = validateFeatureInput(input);
    if (!validation.ok) return validation;
    const sameType = (input.existingRows || []).filter(
      (row) => row?.feature_type === input.feature_type
    );
    return {
      ok: true,
      payload: {
        ...validation.payload,
        display_order: nextDisplayOrder(sameType)
      }
    };
  }

  function buildReorderPayload(orderedIds) {
    const ids = Array.isArray(orderedIds)
      ? orderedIds.map((id) => String(id || "").trim()).filter(Boolean)
      : [];
    if (!ids.length) {
      return { ok: false, error: "Reorder requires at least one feature." };
    }
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id)) {
        return { ok: false, error: "Reorder list contains duplicate ids." };
      }
      seen.add(id);
    }
    return {
      ok: true,
      payload: ids.map((id, index) => ({
        id,
        display_order: (index + 1) * 10
      }))
    };
  }

  function featureItemName(item) {
    if (!item) return "";
    if (typeof item === "string") return trimName(item);
    return trimName(item.name || item.label);
  }

  function savedNamesSet(items) {
    const set = new Set();
    (items || []).forEach(function (item) {
      const key = normalizeName(featureItemName(item));
      if (key) set.add(key);
    });
    return set;
  }

  function buildTemplatePayloadFromCatalogue(catalogue, selectedIds) {
    const selected = new Set((selectedIds || []).map(String));
    const exclusive = [];
    const specialty = [];
    sortFeatures(catalogue || []).forEach(function (row) {
      if (!selected.has(String(row.id))) return;
      const item = {
        name: row.name,
        icon_key: row.icon_key || "sparkles"
      };
      if (trimName(row.description)) item.description = trimName(row.description);
      if (row.feature_type === FEATURE_TYPES.EXCLUSIVE_AREA) exclusive.push(item);
      else if (row.feature_type === FEATURE_TYPES.SPECIALTY_FEATURE) specialty.push(item);
    });
    return { exclusive_areas: exclusive, specialty_features: specialty };
  }

  function deriveSelectedIdsFromTemplate(catalogue, templatePayload) {
    const eaNames = savedNamesSet(templatePayload?.exclusive_areas);
    const sfNames = savedNamesSet(templatePayload?.specialty_features);
    return (catalogue || [])
      .filter(function (row) {
        const key = normalizeName(row?.name);
        if (!key) return false;
        if (row.feature_type === FEATURE_TYPES.EXCLUSIVE_AREA) return eaNames.has(key);
        if (row.feature_type === FEATURE_TYPES.SPECIALTY_FEATURE) return sfNames.has(key);
        return false;
      })
      .map(function (row) {
        return String(row.id);
      });
  }

  function orphanTemplateItems(catalogue, templatePayload) {
    const catalogueKeys = new Set(
      (catalogue || []).map(function (row) {
        return `${row.feature_type}:${normalizeName(row.name)}`;
      })
    );
    const orphans = [];
    [
      { type: FEATURE_TYPES.EXCLUSIVE_AREA, items: templatePayload?.exclusive_areas || [] },
      { type: FEATURE_TYPES.SPECIALTY_FEATURE, items: templatePayload?.specialty_features || [] }
    ].forEach(function (group) {
      (group.items || []).forEach(function (item) {
        const name = featureItemName(item);
        const key = `${group.type}:${normalizeName(name)}`;
        if (name && !catalogueKeys.has(key)) {
          orphans.push({ feature_type: group.type, name: name });
        }
      });
    });
    return orphans;
  }

  function featureItemFromCatalogueRow(row) {
    const item = {
      name: trimName(row?.name),
      icon_key: String(row?.icon_key || "sparkles").trim() || "sparkles"
    };
    const description = trimName(row?.description);
    if (description) item.description = description;
    return item;
  }

  function templateArrayKey(featureType) {
    if (featureType === FEATURE_TYPES.EXCLUSIVE_AREA) return "exclusive_areas";
    if (featureType === FEATURE_TYPES.SPECIALTY_FEATURE) return "specialty_features";
    return null;
  }

  function mergeFeatureIntoTemplatePayload(payload, featureType, item) {
    const key = templateArrayKey(featureType);
    if (!key || !item?.name) {
      return {
        exclusive_areas: Array.isArray(payload?.exclusive_areas) ? payload.exclusive_areas.slice() : [],
        specialty_features: Array.isArray(payload?.specialty_features) ? payload.specialty_features.slice() : []
      };
    }
    const next = {
      exclusive_areas: Array.isArray(payload?.exclusive_areas) ? payload.exclusive_areas.slice() : [],
      specialty_features: Array.isArray(payload?.specialty_features) ? payload.specialty_features.slice() : []
    };
    const arr = next[key];
    const norm = normalizeName(item.name);
    const idx = arr.findIndex(function (entry) {
      return normalizeName(featureItemName(entry)) === norm;
    });
    if (idx >= 0) arr[idx] = Object.assign({}, arr[idx], item);
    else arr.push(item);
    return next;
  }

  function removeFeatureFromTemplatePayload(payload, featureType, name) {
    const key = templateArrayKey(featureType);
    const next = {
      exclusive_areas: Array.isArray(payload?.exclusive_areas) ? payload.exclusive_areas.slice() : [],
      specialty_features: Array.isArray(payload?.specialty_features) ? payload.specialty_features.slice() : []
    };
    if (!key) return next;
    const norm = normalizeName(name);
    next[key] = next[key].filter(function (entry) {
      return normalizeName(featureItemName(entry)) !== norm;
    });
    return next;
  }

  function mergeFeatureIntoShipFacilities(facilities, featureType, item) {
    const key = templateArrayKey(featureType);
    const next = Object.assign({}, facilities && typeof facilities === "object" ? facilities : {});
    if (!key || !item?.name) return next;
    const arr = Array.isArray(next[key]) ? next[key].slice() : [];
    const norm = normalizeName(item.name);
    const idx = arr.findIndex(function (entry) {
      return normalizeName(featureItemName(entry)) === norm;
    });
    if (idx >= 0) arr[idx] = Object.assign({}, arr[idx], item);
    else arr.push(item);
    next[key] = arr;
    return next;
  }

  function shipHasFeature(ship, featureType, name) {
    const key = templateArrayKey(featureType);
    if (!key || !ship) return false;
    const arr = ship.facilities && Array.isArray(ship.facilities[key]) ? ship.facilities[key] : [];
    const norm = normalizeName(name);
    return arr.some(function (entry) {
      return normalizeName(featureItemName(entry)) === norm;
    });
  }

  async function api(action, extra = {}) {
    const headers =
      typeof global.adminAuthHeaders === "function"
        ? await global.adminAuthHeaders({ "Content-Type": "application/json" })
        : { "Content-Type": "application/json" };
    const response = await fetch("/.netlify/functions/cruise-line-features", {
      method: "POST",
      headers,
      body: JSON.stringify({ action, ...extra })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      const err = new Error(data.error || data.detail || `Cruise line features request failed (HTTP ${response.status})`);
      err.statusCode = response.status;
      throw err;
    }
    return data;
  }

  async function listFeaturesForLine(cruiseLineId) {
    const result = await api("list", { cruise_line_id: cruiseLineId });
    return sortFeatures(result.features || []);
  }

  async function createFeature(payload) {
    const result = await api("create", { feature: payload });
    return result.feature;
  }

  async function updateFeature(id, payload) {
    const result = await api("update", { id, feature: payload });
    return result.feature;
  }

  async function deleteFeature(id) {
    return api("delete", { id });
  }

  async function reorderFeatures(cruiseLineId, featureType, orderedIds) {
    const result = await api("reorder", {
      cruise_line_id: cruiseLineId,
      feature_type: featureType,
      ordered_ids: orderedIds
    });
    return sortFeatures(result.features || []);
  }

  const service = {
    TABLE,
    FEATURE_TYPES,
    trimName,
    normalizeName,
    sortFeatures,
    filterByType,
    listActiveFeaturesFromRows,
    nextDisplayOrder,
    validateFeatureInput,
    buildCreatePayload,
    buildReorderPayload,
    featureItemName,
    savedNamesSet,
    buildTemplatePayloadFromCatalogue,
    deriveSelectedIdsFromTemplate,
    orphanTemplateItems,
    featureItemFromCatalogueRow,
    mergeFeatureIntoTemplatePayload,
    removeFeatureFromTemplatePayload,
    mergeFeatureIntoShipFacilities,
    shipHasFeature,
    listFeaturesForLine,
    createFeature,
    updateFeature,
    deleteFeature,
    reorderFeatures
  };

  service.__test__ = {
    trimName,
    normalizeName,
    sortFeatures,
    filterByType,
    buildCreatePayload,
    buildReorderPayload,
    buildTemplatePayloadFromCatalogue,
    deriveSelectedIdsFromTemplate,
    orphanTemplateItems,
    listActiveFeaturesFromRows,
    featureItemFromCatalogueRow,
    mergeFeatureIntoTemplatePayload,
    removeFeatureFromTemplatePayload,
    mergeFeatureIntoShipFacilities,
    shipHasFeature
  };

  global.CruiseLineFeaturesService = service;
})(typeof window !== "undefined" ? window : globalThis);
