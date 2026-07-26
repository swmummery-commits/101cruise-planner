/**
 * Itinerary exception notifications.
 *
 * Email provider: optional Resend (RESEND_API_KEY).
 * Recipients: admin_users.notify_itinerary_exceptions = true (no hardcoded personal emails).
 *
 * Failsafe: email failures are recorded; Admin queue is never cleared by notify failures.
 */

"use strict";

const {
  listOpenItineraryExceptions,
  fingerprintReasons
} = require("./itinerary-exceptions");

function nowIso() {
  return new Date().toISOString();
}

function siteOrigin() {
  return String(process.env.URL || process.env.DEPLOY_PRIME_URL || "https://admirable-tiramisu-d4da8a.netlify.app").replace(
    /\/$/,
    ""
  );
}

function absoluteReviewUrl(pathOrRef) {
  const origin = siteOrigin();
  if (!pathOrRef) return `${origin}/admin.html#booking-documents`;
  if (String(pathOrRef).startsWith("http")) return pathOrRef;
  if (String(pathOrRef).startsWith("/")) return `${origin}${pathOrRef}`;
  return `${origin}/admin.html#booking-documents?ref=${encodeURIComponent(pathOrRef)}`;
}

/**
 * Load configured review recipients from admin_users (not hardcoded emails in source).
 */
async function loadItineraryReviewRecipients(rest) {
  const rows = await rest(
    "admin_users?notify_itinerary_exceptions=eq.true&active=eq.true&select=id,email,display_name&order=email.asc&limit=50",
    { method: "GET" }
  ).catch(() => []);
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      id: row.id,
      email: String(row.email || "").trim().toLowerCase(),
      display_name: row.display_name || null
    }))
    .filter((row) => row.email && row.email.includes("@"));
}

async function sendViaResend({ to, subject, text, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.ITINERARY_ALERT_FROM_EMAIL || process.env.RESEND_FROM_EMAIL;
  if (!apiKey) {
    return { ok: false, skipped: true, provider: "resend", error: "RESEND_API_KEY not configured" };
  }
  if (!from) {
    return {
      ok: false,
      skipped: true,
      provider: "resend",
      error: "ITINERARY_ALERT_FROM_EMAIL / RESEND_FROM_EMAIL not configured"
    };
  }
  if (!to.length) {
    return { ok: false, skipped: true, provider: "resend", error: "No itinerary review recipients configured" };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      text,
      html: html || undefined
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      skipped: false,
      provider: "resend",
      error: data?.message || `Resend HTTP ${response.status}`
    };
  }
  return { ok: true, skipped: false, provider: "resend", id: data?.id || null };
}

function buildImmediateEmail(exception) {
  const reviewUrl = absoluteReviewUrl(exception.admin_review_path || exception.booking_reference);
  const failures = Array.isArray(exception.validation_failures) ? exception.validation_failures : [];
  const reasonLines = failures.length
    ? failures.map((f) => `- ${f.code || "issue"}: ${f.message || ""}`).join("\n")
    : `- ${exception.concise_reason || "review required"}`;

  const subject = `[101cruise] Itinerary needs attention — ${exception.booking_reference || exception.booking_id}`;
  const text = [
    "An itinerary exception requires review.",
    "",
    `Booking reference: ${exception.booking_reference || "—"}`,
    `Customer: ${exception.customer_names || "—"}`,
    `Cruise: ${[exception.cruise_line, exception.ship_name].filter(Boolean).join(" · ") || "—"}`,
    `Departure: ${exception.departure_date || "—"}`,
    `Status: ${exception.exception_kind}`,
    `Source: ${exception.source_filename || "—"}`,
    "",
    "Review reasons:",
    reasonLines,
    "",
    `Open Admin review: ${reviewUrl}`,
    "",
    "Viewing this alert does not clear the Needs Attention queue."
  ].join("\n");

  return { subject, text, reviewUrl };
}

async function recordNotification(rest, payload) {
  try {
    await rest("itinerary_exception_notifications", {
      method: "POST",
      prefer: "return=minimal",
      body: JSON.stringify(payload)
    });
  } catch (error) {
    console.warn("[itinerary-notify] failed to record notification", error.message || error);
  }
}

/**
 * Send immediate alert if should_notify. Dedupes unchanged fingerprints.
 */
