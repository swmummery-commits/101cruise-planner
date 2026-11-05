/**
 * Save a featured cruise together with its room prices and itinerary stops.
 *
 * PostgREST cannot wrap these tables in one database transaction from a
 * Netlify function. This module still treats them as one operation: it
 * snapshots the previous rows, writes cruise then rooms then stops, and
 * restores the snapshot if a later step fails. A failed save therefore
 * does not leave a cruise that claims its rooms were stored.
 *
 * Room ids are updated only when they already belong to this cruise.
 * Temporary editor ids and ids from another cruise are inserted as new rows.
 */

const PERSISTED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PRICING_FIELDS = [
  "room_label",
  "category",
  "brochure_price",
  "cruise_101_price",
  "airline_price",
  "currency_code",
  "display_order"
];

const STOP_FIELDS = [
  "display_order",
  "day_number",
  "stop_date",
  "stop_type",
  "port_id",
  "entered_port_text",
  "entered_country_text",
  "arrival_time",
  "departure_time",
  "is_overnight",
  "notes"
];

const inflightByKey = new Map();

function isPersistedRowId(value) {
  return PERSISTED_ID.test(String(value || "").trim());
}

function pickFields(row, fields) {
  const source = row && typeof row === "object" ? row : {};
  const copy = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) copy[field] = source[field];
  }
  return copy;
}

function planPricingSync({ existingRows, incomingRows, preserveExistingIfEmpty = false } = {}) {
  const existing = [];
  const existingById = new Map();
  for (const row of existingRows || []) {
    const id = isPersistedRowId(row?.id) ? String(row.id).trim() : "";
    if (!id || existingById.has(id)) continue;
    existingById.set(id, row);
    existing.push(row);
  }

  const incoming = Array.isArray(incomingRows) ? incomingRows : [];
  if (!incoming.length && preserveExistingIfEmpty) {
    return { mode: "preserve", updates: [], inserts: [], deleteIds: [] };
  }

  const updates = [];
  const inserts = [];
  const seen = new Set();
  for (const row of incoming) {
    const patch = pickFields(row, PRICING_FIELDS);
    const id = isPersistedRowId(row?.id) ? String(row.id).trim() : "";
    if (id && existingById.has(id) && !seen.has(id)) {
      seen.add(id);
      updates.push({ id, patch });
      continue;
    }
    inserts.push(patch);
  }

  return {
    mode: incoming.length ? "sync" : "clear",
    updates,
    inserts,
    deleteIds: existing.map((row) => String(row.id)).filter((id) => !seen.has(id))
  };
}

function planStopRows(stops) {
  return (Array.isArray(stops) ? stops : []).map((row) => {
    const copy = pickFields(row, STOP_FIELDS);
    if (Object.prototype.hasOwnProperty.call(copy, "port_id") && !isPersistedRowId(copy.port_id)) {
      copy.port_id = null;
    }
    return copy;
  });
}

function cruiseRestorePayload(snapshot) {
  const copy = { ...(snapshot || {}) };
  delete copy.id;
  delete copy.created_at;
  delete copy.updated_at;
  return copy;
}

function cloneRowsForInsert(rows, cruiseId) {
  return (rows || []).map((row) => {
    const copy = { ...row, featured_cruise_id: cruiseId };
    delete copy.id;
    delete copy.created_at;
    delete copy.updated_at;
    return copy;
  });
}

async function restorePricing(io, cruiseId, snapshot) {
  const current = await io.listPricing(cruiseId);
  const ids = (current || []).map((row) => row?.id).filter(Boolean);
  if (ids.length) await io.deletePricing(ids);
  if (snapshot?.length) await io.insertPricing(cloneRowsForInsert(snapshot, cruiseId));
}

async function restoreStops(io, cruiseId, snapshot) {
  const current = await io.listStops(cruiseId);
  const ids = (current || []).map((row) => row?.id).filter(Boolean);
  if (ids.length) await io.deleteStops(ids);
  if (snapshot?.length) await io.insertStops(cloneRowsForInsert(snapshot, cruiseId));
}

async function syncPricing(io, cruiseId, existingRows, incomingRows, preserveExistingIfEmpty) {
  const plan = planPricingSync({
    existingRows,
    incomingRows,
    preserveExistingIfEmpty
  });
  if (plan.mode === "preserve") return { rows: existingRows || [], createdIds: [] };

  const createdIds = [];
  try {
    for (const update of plan.updates) {
      await io.updatePricing(update.id, update.patch);
    }
    if (plan.inserts.length) {
      const created = await io.insertPricing(
        plan.inserts.map((row) => ({ ...row, featured_cruise_id: cruiseId }))
      );
      for (const row of created || []) {
        if (row?.id) createdIds.push(row.id);
      }
    }
    if (plan.deleteIds.length) await io.deletePricing(plan.deleteIds);
  } catch (error) {
    await restorePricing(io, cruiseId, existingRows);
    error.step = error.step || "pricing";
    throw error;
  }
  return { rows: await io.listPricing(cruiseId), createdIds };
}

