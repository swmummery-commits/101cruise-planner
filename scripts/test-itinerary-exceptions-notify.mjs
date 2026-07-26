/**
 * Offline tests for itinerary Needs Attention queue + notification dedupe.
 * No live email, no DB writes, no OpenAI.
 * Run: node scripts/test-itinerary-exceptions-notify.mjs
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const {
  upsertItineraryException,
  resolveItineraryExceptionsForBooking,
  dismissItineraryException,
  listOpenItineraryExceptions,
  countOpenItineraryExceptions,
  fingerprintReasons,
  buildAdminReviewPath,
  EXCEPTION_KINDS,
  publicExceptionView
} = require("../netlify/functions/lib/itinerary-exceptions.js");
const {
  notifyItineraryException,
  sendItineraryExceptionDigest,
  buildImmediateEmail,
  absoluteReviewUrl
} = require("../netlify/functions/lib/itinerary-notify.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function makeStore() {
  const state = {
    exceptions: [],
    notifications: [],
    admins: [
      { id: "a1", email: "reviewer-one@example.com", display_name: "Reviewer One", notify_itinerary_exceptions: true, active: true },
      { id: "a2", email: "reviewer-two@example.com", display_name: "Reviewer Two", notify_itinerary_exceptions: true, active: true },
      { id: "a3", email: "other@example.com", display_name: "Other", notify_itinerary_exceptions: false, active: true }
    ]
  };

  async function rest(path, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    if (path.startsWith("admin_users?") && method === "GET") {
      if (path.includes("notify_itinerary_exceptions=eq.true")) {
        return state.admins.filter((a) => a.notify_itinerary_exceptions && a.active);
      }
      return state.admins.filter((a) => a.active);
    }
    if (path.startsWith("itinerary_exceptions?") && method === "GET") {
      let rows = [...state.exceptions];
      if (path.includes("status=eq.open")) rows = rows.filter((r) => r.status === "open");
      const booking = path.match(/booking_id=eq\.([^&]+)/);
      if (booking) rows = rows.filter((r) => r.booking_id === decodeURIComponent(booking[1]));
      const kind = path.match(/exception_kind=eq\.([^&]+)/);
      if (kind) rows = rows.filter((r) => r.exception_kind === decodeURIComponent(kind[1]));
      return rows.slice(0, 200);
    }
    if (path === "itinerary_exceptions" && method === "POST") {
      const payload = JSON.parse(options.body);
      const row = { id: `ex-${state.exceptions.length + 1}`, ...payload };
      state.exceptions.push(row);
      return [row];
    }
    if (path.startsWith("itinerary_exceptions?") && method === "PATCH") {
      const idMatch = path.match(/(?:^|[?&])id=eq\.([^&]+)/);
      const bookingMatch = path.match(/(?:^|[?&])booking_id=eq\.([^&]+)/);
      const requireOpen = path.includes("status=eq.open");
      const payload = JSON.parse(options.body);
      const updated = [];
      state.exceptions = state.exceptions.map((row) => {
        let match = false;
        if (idMatch) match = String(row.id) === decodeURIComponent(idMatch[1]);
        else if (bookingMatch) match = String(row.booking_id) === decodeURIComponent(bookingMatch[1]);
        if (requireOpen && row.status !== "open") match = false;
        if (!match) return row;
        const next = { ...row, ...payload };
        updated.push(next);
        return next;
      });
      return updated;
    }
    if (path.startsWith("itinerary_exception_notifications") && method === "POST") {
      const payload = JSON.parse(options.body);
      state.notifications.push(payload);
      return [payload];
    }
    return [];
  }

  return { rest, state };
}

const basePayload = {
  booking_id: "b44-1",
  booking_reference: "10175811",
  customer_names: "Alex Example",
  cruise_line: "Explora Journeys",
  ship_name: "EXPLORA I",
  departure_date: "2026-09-28",
  source_filename: "confirmation.pdf",
  exception_kind: EXCEPTION_KINDS.REVIEW_REQUIRED,
  concise_reason: "2 unresolved ports",
  reason_codes: ["unresolved_port", "unresolved_port"],
  validation_failures: [
    { code: "unresolved_port", message: "Port could not be resolved" },
    { code: "unresolved_port", message: "Port could not be resolved" }
  ]
};

const store = makeStore();
const first = await upsertItineraryException(store.rest, basePayload);
assert(first.created === true, "review_required creates queue item");
assert(first.should_notify === true, "first create should notify");
assert(first.exception.status === "open", "open status");

const open1 = await listOpenItineraryExceptions(store.rest);
assert(open1.length === 1, "one persistent queue item");
assert((await countOpenItineraryExceptions(store.rest)) === 1, "badge count 1");

// Viewing does not clear — re-list still open
const openAgain = await listOpenItineraryExceptions(store.rest);
assert(openAgain.length === 1, "viewing does not clear");

// Unchanged retry — no new notify
const second = await upsertItineraryException(store.rest, basePayload);
assert(second.created === false, "unchanged upsert updates existing");
assert(second.should_notify === false, "unchanged retry no notify");
assert((await countOpenItineraryExceptions(store.rest)) === 1, "still one item");

// Materially changed reasons → notify again
const changed = await upsertItineraryException(store.rest, {
  ...basePayload,
  concise_reason: "ship match ambiguous",
  reason_codes: ["ambiguous_ship"],
  validation_failures: [{ code: "ambiguous_ship", message: "Ship match ambiguous" }]
});
assert(changed.reason_changed === true, "material reason change detected");
assert(changed.should_notify === true, "changed reasons notify");

// Failed creates separate kind item
const failed = await upsertItineraryException(store.rest, {
  ...basePayload,
  booking_id: "b44-2",
  booking_reference: "99999999",
  exception_kind: EXCEPTION_KINDS.FAILED,
  concise_reason: "extraction failed",
  reason_codes: ["extraction_failed"],
  validation_failures: [{ code: "extraction_failed", message: "boom" }]
});
assert(failed.created === true, "failed creates queue item");
assert((await countOpenItineraryExceptions(store.rest)) === 2, "badge count 2");

// Notifications: first notify sends; unchanged suppressed; email failure keeps exception
let sendCalls = 0;
const sendOk = async ({ to, subject }) => {
  sendCalls += 1;
  assert(to.includes("reviewer-one@example.com"), "recipient from admin_users flag");
  assert(to.includes("reviewer-two@example.com"), "second recipient configured");
  assert(!to.includes("other@example.com"), "non-flagged admin excluded");
  assert(/10175811/.test(subject), "subject has booking ref");
  return { ok: true, provider: "resend" };
};

const n1 = await notifyItineraryException(store.rest, first, {
  recipients: store.state.admins.filter((a) => a.notify_itinerary_exceptions),
  sendImpl: sendOk
});
assert(n1.sent === true, "immediate notification sent");
assert(sendCalls === 1, "one send");

const n2 = await notifyItineraryException(store.rest, second, {
  recipients: store.state.admins.filter((a) => a.notify_itinerary_exceptions),
  sendImpl: sendOk
});
assert(n2.sent === false, "unchanged retry suppressed");
assert(sendCalls === 1, "no duplicate send");

const n3 = await notifyItineraryException(store.rest, changed, {
  recipients: store.state.admins.filter((a) => a.notify_itinerary_exceptions),
  sendImpl: sendOk
});
assert(n3.sent === true, "changed reasons send again");
assert(sendCalls === 2, "second send after reason change");

const failSend = async () => ({ ok: false, skipped: false, provider: "resend", error: "smtp down" });
const nFail = await notifyItineraryException(store.rest, failed, {
  recipients: store.state.admins.filter((a) => a.notify_itinerary_exceptions),
  sendImpl: failSend
});
assert(nFail.sent === false, "email failure reported");
assert(nFail.exception_still_open === true, "email failure does not remove exception");
assert((await countOpenItineraryExceptions(store.rest)) === 2, "queue retained after email failure");
assert(store.state.notifications.some((n) => n.delivery_status === "failed"), "failure recorded");

// Approval removes from unresolved count
await resolveItineraryExceptionsForBooking(store.rest, "b44-1", "approved", "admin");
assert((await countOpenItineraryExceptions(store.rest)) === 1, "approval removes from badge count");

// Digest omits resolved
const digestSends = [];
const digest = await sendItineraryExceptionDigest(store.rest, {
  recipients: store.state.admins.filter((a) => a.notify_itinerary_exceptions),
  sendImpl: async (payload) => {
    digestSends.push(payload);
    return { ok: true, provider: "resend" };
  }
});
assert(digest.sent === true, "digest sent");
assert(digest.count === 1, "digest only unresolved");
assert(!digestSends[0].text.includes("10175811"), "resolved booking omitted from digest");
assert(digestSends[0].text.includes("99999999"), "open failed item in digest");

// Dismiss with reason
const remaining = (await listOpenItineraryExceptions(store.rest))[0];
await dismissItineraryException(store.rest, remaining.id, "Handled offline", "admin");
assert((await countOpenItineraryExceptions(store.rest)) === 0, "dismiss clears badge");

// Direct Admin link
const pathLink = buildAdminReviewPath("10175811");
assert(pathLink.includes("booking-documents"), "admin path includes booking-documents");
assert(pathLink.includes("ref=10175811"), "admin path includes booking ref");
const abs = absoluteReviewUrl(pathLink);
assert(/^https?:\/\//.test(abs), "absolute review URL");
const email = buildImmediateEmail({
  ...basePayload,
  admin_review_path: pathLink,
  exception_kind: "review_required"
});
assert(email.text.includes("Open Admin review:"), "email contains review URL");
assert(email.text.includes("Alex Example"), "email contains customer names");

// Source checks — no hardcoded Steve/Paul emails
const notifySrc = readFileSync(path.join(root, "netlify/functions/lib/itinerary-notify.js"), "utf8");
assert(!/steve@|paul@101cruise|stevem101/i.test(notifySrc), "no hardcoded personal emails in notify");
assert(/notify_itinerary_exceptions/.test(notifySrc), "recipients from admin_users flag");

const adminSrc = readFileSync(path.join(root, "js/admin.js"), "utf8");
assert(/Needs Attention/.test(adminSrc), "queue UI present");
assert(/admin-nav-badge/.test(adminSrc), "nav badge present");
assert(/reviewItineraryException/.test(adminSrc), "review button wired");
assert(/Viewing must not clear/.test(adminSrc) || /does not clear/.test(adminSrc), "view does not clear documented");
assert(/dismissItineraryExceptionItem/.test(adminSrc), "dismiss control present");
assert(/booking-documents\?ref=/.test(adminSrc), "direct admin deep link");

const migration = readFileSync(
  path.join(root, "supabase/migrations/20260726_itinerary_exceptions_notifications.sql"),
  "utf8"
);
assert(/notify_itinerary_exceptions/.test(migration), "migration adds recipient flag");
assert(/itinerary_exception_notifications/.test(migration), "migration adds notification audit");
assert(!/au\.user_id/.test(migration), "exceptions migration must not use au.user_id");
assert(/au\.auth_user_id\s*=\s*auth\.uid\(\)/.test(migration), "exceptions RLS uses auth_user_id");
assert(/au\.active\s*=\s*true/.test(migration), "exceptions RLS uses active");
assert(/assigned_admin_user_id uuid NULL REFERENCES public\.admin_users\(id\)/.test(migration), "assignment FK uuid → admin_users.id");

assert(fingerprintReasons(["a"], "x") === fingerprintReasons(["a"], "x"), "stable reason fingerprint");
assert(fingerprintReasons(["a"], "x") !== fingerprintReasons(["b"], "x"), "different codes different fp");
assert(publicExceptionView(first.exception).admin_review_path, "public view has review path");

console.log("test-itinerary-exceptions-notify: ok");
