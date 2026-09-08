/**
 * Secure linked-booking helpers for Client Portal switch.
 *
 * Linkage rule (priority order available in this codebase):
 * 1. Explicit portal-account links — not used for surname-login customers
 * 2. Shared CRM contact id — not present on Base44 safe payloads
 * 3. Verified booking-access / invitation rows — planner path only
 * 4. Compound identity: normalised traveller email AND traveller mobile
 *
 * Surname alone is never sufficient and is never queried.
 */
"use strict";

const { createSessionToken, verifyToken } = require("./customer-session-auth");

const SWITCH_TOKEN_TTL_MS = 10 * 60 * 1000;
const FORBIDDEN_CARD_KEYS = Object.freeze([
  "passenger1_first_name",
  "passenger1_last_name",
  "passenger1_email",
  "passenger1_mobile",
  "passenger2_first_name",
  "passenger2_last_name",
  "passenger2_email",
  "passenger2_mobile",
  "passport",
  "address",
  "email",
  "phone",
  "mobile",
  "surname",
  "last_name",
  "raw_payload",
  "finance",
  "cruise_price",
  "cruise_price_usd",
  "total_price",
  "balance",
  "deposit"
]);

function normaliseEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normaliseMobile(value) {
  let digits = String(value || "").replace(/\D+/g, "");
  if (!digits) return "";

  // Treat the common Australian forms +61 4xx xxx xxx and 04xx xxx xxx as
  // the same identity. Do not rewrite non-Australian numbers.
  const intlAu = digits.match(/^61(4\d{8})$/);
  if (intlAu) return `0${intlAu[1]}`;

  const intlAuWithTrunk = digits.match(/^610(4\d{8})$/);
  if (intlAuWithTrunk) return `0${intlAuWithTrunk[1]}`;

  const dialledIntlAu = digits.match(/^001161(4\d{8})$/);
  if (dialledIntlAu) return `0${dialledIntlAu[1]}`;

  return digits;
}

function travellerIdentityKey(emailValue, mobileValue) {
  const email = normaliseEmail(emailValue);
  const mobile = normaliseMobile(mobileValue);
  if (!email || !mobile || mobile.length < 6) return null;
  return `${email}|${mobile}`;
}

function bookingIdentityKeys(row) {
  const raw = row?.raw_payload && typeof row.raw_payload === "object" ? row.raw_payload : null;
  const candidates = [
    travellerIdentityKey(row?.passenger1_email, row?.passenger1_mobile),
    travellerIdentityKey(row?.passenger2_email, row?.passenger2_mobile),
    travellerIdentityKey(raw?.passenger1_email, raw?.passenger1_mobile),
    travellerIdentityKey(raw?.passenger2_email, raw?.passenger2_mobile)
  ].filter(Boolean);
  return [...new Set(candidates)];
}

// Backward-compatible helper used by existing tests/callers. The first secure
// traveller identity is returned, regardless of whether that traveller is pax 1 or 2.
function bookingIdentityKey(row) {
  return bookingIdentityKeys(row)[0] || null;
}

/**
 * Returns true only when both bookings share at least one compound email+mobile
 * traveller identity. Passenger order may differ between bookings. Surname is ignored.
 */
function bookingsShareSecureIdentity(a, b) {
  const keysA = bookingIdentityKeys(a);
  const keysB = new Set(bookingIdentityKeys(b));
  if (!keysA.length || !keysB.size) return false;
  return keysA.some((key) => keysB.has(key));
}

function sameBookingId(a, b) {
  const idA = String(a?.base44_booking_id || a?.booking_id || "").trim();
  const idB = String(b?.base44_booking_id || b?.booking_id || "").trim();
  if (idA && idB && idA === idB) return true;
  const refA = String(a?.booking_reference || "").trim().toUpperCase();
  const refB = String(b?.booking_reference || "").trim().toUpperCase();
  return Boolean(refA && refB && refA === refB);
}

