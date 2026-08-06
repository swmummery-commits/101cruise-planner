/**
 * Authoritative public availability rules for discovered cruise inventory.
 * Uses Australia/Perth calendar dates for all cutoff calculations.
 */

const { perthCalendarDate, OPERATIONAL_TIMEZONE } = require("./cruise-discovery-maintenance");

/** Days until departure at which a cruise becomes hidden (21 = hidden). */
const PUBLIC_BOOKING_CUTOFF_DAYS = 21;

/** Minimum whole calendar days until departure for public visibility (22+ = visible). */
const PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE = PUBLIC_BOOKING_CUTOFF_DAYS + 1;

function addCalendarDays(isoDate, days) {
  const [y, m, d] = String(isoDate || "")
    .slice(0, 10)
    .split("-")
    .map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + Number(days) || 0);
  return dt.toISOString().slice(0, 10);
}

function daysUntilDeparture(departureDate, perthToday = perthCalendarDate()) {
  if (!departureDate || !perthToday) return null;
  const [y1, m1, d1] = String(departureDate).slice(0, 10).split("-").map(Number);
  const [y2, m2, d2] = String(perthToday).slice(0, 10).split("-").map(Number);
  if (!y1 || !m1 || !d1 || !y2 || !m2 || !d2) return null;
  const dep = Date.UTC(y1, m1 - 1, d1);
  const today = Date.UTC(y2, m2 - 1, d2);
  return Math.round((dep - today) / 86400000);
}

function publicBookingCutoffDate(perthToday = perthCalendarDate()) {
  return addCalendarDays(perthToday, PUBLIC_BOOKING_CUTOFF_DAYS);
}

function publicBookingMinimumDepartureDate(perthToday = perthCalendarDate()) {
  return addCalendarDays(perthToday, PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE);
}

function isCruisePubliclyBookable({
  departureDate,
  status = "active",
  perthToday = perthCalendarDate()
} = {}) {
  if (String(status || "").trim() !== "active") return false;
  if (!departureDate) return false;
  const days = daysUntilDeparture(departureDate, perthToday);
  if (days == null) return false;
  return days >= PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE;
}

function shouldRemoveFromPublicInventory({
  departureDate,
  status,
  perthToday = perthCalendarDate()
} = {}) {
  if (String(status || "").trim() === "expired") return true;
  if (!departureDate) return false;
  return String(departureDate).slice(0, 10) <= publicBookingCutoffDate(perthToday);
}

function publicUnavailabilityReason({
  departureDate,
  perthToday = perthCalendarDate(),
  status = null
} = {}) {
  if (String(status || "").trim() === "expired") {
    return {
      code: "outside_public_booking_window",
      label: "No longer publicly bookable",
      detail: "Outside the public booking window or past departure."
    };
  }
  if (!departureDate) return null;
  const days = daysUntilDeparture(departureDate, perthToday);
  if (days == null) return null;
  if (days < 0) {
    return {
      code: "past_departure",
      label: "Past departure",
      detail: "Departure date has passed — hidden from customer inventory."
    };
  }
  if (days <= PUBLIC_BOOKING_CUTOFF_DAYS) {
    return {
      code: "within_21_day_booking_cutoff",
      label: "Within 21-day booking cutoff",
      detail: `Departure is ${days} day(s) away — no longer publicly bookable for new enquiries.`
    };
  }
  return null;
}

function expirationMetadataForMaintenance({ departureDate, perthToday = perthCalendarDate() }) {
  const days = daysUntilDeparture(departureDate, perthToday);
  if (days == null) return null;
  if (days < 0) {
    return {
      expiration_reason: "past_departure_before_perth_calendar_date",
      public_unavailability: "past_departure"
    };
  }
  if (days <= PUBLIC_BOOKING_CUTOFF_DAYS) {
    return {
      expiration_reason: "within_public_booking_cutoff",
      public_unavailability: "within_21_day_booking_cutoff"
    };
  }
  return null;
}

function postgrestMinimumDepartureFilter(perthToday = perthCalendarDate()) {
  return `departure_date=gte.${publicBookingMinimumDepartureDate(perthToday)}`;
}

function postgrestPublicActiveInventoryFilter(perthToday = perthCalendarDate()) {
  return `status=eq.active&${postgrestMinimumDepartureFilter(perthToday)}`;
}

function partitionByPublicBookingCutoff(items, getDepartureDate, perthToday = perthCalendarDate()) {
  const publiclyEligible = [];
  const withinCutoff = [];
  for (const item of items || []) {
    const dep = typeof getDepartureDate === "function" ? getDepartureDate(item) : null;
    if (!dep) {
      publiclyEligible.push(item);
      continue;
    }
    const days = daysUntilDeparture(dep, perthToday);
    if (days != null && days <= PUBLIC_BOOKING_CUTOFF_DAYS) withinCutoff.push(item);
    else publiclyEligible.push(item);
  }
  return { publiclyEligible, withinCutoff };
}

function describePublicAvailability(row, perthToday = perthCalendarDate()) {
  const departureDate = row?.departure_date || null;
  const days = departureDate ? daysUntilDeparture(departureDate, perthToday) : null;
  const publiclyBookable = isCruisePubliclyBookable({
    departureDate,
    status: row?.status,
    perthToday
  });
  const reason = publicUnavailabilityReason({
    departureDate,
    perthToday,
    status: row?.status
  });
  return {
    departure_date: departureDate,
    days_until_departure: days,
    publicly_bookable: publiclyBookable,
    public_availability_status: publiclyBookable ? "publicly_bookable" : "hidden_from_customers",
    public_unavailability_reason: reason?.code || null,
    public_unavailability_label: reason?.label || null,
    public_unavailability_detail: reason?.detail || null,
    perth_as_of: perthToday,
    cutoff_days: PUBLIC_BOOKING_CUTOFF_DAYS
  };
}

module.exports = {
  PUBLIC_BOOKING_CUTOFF_DAYS,
  PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE,
  OPERATIONAL_TIMEZONE,
  perthCalendarDate,
  addCalendarDays,
  daysUntilDeparture,
  publicBookingCutoffDate,
  publicBookingMinimumDepartureDate,
  isCruisePubliclyBookable,
  shouldRemoveFromPublicInventory,
  publicUnavailabilityReason,
  expirationMetadataForMaintenance,
  postgrestMinimumDepartureFilter,
  postgrestPublicActiveInventoryFilter,
  partitionByPublicBookingCutoff,
  describePublicAvailability
};
