/**
 * Destination Experience — interactions (timeline, styles, carousel, reveals).
 * Browser global: DestinationExperienceApp
 */
(function (root) {
  "use strict";

  var model = null;
  var mount = null;
  var reducedMotion = false;

  function $(sel, ctx) {
    return (ctx || document).querySelector(sel);
  }

  function $all(sel, ctx) {
    return Array.prototype.slice.call((ctx || document).querySelectorAll(sel));
  }

  function prefersReducedMotion() {
    return (
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function bindReveals(rootEl) {
    var nodes = $all("[data-dx-reveal]", rootEl);
    if (!nodes.length) return;
    if (reducedMotion || typeof IntersectionObserver === "undefined") {
      nodes.forEach(function (el) {
        el.classList.add("is-visible");
      });
      return;
    }
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        });
      },
      { threshold: 0.16, rootMargin: "0px 0px -8% 0px" }
    );
    nodes.forEach(function (el) {
      io.observe(el);
    });
  }

  function bindStyles(rootEl) {
    var tiles = $all("[data-dx-style]", rootEl);
    var panel = $("[data-dx-style-panel]", rootEl);
    if (!tiles.length || !panel || !model) return;
    tiles.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-dx-style");
        var style = (model.styles || []).find(function (s) {
          return s.id === id;
        });
        tiles.forEach(function (t) {
          var on = t === btn;
          t.classList.toggle("is-active", on);
          t.setAttribute("aria-selected", on ? "true" : "false");
        });
        if (style) {
          panel.classList.add("is-fading");
          window.setTimeout(function () {
            panel.innerHTML = "<p>" + (root.DestinationExperienceData.esc(style.support) || "") + "</p>";
            panel.classList.remove("is-fading");
          }, reducedMotion ? 0 : 160);
        }
      });
    });
  }

  function bindMonths(rootEl) {
    var track = $("[data-dx-month-track]", rootEl);
    var chips = $all("[data-dx-month]", rootEl);
    var panel = $("[data-dx-month-panel]", rootEl);
    if (!chips.length || !panel || !model) return;
    if (track && track.classList.contains("is-readonly")) return;

    function selectMonth(monthNum, focusChip) {
      var month = (model.months || []).find(function (m) {
        return m.month === Number(monthNum);
      });
      if (!month) return;
      chips.forEach(function (chip) {
        var on = Number(chip.getAttribute("data-dx-month")) === month.month;
        chip.classList.toggle("is-active", on);
        chip.setAttribute("aria-selected", on ? "true" : "false");
        if (on && focusChip) chip.focus();
      });
      panel.classList.add("is-fading");
      window.setTimeout(
        function () {
          panel.innerHTML = root.DestinationExperienceComponents.renderMonthPanel(month);
          panel.classList.remove("is-fading");
        },
        reducedMotion ? 0 : 160
      );
    }

    chips.forEach(function (chip, index) {
      chip.addEventListener("click", function () {
        selectMonth(chip.getAttribute("data-dx-month"), false);
      });
      chip.addEventListener("keydown", function (event) {
        var next = null;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") next = chips[index + 1] || chips[0];
        if (event.key === "ArrowLeft" || event.key === "ArrowUp")
          next = chips[index - 1] || chips[chips.length - 1];
        if (event.key === "Home") next = chips[0];
        if (event.key === "End") next = chips[chips.length - 1];
        if (!next) return;
        event.preventDefault();
        selectMonth(next.getAttribute("data-dx-month"), true);
      });
    });
  }

  function bindAll(rootEl) {
    bindReveals(rootEl);
    bindStyles(rootEl);
    bindMonths(rootEl);
  }

  async function markMediaReady(rootEl) {
    if (root.DestinationExperienceImageLoader) {
      await root.DestinationExperienceImageLoader.waitForRenderedImages(rootEl);
    }
    rootEl.classList.add("is-ready");
    rootEl.setAttribute("data-dx-media-ready", "true");
    if (mount) mount.setAttribute("data-dx-media-ready", "true");
  }

  async function preloadCruiseLineLogos(current) {
    if (!current || !Array.isArray(current.cruiseLines) || !root.DestinationExperienceImageLoader) {
      return current;
    }
    await Promise.all(
      current.cruiseLines.map(async function (line) {
        if (!line || !line.logo) {
          line.logoLoadState = "text";
          return;
        }
        var result = await root.DestinationExperienceImageLoader.preloadImage(line.logo);
        line.logoLoadState = result.ok ? "loaded" : "error";
      })
    );
    return current;
  }

  async function loadLineLogos(current) {
    try {
      var response = await fetch("/.netlify/functions/public-ci-cruise-lines");
      if (!response.ok) throw new Error("lines unavailable");
      var data = await response.json();
      var lines = Array.isArray(data.cruise_lines)
        ? data.cruise_lines
        : Array.isArray(data.lines)
          ? data.lines
          : Array.isArray(data)
            ? data
            : [];
      if (!lines.length) {
        response = await fetch("/data/prototype/caribbean-cruise-lines-snapshot.json");
        if (response.ok) {
          var snapshot = await response.json();
          lines = Array.isArray(snapshot.cruise_lines) ? snapshot.cruise_lines : [];
        }
      }
      return root.DestinationExperienceData.applyCruiseLineLogos(current, lines);
    } catch (_error) {
      try {
        var fallback = await fetch("/data/prototype/caribbean-cruise-lines-snapshot.json");
        if (fallback.ok) {
          var payload = await fallback.json();
          var snapshotLines = Array.isArray(payload.cruise_lines) ? payload.cruise_lines : [];
          return root.DestinationExperienceData.applyCruiseLineLogos(current, snapshotLines);
        }
      } catch (_inner) {
        /* ignore */
      }
      return current;
    }
  }

  async function loadDestinationMedia(current, slug) {
    if (!current || !root.DestinationExperienceMedia) return current;
    var fallbackHero = current.hero;
    try {
      var rows = await root.DestinationExperienceMedia.loadCaribbeanMedia();
      var assigned = root.DestinationExperienceMedia.assignDestinationImages(slug, rows, fallbackHero);
      return root.DestinationExperienceData.applyMediaAssignments(current, assigned);
    } catch (_error) {
      var assignedFallback = root.DestinationExperienceMedia.assignDestinationImages(slug, [], fallbackHero);
      return root.DestinationExperienceData.applyMediaAssignments(current, assignedFallback);
    }
  }

  async function boot(options) {
    options = options || {};
    mount = options.mount || document.getElementById("destination-experience-app");
    if (!mount) return;

    reducedMotion = prefersReducedMotion();
    if (reducedMotion) document.documentElement.classList.add("dx-reduced-motion");

    var params = new URLSearchParams(window.location.search || "");
    var slug = String(options.slug || params.get("slug") || params.get("destination") || "").trim();
    if (!slug) {
      mount.innerHTML =
        '<div class="dx-wrap dx-error"><p>Add a destination slug, for example <code>?slug=caribbean</code>.</p></div>';
      return;
    }

    model = root.DestinationExperienceData.fromCruiseFinder(slug, {
      catalogue: root.CruiseFinderDestinations,
      content: root.CruiseFinderDestinationContent,
      images: root.CruiseFinderDestinationImages,
      pickImage: root.CruiseFinderPickDestinationImage,
      filterLines: root.CruiseFinderFilterCruiseLines
    });

    if (!model) {
      mount.innerHTML =
        '<div class="dx-wrap dx-error"><p>No destination experience data was found for “' +
        root.DestinationExperienceData.esc(slug) +
        '”.</p></div>';
      return;
    }

    var fallbackHero = model.hero ? Object.assign({}, model.hero) : null;
    model = await loadDestinationMedia(model, slug);
    if (root.DestinationExperienceImageLoader) {
      model = await root.DestinationExperienceImageLoader.resolveDestinationImages(model, fallbackHero);
    }
    model = await loadLineLogos(model);
    model = await preloadCruiseLineLogos(model);
    model = root.DestinationExperienceData.applyTimingContext(
      model,
      root.DestinationExperienceData.parseTimingFromSearch(params)
    );
    mount.innerHTML = root.DestinationExperienceComponents.renderPage(model);
    bindAll(mount);
    await markMediaReady(mount);
    document.title = (model.name || "Destination") + " Experience | 101cruise";

    if (typeof options.onReady === "function") options.onReady(model);
    return model;
  }

  root.DestinationExperienceApp = {
    boot: boot,
    getModel: function () {
      return model;
    },
    isMediaReady: function () {
      return !!(mount && mount.getAttribute("data-dx-media-ready") === "true");
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
