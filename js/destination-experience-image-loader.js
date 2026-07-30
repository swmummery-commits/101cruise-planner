/**
 * Destination Experience — shared destination image preload, decode and fallback.
 * Browser global: DestinationExperienceImageLoader
 */
(function (root) {
  "use strict";

  var cache = Object.create(null);
  var SLOT_ORDER = ["hero", "reason-1", "reason-2", "reason-3", "advice", "cta"];

  function cloneImage(image, overrides) {
    if (!image) return null;
    var next = Object.assign({}, image, overrides || {});
    return next.url ? next : null;
  }

  function fallbackFromHero(fallbackHero, role) {
    if (!fallbackHero || !fallbackHero.url) return null;
    return cloneImage(fallbackHero, {
      source: "cruise_finder_fallback",
      role: role,
      loadState: "fallback"
    });
  }

  function preloadImage(url, options) {
    options = options || {};
    var key = String(url || "");
    if (!key) {
      return Promise.resolve({ ok: false, url: "", error: "empty_url" });
    }
    if (cache[key]) return cache[key];

    cache[key] = new Promise(function (resolve) {
      var img = new Image();
      img.decoding = options.priority === "high" ? "sync" : "async";
      if (options.crossOrigin) img.crossOrigin = options.crossOrigin;

      function finish(ok, error) {
        resolve({
          ok: ok,
          url: key,
          error: error || null,
          width: ok ? img.naturalWidth : 0,
          height: ok ? img.naturalHeight : 0
        });
      }

      img.onload = function () {
        if (typeof img.decode === "function") {
          img
            .decode()
            .then(function () {
              finish(true);
            })
            .catch(function (err) {
              finish(false, (err && err.message) || "decode_failed");
            });
          return;
        }
        finish(true);
      };
      img.onerror = function () {
        finish(false, "load_failed");
      };
      img.src = key;
    });

    return cache[key];
  }

  function collectSlots(model) {
    var slots = [];
    if (model && model.hero && model.hero.url) {
      slots.push({ role: "hero", image: model.hero, priority: "high" });
    }
    (model.reasons || []).forEach(function (reason, index) {
      if (reason && reason.image && reason.image.url) {
        slots.push({ role: "reason-" + (index + 1), image: reason.image });
      }
    });
    if (model.adviceImage && model.adviceImage.url) {
      slots.push({ role: "advice", image: model.adviceImage });
    }
    if (model.ctaImage && model.ctaImage.url) {
      slots.push({ role: "cta", image: model.ctaImage });
    }
    return slots;
  }

  function applyResolvedImage(model, role, image, loadState) {
    var resolved = cloneImage(image, { loadState: loadState, role: role });
    if (!resolved) return;
    if (role === "hero") {
      model.hero = resolved;
      return;
    }
    if (role.indexOf("reason-") === 0) {
      var index = Number(role.split("-")[1]) - 1;
      if (model.reasons && model.reasons[index]) {
        model.reasons[index].image = resolved;
      }
      return;
    }
    if (role === "advice") {
      model.adviceImage = resolved;
      return;
    }
    if (role === "cta") {
      model.ctaImage = resolved;
    }
  }

  function ensureSlotImage(model, role, fallbackHero) {
    if (role === "hero" && model.hero && model.hero.url) return model.hero;
    if (role.indexOf("reason-") === 0) {
      var index = Number(role.split("-")[1]) - 1;
      var reason = model.reasons && model.reasons[index];
      if (reason && reason.image && reason.image.url) return reason.image;
    }
    if (role === "advice" && model.adviceImage && model.adviceImage.url) return model.adviceImage;
    if (role === "cta" && model.ctaImage && model.ctaImage.url) return model.ctaImage;
    return fallbackFromHero(fallbackHero, role);
  }

  async function resolveDestinationImages(model, fallbackHero) {
    if (!model) return model;
    var slots = collectSlots(model);
    var results = Object.create(null);

    var heroSlot = slots.find(function (slot) {
      return slot.role === "hero";
    });
    if (heroSlot) {
      await preloadImage(heroSlot.image.url, { priority: "high" });
    }

    var otherUrls = [];
    slots.forEach(function (slot) {
      if (slot.role === "hero") return;
      if (otherUrls.indexOf(slot.image.url) === -1) otherUrls.push(slot.image.url);
    });
    await Promise.all(
      otherUrls.map(function (url) {
        return preloadImage(url);
      })
    );

    for (var i = 0; i < SLOT_ORDER.length; i += 1) {
      var roleName = SLOT_ORDER[i];
      var roleSlot = slots.find(function (row) {
        return row.role === roleName;
      });
      var image = roleSlot ? roleSlot.image : ensureSlotImage(model, roleName, fallbackHero);
      if (!image || !image.url) {
        var emptyFallback = fallbackFromHero(fallbackHero, roleName);
        if (emptyFallback) {
          applyResolvedImage(model, roleName, emptyFallback, "fallback");
          results[roleName] = { ok: true, url: emptyFallback.url, error: null, fallback: true };
        } else {
          results[roleName] = { ok: false, url: "", error: "missing_image" };
        }
        continue;
      }

      var loaded = await preloadImage(image.url, roleName === "hero" ? { priority: "high" } : {});
      if (loaded.ok) {
        results[roleName] = loaded;
        applyResolvedImage(model, roleName, image, "loaded");
        continue;
      }

      var fallbackImage = fallbackFromHero(fallbackHero, roleName);
      if (!fallbackImage) {
        results[roleName] = loaded;
        continue;
      }

      var fallbackLoaded = await preloadImage(fallbackImage.url, roleName === "hero" ? { priority: "high" } : {});
      results[roleName] = Object.assign({}, loaded, {
        fallback: true,
        fallbackUrl: fallbackImage.url,
        fallbackOk: fallbackLoaded.ok
      });
      applyResolvedImage(model, roleName, fallbackImage, "fallback");
    }

    model.mediaLoadResults = results;
    model.mediaReady = SLOT_ORDER.every(function (role) {
      var row = results[role];
      return row && (row.ok || row.fallback || row.fallbackOk);
    });
    return model;
  }

  async function waitForRenderedImages(rootEl, timeoutMs) {
    var host = rootEl || document;
    var images = Array.prototype.slice.call(host.querySelectorAll("[data-dx-dest-image]"));
    if (!images.length) return true;

    var timeout = typeof timeoutMs === "number" ? timeoutMs : 30000;
    await Promise.race([
      Promise.all(
        images.map(function (img) {
          if (img.complete && img.naturalWidth > 0) {
            return typeof img.decode === "function" ? img.decode().catch(function () {}) : Promise.resolve();
          }
          return new Promise(function (resolve) {
            function done() {
              if (typeof img.decode === "function") {
                img.decode().then(resolve).catch(resolve);
              } else {
                resolve();
              }
            }
            img.addEventListener("load", done, { once: true });
            img.addEventListener("error", done, { once: true });
          });
        })
      ),
      new Promise(function (resolve) {
        window.setTimeout(resolve, timeout);
      })
    ]);
    return true;
  }

  function clearCache() {
    cache = Object.create(null);
  }

  root.DestinationExperienceImageLoader = {
    SLOT_ORDER: SLOT_ORDER,
    preloadImage: preloadImage,
    resolveDestinationImages: resolveDestinationImages,
    waitForRenderedImages: waitForRenderedImages,
    clearCache: clearCache
  };
})(typeof window !== "undefined" ? window : globalThis);
