/**
 * Canonical stateroom type reference — one source of truth for 101cruise.
 * Browser global: StateroomTypesService
 */
(function (global) {
  "use strict";

  const TABLE = "stateroom_types";
  const SELECT_FIELDS = "id,name,normalized_name,display_order,is_active,created_at,updated_at";

  function trimName(value) {
    return String(value ?? "").trim().replace(/\s+/g, " ");
  }

  function normalizeName(value) {
    return trimName(value).toLowerCase();
  }

  function sortStateroomTypes(rows) {
    return (Array.isArray(rows) ? rows.slice() : []).sort((a, b) =>
      String(a?.name || "").localeCompare(String(b?.name || ""), "en", {
        sensitivity: "base",
        numeric: true
      })
    );
  }

  function dedupeByNormalizedName(rows) {
    const seen = new Set();
    const out = [];
    for (const row of sortStateroomTypes(rows)) {
      const key = normalizeName(row?.name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
    return out;
  }

  // Active is retained in the database only for backwards compatibility.
  // Every canonical type that exists is available to be allocated.
  function listActiveStateroomTypesFromRows(rows) {
    return sortStateroomTypes(rows || []);
  }

  function buildRoomTypeSelectOptions(types, currentLabel) {
    const current = trimName(currentLabel);
    const currentKey = normalizeName(current);
    const canonical = dedupeByNormalizedName(types);
    const options = [{ value: "", label: "Select room type", selected: !current, inactive: false }];
    for (const type of canonical) {
      const name = trimName(type?.name);
      if (!name) continue;
      options.push({ value: name, label: name, selected: currentKey === normalizeName(name), inactive: false });
    }
    const keys = new Set(canonical.map((type) => normalizeName(type?.name)).filter(Boolean));
    if (current && !keys.has(currentKey)) {
      options.push({ value: current, label: `${current} (legacy)`, selected: true, inactive: true });
    }
    return dedupeSelectOptions(options);
  }

  function normalizeAllocationMap(raw) {
    const map = {};
    if (!raw || typeof raw !== "object") return map;
    for (const [lineId, ids] of Object.entries(raw)) {
      if (!lineId) continue;
      map[lineId] = Array.isArray(ids) ? [...new Set(ids.map(String).filter(Boolean))] : [];
    }
    return map;
  }

  // Explicit allocation only. An empty allocation means no types, never "all".
  function filterActiveTypesForCruiseLine(allTypes, cruiseLineId, allocationMap) {
    if (!cruiseLineId) return [];
    const assigned = Array.isArray(allocationMap?.[cruiseLineId]) ? allocationMap[cruiseLineId] : [];
    const allowed = new Set(assigned.map(String));
    return sortStateroomTypes((allTypes || []).filter((row) => allowed.has(String(row.id))));
  }

  function buildRoomTypeSelectOptionsForCruiseLine(allTypes, cruiseLineId, allocationMap, currentLabel) {
    if (!cruiseLineId) {
      return [{ value: "", label: "Select cruise line first", selected: true, inactive: false }];
    }
    const allowedTypes = filterActiveTypesForCruiseLine(allTypes, cruiseLineId, allocationMap);
    const current = trimName(currentLabel);
    const currentKey = normalizeName(current);
    const allowed = dedupeByNormalizedName(allowedTypes);
    const options = [{ value: "", label: "Select room type", selected: !current, inactive: false }];
    for (const type of allowed) {
      const name = trimName(type?.name);
      if (!name) continue;
      options.push({ value: name, label: name, selected: currentKey === normalizeName(name), inactive: false });
    }
    const allowedKeys = new Set(allowed.map((type) => normalizeName(type?.name)).filter(Boolean));
    if (current && !allowedKeys.has(currentKey)) {
      const existsGlobally = (allTypes || []).some((type) => normalizeName(type?.name) === currentKey);
      options.push({
        value: current,
        label: existsGlobally ? `${current} (not enabled for this line)` : `${current} (legacy)`,
        selected: true,
        inactive: true
      });
    }
    return dedupeSelectOptions(options);
  }

  function dedupeSelectOptions(options) {
    const seen = new Set();
    const out = [];
    for (const option of options || []) {
      const key = option.value === "" ? "" : normalizeName(option.value);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(option);
    }
    return out;
  }

  function validateStateroomTypeInput({ name, existingRows, editingId }) {
    const trimmed = trimName(name);
    if (!trimmed) return { ok: false, error: "Stateroom type name is required." };
    const normalized = normalizeName(trimmed);
    const duplicate = (existingRows || []).some((row) => {
      if (editingId && String(row?.id) === String(editingId)) return false;
      return normalizeName(row?.name) === normalized;
    });
    if (duplicate) return { ok: false, error: "A stateroom type with this name already exists." };
    return { ok: true, payload: { name: trimmed, normalized_name: normalized, is_active: true } };
  }

  function nextDisplayOrder(rows) {
    const max = (rows || []).reduce((acc, row) => Math.max(acc, Number(row?.display_order) || 0), 0);
    return max + 10;
  }

  function buildCreatePayload({ name, existingRows }) {
    const validation = validateStateroomTypeInput({ name, existingRows });
    if (!validation.ok) return validation;
    return { ok: true, payload: { ...validation.payload, display_order: nextDisplayOrder(existingRows) } };
  }

  // Kept for backwards compatibility with older callers. Ordering is now A–Z.
  function buildReorderPayload(orderedIds) {
    const ids = Array.isArray(orderedIds) ? orderedIds.map(String).filter(Boolean) : [];
    return ids.length
      ? { ok: true, payload: ids.map((id, index) => ({ id, display_order: (index + 1) * 10 })) }
      : { ok: false, error: "Reorder requires at least one stateroom type." };
  }

  function getSupabaseClient() {
    return global.supabaseClient || global.getAdminSupabaseClient?.() || null;
  }

  async function api(action, extra = {}) {
    const headers = typeof global.adminAuthHeaders === "function"
      ? await global.adminAuthHeaders({ "Content-Type": "application/json" })
      : { "Content-Type": "application/json" };
    const response = await fetch("/.netlify/functions/stateroom-types", {
      method: "POST",
      headers,
      body: JSON.stringify({ action, ...extra })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      const err = new Error(data.error || `Stateroom types request failed (HTTP ${response.status})`);
      err.statusCode = response.status;
      throw err;
    }
    return data;
  }

  async function listAllStateroomTypes({ client } = {}) {
    const supabase = client || getSupabaseClient();
    if (supabase) {
      const { data, error } = await supabase.from(TABLE).select(SELECT_FIELDS).order("name", { ascending: true });
      if (error) throw new Error(error.message || "Could not load stateroom types.");
      return sortStateroomTypes(data || []);
    }
    const result = await api("list");
    return sortStateroomTypes(result.stateroom_types || []);
  }

  async function listActiveStateroomTypes(opts) {
    return listAllStateroomTypes(opts);
  }

  async function createStateroomType(payload) {
    const result = await api("create", { stateroom_type: { ...payload, is_active: true } });
    return result.stateroom_type;
  }

  async function updateStateroomType(id, payload) {
    const result = await api("update", { id, stateroom_type: { ...payload, is_active: true } });
    return result.stateroom_type;
  }

  async function deleteStateroomType(id) {
    return api("delete", { id });
  }

  async function checkStateroomTypeUsage(id) {
    const result = await api("check_usage", { id });
    return Boolean(result.in_use);
  }

  async function loadCruiseLineStateroomAllocations() {
    const result = await api("list_line_allocations");
    return normalizeAllocationMap(result.allocations || {});
  }

  async function saveCruiseLineStateroomTypes(cruiseLineId, stateroomTypeIds) {
    const result = await api("save_line_allocations", {
      cruise_line_id: cruiseLineId,
      stateroom_type_ids: stateroomTypeIds
    });
    return normalizeAllocationMap(result.allocations || {});
  }

  async function reorderStateroomTypes(orderedIds) {
    const result = await api("reorder", { ordered_ids: orderedIds });
    return sortStateroomTypes(result.stateroom_types || []);
  }

  const service = {
    trimName,
    normalizeName,
    sortStateroomTypes,
    dedupeByNormalizedName,
    listActiveStateroomTypesFromRows,
    buildRoomTypeSelectOptions,
    normalizeAllocationMap,
    filterActiveTypesForCruiseLine,
    buildRoomTypeSelectOptionsForCruiseLine,
    validateStateroomTypeInput,
    buildCreatePayload,
    buildReorderPayload,
    nextDisplayOrder,
    listAllStateroomTypes,
    listActiveStateroomTypes,
    createStateroomType,
    updateStateroomType,
    deleteStateroomType,
    checkStateroomTypeUsage,
    reorderStateroomTypes,
    loadCruiseLineStateroomAllocations,
    saveCruiseLineStateroomTypes
  };

  service.__test__ = {
    trimName,
    normalizeName,
    sortStateroomTypes,
    dedupeByNormalizedName,
    buildRoomTypeSelectOptions,
    normalizeAllocationMap,
    filterActiveTypesForCruiseLine,
    buildRoomTypeSelectOptionsForCruiseLine,
    validateStateroomTypeInput,
    buildCreatePayload,
    buildReorderPayload,
    nextDisplayOrder,
    listActiveStateroomTypesFromRows
  };

  global.StateroomTypesService = service;
})(typeof window !== "undefined" ? window : globalThis);
