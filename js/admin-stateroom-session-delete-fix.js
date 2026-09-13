/**
 * Stateroom admin reliability fixes.
 * - Retry protected stateroom API calls once after refreshing the Supabase session.
 * - Keep Admin sign-out local to this browser session so it does not revoke other sessions.
 * - Explain exactly why a room type cannot be deleted, including the cruise lines,
 *   ships and Featured Cruise pricing records that still use it.
 */
(function (global) {
  "use strict";

  function isSessionError(error) {
    const status = Number(error?.statusCode || error?.status || 0);
    const text = String(error?.message || error || "").toLowerCase();
    return status === 401 ||
      text.includes("session expired") ||
      text.includes("session is invalid") ||
      text.includes("admin authentication is required") ||
      text.includes("invalid refresh token") ||
      text.includes("refresh token");
  }

  async function refreshAdminSession() {
    const client = global.supabaseClient;
    if (!client?.auth?.refreshSession) return false;
    try {
      const refreshed = await client.auth.refreshSession();
      return Boolean(!refreshed?.error && refreshed?.data?.session?.access_token);
    } catch (_) {
      return false;
    }
  }

  function installServiceRetry() {
    const service = global.StateroomTypesService;
    if (!service || service.__sessionRetryInstalled) return;

    const methodNames = [
      "createStateroomType",
      "updateStateroomType",
      "deleteStateroomType",
      "checkStateroomTypeUsage",
      "reorderStateroomTypes",
      "loadCruiseLineStateroomAllocations",
      "saveCruiseLineStateroomTypes"
    ];

    for (const name of methodNames) {
      const original = service[name];
      if (typeof original !== "function") continue;
      service[name] = async function (...args) {
        try {
          return await original.apply(service, args);
        } catch (error) {
          if (!isSessionError(error)) throw error;
          const refreshed = await refreshAdminSession();
          if (!refreshed) throw error;
          return original.apply(service, args);
        }
      };
    }

    service.__sessionRetryInstalled = true;
  }

  function installLocalAdminSignOut() {
    if (typeof global.adminSignOut !== "function" || global.adminSignOut.__localScopeInstalled) return;

    const localSignOut = async function () {
      try {
        await global.supabaseClient?.auth?.signOut?.({ scope: "local" });
      } finally {
        try { currentUser = null; } catch (_) {}
        try { currentProfile = null; } catch (_) {}
        try { crmSyncResult = null; } catch (_) {}
        try { crmDocuments = []; } catch (_) {}
        try {
          if (typeof renderLogin === "function") renderLogin();
          else global.location?.reload?.();
        } catch (_) {
          global.location?.reload?.();
        }
      }
    };
    localSignOut.__localScopeInstalled = true;
    global.adminSignOut = localSignOut;
  }

  function unique(values) {
    return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
  }

  async function fetchRows(table, columns, configure) {
    const client = global.supabaseClient;
    if (!client) throw new Error("Admin database connection is unavailable.");
    let query = client.from(table).select(columns);
    if (typeof configure === "function") query = configure(query);
    const result = await query;
    if (result.error) throw new Error(result.error.message || `Could not check ${table}.`);
    return Array.isArray(result.data) ? result.data : [];
  }

  async function fetchRowsByIds(table, columns, ids) {
    const cleanIds = unique(ids);
    if (!cleanIds.length) return [];
    return fetchRows(table, columns, (query) => query.in("id", cleanIds));
  }

  async function loadUsageDetails(typeId) {
    const [lineLinks, shipLinks, pricingLinks] = await Promise.all([
      fetchRows(
        "cruise_line_stateroom_types",
        "cruise_line_id,stateroom_type_id",
        (query) => query.eq("stateroom_type_id", typeId)
      ),
      fetchRows(
        "ship_stateroom_types",
        "ship_id,stateroom_type_id,source_label",
        (query) => query.eq("stateroom_type_id", typeId)
      ),
      fetchRows(
        "featured_cruise_pricing",
        "id,featured_cruise_id,room_label,stateroom_type_id",
        (query) => query.eq("stateroom_type_id", typeId)
      )
    ]);

    const featuredCruiseIds = unique(pricingLinks.map((row) => row.featured_cruise_id));
    const featuredCruises = await fetchRowsByIds(
      "featured_cruises",
      "id,headline,departure_date,cruise_line_id,cruise_ship_id,newsletter_number",
      featuredCruiseIds
    );

    const shipIds = unique([
      ...shipLinks.map((row) => row.ship_id),
      ...featuredCruises.map((row) => row.cruise_ship_id)
    ]);
    const ships = await fetchRowsByIds(
      "ci_cruise_ships",
      "id,name,cruise_line_id",
      shipIds
    );

    const cruiseLineIds = unique([
      ...lineLinks.map((row) => row.cruise_line_id),
      ...ships.map((row) => row.cruise_line_id),
      ...featuredCruises.map((row) => row.cruise_line_id)
    ]);
    const cruiseLines = await fetchRowsByIds(
      "ci_cruise_lines",
      "id,name",
      cruiseLineIds
    );

    const shipById = new Map(ships.map((row) => [String(row.id), row]));
    const lineById = new Map(cruiseLines.map((row) => [String(row.id), row]));
    const featuredById = new Map(featuredCruises.map((row) => [String(row.id), row]));

    return {
      cruiseLines: lineLinks.map((link) => {
        const line = lineById.get(String(link.cruise_line_id));
        return {
          id: link.cruise_line_id,
          name: line?.name || "Unknown cruise line"
        };
      }).sort((a, b) => a.name.localeCompare(b.name)),

      ships: shipLinks.map((link) => {
        const ship = shipById.get(String(link.ship_id));
        const line = ship ? lineById.get(String(ship.cruise_line_id)) : null;
        return {
          id: link.ship_id,
          name: ship?.name || "Unknown ship",
          cruiseLineName: line?.name || "Unknown cruise line",
          sourceLabel: String(link.source_label || "").trim()
        };
      }).sort((a, b) => a.name.localeCompare(b.name)),

      pricing: pricingLinks.map((link) => {
        const cruise = featuredById.get(String(link.featured_cruise_id));
        const ship = cruise ? shipById.get(String(cruise.cruise_ship_id)) : null;
        const line = cruise ? lineById.get(String(cruise.cruise_line_id)) : null;
        return {
          id: link.id,
          featuredCruiseId: link.featured_cruise_id,
          headline: cruise?.headline || "Unnamed Featured Cruise",
          departureDate: cruise?.departure_date || "",
          newsletterNumber: cruise?.newsletter_number || null,
          shipName: ship?.name || "",
          cruiseLineName: line?.name || "",
          roomLabel: String(link.room_label || "").trim()
        };
      }).sort((a, b) => a.headline.localeCompare(b.headline))
    };
  }

  function addSection(lines, heading, items, formatter, maxItems = 12) {
    if (!items.length) return;
    lines.push("", heading);
    items.slice(0, maxItems).forEach((item) => lines.push(`• ${formatter(item)}`));
    if (items.length > maxItems) lines.push(`• …and ${items.length - maxItems} more`);
  }

  function buildUsageMessage(roomType, usage) {
    const total = usage.cruiseLines.length + usage.ships.length + usage.pricing.length;
    if (!total) return "";

    const lines = [
      `“${roomType.name}” cannot be deleted because it is still in use.`
    ];

    addSection(
      lines,
      "Cruise line assignments:",
      usage.cruiseLines,
      (item) => `${item.name}  [untick this cruise line on the Stateroom Types screen]`
    );

    addSection(
      lines,
      "Ships:",
      usage.ships,
      (item) => {
        const source = item.sourceLabel && item.sourceLabel !== roomType.name
          ? `, source label: ${item.sourceLabel}`
          : "";
        return `${item.name} — ${item.cruiseLineName}${source}  [Cruise Database → Ships]`;
      }
    );

    addSection(
      lines,
      "Featured Cruise pricing:",
      usage.pricing,
      (item) => {
        const context = [item.cruiseLineName, item.shipName, item.departureDate].filter(Boolean).join(" — ");
        const newsletter = item.newsletterNumber ? `, Newsletter ${item.newsletterNumber}` : "";
        const room = item.roomLabel ? `, room: ${item.roomLabel}` : "";
        return `${item.headline}${context ? ` (${context})` : ""}${newsletter}${room}  [Marketing → Featured Cruises]`;
      }
    );

    lines.push("", "Remove the references above, then return here and delete the room type.");
    return lines.join("\n");
  }

  async function loadUsageDetailsWithRetry(typeId) {
    try {
      return await loadUsageDetails(typeId);
    } catch (error) {
      if (!isSessionError(error)) throw error;
      const refreshed = await refreshAdminSession();
      if (!refreshed) throw error;
      return loadUsageDetails(typeId);
    }
  }

  function installDeleteExplanation() {
    const admin = global.StateroomTypesAdmin;
    const service = global.StateroomTypesService;
    if (!admin || !service || admin.__deleteExplanationInstalled) return;

    const originalDelete = admin.deleteStateroomType;
    if (typeof originalDelete !== "function") return;

    admin.deleteStateroomType = async function (id) {
      try {
        const rows = await service.listAllStateroomTypes();
        const roomType = (rows || []).find((row) => String(row?.id) === String(id));
        if (!roomType) return originalDelete.call(admin, id);

        const usage = await loadUsageDetailsWithRetry(id);
        const message = buildUsageMessage(roomType, usage);
        if (message) {
          global.alert(message);
          return;
        }

        return originalDelete.call(admin, id);
      } catch (error) {
        global.alert(error?.message || "Could not check whether this room type is in use.");
      }
    };

    admin.__deleteExplanationInstalled = true;
  }

  function installAll() {
    installServiceRetry();
    installLocalAdminSignOut();
    installDeleteExplanation();
  }

  installAll();
  setTimeout(installAll, 0);
})(typeof window !== "undefined" ? window : globalThis);
