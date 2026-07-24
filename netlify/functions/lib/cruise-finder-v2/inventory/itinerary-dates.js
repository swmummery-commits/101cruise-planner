/**
 * Deterministic itinerary date calculation from departureDate + dayNumber.
 */

function toIsoDate(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function addDaysIso(isoDate, days) {
  if (!isoDate || days == null || !Number.isFinite(Number(days))) return null;
  const d = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString().slice(0, 10);
}

/**
 * @param {string} departureDate
 * @param {number|null} dayNumber
 * @returns {string|null}
 */
function dateForDay(departureDate, dayNumber) {
  const dep = toIsoDate(departureDate);
  if (!dep || dayNumber == null || !Number.isFinite(Number(dayNumber))) return null;
  return addDaysIso(dep, Number(dayNumber) - 1);
}

/**
 * @param {{ departureDate: string, nights: number|null, itinerary: Array<{dayNumber:number|null, date?:string|null, type?:string}> }} input
 */
function applyItineraryDates(input) {
  const departureDate = toIsoDate(input.departureDate) || "";
  const nights =
    input.nights == null || input.nights === "" ? null : Number(input.nights);

  const itinerary = (input.itinerary || []).map((stop) => ({
    ...stop,
    date: dateForDay(departureDate, stop.dayNumber)
  }));

  const lastDay = itinerary.reduce((max, s) => {
    const n = s.dayNumber == null ? null : Number(s.dayNumber);
    if (!Number.isFinite(n)) return max;
    return max == null || n > max ? n : max;
  }, null);

  const returnFromItinerary =
    lastDay != null ? dateForDay(departureDate, lastDay) : null;
  const returnFromDuration =
    departureDate && Number.isFinite(nights) ? addDaysIso(departureDate, nights) : null;

  const warnings = [];
  if (returnFromItinerary && returnFromDuration && returnFromItinerary !== returnFromDuration) {
    warnings.push({
      code: "duration_date_inconsistency",
      message: `Final itinerary date ${returnFromItinerary} differs from departureDate+duration (${returnFromDuration}).`,
      returnFromItinerary,
      returnFromDuration,
      nights,
      lastDayNumber: lastDay
    });
  }

  // Prefer final itinerary day when present; otherwise duration-based.
  const returnDate = returnFromItinerary || returnFromDuration || "";

  return {
    departureDate,
    returnDate,
    nights: Number.isFinite(nights) ? nights : null,
    itinerary,
    dateConsistency: {
      ok: warnings.length === 0,
      returnFromItinerary,
      returnFromDuration,
      warnings
    }
  };
}

module.exports = {
  toIsoDate,
  addDaysIso,
  dateForDay,
  applyItineraryDates
};
