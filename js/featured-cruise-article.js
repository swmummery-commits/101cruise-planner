/**
 * Featured Cruise Article V2 boot + media preload.
 * Browser global: FeaturedCruiseArticle
 */
(function (root) {
  "use strict";

  var Loader = root.DestinationExperienceImageLoader;
  var Data = root.FeaturedCruiseArticleData;
  var Components = root.FeaturedCruiseArticleComponents;

  async function resolveArticleMedia(model, cruise, options) {
    if (!model || !Loader) return model;
    options = options || {};
    var preloadFn = options.preload || Loader.preloadImage;

    if (model.heroImage && model.heroImage.url) {
      var heroLoaded = await preloadFn(model.heroImage.url);
      if (heroLoaded.ok) model.heroImage.loadState = "loaded";
      else model.heroImage = null;
    }

    if (model.ctaImage && model.ctaImage.url) {
      var ctaLoaded = await preloadFn(model.ctaImage.url);
      if (ctaLoaded.ok) model.ctaImage.loadState = "loaded";
      else model.ctaImage = null;
    }

    if (model.routeMap && model.routeMap.url) {
      var mapLoaded = await preloadFn(model.routeMap.url);
      if (mapLoaded.ok) model.routeMap.loadState = "loaded";
      else model.routeMap = null;
    }

    if (model.ship) {
      var candidates = Loader.collectShipHeroCandidates
        ? Loader.collectShipHeroCandidates(cruise)
        : [];
      var shipHero = null;
      for (var i = 0; i < candidates.length; i += 1) {
        var row = candidates[i];
        var loaded = await preloadFn(row.url);
        if (loaded.ok) {
          shipHero = { url: row.url, alt: row.alt, loadState: "loaded" };
          break;
        }
      }
      model.ship.hero = shipHero;
    }

    if (Array.isArray(model.ports)) {
      await Promise.all(
        model.ports.map(async function (port) {
          if (port.is_sea_day || !port.image || !port.image.url) {
            port.image = null;
            return;
          }
          var portLoaded = await preloadFn(port.image.url);
          if (portLoaded.ok) port.image.loadState = "loaded";
          else port.image = null;
        })
      );
    }

    if (Array.isArray(model.reasons)) {
      await Promise.all(
        model.reasons.map(async function (reason) {
          if (!reason.image || !reason.image.url) {
            reason.image = null;
            return;
          }
          var reasonLoaded = await preloadFn(reason.image.url);
          if (reasonLoaded.ok) reason.image.loadState = "loaded";
          else reason.image = null;
        })
      );
    }

    return model;
  }

  async function render(mount, cruise, options) {
    options = options || {};
    if (!mount || !Data || !Components) {
      throw new Error("Featured Cruise Article V2 is unavailable.");
    }
    var model = Data.fromFeaturedCruise(cruise, options);
    if (!model) throw new Error("Could not build Featured Cruise Article model.");
    model = await resolveArticleMedia(model, cruise, options);
    mount.innerHTML = Components.renderPage(model);
    if (typeof options.onReady === "function") options.onReady();
    if (typeof options.onHeightChange === "function") options.onHeightChange();
    return model;
  }

  root.FeaturedCruiseArticle = {
    render: render,
    resolveArticleMedia: resolveArticleMedia
  };
})(typeof window !== "undefined" ? window : globalThis);
