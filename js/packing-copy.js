/**
 * My Cruise — copy an individual traveller's packing selections from a previous cruise.
 * Loaded after planner.js so this can extend the Packing Assistant without changing its core.
 */
(function () {
  "use strict";

  var OVERLAY_ID = "packing-copy-overlay";
  var sourceCache = new Map();
  var previousBodyOverflow = "";
  var escapeHandler = null;

  function escapeCopyHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatCopyDate(value) {
    var raw = String(value || "").trim();
    if (!raw) return "";
    var date = new Date(raw.slice(0, 10) + "T12:00:00");
    if (Number.isNaN(date.getTime())) return raw;
    return date.toLocaleDateString("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric"
    });
  }

  async function packingCopyRequest(action, payload) {
    var response = await fetch("/.netlify/functions/customer-packing-copy", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + customerSessionToken
      },
      body: JSON.stringify(Object.assign({ action: action }, payload || {}))
    });
    var data = await response.json().catch(function () {
      return null;
    });
    if (!response.ok || !data || data.success !== true) {
      throw new Error(
        (data && data.error) || "We couldn’t load previous packing lists just now."
      );
    }
    return data;
  }

  function ensureStyles() {
    if (document.getElementById("packing-copy-styles")) return;
    var style = document.createElement("style");
    style.id = "packing-copy-styles";
    style.textContent = [
      ".packing-copy-button{white-space:nowrap}",
      ".packing-copy-overlay{position:fixed;inset:0;z-index:10050;background:rgba(18,18,18,.42);display:flex;align-items:center;justify-content:center;padding:20px}",
      ".packing-copy-panel{width:min(680px,100%);max-height:min(760px,calc(100vh - 40px));overflow:auto;background:#fff;border-radius:22px;box-shadow:0 24px 70px rgba(0,0,0,.25);padding:24px}",
      ".packing-copy-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px}",
      ".packing-copy-header h2{margin:0 0 6px;font-size:1.45rem}",
      ".packing-copy-header p{margin:0;color:#666}",
      ".packing-copy-close{border:0;background:#f2f2f2;border-radius:999px;width:36px;height:36px;font-size:24px;line-height:1;cursor:pointer}",
      ".packing-copy-list{display:grid;gap:12px}",
      ".packing-copy-card{border:1px solid #e6e6e6;border-radius:16px;padding:16px;display:grid;grid-template-columns:1fr auto;gap:14px;align-items:center}",
      ".packing-copy-card h3{margin:0 0 4px;font-size:1.05rem}",
      ".packing-copy-card p{margin:3px 0;color:#666}",
      ".packing-copy-count{font-size:.9rem;color:#555}",
      ".packing-copy-help{margin:18px 0 0;padding:14px 16px;background:#f7f7f7;border-radius:14px;color:#555;font-size:.92rem}",
      "@media(max-width:600px){.packing-copy-overlay{padding:10px;align-items:flex-end}.packing-copy-panel{border-radius:20px 20px 0 0;max-height:88vh}.packing-copy-card{grid-template-columns:1fr}.packing-copy-card .planner-button{width:100%}}"
    ].join("");
    document.head.appendChild(style);
  }

  function closePackingCopyChooser() {
    var overlay = document.getElementById(OVERLAY_ID);
    if (overlay) overlay.remove();
    document.body.style.overflow = previousBodyOverflow;
    if (escapeHandler) {
      document.removeEventListener("keydown", escapeHandler);
      escapeHandler = null;
    }
  }

  function sourceLabel(source) {
    return (
      String(source.ship_name || source.cruise_line || "Previous cruise") +
      (source.departure_date ? " departing " + formatCopyDate(source.departure_date) : "")
    );
  }

  async function copyFromSource(source, profile) {
    var label = sourceLabel(source);
    var ok = window.confirm(
      "Copy " +
        profile.profile_name +
        "’s pack list from " +
        label +
        "?\n\nItems and quantities will be copied. Existing selections will be kept, and old Packed ticks will not be copied."
    );
    if (!ok) return;

    var actionButton = document.querySelector(
      '[data-packing-copy-token="' + CSS.escape(source.copy_token) + '"]'
    );
    if (actionButton) {
      actionButton.disabled = true;
      actionButton.textContent = "Copying…";
    }

    try {
      var result = await packingCopyRequest("copy", { copy_token: source.copy_token });
      closePackingCopyChooser();
      if (result.copied_count > 0) {
        window.alert(
          "Copied " +
            result.copied_count +
            " item" +
            (result.copied_count === 1 ? "" : "s") +
            " into " +
            profile.profile_name +
            "’s pack list. Existing selections were kept."
        );
      } else {
        window.alert(
          profile.profile_name +
            "’s current pack list already contains all of those selections."
        );
      }
      await renderPackingPlanner();
    } catch (error) {
      if (actionButton) {
        actionButton.disabled = false;
        actionButton.textContent = "Copy this pack list";
      }
      window.alert(error.message || "We couldn’t copy that packing list just now.");
    }
  }

  function openPackingCopyChooser(sources, profile) {
    closePackingCopyChooser();
    ensureStyles();

    var overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.className = "packing-copy-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "packing-copy-title");

    var cards = sources
      .map(function (source) {
        return (
          '<article class="packing-copy-card">' +
          "<div>" +
          "<h3>" +
          escapeCopyHtml(source.ship_name || "Previous cruise") +
          "</h3>" +
          "<p>" +
          escapeCopyHtml(source.cruise_line || "") +
          (source.departure_date
            ? " · " + escapeCopyHtml(formatCopyDate(source.departure_date))
            : "") +
          "</p>" +
          '<div class="packing-copy-count">' +
          escapeCopyHtml(source.selected_count) +
          " selected item" +
          (Number(source.selected_count) === 1 ? "" : "s") +
          "</div>" +
          "</div>" +
          '<button type="button" class="planner-button" data-packing-copy-token="' +
          escapeCopyHtml(source.copy_token) +
          '">Copy this pack list</button>' +
          "</article>"
        );
      })
      .join("");

    overlay.innerHTML =
      '<section class="packing-copy-panel">' +
      '<div class="packing-copy-header">' +
      "<div>" +
      '<h2 id="packing-copy-title">Copy ' +
      escapeCopyHtml(profile.profile_name) +
      "’s pack list</h2>" +
      "<p>Choose one of " +
      escapeCopyHtml(profile.profile_name) +
      "’s previous cruises.</p>" +
      "</div>" +
      '<button type="button" class="packing-copy-close" aria-label="Close" data-packing-copy-close>&times;</button>' +
      "</div>" +
      '<div class="packing-copy-list">' +
      cards +
      "</div>" +
      '<p class="packing-copy-help">This copies selected items, quantities and Checked / Carry-on / Wearing choices. Anything already selected for this cruise stays as it is. Packed ticks are reset for the new cruise.</p>' +
      "</section>";

    previousBodyOverflow = document.body.style.overflow || "";
    document.body.style.overflow = "hidden";
    document.body.appendChild(overlay);

    overlay.addEventListener("click", function (event) {
      if (
        event.target === overlay ||
        (event.target && event.target.closest("[data-packing-copy-close]"))
      ) {
        closePackingCopyChooser();
        return;
      }
      var button =
        event.target && event.target.closest
          ? event.target.closest("[data-packing-copy-token]")
          : null;
      if (!button) return;
      var token = button.getAttribute("data-packing-copy-token");
      var source = sources.find(function (item) {
        return item.copy_token === token;
      });
      if (source) copyFromSource(source, profile);
    });

    escapeHandler = function (event) {
      if (event.key === "Escape") closePackingCopyChooser();
    };
    document.addEventListener("keydown", escapeHandler);
    overlay.querySelector("[data-packing-copy-close]")?.focus();
  }

  async function loadCopySources(profileKey) {
    var cacheKey = String(packingV2CurrentCruiseKey || "current") + ":" + profileKey;
    if (sourceCache.has(cacheKey)) return sourceCache.get(cacheKey);
    var data = await packingCopyRequest("sources", { profile_key: profileKey });
    var sources = Array.isArray(data.sources) ? data.sources : [];
    sourceCache.set(cacheKey, sources);
    return sources;
  }

  async function installCopyControl() {
    if (
      typeof customerMode === "undefined" ||
      customerMode !== true ||
      typeof getActivePackingProfile !== "function"
    ) {
      return;
    }

    var profile = getActivePackingProfile();
    if (!profile || profile.profile_type !== "traveller") return;

    var toolbar = document.querySelector(".packing-toolbar .checklist-toolbar-actions");
    if (!toolbar || toolbar.querySelector("[data-packing-copy-open]")) return;

    var expectedProfileKey = profile.profile_key;
    try {
      var sources = await loadCopySources(expectedProfileKey);
      var currentProfile = getActivePackingProfile();
      if (
        !sources.length ||
        !currentProfile ||
        currentProfile.profile_key !== expectedProfileKey ||
        currentProfile.profile_type !== "traveller"
      ) {
        return;
      }

      var button = document.createElement("button");
      button.type = "button";
      button.className = "planner-button secondary packing-copy-button";
      button.setAttribute("data-packing-copy-open", "");
      button.textContent = "Copy pack list from previous cruise";
      button.addEventListener("click", function () {
        openPackingCopyChooser(sources, currentProfile);
      });
      toolbar.prepend(button);
    } catch (error) {
      console.warn("Previous packing lists unavailable", error);
    }
  }

  if (typeof packingItemApplies === "function" && typeof getPackingState === "function") {
    var originalPackingItemApplies = packingItemApplies;
    packingItemApplies = function (item, context) {
      try {
        if (item && item.id != null) {
          var saved = getPackingState("system:" + item.id);
          if (saved && Number(saved.quantity || 0) > 0) return true;
        }
      } catch (error) {
        // Fall through to the normal recommendation logic.
      }
      return originalPackingItemApplies.apply(this, arguments);
    };
  }

  if (typeof renderPackingPlanner === "function") {
    var originalRenderPackingPlanner = renderPackingPlanner;
    renderPackingPlanner = async function () {
      var result = await originalRenderPackingPlanner.apply(this, arguments);
      installCopyControl();
      return result;
    };
  }
})();
