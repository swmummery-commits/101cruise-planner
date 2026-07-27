/**
 * Shared Base44 booking finance helper.
 *
 * Canonical source of truth for getBookingFor101Cruise / pushBookingTo101Cruise.
 * Mirrors js/base44-booking-field-contract.js — keep both aligned.
 *
 * IMPORTANT:
 * - cruise_payment_2 / cruise_payment_3 are SCHEDULED amounts, never received money.
 * - Do not auto-stamp fully_paid_date from deposit + scheduled instalments.
 * - This helper does not mutate CruiseBooking entity records by itself.
 */

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

function scheduledInstalmentsHaveIndependentReceipt(payment2Amount, payment3Amount, booking = {}) {
  const need2 = payment2Amount != null && payment2Amount > MONEY_EPS;
  const need3 = payment3Amount != null && payment3Amount > MONEY_EPS;
  if (!need2 && !need3) return true;

  const p2Recv = parseMoney(booking.payment_2_received_amount);
  const p3Recv = parseMoney(booking.payment_3_received_amount);
  const finalRecv = parseMoney(booking.final_payment_received_amount);
  const scheduledTotal = (need2 ? payment2Amount : 0) + (need3 ? payment3Amount : 0);

  let covered2 = !need2;
  let covered3 = !need3;
  if (need2 && p2Recv != null && p2Recv + MONEY_EPS >= payment2Amount) covered2 = true;
  if (need3 && p3Recv != null && p3Recv + MONEY_EPS >= payment3Amount) covered3 = true;
  if (finalRecv != null && finalRecv + MONEY_EPS >= scheduledTotal) {
    covered2 = true;
    covered3 = true;
  }
  return covered2 && covered3;
}

