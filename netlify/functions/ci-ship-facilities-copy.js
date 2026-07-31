/**
 * Admin copy of ship facilities — item-level merge or legacy whole-section copy.
 *
 * POST /.netlify/functions/ci-ship-facilities-copy
 */
const { requireAdmin } = require("./admin-auth");
const {
  mergeFacilitiesCopy,
  validateSameClassCopyRequest,
  buildFacilitiesPatch,
  ItemCopy,
  executeItemLevelCopy
} = require("./lib/ci-ship-facilities-copy");

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server access is not configured");
  return { url: url.replace(/\/$/, ""), key };
}

async function supabase(path, options = {}) {
  const { url, key } = config();
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    ...(options.headers || {})
  };
  if (options.body !== undefined && options.body !== null) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }
  const response = await fetch(`${url}/rest/v1/${path}`, { ...options, headers });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_error) {
    data = null;
  }
  if (!response.ok) {
    const message = (data && data.message) || text || `Supabase HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function fetchShip(shipId) {
  const rows = await supabase(
    `ci_cruise_ships?id=eq.${encodeURIComponent(shipId)}&select=id,name,active,cruise_line_id,ship_class,facilities,passenger_capacity,crew_count,deck_count,stateroom_count,gross_tonnage,length_metres,year_built,year_refurbished,hero_image_url,ci_cruise_lines(id,name)&limit=1`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

function assertFacilitiesOnlyPatch(before, after) {
  if (
    after.passenger_capacity !== before.passenger_capacity ||
    after.crew_count !== before.crew_count ||
    after.deck_count !== before.deck_count ||
    after.hero_image_url !== before.hero_image_url
  ) {
    throw new Error("Unexpected non-facilities mutation detected");
  }
}

async function handleLegacyCategoryCopy(body, sourceShip, targetShips) {
  const patchResult = buildFacilitiesPatch(body);
  if (!patchResult.ok) {
    return jsonResponse(400, { success: false, error: patchResult.error });
  }

  const validation = validateSameClassCopyRequest({
    sourceShip,
    targetShips,
    draftClass: body.source_ship_class
  });
  if (!validation.ok) {
    return jsonResponse(409, { success: false, error: validation.error });
  }

  const results = [];
  for (const target of targetShips) {
    const before = {
      passenger_capacity: target.passenger_capacity,
      crew_count: target.crew_count,
      deck_count: target.deck_count,
      hero_image_url: target.hero_image_url
    };
    const nextFacilities = mergeFacilitiesCopy(target.facilities, patchResult.patch);
    try {
      const updated = await supabase(`ci_cruise_ships?id=eq.${encodeURIComponent(target.id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ facilities: nextFacilities })
      });
      const row = Array.isArray(updated) ? updated[0] : updated;
      assertFacilitiesOnlyPatch(before, row || {});
      results.push({ id: target.id, name: target.name, ok: true, facilities: nextFacilities });
    } catch (error) {
      results.push({
        id: target.id,
        name: target.name,
        ok: false,
        error: String(error.message || error)
      });
    }
  }

  const updated = results.filter((row) => row.ok);
  const failed = results.filter((row) => !row.ok);
  return jsonResponse(failed.length && !updated.length ? 500 : 200, {
    success: failed.length === 0,
    updated_count: updated.length,
    failed_count: failed.length,
    updated: updated.map((row) => row.name),
    failures: failed,
    results
  });
}