async function notifyItineraryException(rest, upsertResult, options = {}) {
  const exception = upsertResult?.exception;
  if (!exception) return { sent: false, reason: "missing_exception" };
  if (!upsertResult.should_notify && !options.force) {
    return { sent: false, reason: "unchanged_retry_suppressed" };
  }

  // Extra guard: if last notified fingerprint matches, skip
  if (
    !options.force &&
    exception.last_notified_fingerprint &&
    exception.last_notified_fingerprint === exception.reason_fingerprint
  ) {
    return { sent: false, reason: "fingerprint_already_notified" };
  }

  const recipients = options.recipients || (await loadItineraryReviewRecipients(rest));
  const emails = recipients.map((r) => r.email);
  const { subject, text } = buildImmediateEmail(exception);

  let delivery;
  try {
    delivery = options.sendImpl
      ? await options.sendImpl({ to: emails, subject, text })
      : await sendViaResend({ to: emails, subject, text });
  } catch (error) {
    delivery = { ok: false, skipped: false, provider: "resend", error: error.message || String(error) };
  }

  const deliveryStatus = delivery.ok ? "sent" : delivery.skipped ? "skipped" : "failed";
  await recordNotification(rest, {
    exception_id: exception.id,
    booking_id: exception.booking_id,
    booking_reference: exception.booking_reference,
    channel: "email",
    notification_type: "immediate",
    reason_fingerprint: exception.reason_fingerprint,
    recipients: recipients,
    subject,
    body_text: text,
    delivery_status: deliveryStatus,
    delivery_error: delivery.error || null,
    provider: delivery.provider || null,
    created_at: nowIso()
  });

  // Always patch exception audit fields — even on email failure (failsafe).
  try {
    await rest(`itinerary_exceptions?id=eq.${encodeURIComponent(exception.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        last_notified_at: delivery.ok ? nowIso() : exception.last_notified_at || null,
        last_notified_fingerprint: delivery.ok ? exception.reason_fingerprint : exception.last_notified_fingerprint,
        last_email_status: deliveryStatus,
        last_email_error: delivery.error || null,
        updated_at: nowIso()
      })
    });
  } catch (error) {
    console.warn("[itinerary-notify] failed to patch exception email status", error.message || error);
  }

  return {
    sent: Boolean(delivery.ok),
    delivery_status: deliveryStatus,
    error: delivery.error || null,
    recipients: emails,
    exception_still_open: true
  };
}

/**
 * Consolidated daily digest of unresolved exceptions.
 */
async function sendItineraryExceptionDigest(rest, options = {}) {
  const open = await listOpenItineraryExceptions(rest);
  const recipients = options.recipients || (await loadItineraryReviewRecipients(rest));
  const emails = recipients.map((r) => r.email);

  if (!open.length) {
    await recordNotification(rest, {
      exception_id: null,
      booking_id: null,
      booking_reference: null,
      channel: "email",
      notification_type: "digest",
      reason_fingerprint: fingerprintReasons(["empty"], "no unresolved"),
      recipients,
      subject: "[101cruise] Itinerary exceptions digest — none unresolved",
      body_text: "No unresolved itinerary exceptions.",
      delivery_status: "skipped",
      delivery_error: "no_open_exceptions",
      provider: null,
      created_at: nowIso()
    });
    return { sent: false, reason: "no_open_exceptions", count: 0 };
  }

  const lines = open.map((row, i) => {
    const url = absoluteReviewUrl(row.admin_review_path || row.booking_reference);
    return [
      `${i + 1}. ${row.booking_reference || row.booking_id} — ${row.exception_kind}`,
      `   ${row.customer_names || "Customer unknown"} · ${[row.cruise_line, row.ship_name].filter(Boolean).join(" · ")}`,
      `   Departs ${row.departure_date || "—"} · Waiting ${row.awaiting_label}`,
      `   ${row.concise_reason || "review required"}`,
      `   ${url}`
    ].join("\n");
  });

  const subject = `[101cruise] ${open.length} itinerary exception${open.length === 1 ? "" : "s"} need attention`;
  const text = ["Daily digest — unresolved itinerary exceptions:", "", ...lines, "", "Resolved items are omitted automatically."].join(
    "\n"
  );

  let delivery;
  try {
    delivery = options.sendImpl
      ? await options.sendImpl({ to: emails, subject, text })
      : await sendViaResend({ to: emails, subject, text });
  } catch (error) {
    delivery = { ok: false, skipped: false, provider: "resend", error: error.message || String(error) };
  }

  const deliveryStatus = delivery.ok ? "sent" : delivery.skipped ? "skipped" : "failed";
  await recordNotification(rest, {
    exception_id: null,
    booking_id: null,
    booking_reference: null,
    channel: "email",
    notification_type: "digest",
    reason_fingerprint: fingerprintReasons(
      open.map((o) => o.reason_fingerprint),
      `digest:${open.length}`
    ),
    recipients,
    subject,
    body_text: text,
    delivery_status: deliveryStatus,
    delivery_error: delivery.error || null,
    provider: delivery.provider || null,
    created_at: nowIso()
  });

  return {
    sent: Boolean(delivery.ok),
    delivery_status: deliveryStatus,
    error: delivery.error || null,
    count: open.length,
    open_ids: open.map((o) => o.id)
  };
}

module.exports = {
  loadItineraryReviewRecipients,
  notifyItineraryException,
  sendItineraryExceptionDigest,
  sendViaResend,
  buildImmediateEmail,
  absoluteReviewUrl,
  siteOrigin
};
