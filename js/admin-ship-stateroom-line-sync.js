/**
 * Keep ship stateroom selections and cruise-line allocations consistent.
 *
 * Rules:
 * - If a canonical stateroom type is selected on a ship, that type is automatically
 *   enabled for the ship's cruise line when the ship is saved.
 * - Do not show the transitional "not enabled for this line" suffix. Existing
 *   mismatches are backfilled in the database, and any future exact canonical
 *   selection is repaired on save.
 * - Unmapped historical labels still show as legacy until they are deliberately
 *   mapped to a canonical stateroom type.
 */
(function (global) {
  "use strict";

  const ADD_NEW_VALUE = "__add_new_stateroom_type__";

  function service() {
    return global.StateroomTypesService || null;
  }

  function currentLineId() {
    return String(document.getElementById("ciShipLineId")?.value || "").trim();
  }

  function assignAllocationMap(map) {
    try { cruiseLineStateroomAllocations = map; } catch (_) {}
  }

  function installCleanOptionLabels() {
    const svc = service();
    if (!svc || svc.__shipLineOptionCleanupInstalled) return;
    const original = svc.buildRoomTypeSelectOptionsForCruiseLine;
    if (typeof original !== "function") return;

    svc.buildRoomTypeSelectOptionsForCruiseLine = function (...args) {
      const options = original.apply(svc, args) || [];
      return options.map((option) => {
        const label = String(option?.label || "");
        if (!label.endsWith(" (not enabled for this line)")) return option;
        return { ...option, label: String(option?.value || "") };
      });
    };
    svc.__shipLineOptionCleanupInstalled = true;
  }

  async function selectedCanonicalTypes() {
    const svc = service();
    if (!svc) return [];

    let types = [];
    try {
      types = await svc.listAllStateroomTypes();
    } catch (_) {
      try { types = Array.isArray(stateroomTypesActive) ? stateroomTypesActive : []; } catch (_) { types = []; }
    }

    const byName = new Map(
      (types || [])
        .filter((type) => type?.id && type?.name)
        .map((type) => [svc.normalizeName(type.name), type])
    );

    const selected = [];
    const seen = new Set();
    document.querySelectorAll("select.ci-stateroom-label").forEach((select) => {
      const label = String(select.value || "").trim();
      if (!label || label === ADD_NEW_VALUE) return;
      const type = byName.get(svc.normalizeName(label));
      if (!type?.id || seen.has(String(type.id))) return;
      seen.add(String(type.id));
      selected.push(type);
    });
    return selected;
  }

  async function ensureSelectedTypesEnabledForLine(lineId, selectedTypes) {
    const svc = service();
    if (!svc || !lineId || !selectedTypes?.length) return;

    const allocations = await svc.loadCruiseLineStateroomAllocations();
    const existing = new Set((allocations?.[lineId] || []).map(String));
    const required = selectedTypes.map((type) => String(type.id)).filter(Boolean);
    const missing = required.filter((id) => !existing.has(id));

    if (!missing.length) {
      assignAllocationMap(allocations);
      return;
    }

    missing.forEach((id) => existing.add(id));
    const updated = await svc.saveCruiseLineStateroomTypes(lineId, [...existing]);
    assignAllocationMap(updated);
  }

  function installShipSaveGuard() {
    let currentPersist;
    try { currentPersist = persistCiShip; } catch (_) { currentPersist = null; }
    if (typeof currentPersist !== "function" || currentPersist.__shipLineTypeSyncInstalled) return;

    const originalPersist = currentPersist;
    const wrappedPersist = async function persistCiShipWithLineTypeSync(options) {
      const lineId = currentLineId();
      if (lineId) {
        try {
          const selected = await selectedCanonicalTypes();
          await ensureSelectedTypesEnabledForLine(lineId, selected);
        } catch (error) {
          console.error("Could not enable ship room types for cruise line", error);
          global.alert(
            `The ship was not saved because its room types could not be enabled for the selected cruise line.\n\n${error?.message || error}`
          );
          return false;
        }
      }
      return originalPersist(options);
    };

    wrappedPersist.__shipLineTypeSyncInstalled = true;
    persistCiShip = wrappedPersist;
  }

  function installAll() {
    installCleanOptionLabels();
    installShipSaveGuard();
  }

  installAll();
  setTimeout(installAll, 0);
})(typeof window !== "undefined" ? window : globalThis);
