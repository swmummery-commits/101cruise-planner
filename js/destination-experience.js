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

  function bindFindCruises(rootEl, handler) {
    var btn = $("[data-dx-find-cruises]", rootEl);
    if (!btn || typeof handler !== "function") return;
    btn.addEventListener("click", function () {
      handler();
    });
  }

  function bindAll(rootEl, options) {
    bindReveals(rootEl);
    bindStyles(rootEl);
    bindMonths(rootEl);
    if (options && typeof options.onFindCruises === "function") {
      bindFindCruises(rootEl, options.onFindCruises);
    }
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

  async function loadLineLogos(current, options) {
    options = options || {};
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
      if (!lines.length) throw new Error("no lines");
      return root.DestinationExperienceData.applyCruiseLineLogos(current, lines);
    } catch (_error) {
      if (!options.allowSnapshotFallback) return current;
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

  async function loadDestinationMedia(current, slug, options) {
    options = options || {};
    if (!current || !root.DestinationExperienceMedia) return current;
    var fallbackHero = current.hero ? Object.assign({}, current.hero) : null;
    var destinationName = current.name || slug;

    try {
      var payload = await root.DestinationExperienceMedia.loadDestinationMedia(slug, destinationName, {
        source: options.mediaSource === "snapshot" ? "snapshot" : "live",
        allowSnapshotFallback: !!options.allowSnapshotFallback
      });
      var assigned = root.DestinationExperienceMedia.assignDestinationImages(
        slug,
        payload.destinationMedia || [],
        fallbackHero,
        destinationName
      );
      current = root.DestinationExperienceData.applyMediaAssignments(current, assigned);
      current.ports = root.DestinationExperienceMedia.applyPortMedia(
        current.ports || [],
        payload.portMedia || [],
        destinationName
      );
      current.mediaSource = payload.source || "media_library_live";
      return current;
    } catch (_error) {
      var assignedFallback = root.DestinationExperienceMedia.assignDestinationImages(
        slug,
        [],
        fallbackHero,
        destinationName
      );
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

    var isCruiseFinder = !!options.cruiseFinder;
    model = root.DestinationExperienceData.fromCruiseFinder(slug, {
      catalogue: options.catalogue || root.CruiseFinderDestinations,
      content: options.content || root.CruiseFinderDestinationContent,
      images: options.images || root.CruiseFinderDestinationImages,
      pickImage: options.pickImage || root.CruiseFinderPickDestinationImage,
      filterLines: options.filterLines || root.CruiseFinderFilterCruiseLines,
      prefs: options.prefs || null,
      eyebrow: options.eyebrow || null
    });

    if (!model) {
      mount.innerHTML =
        '<div class="dx-wrap dx-error"><p>No destination experience data was found for “' +
        root.DestinationExperienceData.esc(slug) +
        '”.</p></div>';
      return;
    }

    if (isCruiseFinder) {
      model.cta = Object.assign({}, model.cta, {
        primaryAction: "find-cruises",
        primaryLabel: "Find Current Cruises",
        body: "We’ll search for current sailings that match your dates and preferences.",
        secondaryLabel: "Back to Cruise Finder",
        secondaryHref: options.finderBackHref || model.cta.secondaryHref
      });
    }

    var fallbackHero = model.hero ? Object.assign({}, model.hero) : null;
    model = await loadDestinationMedia(model, slug, {
      mediaSource: isCruiseFinder ? "live" : options.mediaSource || "snapshot",
      allowSnapshotFallback: !isCruiseFinder
    });
    if (root.DestinationExperienceImageLoader) {
      model = await root.DestinationExperienceImageLoader.resolveDestinationImages(model, fallbackHero);
    }
    model = await loadLineLogos(model, { allowSnapshotFallback: !isCruiseFinder });
    model = await preloadCruiseLineLogos(model);

    var timing = isCruiseFinder
      ? root.DestinationExperienceData.parseTimingFromCruiseFinder(options.prefs || {})
      : root.DestinationExperienceData.parseTimingFromSearch(params);
    model = root.DestinationExperienceData.applyTimingContext(model, timing);

    mount.innerHTML = root.DestinationExperienceComponents.renderPage(model);
    bindAll(mount, options);
    await markMediaReady(mount);
    document.title = isCruiseFinder
      ? (model.name || "Destination") + " | 101cruise Cruise Finder"
      : (model.name || "Destination") + " Experience | 101cruise";

    if (typeof options.onReady === "function") options.onReady(model);
    return model;
  }

  root.DestinationExperienceApp = {
    VERSION: "dx-route-fix-1",
    boot: boot,
    getModel: function () {
      return model;
    },
    isMediaReady: function () {
      return !!(mount && mount.getAttribute("data-dx-media-ready") === "true");
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
