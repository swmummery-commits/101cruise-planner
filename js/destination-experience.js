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

  function bindPortsCarousel(rootEl) {
    var track = $("[data-dx-ports-track]", rootEl);
    var prev = $("[data-dx-ports-prev]", rootEl);
    var next = $("[data-dx-ports-next]", rootEl);
    var dotsHost = $("[data-dx-ports-dots]", rootEl);
    if (!track) return;

    var cards = $all(".dx-port-card", track);
    if (!cards.length) return;

    function cardWidth() {
      var card = cards[0];
      var styles = window.getComputedStyle(track);
      var gap = parseFloat(styles.columnGap || styles.gap || "16") || 16;
      return card.getBoundingClientRect().width + gap;
    }

    function pageCount() {
      var visible = Math.max(1, Math.round(track.clientWidth / cardWidth()));
      return Math.max(1, cards.length - visible + 1);
    }

    function currentIndex() {
      return Math.round(track.scrollLeft / cardWidth());
    }

    function renderDots() {
      if (!dotsHost) return;
      var count = pageCount();
      var active = Math.min(currentIndex(), count - 1);
      dotsHost.innerHTML = Array.from({ length: count })
        .map(function (_n, i) {
          return `<button type="button" class="dx-dot-btn${i === active ? " is-active" : ""}" data-dx-dot="${i}" aria-label="Port set ${
            i + 1
          }"></button>`;
        })
        .join("");
      $all("[data-dx-dot]", dotsHost).forEach(function (btn) {
        btn.addEventListener("click", function () {
          track.scrollTo({
            left: Number(btn.getAttribute("data-dx-dot")) * cardWidth(),
            behavior: reducedMotion ? "auto" : "smooth"
          });
        });
      });
    }

    function scrollByDir(dir) {
      track.scrollBy({
        left: dir * cardWidth(),
        behavior: reducedMotion ? "auto" : "smooth"
      });
    }

    if (prev) prev.addEventListener("click", function () {
      scrollByDir(-1);
    });
    if (next) next.addEventListener("click", function () {
      scrollByDir(1);
    });

    track.addEventListener("scroll", function () {
      window.clearTimeout(track._dxDotTimer);
      track._dxDotTimer = window.setTimeout(renderDots, 80);
    });

    // Pointer drag
    var dragging = false;
    var startX = 0;
    var startLeft = 0;
    track.addEventListener("pointerdown", function (event) {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      dragging = true;
      startX = event.clientX;
      startLeft = track.scrollLeft;
      track.setPointerCapture(event.pointerId);
      track.classList.add("is-dragging");
    });
    track.addEventListener("pointermove", function (event) {
      if (!dragging) return;
      track.scrollLeft = startLeft - (event.clientX - startX);
    });
    function endDrag(event) {
      if (!dragging) return;
      dragging = false;
      track.classList.remove("is-dragging");
      try {
        track.releasePointerCapture(event.pointerId);
      } catch (_err) {
        /* ignore */
      }
    }
    track.addEventListener("pointerup", endDrag);
    track.addEventListener("pointercancel", endDrag);

    renderDots();
    window.addEventListener("resize", function () {
      window.clearTimeout(track._dxResizeTimer);
      track._dxResizeTimer = window.setTimeout(renderDots, 120);
    });
  }

  function bindAll(rootEl) {
    bindReveals(rootEl);
    bindStyles(rootEl);
    bindMonths(rootEl);
    bindPortsCarousel(rootEl);
    rootEl.classList.add("is-ready");
  }

  async function loadLineLogos(current) {
    try {
      var response = await fetch("/.netlify/functions/public-ci-cruise-lines");
      if (!response.ok) return current;
      var data = await response.json();
      var lines = Array.isArray(data.lines) ? data.lines : Array.isArray(data) ? data : [];
      return root.DestinationExperienceData.applyCruiseLineLogos(current, lines);
    } catch (_error) {
      return current;
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

    model = await loadLineLogos(model);
    model = root.DestinationExperienceData.applyTimingContext(
      model,
      root.DestinationExperienceData.parseTimingFromSearch(params)
    );
    mount.innerHTML = root.DestinationExperienceComponents.renderPage(model);
    bindAll(mount);
    document.title = (model.name || "Destination") + " Experience | 101cruise";

    if (typeof options.onReady === "function") options.onReady(model);
    return model;
  }

  root.DestinationExperienceApp = {
    boot: boot,
    getModel: function () {
      return model;
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
