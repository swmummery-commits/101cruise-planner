/**
 * Shared stateroom type reference — normalisation, sorting, and data access.
 * Browser global: StateroomTypesService
 */
(function (global) {
  "use strict";

  const TABLE = "stateroom_types";
  const SELECT_FIELDS = "id,name,normalized_name,display_order,is_active,created_at,updated_at";

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

  function sortStateroomTypes(rows) {
    const list = Array.isArray(rows) ? rows.slice() : [];
    list.sort((a, b) => {
      const orderDiff =
        parseDisplayOrder(a?.display_order, 0) - parseDisplayOrder(b?.display_order, 0);
      if (orderDiff !== 0) return orderDiff;
      return String(a?.name || "").localeCompare(String(b?.name || ""), "en", { sensitivity: "base" });
    });
    return list;
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

  function listActiveStateroomTypesFromRows(rows) {
    return sortStateroomTypes((rows || []).filter((row) => row?.is_active !== false));
  }

  function buildRoomTypeSelectOptions(activeTypes, currentLabel) {
    const current = trimName(currentLabel);
    const currentKey = normalizeName(current);
    const active = dedupeByNormalizedName(activeTypes);
    const options = [{ value: "", label: "Select room type", selected: !current, inactive: false }];

    for (const type of active) {
      const name = trimName(type?.name);
      if (!name) continue;
      options.push({
        value: name,
        label: name,
        selected: currentKey !== "" && normalizeName(name) === currentKey,
        inactive: false
      });
    }

    const activeKeys = new Set(active.map((type) => normalizeName(type?.name)).filter(Boolean));
    if (current && !activeKeys.has(currentKey)) {
      options.push({
        value: current,
        label: `${current} (inactive)`,
        selected: true,
        inactive: true
      });
    }

    return dedupeSelectOptions(options);
  }

  function dedupeSelectOptions(options) {
    const seen = new Set();
    const out = [];
    for (const option of options) {
      const key = option.value === "" ? "" : normalizeName(option.value);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(option);
    }
    return out;
  }

  function validateStateroomTypeInput({ name, display_order, is_active, existingRows, editingId }) {
    const trimmed = trimName(name);
    if (!trimmed) {
      return { ok: false, error: "Stateroom type name is required." };
    }
    const order = parseDisplayOrder(display_order, NaN);
    if (!Number.isFinite(order)) {
      return { ok: false, error: "Display order must be a whole number." };
    }
    const normalized = normalizeName(trimmed);
    const duplicate = (existingRows || []).some((row) => {
      if (editingId && row?.id === editingId) return false;
      return normalizeName(row?.name) === normalized;
    });
    if (duplicate) {
      return { ok: false, error: "A stateroom type with this name already exists." };
    }
    return {
      ok: true,
      payload: {
        name: trimmed,
        normalized_name: normalized,
        display_order: order,
        is_active: is_active !== false
      }
    };
  }

  function nextDisplayOrder(rows) {
    const sorted = sortStateroomTypes(rows || []);
    if (!sorted.length) return 10;
    const max = sorted.reduce(
      (acc, row) => Math.max(acc, parseDisplayOrder(row?.display_order, 0)),
      0
    );
    return max + 10;
  }

  function getSupabaseClient() {
    return global.supabaseClient || global.getAdminSupabaseClient?.() || null;
  }

  async function api(action, extra = {}) {
    const headers =
      typeof global.adminAuthHeaders === "function"
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
      const { data, error } = await supabase
        .from(TABLE)
        .select(SELECT_FIELDS)
        .order("display_order", { ascending: true })
        .order("name", { ascending: true });
      if (error) throw new Error(error.message || "Could not load stateroom types.");
      return sortStateroomTypes(data || []);
    }
    const result = await api("list");
    return sortStateroomTypes(result.stateroom_types || []);
  }

  async function listActiveStateroomTypes(opts) {
    const rows = await listAllStateroomTypes(opts);
    return listActiveStateroomTypesFromRows(rows);
  }

  async function createStateroomType(payload) {
    const result = await api("create", { stateroom_type: payload });
    return result.stateroom_type;
  }

  async function updateStateroomType(id, payload) {
    const result = await api("update", { id, stateroom_type: payload });
    return result.stateroom_type;
  }

  async function deleteStateroomType(id) {
    const result = await api("delete", { id });
    return result;
  }

  async function checkStateroomTypeUsage(id) {
    const result = await api("check_usage", { id });
    return Boolean(result.in_use);
  }

  const service = {
    trimName,
    normalizeName,
    sortStateroomTypes,
    dedupeByNormalizedName,
    listActiveStateroomTypesFromRows,
    buildRoomTypeSelectOptions,
    validateStateroomTypeInput,
    nextDisplayOrder,
    listAllStateroomTypes,
    listActiveStateroomTypes,
    createStateroomType,
    updateStateroomType,
    deleteStateroomType,
    checkStateroomTypeUsage
  };

  service.__test__ = {
    trimName,
    normalizeName,
    sortStateroomTypes,
    dedupeByNormalizedName,
    buildRoomTypeSelectOptions,
    validateStateroomTypeInput,
    nextDisplayOrder,
    listActiveStateroomTypesFromRows
  };

  global.StateroomTypesService = service;
})(typeof window !== "undefined" ? window : globalThis);
