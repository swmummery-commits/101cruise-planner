/**
 * Shared safe Base44 ↔ 101cruise booking field contract.
 *
 * Explicit whitelists only — never spread a full CruiseBooking object
 * (passports, addresses, notes, commissions, etc. must stay out).
 *
 * Dual export: CommonJS (Node) + browser global Base44BookingFieldContract.
 *
 * Base44 function changes (getBookingFor101Cruise / pushBookingTo101Cruise)
 * should import or mirror these lists. Source of those functions lives in
 * Base44, not this repo.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Base44BookingFieldContract = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /**
   * Field semantics (CruiseBooking form / CRM UI — CD5Q25 verified):
   *
   * cruise_price_usd          — total cruise price (scheduled)
   * cruise_deposit            — deposit amount RECEIVED (when paired with date)
   * cruise_deposit_date       — actual deposit payment-received date
   * reminder_deposit_due      — deposit REMINDER only
   * deposit_due_date          — deposit due date (schedule; often null)
   * cruise_payment_2          — final instalment AMOUNT SCHEDULED (not received)
   * cruise_payment_2_date     — final instalment DUE date (not received)
   * cruise_payment_3          — optional further SCHEDULED amount
   * cruise_payment_3_date     — optional further DUE date
   * reminder_final_payment_due— final-payment REMINDER only
   * final_payment_due_date    — stored final due (often null; do not alias reminder here)
   * fully_paid_date           — authoritative fully-paid received date (null ⇒ not fully paid)
   * extra_payment_due_date    — optional extra due
   * reminder_extra_payment_due— optional extra reminder
   * booking_date              — booking created/sold date
   *
   * BUG (current getBookingFor101Cruise):
   *   amount_paid = cruise_deposit + cruise_payment_2 + cruise_payment_3
   *   treats scheduled instalments as received → false fully_paid.
   *   Also maps reminder_final_payment_due → API final_payment_due_date.
   */

  /** Safe identity / cruise summary fields for pull + push. */
  const SAFE_BOOKING_CORE_FIELDS = [
    "base44_booking_id",
    "booking_reference",
    "booking_status",
    "booking_date",
    "cruise_line",
    "cruise_ship",
    "departing_date",
    "arriving_date",
    "departing_port",
    "arriving_port",
    "cruise_duration",
    "room_number",
    "room_type",
    "category_class",
    "adult_count",
    "child_count",
    "infant_count",
    "total_passengers",
    "passenger1_first_name",
    "passenger1_last_name",
    "passenger1_email",
    "passenger1_mobile",
    "passenger1_type",
    "passenger2_first_name",
    "passenger2_last_name",
    "passenger2_email",
    "passenger2_mobile",
    "passenger2_type",
    "inclusions"
  ];

  /**
   * Payment fields that MUST be on the pull whitelist (raw Base44 names).
   * Do not derive amount_paid by summing scheduled instalments.
   */
  const SAFE_PAYMENT_PULL_RAW_FIELDS = [
    "cruise_price_usd",
    "cruise_deposit",
    "cruise_deposit_date",
    "cruise_payment_2",
    "cruise_payment_2_date",
    "cruise_payment_3",
    "cruise_payment_3_date",
    "fully_paid_date",
    "deposit_due_date",
    "extra_payment_due_date",
    "final_payment_due_date",
    "reminder_deposit_due",
    "reminder_final_payment_due",
    "reminder_extra_payment_due"
  ];

  /**
   * Explicit normalised aliases the pull function should also emit
   * (unambiguous; never put a reminder into final_payment_due_date).
   */
  const SAFE_PAYMENT_PULL_NORMALISED_FIELDS = [
    "deposit_amount",
    "deposit_paid_date",
    "payment_2_amount",
    "payment_2_due_date",
    "payment_3_amount",
    "payment_3_due_date",
    "final_payment_due_date",
    "final_payment_reminder_date",
    "amount_received",
    "balance_owing",
    "payment_status"
  ];

  /** Push whitelist: keep cache accurate without sensitive private data. */
  const SAFE_PUSH_FIELDS = [
    "base44_booking_id",
    "booking_reference",
    "booking_status",
    "booking_date",
    "cruise_line",
    "cruise_ship",
    "departing_date",
    "arriving_date",
    "departing_port",
    "arriving_port",
    "cruise_duration",
    "room_number",
    "room_type",
    "category_class",
    "adult_count",
    "child_count",
    "infant_count",
    "total_passengers",
    "passenger1_first_name",
    "passenger1_last_name",
    "passenger1_email",
    "passenger1_mobile",
    "passenger2_first_name",
    "passenger2_last_name",
    "passenger2_email",
    "passenger2_mobile",
    "cruise_price_usd",
    "cruise_deposit",
    "cruise_deposit_date",
    "cruise_payment_2",
    "cruise_payment_2_date",
    "cruise_payment_3",
    "cruise_payment_3_date",
    "fully_paid_date",
    "deposit_due_date",
    "extra_payment_due_date",
    "final_payment_due_date",
    "reminder_deposit_due",
    "reminder_final_payment_due",
    "reminder_extra_payment_due",
    "deposit_amount",
    "deposit_paid_date",
    "payment_2_amount",
    "payment_2_due_date",
    "payment_3_amount",
    "payment_3_due_date",
    "final_payment_reminder_date",
    "amount_received",
    "balance_owing",
    "payment_status"
  ];

  /** Never include these (or any unrestricted entity spread). */
  const FORBIDDEN_SENSITIVE_FIELDS = [
    "passenger1_passport",
    "passenger1_passport_exp_date",
    "passenger1_passport_country",
    "passenger1_birthdate",
    "passenger1_middle_name",
    "passenger2_passport",
    "passenger2_passport_exp_date",
    "passenger2_passport_country",
    "passenger2_birthdate",
    "passenger2_middle_name",
    "address",
    "home_address",
    "notes",
    "internal_notes",
    "agent_notes",
    "commission",
    "commission_amount",
    "commission_percent"
  ];

  const MONEY_EPS = 0.02;

  function parseMoney(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const text = String(value).trim();
    if (!text) return null;
    const digits = text.replace(/[^0-9.-]/g, "");
    if (!digits || digits === "-" || digits === "." || digits === "-.") return null;
    const n = Number(digits);
    return Number.isFinite(n) ? n : null;
  }

  function parseDate(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (!text) return null;
    const m = text.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!m) return null;
    const d = new Date(`${m[1]}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : m[1];
  }

  function nearlyEqual(a, b) {
    if (a == null || b == null) return false;
    return Math.abs(a - b) <= MONEY_EPS;
  }

  function pick(source, keys) {
    const out = {};
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        out[key] = source[key];
      }
    }
    return out;
  }

  /**
   * Derive unambiguous payment fields from a raw CruiseBooking (or API) object.
   * Display-only safe — does not mutate Base44.
   */
  function derivePaymentFields(booking = {}) {
    const price = parseMoney(booking.cruise_price_usd);
    const depositAmount = parseMoney(booking.cruise_deposit ?? booking.deposit_amount);
    const depositPaidDate = parseDate(
      booking.cruise_deposit_date ?? booking.deposit_paid_date ?? booking.deposit_payment_date
    );
    const payment2Amount = parseMoney(booking.cruise_payment_2 ?? booking.payment_2_amount);
    const payment2DueDate = parseDate(
      booking.cruise_payment_2_date ?? booking.payment_2_due_date
    );
    const payment3Amount = parseMoney(booking.cruise_payment_3 ?? booking.payment_3_amount);
    const payment3DueDate = parseDate(
      booking.cruise_payment_3_date ?? booking.payment_3_due_date
    );
    const fullyPaidDate = parseDate(booking.fully_paid_date);
    const depositDueDate = parseDate(booking.deposit_due_date);
    const storedFinalDue = parseDate(booking.final_payment_due_date);
    const reminderDeposit = parseDate(booking.reminder_deposit_due);
    const reminderFinal = parseDate(
      booking.reminder_final_payment_due ?? booking.final_payment_reminder_date
    );

    // Authoritative final due = instalment due date, then stored due.
    // Never use reminder as final_payment_due_date.
    let finalPaymentDueDate = payment2DueDate || payment3DueDate || storedFinalDue || null;
    if (finalPaymentDueDate && reminderFinal && finalPaymentDueDate === reminderFinal && payment2DueDate) {
      finalPaymentDueDate = payment2DueDate;
    }
    // Legacy bug: API put reminder into final_payment_due_date with no payment_2_date.
    if (
      !payment2DueDate &&
      storedFinalDue &&
      reminderFinal &&
      storedFinalDue === reminderFinal
    ) {
      finalPaymentDueDate = null; // unknown due; reminder kept separately
    } else if (!payment2DueDate && storedFinalDue && !reminderFinal) {
      finalPaymentDueDate = storedFinalDue;
    } else if (payment2DueDate) {
      finalPaymentDueDate = payment2DueDate;
    }

    let amountReceived = null;
    if (depositAmount != null && depositAmount > MONEY_EPS && depositPaidDate) {
      amountReceived = depositAmount;
    } else if (booking.amount_received != null) {
      amountReceived = parseMoney(booking.amount_received);
    }

    // Detect legacy false amount_paid = sum of deposit + scheduled instalments.
    const legacyAmountPaid = parseMoney(booking.amount_paid);
    const scheduledSum =
      (depositAmount || 0) + (payment2Amount || 0) + (payment3Amount || 0);
    const legacySummedInstalments =
      legacyAmountPaid != null &&
      price != null &&
      nearlyEqual(legacyAmountPaid, scheduledSum) &&
      payment2Amount != null &&
      payment2Amount > MONEY_EPS &&
      !fullyPaidDate;

    if (legacySummedInstalments) {
      // Ignore false amount_paid; keep deposit-only received when dated.
      if (amountReceived == null && depositPaidDate && depositAmount != null) {
        amountReceived = depositAmount;
      }
    } else if (
      amountReceived == null &&
      legacyAmountPaid != null &&
      depositAmount != null &&
      nearlyEqual(legacyAmountPaid, depositAmount)
    ) {
      amountReceived = depositAmount;
    }

    let balanceOwing = null;
    if (fullyPaidDate && price != null) {
      balanceOwing = 0;
      amountReceived = amountReceived != null ? amountReceived : price;
    } else if (payment2Amount != null && payment2Amount > MONEY_EPS && !fullyPaidDate) {
      // Scheduled final instalment is still owing unless fully paid.
      balanceOwing = payment2Amount + (payment3Amount && payment3Amount > MONEY_EPS ? payment3Amount : 0);
    } else if (price != null && amountReceived != null) {
      balanceOwing = Math.max(0, price - amountReceived);
    } else {
      const rawBalance = parseMoney(booking.balance_owing);
      // Do not trust zero balance when fully_paid_date is null and instalments exist.
      if (rawBalance != null && !(rawBalance === 0 && payment2Amount > MONEY_EPS && !fullyPaidDate)) {
        balanceOwing = rawBalance;
      }
    }

    let paymentStatus = "unknown";
    if (fullyPaidDate || (balanceOwing === 0 && amountReceived != null && price != null && nearlyEqual(amountReceived, price))) {
      paymentStatus = "fully_paid";
      balanceOwing = 0;
    } else if (
      depositPaidDate &&
      depositAmount != null &&
      depositAmount > MONEY_EPS &&
      balanceOwing != null &&
      balanceOwing > MONEY_EPS
    ) {
      paymentStatus = "deposit_paid_balance_outstanding";
    } else if (balanceOwing != null && balanceOwing > MONEY_EPS) {
      paymentStatus = "payment_outstanding";
    }

    return {
      cruise_price_usd: price,
      deposit_amount: depositAmount,
      deposit_paid_date: depositPaidDate,
      payment_2_amount: payment2Amount,
      payment_2_due_date: payment2DueDate,
      payment_3_amount: payment3Amount,
      payment_3_due_date: payment3DueDate,
      final_payment_due_date: finalPaymentDueDate,
      final_payment_reminder_date: reminderFinal,
      deposit_due_date: depositDueDate,
      reminder_deposit_due: reminderDeposit,
      fully_paid_date: fullyPaidDate,
      amount_received: amountReceived,
      balance_owing: balanceOwing,
      payment_status: paymentStatus,
      // Legacy raw passthrough names for compatibility
      cruise_deposit: depositAmount,
      cruise_deposit_date: depositPaidDate,
      cruise_payment_2: payment2Amount,
      cruise_payment_2_date: payment2DueDate,
      cruise_payment_3: payment3Amount,
      cruise_payment_3_date: payment3DueDate,
      reminder_final_payment_due: reminderFinal,
      _meta: {
        legacy_summed_instalments_ignored: Boolean(legacySummedInstalments),
        reminder_not_used_as_due: Boolean(reminderFinal && finalPaymentDueDate !== reminderFinal)
      }
    };
  }

  function buildPullPayload(booking = {}, documents = undefined) {
    const core = pick(booking, SAFE_BOOKING_CORE_FIELDS);
    const rawPayment = pick(booking, SAFE_PAYMENT_PULL_RAW_FIELDS);
    const derived = derivePaymentFields({ ...booking, ...rawPayment });
    const normalised = pick(derived, SAFE_PAYMENT_PULL_NORMALISED_FIELDS);
    const payload = {
      ...core,
      ...rawPayment,
      ...normalised,
      // Keep raw instalment/date names for portal normaliser compatibility.
      // Always prefer derived due/reminder/received semantics over raw aliases.
      cruise_deposit: derived.cruise_deposit,
      cruise_deposit_date: derived.cruise_deposit_date,
      cruise_payment_2: derived.cruise_payment_2,
      cruise_payment_2_date: derived.cruise_payment_2_date,
      cruise_payment_3: derived.cruise_payment_3,
      cruise_payment_3_date: derived.cruise_payment_3_date,
      reminder_deposit_due: derived.reminder_deposit_due,
      reminder_final_payment_due: derived.reminder_final_payment_due,
      fully_paid_date: derived.fully_paid_date,
      cruise_price_usd: derived.cruise_price_usd,
      final_payment_due_date: derived.final_payment_due_date,
      final_payment_reminder_date: derived.final_payment_reminder_date,
      amount_received: derived.amount_received,
      balance_owing: derived.balance_owing,
      payment_status: derived.payment_status
    };
    if (documents !== undefined) payload.documents = documents;
    for (const bad of FORBIDDEN_SENSITIVE_FIELDS) {
      delete payload[bad];
    }
    return payload;
  }

  function buildPushPayload(booking = {}) {
    const derived = derivePaymentFields(booking);
    const merged = { ...booking, ...derived };
    const payload = pick(merged, SAFE_PUSH_FIELDS);
    for (const bad of FORBIDDEN_SENSITIVE_FIELDS) {
      delete payload[bad];
    }
    return payload;
  }

  return {
    SAFE_BOOKING_CORE_FIELDS,
    SAFE_PAYMENT_PULL_RAW_FIELDS,
    SAFE_PAYMENT_PULL_NORMALISED_FIELDS,
    SAFE_PUSH_FIELDS,
    FORBIDDEN_SENSITIVE_FIELDS,
    derivePaymentFields,
    buildPullPayload,
    buildPushPayload,
    parseMoney,
    parseDate,
    MONEY_EPS
  };
});
