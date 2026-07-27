/**
 * Shared brand loading indicator — 3×3 grid of nine red logo squares.
 * Random short flash sequences loop continuously (Cursor-style).
 * Dual export: CommonJS (tests) + browser global BrandLoading.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.BrandLoading = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var BOX_COUNT = 9;
  var LIVE_ATTR = "data-brand-loading-live";
  var STATE_KEY = "_brandLoadingState";

  /**
   * @param {{ inline?: boolean, large?: boolean, className?: string }=} opts
   */
  function html(opts) {
    var options = opts && typeof opts === "object" ? opts : {};
    var classes = ["brand-loading-boxes"];
    if (options.inline) classes.push("brand-loading-boxes--inline");
    if (options.large) classes.push("brand-loading-boxes--large");
    if (options.className) classes.push(String(options.className));
    var boxes = "";
    for (var i = 0; i < BOX_COUNT; i++) boxes += "<span></span>";
    return (
      '<span class="' + classes.join(" ") + '" aria-hidden="true">' + boxes + "</span>"
    );
  }

  function prefersReducedMotion() {
    try {
      return (
        typeof matchMedia === "function" &&
        matchMedia("(prefers-reduced-motion: reduce)").matches
      );
    } catch (e) {
      return false;
    }
  }

  function clearFlashTimers(state) {
    if (!state || !state.flashTimers) return;
    for (var i = 0; i < state.flashTimers.length; i++) {
      clearTimeout(state.flashTimers[i]);
    }
    state.flashTimers = [];
  }

  function stop(el) {
    if (!el || !el[STATE_KEY]) return;
    var state = el[STATE_KEY];
    if (state.timer) clearTimeout(state.timer);
    clearFlashTimers(state);
    var cells = state.cells || [];
    for (var i = 0; i < cells.length; i++) {
      cells[i].classList.remove("is-on");
    }
    delete el[STATE_KEY];
    if (el.removeAttribute) el.removeAttribute(LIVE_ATTR);
    el.classList.remove("brand-loading-boxes--static");
  }

  function buildSequence(cellCount) {
    var len = 10 + Math.floor(Math.random() * 8);
    var seq = new Array(len);
    for (var i = 0; i < len; i++) {
      seq[i] = Math.floor(Math.random() * cellCount);
    }
    return seq;
  }

  function play(el) {
    if (!el || el[STATE_KEY]) return el;
    if (prefersReducedMotion()) {
      el.classList.add("brand-loading-boxes--static");
      el.setAttribute(LIVE_ATTR, "static");
      return el;
    }

    var cells = [];
    for (var i = 0; i < el.children.length; i++) {
      cells.push(el.children[i]);
    }
    if (!cells.length) return el;

    var state = {
      cells: cells,
      seq: buildSequence(cells.length),
      idx: 0,
      timer: null,
      flashTimers: []
    };
    el[STATE_KEY] = state;
    el.setAttribute(LIVE_ATTR, "1");

    function schedule(fn, ms) {
      state.timer = setTimeout(fn, ms);
    }

    function flash(cell) {
      cell.classList.add("is-on");
      var onMs = 120 + Math.floor(Math.random() * 160);
      var t = setTimeout(function () {
        cell.classList.remove("is-on");
      }, onMs);
      state.flashTimers.push(t);
    }

    function tick() {
      if (!el[STATE_KEY]) return;

      if (state.idx >= state.seq.length) {
        // Short pause, then a fresh random sequence — continuous loop
        state.seq = buildSequence(cells.length);
        state.idx = 0;
        schedule(tick, 100 + Math.floor(Math.random() * 160));
        return;
      }

      flash(cells[state.seq[state.idx++]]);
      // Occasionally spark a second box in the same beat
      if (Math.random() < 0.35) {
        flash(cells[Math.floor(Math.random() * cells.length)]);
      }
      schedule(tick, 35 + Math.floor(Math.random() * 75));
    }

    tick();
    return el;
  }

  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    var nodes = root.querySelectorAll(".brand-loading-boxes:not([" + LIVE_ATTR + "])");
    for (var i = 0; i < nodes.length; i++) play(nodes[i]);
  }

  function stopTree(root) {
    if (!root) return;
    if (root.classList && root.classList.contains("brand-loading-boxes")) stop(root);
    if (!root.querySelectorAll) return;
    var nodes = root.querySelectorAll(".brand-loading-boxes");
    for (var i = 0; i < nodes.length; i++) stop(nodes[i]);
  }

  function autoBind() {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
    scan(document);
    var mo = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type !== "childList") continue;
        for (var a = 0; a < m.addedNodes.length; a++) {
          var node = m.addedNodes[a];
          if (!node || node.nodeType !== 1) continue;
          if (node.classList && node.classList.contains("brand-loading-boxes")) play(node);
          else scan(node);
        }
        for (var r = 0; r < m.removedNodes.length; r++) {
          stopTree(m.removedNodes[r]);
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", autoBind);
    } else {
      autoBind();
    }
  }

  return {
    html: html,
    play: play,
    stop: stop,
    scan: scan,
    BOX_COUNT: BOX_COUNT
  };
});
