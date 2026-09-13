/** Preserve explicit cruise-line room allocations when saving another line tab. */
(function (global) {
  "use strict";

  if (typeof persistCiLineStateroomTypes !== "function") return;

  persistCiLineStateroomTypes = async function persistCiLineStateroomTypesCanonical(lineId) {
    const service = global.StateroomTypesService;
    if (!service || !lineId) return true;

    const boxes = Array.from(document.querySelectorAll(".ci-line-stateroom-type-cb"));
    try {
      // No Room Types UI in the DOM means the admin is saving another tab.
      // Keep the current database allocations, including the four defaults seeded for a new line.
      if (!boxes.length) {
        cruiseLineStateroomAllocations = await service.loadCruiseLineStateroomAllocations();
        return true;
      }

      const selectedIds = boxes
        .filter((el) => el.checked)
        .map((el) => String(el.value || "").trim())
        .filter(Boolean);
      cruiseLineStateroomAllocations = await service.saveCruiseLineStateroomTypes(lineId, selectedIds);
      return true;
    } catch (error) {
      try {
        ciMessage = error?.message || "Could not save cruise-line room types.";
        ciMessageTone = "error";
      } catch (_) {}
      return false;
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
