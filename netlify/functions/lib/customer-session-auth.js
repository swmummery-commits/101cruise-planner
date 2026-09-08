/**
 * Shared Client Portal HMAC session helpers.
 */
"use strict";

const crypto = require("crypto");

const CUSTOMER_SESSION_VERSION = 2;
const DEFAULT_CUSTOMER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function jsonResponse(statusCode, body, methods = "GET, POST, OPTIONS") {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": methods,
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function createSessionToken(payload, secret) {
  const encoded = base64url(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyToken(token, secret) {
  const [encoded, signature] = String(token || "").split(".");
  if (!encoded || !signature || !secret) return null;
  const expected = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || !payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

function extractBearer(event) {
  const headers = event?.headers || {};
  const auth = headers.authorization || headers.Authorization || "";
  return String(auth).replace(/^Bearer\s+/i, "").trim();
}

function requireCustomerSession(event, secret) {
  const token = extractBearer(event);
  const session = verifyToken(token, secret || process.env.CUSTOMER_SESSION_SECRET || "");
  if (!session?.booking_id || session.v !== CUSTOMER_SESSION_VERSION) return null;
  return session;
}

function mintBookingSessionToken(booking, secret, ttlMs = DEFAULT_CUSTOMER_SESSION_TTL_MS) {
  const bookingId = String(booking.base44_booking_id || booking.booking_id || booking.booking_reference || "");
  const bookingReference = String(booking.booking_reference || "");
  return createSessionToken(
    {
      v: CUSTOMER_SESSION_VERSION,
      booking_id: bookingId,
      booking_reference: bookingReference,
      exp: Date.now() + ttlMs
    },
    secret
  );
}

module.exports = {
  CUSTOMER_SESSION_VERSION,
  DEFAULT_CUSTOMER_SESSION_TTL_MS,
  jsonResponse,
  createSessionToken,
  verifyToken,
  extractBearer,
  requireCustomerSession,
  mintBookingSessionToken
};
