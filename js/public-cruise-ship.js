/**
 * Mount shared Cruise Intelligence ship presentation on public Featured Cruise pages.
 * Browser global: PublicCruiseShip
 */
(function (root) {
  "use strict";

  async function mountCiShipPresentation(container, cruise, options) {
    options = options || {};
    if (!container) return null;
    var Presentation = root.CiShipPresentation;
    if (!Presentation) {
      container.innerHTML =
        '<p class="ship-section-intro">Detailed ship information is not available yet.</p>';
      return null;
    }

    var shipName = String((cruise && cruise.ship_name) || "").trim();
    var cruiseLine = String((cruise && cruise.cruise_line_name) || "").trim();

    if (!shipName) {
      Presentation.mountPresentation(container, null, {
        mode: "public",
        unavailableMessage: "Detailed ship information is not available yet."
      });
      if (typeof options.onHeightChange === "function") options.onHeightChange();
      return null;
    }

    var result;
    try {
      result = await Presentation.fetchShip(shipName, cruiseLine);
    } catch (_error) {
      result = { ok: false };
    }

    if (!result || !result.ok || !result.ship) {
      Presentation.mountPresentation(container, null, {
        mode: "public",
        unavailableMessage: "Detailed ship information is not available yet."
      });
      if (typeof options.onHeightChange === "function") options.onHeightChange();
      return null;
    }

    var profile = Presentation.buildProfile(result.ship, {
      shipName: shipName,
      cruiseLine: result.ship.cruise_line_name || cruiseLine
    });

    var shipImage =
      String(result.ship.hero_image_url || "").trim() ||
      String((cruise && cruise.media && cruise.media.ship_hero && cruise.media.ship_hero.url) || "").trim() ||
      String((cruise && cruise.hero_image_url) || "").trim();

    var cruiseLineLogo = String(result.ship.cruise_line_logo_url || "").trim();

    var page = Presentation.mountPresentation(container, profile, {
      mode: "public",
      cruiseLineLogo: cruiseLineLogo,
      shipImage: shipImage
    });

    if (typeof options.onHeightChange === "function") options.onHeightChange();
    return { page: page, profile: profile, shipId: result.ship.id, source: result.source };
  }

  root.PublicCruiseShip = {
    mountCiShipPresentation: mountCiShipPresentation
  };
})(typeof window !== "undefined" ? window : globalThis);
