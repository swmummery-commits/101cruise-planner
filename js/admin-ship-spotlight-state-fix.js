/* Prevent Ship Spotlight editor fields from bleeding from the previously
 * selected ship into the next ship during the selector transition.
 *
 * The core selector calls render(), and render() captures currently mounted
 * form fields before repainting. Without this guard those old DOM values can
 * overwrite the freshly-created draft for the newly selected ship.
 */
(function (global) {
  "use strict";

  function detachCurrentEditorFieldIds() {
    const overlay = document.getElementById("shipSpotlightOverlay");
    if (!overlay) return;
    ["ssEyebrow", "ssHeading", "ssIntro", "ssSlug", "ssPublished", "ssHero"].forEach((id) => {
      const el = overlay.querySelector(`#${id}`);
      if (el) el.removeAttribute("id");
    });
  }

  function install() {
    const api = global.ShipSpotlightAdmin;
    if (!api || typeof api.selectShip !== "function" || api.__shipSelectionStateFixInstalled) return false;

    const originalSelectShip = api.selectShip.bind(api);
    api.selectShip = function (id) {
      // The ship selector has already changed by the time this handler runs.
      // Hide the old editor fields from the core capture() routine so that
      // render() cannot copy the previous ship's values into the new draft.
      detachCurrentEditorFieldIds();
      return originalSelectShip(id);
    };

    api.__shipSelectionStateFixInstalled = true;
    return true;
  }

  install();
  const observer = new MutationObserver(install);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})(window);
