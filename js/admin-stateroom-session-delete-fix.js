/**
 * Stateroom admin reliability fixes.
 * - Retry protected stateroom API calls once after refreshing the Supabase session.
 * - Keep Admin sign-out local to this browser session so it does not revoke other sessions.
 * - Explain exactly why a room type cannot be deleted.
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

  async function countLinks(table, typeId) {
    const client = global.supabaseClient;
    if (!client) throw new Error("Admin database connection is unavailable.");
    const result = await client
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq("stateroom_type_id", typeId);
    if (result.error) throw new Error(result.error.message || `Could not check ${table}.`);
    return Number(result.count || 0);
  }

  function usageSentence(count, singular, plural) {
    if (!count) return "";
    return `${count} ${count === 1 ? singular : plural}`;
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

        let counts;
        try {
          const [cruiseLines, ships, pricing] = await Promise.all([
            countLinks("cruise_line_stateroom_types", id),
            countLinks("ship_stateroom_types", id),
            countLinks("featured_cruise_pricing", id)
          ]);
          counts = { cruiseLines, ships, pricing };
        } catch (error) {
          if (isSessionError(error) && await refreshAdminSession()) {
            const [cruiseLines, ships, pricing] = await Promise.all([
              countLinks("cruise_line_stateroom_types", id),
              countLinks("ship_stateroom_types", id),
              countLinks("featured_cruise_pricing", id)
            ]);
            counts = { cruiseLines, ships, pricing };
          } else {
            throw error;
          }
        }

        const total = counts.cruiseLines + counts.ships + counts.pricing;
        if (total > 0) {
          const uses = [
            usageSentence(counts.cruiseLines, "cruise line", "cruise lines"),
            usageSentence(counts.ships, "ship", "ships"),
            usageSentence(counts.pricing, "pricing record", "pricing records")
          ].filter(Boolean);
          global.alert(
            `“${roomType.name}” cannot be deleted because it is still being used by ${uses.join(", ")}.\n\n` +
            "Remove those uses first, then delete the room type."
          );
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
