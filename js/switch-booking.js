/**
 * Client Portal — Switch Booking chooser UI.
 * Dual export: CommonJS (tests) + browser global SwitchBooking.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SwitchBooking = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var OVERLAY_ID = "switch-booking-overlay";
  var ESCAPE_HANDLER = null;
  var FOCUS_HANDLER = null;
  var PREVIOUS_OVERFLOW = "";

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatDisplayDate(isoDate) {
    var raw = String(isoDate || "").trim();
    if (!raw) return "";
    var d = new Date(raw.slice(0, 10) + "T12:00:00");
    if (Number.isNaN(d.getTime())) return raw;
    try {
      return d.toLocaleDateString("en-AU", {
        day: "numeric",
        month: "short",
        year: "numeric"
      });
    } catch (e) {
      return raw;
    }
  }

  function lifecycleLabel(lifecycle) {
    if (lifecycle === "currently_sailing") return "Currently sailing";
    if (lifecycle === "completed") return "Completed";
    return "Upcoming";
  }

  function lockPageScroll(lock) {
    if (typeof document === "undefined") return;
    if (lock) {
      PREVIOUS_OVERFLOW = document.body.style.overflow || "";
      document.body.style.overflow = "hidden";
      document.documentElement.classList.add("switch-booking-open");
    } else {
      document.body.style.overflow = PREVIOUS_OVERFLOW;
      document.documentElement.classList.remove("switch-booking-open");
    }
  }

  function closeChooser() {
    if (typeof document === "undefined") return;
    var overlay = document.getElementById(OVERLAY_ID);
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    if (ESCAPE_HANDLER) {
      document.removeEventListener("keydown", ESCAPE_HANDLER);
      ESCAPE_HANDLER = null;
    }
    if (FOCUS_HANDLER) {
      document.removeEventListener("keydown", FOCUS_HANDLER);
      FOCUS_HANDLER = null;
    }
    lockPageScroll(false);
  }

  function renderCard(booking, handlers) {
    var isCurrent = booking.is_current === true;
    var hero = booking.ship_hero_image
      ? '<div class="switch-booking-card-hero" style="background-image:url(\'' +
        escapeHtml(booking.ship_hero_image) +
        "')\"></div>"
      : '<div class="switch-booking-card-hero switch-booking-card-hero--fallback" aria-hidden="true"></div>';

    var route =
      booking.route_summary ||
      [booking.embarkation_port, booking.disembarkation_port].filter(Boolean).join(" → ");
    var duration =
      booking.duration_nights != null && booking.duration_nights !== ""
        ? booking.duration_nights + " nights"
        : "";
    var badge = lifecycleLabel(booking.lifecycle);
    var action = isCurrent
      ? '<button type="button" class="switch-booking-card-action is-current" disabled>Current cruise</button>'
      : '<button type="button" class="switch-booking-card-action" data-switch-token="' +
        escapeHtml(booking.switch_token || "") +
        '">Open this cruise</button>';

    return (
      '<article class="switch-booking-card' +
      (isCurrent ? " is-current" : "") +
      '" role="listitem" tabindex="0" data-switch-card' +
      (isCurrent ? ' aria-current="true"' : "") +
      ">" +
      hero +
      '<div class="switch-booking-card-body">' +
      '<p class="switch-booking-card-badge">' +
      escapeHtml(badge) +
      "</p>" +
      "<h3>" +
      escapeHtml(booking.ship_name || "Your cruise") +
      "</h3>" +
      '<p class="switch-booking-card-line">' +
      escapeHtml(booking.cruise_line || "") +
      "</p>" +
      '<p class="switch-booking-card-date">' +
      escapeHtml(formatDisplayDate(booking.departure_date)) +
      (duration ? " · " + escapeHtml(duration) : "") +
      "</p>" +
      (route ? '<p class="switch-booking-card-route">' + escapeHtml(route) + "</p>" : "") +
      (booking.booking_reference
        ? '<p class="switch-booking-card-ref">Booking ' +
          escapeHtml(booking.booking_reference) +
          "</p>"
        : "") +
      action +
      "</div></article>"
    );
  }

  function trapFocus(overlay) {
    FOCUS_HANDLER = function (event) {
      if (event.key !== "Tab") return;
      var focusable = overlay.querySelectorAll(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", FOCUS_HANDLER);
  }

  /**
   * @param {{
   *   bookings: Array<object>,
   *   emptyMessage?: string,
   *   errorMessage?: string,
   *   onSelect: (switchToken: string) => void|Promise<void>,
   *   onSignOut?: () => void,
   *   onClose?: () => void
   * }} opts
   */
  function openChooser(opts) {
    if (typeof document === "undefined") return;
    var options = opts && typeof opts === "object" ? opts : {};
    closeChooser();

    var bookings = Array.isArray(options.bookings) ? options.bookings : [];
    var overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.className = "switch-booking-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "switch-booking-title");

    var bodyHtml = "";
    if (options.errorMessage) {
      bodyHtml =
        '<p class="switch-booking-message" role="alert">' +
        escapeHtml(options.errorMessage) +
        "</p>" +
        '<button type="button" class="planner-button black" data-switch-retry>Try again</button>';
    } else if (bookings.length <= 1) {
      bodyHtml =
        '<p class="switch-booking-message">' +
        escapeHtml(
          options.emptyMessage || "No other linked cruises are available in this account."
        ) +
        "</p>";
    } else {
      bodyHtml =
        '<div class="switch-booking-list" role="list">' +
        bookings.map(function (b) {
          return renderCard(b);
        }).join("") +
        "</div>";
    }

    overlay.innerHTML =
      '<div class="switch-booking-panel">' +
      '<div class="switch-booking-panel-header">' +
      "<div>" +
      '<h2 id="switch-booking-title">Choose your cruise</h2>' +
      '<p class="switch-booking-support">Select another cruise linked to your account.</p>' +
      "</div>" +
      '<button type="button" class="switch-booking-close" aria-label="Close" data-switch-close>&times;</button>' +
      "</div>" +
      '<div class="switch-booking-panel-body">' +
      bodyHtml +
      "</div>" +
      '<div class="switch-booking-panel-footer">' +
      (typeof options.onSignOut === "function"
        ? '<button type="button" class="switch-booking-signout" data-switch-signout>Sign out</button>'
        : "") +
      "</div>" +
      "</div>";

    document.body.appendChild(overlay);
    lockPageScroll(true);

    function handleClose() {
      closeChooser();
      if (typeof options.onClose === "function") options.onClose();
    }

    overlay.addEventListener("click", function (event) {
      var target = event.target;
      if (target === overlay || (target && target.getAttribute("data-switch-close") != null)) {
        handleClose();
        return;
      }
      if (target && target.getAttribute("data-switch-signout") != null) {
        closeChooser();
        options.onSignOut();
        return;
      }
      if (target && target.getAttribute("data-switch-retry") != null) {
        closeChooser();
        if (typeof options.onRetry === "function") options.onRetry();
        return;
      }
      var action = target && target.closest ? target.closest("[data-switch-token]") : null;
      if (action && action.getAttribute("data-switch-token")) {
        var token = action.getAttribute("data-switch-token");
        if (token && typeof options.onSelect === "function") {
          options.onSelect(token);
        }
      }
    });

    ESCAPE_HANDLER = function (event) {
      if (event.key === "Escape") handleClose();
    };
    document.addEventListener("keydown", ESCAPE_HANDLER);
    trapFocus(overlay);

    var closeBtn = overlay.querySelector("[data-switch-close]");
    if (closeBtn) closeBtn.focus();
  }

  function shouldShowSwitchControl(linkedPayload) {
    if (!linkedPayload || linkedPayload.success === false) return false;
    if (typeof linkedPayload.can_switch === "boolean") return linkedPayload.can_switch;
    return Array.isArray(linkedPayload.bookings) && linkedPayload.bookings.length > 1;
  }

  return {
    openChooser: openChooser,
    closeChooser: closeChooser,
    shouldShowSwitchControl: shouldShowSwitchControl,
    formatDisplayDate: formatDisplayDate,
    lifecycleLabel: lifecycleLabel,
    escapeHtml: escapeHtml,
    OVERLAY_ID: OVERLAY_ID
  };
});