function parseDateOnly(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const d = new Date(`${raw.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function calculateDurationNights(departingDate, arrivingDate) {
  const start = parseDateOnly(departingDate);
  const end = parseDateOnly(arrivingDate);
  if (!start || !end) return null;
  const days = Math.round((end.getTime() - start.getTime()) / 86400000);
  return days > 0 ? days : null;
}

function classifyLifecycle(departingDate, arrivingDate, now = new Date()) {
  const start = parseDateOnly(departingDate);
  const end = parseDateOnly(arrivingDate);
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12));
  if (start && end) {
    if (today.getTime() >= start.getTime() && today.getTime() <= end.getTime()) return "currently_sailing";
    if (today.getTime() < start.getTime()) return "upcoming";
    return "completed";
  }
  if (start) {
    if (today.getTime() < start.getTime()) return "upcoming";
    return "completed";
  }
  return "upcoming";
}

function lifecycleSortRank(lifecycle) {
  if (lifecycle === "currently_sailing") return 0;
  if (lifecycle === "upcoming") return 1;
  return 2;
}

function routeSummary(row) {
  const embark = String(row?.departing_port || "").trim();
  const disembark = String(row?.arriving_port || "").trim();
  if (embark && disembark) return `${embark} → ${disembark}`;
  return embark || disembark || "";
}

function createSwitchToken({ sessionBookingId, targetBookingId, secret, now = Date.now() }) {
  return createSessionToken(
    {
      typ: "switch",
      sid: String(sessionBookingId),
      tid: String(targetBookingId),
      exp: now + SWITCH_TOKEN_TTL_MS
    },
    secret
  );
}

function verifySwitchToken(token, secret, sessionBookingId) {
  const payload = verifyToken(token, secret);
  if (!payload || payload.typ !== "switch") return null;
  if (String(payload.sid) !== String(sessionBookingId)) return null;
  if (!payload.tid) return null;
  return payload;
}

function assertCardHasNoSensitiveFields(card) {
  const keys = Object.keys(card || {});
  for (const key of keys) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_CARD_KEYS.some((f) => lower.includes(f) || lower === f)) {
      throw new Error(`Sensitive field leaked in card: ${key}`);
    }
  }
  return true;
}

function toSafeLinkedBookingCard(row, { currentBookingId, currentBookingReference, secret, heroImageUrl = null, now = new Date() }) {
  const bookingId = String(row.base44_booking_id || "").trim();
  const bookingReference = String(row.booking_reference || "").trim();
  const isCurrent =
    (bookingId && bookingId === String(currentBookingId || "")) ||
    (bookingReference &&
      bookingReference.toUpperCase() === String(currentBookingReference || "").trim().toUpperCase());

  const lifecycle = classifyLifecycle(row.departing_date, row.arriving_date, now);
  const duration = calculateDurationNights(row.departing_date, row.arriving_date);
  const switchToken =
    !isCurrent && bookingId && secret
      ? createSwitchToken({
          sessionBookingId: currentBookingId,
          targetBookingId: bookingId,
          secret
        })
      : null;

  const card = {
    switch_token: switchToken,
    booking_reference: bookingReference || null,
    cruise_line: row.cruise_line || null,
    ship_name: row.cruise_ship || null,
    departure_date: row.departing_date || null,
    arrival_date: row.arriving_date || null,
    duration_nights: duration,
    embarkation_port: row.departing_port || null,
    disembarkation_port: row.arriving_port || null,
    route_summary: routeSummary(row) || null,
    ship_hero_image: heroImageUrl || null,
    lifecycle,
    is_current: Boolean(isCurrent)
  };

  assertCardHasNoSensitiveFields(card);
  return card;
}

/**
 * Filter candidate cache rows to those securely linked to the session booking.
 * Never uses surname. Returns only the current booking when compound identity is unavailable.
 */
function filterSecurelyLinkedBookings(sessionBooking, candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const currentId = String(sessionBooking?.base44_booking_id || sessionBooking?.booking_id || "").trim();
  const currentRef = String(sessionBooking?.booking_reference || "").trim().toUpperCase();

  const currentRow =
    list.find(
      (row) =>
        String(row.base44_booking_id || "") === currentId ||
        String(row.booking_reference || "").trim().toUpperCase() === currentRef
    ) || sessionBooking;

  const identities = bookingIdentityKeys(currentRow);
  if (!identities.length) {
    return list.filter(
      (row) =>
        String(row.base44_booking_id || "") === currentId ||
        String(row.booking_reference || "").trim().toUpperCase() === currentRef
    );
  }

  return list.filter((row) => bookingsShareSecureIdentity(currentRow, row));
}

function sortLinkedBookingCards(cards) {
  return [...cards].sort((a, b) => {
    const rank = lifecycleSortRank(a.lifecycle) - lifecycleSortRank(b.lifecycle);
    if (rank !== 0) return rank;
    const depA = parseDateOnly(a.departure_date)?.getTime() || 0;
    const depB = parseDateOnly(b.departure_date)?.getTime() || 0;
    if (a.lifecycle === "completed") return depB - depA;
    return depA - depB;
  });
}

function buildLinkedBookingCards(sessionBooking, candidates, { secret, heroByShip = {}, now = new Date() } = {}) {
  const linked = filterSecurelyLinkedBookings(sessionBooking, candidates);
  const currentBookingId = String(sessionBooking?.base44_booking_id || sessionBooking?.booking_id || "").trim();
  const currentBookingReference = String(sessionBooking?.booking_reference || "").trim();

  const cards = linked.map((row) => {
    const ship = String(row.cruise_ship || "").trim();
    const hero = heroByShip[ship] || heroByShip[ship.toLowerCase()] || null;
    return toSafeLinkedBookingCard(row, {
      currentBookingId,
      currentBookingReference,
      secret,
      heroImageUrl: hero,
      now
    });
  });

  return sortLinkedBookingCards(cards);
}

/** Reject surname-style enumeration attempts from request bodies. */
function rejectSurnameSearchBody(body) {
  if (!body || typeof body !== "object") return null;
  const keys = Object.keys(body);
  const banned = keys.filter((k) => /surname|last_name|lastname|family_name/i.test(k));
  if (banned.length) {
    return "Surname search is not permitted for linked bookings.";
  }
  return null;
}

module.exports = {
  SWITCH_TOKEN_TTL_MS,
  FORBIDDEN_CARD_KEYS,
  normaliseEmail,
  normaliseMobile,
  travellerIdentityKey,
  bookingIdentityKeys,
  bookingIdentityKey,
  bookingsShareSecureIdentity,
  sameBookingId,
  classifyLifecycle,
  calculateDurationNights,
  createSwitchToken,
  verifySwitchToken,
  toSafeLinkedBookingCard,
  filterSecurelyLinkedBookings,
  sortLinkedBookingCards,
  buildLinkedBookingCards,
  rejectSurnameSearchBody,
  assertCardHasNoSensitiveFields
};