function isContradictoryFullyPaid(booking = {}) {
  const price = parseMoney(booking.cruise_price_usd);
  const depositAmount = parseMoney(booking.cruise_deposit ?? booking.deposit_amount);
  const payment2Amount = parseMoney(booking.cruise_payment_2 ?? booking.payment_2_amount);
  const payment3Amount = parseMoney(booking.cruise_payment_3 ?? booking.payment_3_amount);
  const fullyPaidDate = parseDate(booking.fully_paid_date);
  const statusRaw = String(booking.payment_status || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  const claimsFullyPaid = Boolean(fullyPaidDate) || statusRaw === "fully_paid";
  const scheduledInstalments =
    (payment2Amount != null && payment2Amount > MONEY_EPS ? payment2Amount : 0) +
    (payment3Amount != null && payment3Amount > MONEY_EPS ? payment3Amount : 0);
  const depositLessThanPrice =
    depositAmount != null && price != null && depositAmount + MONEY_EPS < price;

  if (!claimsFullyPaid || scheduledInstalments <= MONEY_EPS || !depositLessThanPrice) {
    return false;
  }
  return !scheduledInstalmentsHaveIndependentReceipt(payment2Amount, payment3Amount, booking);
}

/**
 * Derive safe integration payment fields from a CruiseBooking-like object.
 * Never counts scheduled instalments as received.
 */
function deriveBookingFinance(booking = {}) {
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
  const rawFullyPaidDate = parseDate(booking.fully_paid_date);
  const reminderFinal = parseDate(
    booking.reminder_final_payment_due ?? booking.final_payment_reminder_date
  );
  const statusRaw = String(booking.payment_status || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  const scheduledInstalments =
    (payment2Amount != null && payment2Amount > MONEY_EPS ? payment2Amount : 0) +
    (payment3Amount != null && payment3Amount > MONEY_EPS ? payment3Amount : 0);
  const hasScheduledOutstanding = scheduledInstalments > MONEY_EPS;
  const contradictory = isContradictoryFullyPaid(booking);
  const independentReceipt = scheduledInstalmentsHaveIndependentReceipt(
    payment2Amount,
    payment3Amount,
    booking
  );
  const effectiveFullyPaidDate = contradictory ? null : rawFullyPaidDate;

  // Authoritative final due = instalment due date. Never use reminder dates.
  const finalPaymentDueDate = payment2DueDate || payment3DueDate || null;

  let amountReceived = null;
  if (depositAmount != null && depositAmount > MONEY_EPS && depositPaidDate) {
    amountReceived = depositAmount;
  } else if (booking.amount_received != null && !contradictory) {
    amountReceived = parseMoney(booking.amount_received);
  }

  // Detect legacy false amount_paid = deposit + scheduled instalments.
  const legacyAmountPaid = parseMoney(booking.amount_paid);
  const scheduledSum =
    (depositAmount || 0) + (payment2Amount || 0) + (payment3Amount || 0);
  const legacySummedInstalments =
    legacyAmountPaid != null &&
    price != null &&
    nearlyEqual(legacyAmountPaid, scheduledSum) &&
    hasScheduledOutstanding &&
    !effectiveFullyPaidDate;

  if ((contradictory || legacySummedInstalments) && depositAmount != null && depositAmount > MONEY_EPS) {
    amountReceived = depositAmount;
  }

  let balanceOwing = null;
  if (contradictory && hasScheduledOutstanding) {
    balanceOwing = scheduledInstalments;
    if (depositAmount != null && depositAmount > MONEY_EPS) amountReceived = depositAmount;
  } else if (effectiveFullyPaidDate && (!hasScheduledOutstanding || independentReceipt)) {
    balanceOwing = 0;
    amountReceived = amountReceived != null ? amountReceived : price;
  } else if (hasScheduledOutstanding) {
    balanceOwing = scheduledInstalments;
  } else if (price != null && amountReceived != null) {
    balanceOwing = Math.max(0, price - amountReceived);
  } else {
    const rawBalance = parseMoney(booking.balance_owing);
    if (rawBalance != null && !(rawBalance === 0 && hasScheduledOutstanding && !effectiveFullyPaidDate)) {
      balanceOwing = rawBalance;
    }
  }

  let paymentStatus = "unknown";
  if (
    (effectiveFullyPaidDate && !hasScheduledOutstanding) ||
    (effectiveFullyPaidDate && independentReceipt) ||
    (balanceOwing === 0 &&
      amountReceived != null &&
      price != null &&
      nearlyEqual(amountReceived, price) &&
      !hasScheduledOutstanding)
  ) {
    paymentStatus = "fully_paid";
    balanceOwing = 0;
  } else if (
    depositPaidDate &&
    depositAmount != null &&
    depositAmount > MONEY_EPS &&
    balanceOwing != null &&
    balanceOwing > MONEY_EPS
  ) {
    paymentStatus = "partially_paid";
  } else if (balanceOwing != null && balanceOwing > MONEY_EPS) {
    paymentStatus = "payment_outstanding";
  }

  return {
    deposit_amount: depositAmount,
    deposit_paid_date: depositPaidDate,
    payment_2_amount: payment2Amount,
    payment_2_due_date: payment2DueDate,
    payment_3_amount: payment3Amount,
    payment_3_due_date: payment3DueDate,
    final_payment_due_date: finalPaymentDueDate,
    final_payment_due_date_normalised: finalPaymentDueDate,
    final_payment_reminder_date: reminderFinal,
    amount_received: amountReceived,
    balance_owing: balanceOwing,
    payment_status: paymentStatus,
    fully_paid_date: effectiveFullyPaidDate,
    // Keep reminder on its own field only.
    reminder_final_payment_due: reminderFinal,
    _meta: {
      contradictory_fully_paid_with_scheduled_instalment: Boolean(contradictory),
      legacy_summed_instalments_ignored: Boolean(legacySummedInstalments),
      independent_instalment_receipt_evidence: Boolean(independentReceipt && hasScheduledOutstanding)
    }
  };
}

/**
 * Apply finance derivation onto a booking payload for integration responses.
 * Does not persist anything to CruiseBooking.
 */
function applyBookingFinance(booking = {}) {
  const derived = deriveBookingFinance(booking);
  return {
    ...booking,
    ...derived,
    // Preserve schedule raw names for compatibility.
    cruise_deposit: derived.deposit_amount != null ? derived.deposit_amount : booking.cruise_deposit,
    cruise_deposit_date: derived.deposit_paid_date || booking.cruise_deposit_date || null,
    cruise_payment_2: derived.payment_2_amount != null ? derived.payment_2_amount : booking.cruise_payment_2,
    cruise_payment_2_date: derived.payment_2_due_date || booking.cruise_payment_2_date || null,
    cruise_payment_3: Object.prototype.hasOwnProperty.call(derived, "payment_3_amount")
      ? derived.payment_3_amount
      : booking.cruise_payment_3,
    cruise_payment_3_date: Object.prototype.hasOwnProperty.call(derived, "payment_3_due_date")
      ? derived.payment_3_due_date
      : booking.cruise_payment_3_date
  };
}

module.exports = {
  MONEY_EPS,
  parseMoney,
  parseDate,
  deriveBookingFinance,
  applyBookingFinance,
  isContradictoryFullyPaid,
  scheduledInstalmentsHaveIndependentReceipt
};
