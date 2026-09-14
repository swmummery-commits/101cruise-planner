(function (root) {
  "use strict";

  const presentation = root.CiShipPresentation;
  const editorialUi = root.ShipEditorialExperience;
  if (!presentation || !editorialUi) return;

  const originalFetchShip = presentation.fetchShip.bind(presentation);
  const originalBuildProfile = presentation.buildProfile.bind(presentation);
  const originalRenderPresentationHtml = presentation.renderPresentationHtml.bind(presentation);

  async function fetchPublishedEditorial(shipId) {
    const id = String(shipId || "").trim();
    if (!id) return null;
    try {
      const response = await fetch(`/.netlify/functions/public-ship-editorial?ship_id=${encodeURIComponent(id)}`, {
        method: "GET",
        headers: { Accept: "application/json" }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) return null;
      return data.editorial || null;
    } catch (error) {
      console.warn("Published ship editorial could not be loaded", error);
      return null;
    }
  }

  presentation.fetchShip = async function (shipName, cruiseLine) {
    const result = await originalFetchShip(shipName, cruiseLine);
    if (!result?.ok || !result.ship?.id) return result;

    const editorial = await fetchPublishedEditorial(result.ship.id);
    if (editorial) result.ship.__publishedEditorial = editorial;
    return result;
  };

  presentation.buildProfile = function (ship, options) {
    const profile = originalBuildProfile(ship, options);
    if (profile && ship?.__publishedEditorial) {
      profile.__publishedEditorial = ship.__publishedEditorial;
    }
    return profile;
  };

  presentation.renderPresentationHtml = function (profile, options) {
    let html = originalRenderPresentationHtml(profile, options);
    const mode = options?.mode === "public" ? "public" : "portal";
    const editorial = profile?.__publishedEditorial;
    if (mode !== "portal" || !editorial || !html) return html;

    const lead = editorialUi.renderPortalIntro(editorial);
    const details = editorialUi.renderPortalDetails(editorial);

    if (lead) {
      const headerEnd = html.indexOf("</header>");
      if (headerEnd >= 0) {
        const insertAt = headerEnd + "</header>".length;
        html = `${html.slice(0, insertAt)}${lead}${html.slice(insertAt)}`;
      }
    }

    return details ? `${html}${details}` : html;
  };
})(window);
