"use strict";

const { supabaseRest } = require("./booking-service");
const {
  jsonResponse,
  requireCustomerSession,
  createSessionToken,
  verifyToken
} = require("./lib/customer-session-auth");
const {
  bookingIdentityKey,
  bookingsShareSecureIdentity,
  classifyLifecycle
} = require("./lib/customer-linked-bookings-core");

const COPY_TOKEN_TTL_MS = 10 * 60 * 1000;
const PROFILE_KEY_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

function cleanProfileKey(value) {
  const key = String(value || "").trim().toLowerCase();
  return PROFILE_KEY_RE.test(key) ? key : "";
}

function isSystemItemKey(value) {
  return /^system:[A-Za-z0-9_-]+$/.test(String(value || ""));
}

function normalisePackingLocation(value) {
  const location = String(value || "").trim().toLowerCase();
  return ["checked", "carry-on", "wearing"].includes(location) ? location : "checked";
}

function parseDateOnly(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const date = new Date(`${raw.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isEarlierCompletedCruise(source, current, now = new Date()) {
  if (classifyLifecycle(source?.departing_date, source?.arriving_date, now) !== "completed") return false;
  const sourceDeparture = parseDateOnly(source?.departing_date);
  const currentDeparture = parseDateOnly(current?.departing_date);
  if (sourceDeparture && currentDeparture) return sourceDeparture.getTime() < currentDeparture.getTime();
  return true;
}

async function loadBookingRow(bookingId) {
  const id = String(bookingId || "").trim();
  if (!id) return null;
  const rows = await supabaseRest(
    `base44_booking_cache?base44_booking_id=eq.${encodeURIComponent(id)}&select=base44_booking_id,booking_reference,passenger1_email,passenger1_mobile,cruise_line,cruise_ship,departing_date,arriving_date&limit=1`
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function loadSecureLinkedRows(current) {
  const identity = bookingIdentityKey(current);
  if (!identity) return [];
  const email = String(current.passenger1_email || "").trim();
  if (!email) return [];
  const rows = await supabaseRest(
    `base44_booking_cache?passenger1_email=eq.${encodeURIComponent(email)}&select=base44_booking_id,booking_reference,passenger1_email,passenger1_mobile,cruise_line,cruise_ship,departing_date,arriving_date&limit=50`
  );
  return (Array.isArray(rows) ? rows : []).filter((row) => bookingsShareSecureIdentity(current, row));
}

async function loadSelectedPackingRows(bookingId, profileKey) {
  const rows = await supabaseRest(
    `customer_packing_state?booking_id=eq.${encodeURIComponent(bookingId)}&profile_key=eq.${encodeURIComponent(profileKey)}&quantity=gt.0&select=item_key,quantity,packing_location`
  );
  return (Array.isArray(rows) ? rows : []).filter(
    (row) => isSystemItemKey(row.item_key) && Number(row.quantity) > 0
  );
}

function createCopyToken({ currentBookingId, sourceBookingId, profileKey, secret }) {
  return createSessionToken(
    {
      typ: "packing-copy",
      sid: String(currentBookingId),
      src: String(sourceBookingId),
      pk: profileKey,
      exp: Date.now() + COPY_TOKEN_TTL_MS
    },
    secret
  );
}

function verifyCopyToken(token, secret, currentBookingId) {
  const payload = verifyToken(token, secret);
  if (!payload || payload.typ !== "packing-copy") return null;
  if (String(payload.sid) !== String(currentBookingId)) return null;
  if (!payload.src || !cleanProfileKey(payload.pk)) return null;
  return payload;
}

function safeSourceCard(row, selectedCount, token) {
  return {
    copy_token: token,
    booking_reference: row.booking_reference || null,
    cruise_line: row.cruise_line || null,
    ship_name: row.cruise_ship || null,
    departure_date: row.departing_date || null,
    arrival_date: row.arriving_date || null,
    selected_count: selectedCount
  };
}

async function listSources(session, secret, profileKey) {
  const current = await loadBookingRow(session.booking_id);
  if (!current || !bookingIdentityKey(current)) return [];

  const linked = await loadSecureLinkedRows(current);
  const prior = linked
    .filter((row) => String(row.base44_booking_id || "") !== String(session.booking_id))
    .filter((row) => isEarlierCompletedCruise(row, current))
    .sort((a, b) => {
      const dateA = parseDateOnly(a.departing_date)?.getTime() || 0;
      const dateB = parseDateOnly(b.departing_date)?.getTime() || 0;
      return dateB - dateA;
    });

  const candidates = await Promise.all(
    prior.map(async (row) => {
      const state = await loadSelectedPackingRows(row.base44_booking_id, profileKey);
      if (!state.length) return null;
      return safeSourceCard(
        row,
        state.length,
        createCopyToken({
          currentBookingId: session.booking_id,
          sourceBookingId: row.base44_booking_id,
          profileKey,
          secret
        })
      );
    })
  );

  return candidates.filter(Boolean);
}

async function copyPackingList(session, secret, copyToken) {
  const token = verifyCopyToken(copyToken, secret, session.booking_id);
  if (!token) {
    const error = new Error("That previous cruise is no longer available to copy.");
    error.statusCode = 403;
    throw error;
  }

  const profileKey = cleanProfileKey(token.pk);
  const [current, source] = await Promise.all([
    loadBookingRow(session.booking_id),
    loadBookingRow(token.src)
  ]);

  if (
    !current ||
    !source ||
    !bookingIdentityKey(current) ||
    !bookingsShareSecureIdentity(current, source) ||
    !isEarlierCompletedCruise(source, current)
  ) {
    const error = new Error("That previous cruise is no longer available to copy.");
    error.statusCode = 403;
    throw error;
  }

  const [sourceRows, destinationRows] = await Promise.all([
    loadSelectedPackingRows(source.base44_booking_id, profileKey),
    supabaseRest(
      `customer_packing_state?booking_id=eq.${encodeURIComponent(session.booking_id)}&profile_key=eq.${encodeURIComponent(profileKey)}&select=item_key,quantity`
    )
  ]);

  const destinationSelected = new Set(
    (Array.isArray(destinationRows) ? destinationRows : [])
      .filter((row) => Number(row.quantity) > 0)
      .map((row) => String(row.item_key))
  );

  const now = new Date().toISOString();
  const toCopy = sourceRows
    .filter((row) => !destinationSelected.has(String(row.item_key)))
    .map((row) => ({
      booking_id: String(session.booking_id),
      profile_key: profileKey,
      item_key: String(row.item_key),
      quantity: Math.max(1, Math.round(Number(row.quantity) || 1)),
      packed: false,
      packing_location: normalisePackingLocation(row.packing_location),
      packed_at: null,
      updated_at: now
    }));

  if (toCopy.length) {
    await supabaseRest("customer_packing_state?on_conflict=booking_id,profile_key,item_key", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(toCopy)
    });
  }

  return {
    copied_count: toCopy.length,
    existing_count: sourceRows.length - toCopy.length,
    source: {
      booking_reference: source.booking_reference || null,
      cruise_line: source.cruise_line || null,
      ship_name: source.cruise_ship || null,
      departure_date: source.departing_date || null
    }
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return jsonResponse(200, {});
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { success: false, error: "Method not allowed" });
  }

  try {
    const secret = process.env.CUSTOMER_SESSION_SECRET || "";
    if (!secret) {
      return jsonResponse(500, {
        success: false,
        error: "Customer access is not fully configured."
      });
    }

    const session = requireCustomerSession(event, secret);
    if (!session) {
      return jsonResponse(401, {
        success: false,
        error: "Your booking session has expired. Please access My Cruise again."
      });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      body = {};
    }

    if (body.action === "sources") {
      const profileKey = cleanProfileKey(body.profile_key);
      if (!profileKey || profileKey === "cabin") {
        return jsonResponse(400, { success: false, error: "A traveller is required." });
      }
      const sources = await listSources(session, secret, profileKey);
      return jsonResponse(200, {
        success: true,
        sources,
        can_copy: sources.length > 0
      });
    }

    if (body.action === "copy") {
      const copyToken = String(body.copy_token || "").trim();
      if (!copyToken) {
        return jsonResponse(400, { success: false, error: "Choose a previous cruise first." });
      }
      const result = await copyPackingList(session, secret, copyToken);
      return jsonResponse(200, { success: true, ...result });
    }

    return jsonResponse(400, { success: false, error: "Unsupported action" });
  } catch (error) {
    console.error("customer-packing-copy error", error);
    const statusCode = Number(error?.statusCode) || 500;
    return jsonResponse(statusCode, {
      success: false,
      error:
        statusCode === 500
          ? "We couldn’t copy that packing list just now. Please try again."
          : error.message
    });
  }
};