async function handleItemLevelCopy(body, sourceShip, targetShips) {
  const targetScope = body.target_scope === ItemCopy.TARGET_SCOPE_FLEET
    ? ItemCopy.TARGET_SCOPE_FLEET
    : ItemCopy.TARGET_SCOPE_SAME_CLASS;
  const conflictResolutions = Array.isArray(body.conflict_resolutions) ? body.conflict_resolutions : [];

  const validation = ItemCopy.validateItemLevelCopyRequest({
    sourceShip,
    targetShips,
    targetScope,
    selectedItems: body.selected_items,
    conflictResolutions,
    sourceFacilities: sourceShip.facilities
  });
  if (!validation.ok) {
    const status = validation.error === "NO_CHANGES" ? 400 : 409;
    return jsonResponse(status, { success: false, error: validation.error, detail: validation.detail || null });
  }

  const results = [];
  for (const target of targetShips) {
    const before = {
      passenger_capacity: target.passenger_capacity,
      crew_count: target.crew_count,
      deck_count: target.deck_count,
      hero_image_url: target.hero_image_url,
      facilities: target.facilities
    };
    const execution = executeItemLevelCopy({
      sourceFacilities: sourceShip.facilities,
      target,
      resolvedItems: validation.resolvedItems,
      conflictResolutions
    });
    if (!execution.ok) {
      results.push({
        id: target.id,
        name: target.name,
        ok: false,
        error: execution.error || "NO_CHANGES",
        status: "failed"
      });
      continue;
    }
    try {
      const updated = await supabase(`ci_cruise_ships?id=eq.${encodeURIComponent(target.id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ facilities: execution.facilities })
      });
      const row = Array.isArray(updated) ? updated[0] : updated;
      assertFacilitiesOnlyPatch(before, row || {});
      results.push({
        id: target.id,
        name: target.name,
        ok: true,
        status: "updated",
        facilities: execution.facilities,
        items: execution.outcomes,
        summary: execution.summary,
        result: execution.resultRow
      });
    } catch (error) {
      results.push({
        id: target.id,
        name: target.name,
        ok: false,
        error: String(error.message || error),
        status: "failed"
      });
    }
  }

  const updated = results.filter((row) => row.ok);
  const failed = results.filter((row) => !row.ok);
  return jsonResponse(failed.length && !updated.length ? 500 : 200, {
    success: failed.length === 0,
    mode: "item_level",
    updated_count: updated.length,
    failed_count: failed.length,
    updated: updated.map((row) => row.name),
    failures: failed,
    results
  });
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, {});
  }
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { success: false, error: "METHOD_NOT_ALLOWED" });
  }

  try {
    await requireAdmin(event);
  } catch (error) {
    return jsonResponse(error.statusCode || 401, {
      success: false,
      error: error.code || "UNAUTHORIZED",
      detail: error.message
    });
  }

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (_error) {
    return jsonResponse(400, { success: false, error: "INVALID_JSON" });
  }

  const sourceShipId = String(body.source_ship_id || "").trim();
  const targetIds = Array.isArray(body.target_ship_ids)
    ? body.target_ship_ids.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  if (!sourceShipId || !targetIds.length) {
    return jsonResponse(400, { success: false, error: "SOURCE_OR_TARGETS_MISSING" });
  }
  if (new Set(targetIds).size !== targetIds.length) {
    return jsonResponse(400, { success: false, error: "DUPLICATE_TARGETS" });
  }

  try {
    const sourceShip = await fetchShip(sourceShipId);
    if (!sourceShip) {
      return jsonResponse(404, { success: false, error: "SOURCE_NOT_FOUND" });
    }
    if (sourceShip.active === false) {
      return jsonResponse(409, { success: false, error: "SOURCE_INACTIVE" });
    }

    const targetShips = [];
    for (const targetId of targetIds) {
      if (targetId === sourceShipId) {
        return jsonResponse(409, { success: false, error: "SOURCE_IN_TARGETS" });
      }
      const target = await fetchShip(targetId);
      if (!target) {
        return jsonResponse(404, {
          success: false,
          error: "TARGET_NOT_FOUND",
          detail: targetId
        });
      }
      targetShips.push(target);
    }

    if (ItemCopy.isItemLevelCopyPayload(body)) {
      return handleItemLevelCopy(body, sourceShip, targetShips);
    }
    return handleLegacyCategoryCopy(body, sourceShip, targetShips);
  } catch (error) {
    return jsonResponse(500, {
      success: false,
      error: "COPY_FAILED",
      detail: String(error.message || error)
    });
  }
};
