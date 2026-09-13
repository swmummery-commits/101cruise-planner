/**
 * Clarify Administration → Stateroom Types autosave behaviour.
 */
(function (global) {
  "use strict";

  const admin = global.StateroomTypesAdmin;
  if (!admin || typeof admin.renderPanel !== "function" || admin.__autosaveNoteInstalled) return;

  const originalRenderPanel = admin.renderPanel;
  admin.renderPanel = function renderPanelWithAutosaveNote(...args) {
    const html = originalRenderPanel.apply(admin, args);
    return String(html).replace(
      "Tick the cruise lines that use each type.",
      "Tick the cruise lines that use each type. <strong>Changes save automatically as you tick or untick a cruise line. There is no page Save button.</strong>"
    );
  };

  admin.__autosaveNoteInstalled = true;
})(typeof window !== "undefined" ? window : globalThis);
