/**
 * Admin bulk ship_class assignment for a cruise-line fleet.
 *
 * POST /.netlify/functions/ci-ship-class-bulk-assign
 * Body: { action: "assign"|"clear", cruise_line_id, ship_ids, ship_class?, replacement_confirmed? }
 */
const { requireAdmin } = require("./admin-auth");
const { CiShipClassBulk } = require("./lib/ci-ship-class-bulk-assign");

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

async function fetchShipsByIds(shipIds) {
  if (!Array.isArray(shipIds) || !shipIds.length) return [];
  const filter = shipIds.map((id) => encodeURIComponent(id)).join(",");
  const rows = await supabase(
    `ci_cruise_ships?id=in.(${filter})&select=id,name,cruise_line_id,ship_class,status,active&limit=${shipIds.length}`
  );
  return Array.isArray(rows) ? rows : [];
}

async function patchShipClass(shipId, shipClass) {
  const updated = await supabase(`ci_cruise_ships?id=eq.${encodeURIComponent(shipId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ ship_class: shipClass })
  });
  const row = Array.isArray(updated) ? updated[0] : updated;
  if (!row || !Object.prototype.hasOwnProperty.call(row, "ship_class")) {
    throw new Error("Empty update response");
  }
  return row;
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

  const action = String(body.action || "assign").trim().toLowerCase();
  const shipIds = Array.isArray(body.ship_ids)
    ? body.ship_ids.map((id) => String(id || "").trim()).filter(Boolean)
    : [];

  if (!shipIds.length) {
    return jsonResponse(400, { success: false, error: "NO_SHIPS_SELECTED" });
  }

  try {
    const ships = await fetchShipsByIds(shipIds);
    if (ships.length !== shipIds.length) {
      const found = new Set(ships.map((row) => row.id));
      const missing = shipIds.find((id) => !found.has(id));
      return jsonResponse(404, { success: false, error: "SHIP_NOT_FOUND", detail: missing });
    }

    if (action === "clear") {
      const validation = CiShipClassBulk.validateBulkClearRequest({
        cruiseLineId: body.cruise_line_id,
        shipIds,
        ships
      });
      if (!validation.ok) {
        return jsonResponse(400, { success: false, error: validation.error, detail: validation.detail || null });
      }

      const results = [];
      for (const ship of validation.selected) {
        const hadClass = !CiShipClassBulk.isUnassignedClass(ship.ship_class);
        if (!hadClass) {
          results.push({
            id: ship.id,
            name: ship.name,
            old_class: ship.ship_class || null,
            new_class: null,
            outcome: "unchanged",
            ok: true
          });
          continue;
        }
        try {
          const updated = await patchShipClass(ship.id, null);
          results.push({
            id: ship.id,
            name: ship.name,
            old_class: ship.ship_class || null,
            new_class: updated.ship_class,
            outcome: "updated",
            ok: true
          });
        } catch (error) {
          results.push({
            id: ship.id,
            name: ship.name,
            old_class: ship.ship_class || null,
            new_class: null,
            outcome: "failed",
            ok: false,
            error: String(error.message || error)
          });
        }
      }

      const updated = results.filter((row) => row.outcome === "updated");
      const unchanged = results.filter((row) => row.outcome === "unchanged");
      const failed = results.filter((row) => row.outcome === "failed");
      return jsonResponse(failed.length && !updated.length ? 500 : 200, {
        success: failed.length === 0,
        action: "clear",
        updated_count: updated.length,
        unchanged_count: unchanged.length,
        failed_count: failed.length,
        results
      });
    }

    if (action !== "assign") {
      return jsonResponse(400, { success: false, error: "INVALID_ACTION" });
    }

    const validation = CiShipClassBulk.validateBulkAssignRequest({
      cruiseLineId: body.cruise_line_id,
      shipIds,
      shipClass: body.ship_class,
      ships,
      replacementConfirmed: Boolean(body.replacement_confirmed)
    });
    if (!validation.ok) {
      const status = validation.error === "REPLACEMENT_NOT_CONFIRMED" ? 409 : 400;
      return jsonResponse(status, {
        success: false,
        error: validation.error,
        detail: validation.detail || null,
        replace_count: validation.replaceCount || 0
      });
    }

    const results = [];
    for (const ship of validation.selected) {
      const plan = CiShipClassBulk.classifyAssignment(ship, validation.shipClass);
      if (plan.kind === "unchanged") {
        results.push({
          id: ship.id,
          name: ship.name,
          old_class: ship.ship_class || null,
          new_class: validation.shipClass,
          outcome: "unchanged",
          ok: true
        });
        continue;
      }
      try {
        const updated = await patchShipClass(ship.id, validation.shipClass);
        results.push({
          id: ship.id,
          name: ship.name,
          old_class: ship.ship_class || null,
          new_class: updated.ship_class,
          outcome: "updated",
          ok: true
        });
      } catch (error) {
        results.push({
          id: ship.id,
          name: ship.name,
          old_class: ship.ship_class || null,
          new_class: validation.shipClass,
          outcome: "failed",
          ok: false,
          error: String(error.message || error)
        });
      }
    }

    const updated = results.filter((row) => row.outcome === "updated");
    const unchanged = results.filter((row) => row.outcome === "unchanged");
    const failed = results.filter((row) => row.outcome === "failed");
    return jsonResponse(failed.length && !updated.length && !unchanged.length ? 500 : 200, {
      success: failed.length === 0,
      action: "assign",
      ship_class: validation.shipClass,
      updated_count: updated.length,
      unchanged_count: unchanged.length,
      failed_count: failed.length,
      results
    });
  } catch (error) {
    return jsonResponse(500, {
      success: false,
      error: "BULK_ASSIGN_FAILED",
      detail: String(error.message || error)
    });
  }
};
