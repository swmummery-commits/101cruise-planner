"use strict";

const {
  BASE44_FETCH_TIMEOUT_MS,
  fetchBase44Booking,
  readBookingCache,
  classifyBookingCache,
  bookingFromCacheRow,
  sourceFromBooking
} = require("./booking-service");

function normaliseReference(value) {
  return String(value || "").trim().toUpperCase();
}

function normaliseSurname(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]/g, "");
}

function bookingSurnameMatches(booking, surname) {
  const wanted = normaliseSurname(surname);
  if (!wanted || !booking || typeof booking !== "object") return false;

  const raw = booking.raw_payload && typeof booking.raw_payload === "object"
    ? booking.raw_payload
    : null;

  const candidates = [
    booking.passenger1_last_name,
    booking.passenger2_last_name,
    raw?.passenger1_last_name,
    raw?.passenger2_last_name
  ]
    .map(normaliseSurname)
    .filter(Boolean);

  return candidates.includes(wanted);
}

function cacheCanBeUsed(cacheInfo) {
  if (!cacheInfo?.usable) return false;
  // booking-service historically labels cache older than the acceptable window
  // as "stale" while still marking it usable. Customer authentication must not
  // rely on indefinitely old identity data.
  return cacheInfo.freshness === "fresh" || cacheInfo.freshness === "stale_acceptable";
}

async function resolveCustomerBooking(
  { booking_reference, surname },
  { timeoutMs = BASE44_FETCH_TIMEOUT_MS, fetchImpl = fetch } = {}
) {
  const reference = normaliseReference(booking_reference);
  const surnameNorm = normaliseSurname(surname);

  if (!reference || !surnameNorm) {
    const error = new Error("Booking number and traveller surname are required.");
    error.code = "invalid_request";
    throw error;
  }

  // Cache is fallback only. Never reject a customer from stale cached identity
  // before checking the authoritative CRM booking.
  let cacheRow = null;
  let cacheInfo = { usable: false, freshness: "unavailable" };
  try {
    cacheRow = await readBookingCache({ booking_reference: reference });
    cacheInfo = classifyBookingCache(cacheRow);
  } catch (cacheError) {
    console.warn("Customer booking cache read failed", cacheError?.message || cacheError);
  }

  try {
    const { booking, source } = await fetchBase44Booking({
      booking_reference: reference,
      timeoutMs,
      fetchImpl
    });

    if (!bookingSurnameMatches(booking, surnameNorm)) {
      const error = new Error("We could not match those booking details.");
      error.code = "surname_mismatch";
      throw error;
    }

    return {
      booking,
      source,
      bookingSource: "live",
      cacheFallback: false,
      cacheFreshness: cacheInfo.freshness,
      cacheRow
    };
  } catch (fetchError) {
    // A deliberate surname mismatch from the live CRM must never fall back to
    // a cache row that could contain an older traveller identity.
    if (fetchError?.code === "surname_mismatch") throw fetchError;

    if (
      cacheRow &&
      cacheCanBeUsed(cacheInfo) &&
      bookingSurnameMatches(cacheRow, surnameNorm)
    ) {
      const booking = bookingFromCacheRow(cacheRow);
      return {
        booking,
        source: sourceFromBooking(booking),
        bookingSource: "cache",
        cacheFallback: true,
        cacheFreshness: cacheInfo.freshness,
        cacheRow
      };
    }

    if (fetchError?.code === "base44_timeout") {
      const error = new Error("The booking service is taking longer than expected. Please try again.");
      error.code = "base44_timeout";
      error.httpStatus = 503;
      throw error;
    }

    throw fetchError;
  }
}

module.exports = {
  normaliseReference,
  normaliseSurname,
  bookingSurnameMatches,
  cacheCanBeUsed,
  resolveCustomerBooking
};
