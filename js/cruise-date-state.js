/**
 * Shared Client Portal cruise calendar lifecycle + countdown presentation.
 * Date-only semantics: local Y-M-D calendar days (no timezone day-shift).
 *
 * Dual export: CommonJS (Node) + browser global CruiseDateState.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CruiseDateState = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function normaliseIsoDate(value) {
    const match = String(value || "").trim().match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : null;
  }

  function formatDateOnly(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function parseDateOnly(iso) {
    const normalized = normaliseIsoDate(iso);
    if (!normalized) return null;
    const parts = normalized.split("-").map(Number);
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
    const date = new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function addDays(date, n) {
    const base = date instanceof Date ? new Date(date.getTime()) : parseDateOnly(date);
    if (!base || Number.isNaN(base.getTime())) return null;
    const days = Number(n);
    if (!Number.isFinite(days)) return null;
    base.setDate(base.getDate() + Math.trunc(days));
    return base;
  }

  function parseDurationNights(value) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.trunc(value);
    }
    const text = String(value).trim();
    if (!text) return null;
    const match = text.match(/(\d+)/);
    if (!match) return null;
    const nights = Number(match[1]);
    return Number.isFinite(nights) && nights > 0 ? nights : null;
  }

  function getToday(now) {
    const d = now instanceof Date ? now : new Date(now || Date.now());
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  }

  function compareCalendarDays(left, right) {
    return Math.floor((left.getTime() - right.getTime()) / 86400000);
  }

  function deriveReturnDate({ departing_date, arriving_date, cruise_duration, nights }) {
    const arriving = normaliseIsoDate(arriving_date);
    if (arriving) {
      return { returnDate: arriving, derived: false };
    }

    const departure = parseDateOnly(departing_date);
    if (!departure) {
      return { returnDate: null, derived: false };
    }

    const nightCount =
      parseDurationNights(nights) ?? parseDurationNights(cruise_duration);
    if (nightCount == null) {
      return { returnDate: null, derived: false };
    }

    const returnDate = addDays(departure, nightCount);
    return {
      returnDate: formatDateOnly(returnDate),
      derived: true
    };
  }

  function getCruiseLifecycleState({
    departing_date,
    arriving_date,
    cruise_duration,
    nights,
    now
  }) {
    const departure = parseDateOnly(departing_date);
    if (!departure) return "hidden";

    const today = getToday(now);
    const daysUntilDeparture = compareCalendarDays(departure, today);

    if (daysUntilDeparture > 0) return "before_embarkation";
    if (daysUntilDeparture === 0) return "embarkation_day";

    const { returnDate } = deriveReturnDate({
      departing_date,
      arriving_date,
      cruise_duration,
      nights
    });
    const disembarkation = returnDate ? parseDateOnly(returnDate) : null;

    if (disembarkation) {
      const daysUntilDisembarkation = compareCalendarDays(disembarkation, today);
      if (daysUntilDisembarkation <= 0) return "disembarked";
    }

    return "during_cruise";
  }

  function buildCountdownPresentation(state, legacyCountdownConfig) {
    const legacy = legacyCountdownConfig && typeof legacyCountdownConfig === "object"
      ? legacyCountdownConfig
      : {};

    if (state === "before_embarkation") {
      return {
        mode: "countdown",
        panelLabel: legacy.panelLabel || "Sailing in",
        showCounters: true
      };
    }

    if (state === "embarkation_day") {
      return {
        mode: "sail_day",
        message: {
          title: "TODAY IS SAIL DAY",
          subtitle: "BON VOYAGE!"
        },
        showCounters: false
      };
    }

    if (state === "during_cruise") {
      return {
        mode: "enjoying",
        message: "HOPE YOU ARE ENJOYING YOUR CRUISE",
        showCounters: false
      };
    }

    return {
      mode: "hidden",
      showCounters: false
    };
  }

  return {
    parseDateOnly,
    addDays,
    deriveReturnDate,
    getCruiseLifecycleState,
    buildCountdownPresentation,
    formatDateOnly,
    parseDurationNights
  };
});
