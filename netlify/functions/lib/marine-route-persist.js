/**
 * Persist / load featured_cruise_marine_routes via Supabase REST.
 * Uses service-role helpers supplied by the caller (scripts / Netlify functions).
 */

/**
 * @param {(path: string, options?: object) => Promise<any>} supabaseRequest
 *   GET by default; pass { method, body } for writes.
 */

async function loadMarineRouteRow(supabaseRequest, featuredCruiseId) {
  const id = String(featuredCruiseId || "").trim();
  if (!id) return null;
  const rows = await supabaseRequest(
    `featured_cruise_marine_routes?featured_cruise_id=eq.${encodeURIComponent(id)}` +
      `&select=id,featured_cruise_id,itinerary_signature,route_data,total_distance_nm,total_distance_km,status,router_engine,router_dataset,router_version,warnings,error_message,generated_at,updated_at` +
      `&limit=1`
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

/**
 * Upsert the single current route row for a Featured Cruise.
 */
async function saveMarineRouteRow(supabaseRequest, { featuredCruiseId, routeObject, status = "current", errorMessage = null }) {
  const id = String(featuredCruiseId || "").trim();
  if (!id) throw new Error("featured_cruise_id is required to persist a marine route.");
  if (!routeObject || typeof routeObject !== "object") {
    throw new Error("routeObject is required.");
  }

  const payload = {
    featured_cruise_id: id,
    itinerary_signature: routeObject.itinerary_signature,
    route_data: routeObject,
    total_distance_nm: routeObject.totals?.distance_nm ?? null,
    total_distance_km: routeObject.totals?.distance_km ?? null,
    status,
    router_engine: routeObject.router?.engine || null,
    router_dataset: routeObject.router?.dataset || null,
    router_version: routeObject.router?.engine_version || null,
    warnings: Array.isArray(routeObject.warnings) ? routeObject.warnings : [],
    error_message: errorMessage,
    generated_at: routeObject.generated_at || new Date().toISOString()
  };

  const existing = await loadMarineRouteRow(supabaseRequest, id);
  if (existing?.id) {
    const updated = await supabaseRequest(
      `featured_cruise_marine_routes?id=eq.${encodeURIComponent(existing.id)}`,
      {
        method: "PATCH",
        body: payload,
        prefer: "return=representation"
      }
    );
    return Array.isArray(updated) ? updated[0] : updated;
  }

  const inserted = await supabaseRequest(`featured_cruise_marine_routes`, {
    method: "POST",
    body: payload,
    prefer: "return=representation"
  });
  return Array.isArray(inserted) ? inserted[0] : inserted;
}

module.exports = {
  loadMarineRouteRow,
  saveMarineRouteRow
};