async function syncStops(io, cruiseId, incomingStops) {
  const rows = planStopRows(incomingStops).map((row) => ({
    ...row,
    featured_cruise_id: cruiseId
  }));
  if (!rows.length) return { createdIds: [] };
  try {
    const created = await io.insertStops(rows);
    return { createdIds: (created || []).map((row) => row?.id).filter(Boolean) };
  } catch (error) {
    const foreignKey = /foreign key|port_id/i.test(String(error?.message || ""));
    if (!foreignKey || rows.every((row) => !row.port_id)) {
      error.step = error.step || "stops";
      throw error;
    }
    const created = await io.insertStops(rows.map((row) => ({ ...row, port_id: null })));
    return { createdIds: (created || []).map((row) => row?.id).filter(Boolean), unlinked: true };
  }
}

async function runCruiseSaveBundle({
  io,
  id = null,
  cruise,
  pricing,
  stops = null,
  userId = null,
  preserveExistingIfEmpty = false,
  clientSaveKey = null
} = {}) {
  let cruiseId = id ? String(id) : "";
  if (!cruiseId && clientSaveKey) {
    const found = await io.findCruiseByClientKey(clientSaveKey);
    if (found?.id) cruiseId = String(found.id);
  }

  const snapshot = {
    cruise: null,
    pricing: [],
    stops: []
  };
  if (cruiseId) {
    snapshot.cruise = await io.getCruise(cruiseId);
    if (!snapshot.cruise) {
      const missing = new Error("This cruise could not be found.");
      missing.statusCode = 404;
      missing.step = "cruise";
      throw missing;
    }
    snapshot.pricing = await io.listPricing(cruiseId);
    if (Array.isArray(stops) && stops.length) snapshot.stops = await io.listStops(cruiseId);
  }

  let createdThisCall = false;
  let pricingTouched = false;
  let stopsTouched = false;
  const warnings = [];

  try {
    const saved = await io.saveCruise({
      id: cruiseId || null,
      cruise,
      userId,
      clientSaveKey
    });
    if (!saved?.row?.id) {
      const err = new Error("Featured cruise save returned no id.");
      err.step = "cruise";
      throw err;
    }
    createdThisCall = Boolean(saved.created);
    cruiseId = String(saved.row.id);

    let pricingRows = snapshot.pricing;
    if (Array.isArray(pricing)) {
      pricingTouched = true;
      const pricingResult = await syncPricing(
        io,
        cruiseId,
        snapshot.pricing,
        pricing,
        preserveExistingIfEmpty
      );
      pricingRows = pricingResult.rows;
    }

    if (Array.isArray(stops) && stops.length) {
      const previousIds = (snapshot.stops || []).map((row) => row?.id).filter(Boolean);
      stopsTouched = true;
      let inserted;
      try {
        inserted = await syncStops(io, cruiseId, stops);
      } catch (stopError) {
        stopError.step = "stops";
        throw stopError;
      }
      if (inserted.unlinked) {
        warnings.push("Some ports could not be linked. The entered port names were kept.");
      }
      if (previousIds.length) {
        try {
          await io.deleteStops(previousIds);
        } catch (deleteError) {
          const newIds = inserted.createdIds || [];
          if (newIds.length) await io.deleteStops(newIds).catch(() => {});
          deleteError.step = "stops";
          throw deleteError;
        }
      }
    }

    const fresh = await io.getCruise(cruiseId);
    const storedPricing = Array.isArray(pricing) ? await io.listPricing(cruiseId) : pricingRows;
    return {
      cruise: fresh || saved.row,
      pricing: storedPricing || [],
      warnings,
      stripped: saved.stripped || [],
      created: createdThisCall,
      rolledBack: false
    };
  } catch (error) {
    error.step = error.step || "cruise";
    try {
      if (createdThisCall && cruiseId) {
        await io.deleteCruise(cruiseId);
        error.cruiseId = null;
        error.updatedAt = null;
      } else if (cruiseId && snapshot.cruise) {
        if (stopsTouched) await restoreStops(io, cruiseId, snapshot.stops);
        if (pricingTouched) await restorePricing(io, cruiseId, snapshot.pricing);
        await io.updateCruise(cruiseId, cruiseRestorePayload(snapshot.cruise));
        const fresh = await io.getCruise(cruiseId);
        error.cruiseId = cruiseId;
        error.updatedAt = fresh?.updated_at || null;
      }
      error.rolledBack = true;
    } catch (rollbackError) {
      error.rolledBack = false;
      error.rollbackError = rollbackError.message || "Rollback failed";
      if (cruiseId) error.cruiseId = cruiseId;
      console.error("featured cruise save rollback failed", rollbackError);
    }
    throw error;
  }
}

function executeCruiseSaveBundle(args) {
  const key = String(args?.clientSaveKey || "").trim();
  if (key && inflightByKey.has(key)) return inflightByKey.get(key);
  const run = runCruiseSaveBundle(args).finally(() => {
    if (key) inflightByKey.delete(key);
  });
  if (key) inflightByKey.set(key, run);
  return run;
}

module.exports = {
  isPersistedRowId,
  planPricingSync,
  planStopRows,
  executeCruiseSaveBundle
};
