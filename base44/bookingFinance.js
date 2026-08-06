/**
 * Shared Base44 booking finance helper.
 *
 * Canonical source of truth for getBookingFor101Cruise / pushBookingTo101Cruise.
 * Mirrors js/base44-booking-field-contract.js — keep both aligned.
 *
 * IMPORTANT:
 * - cruise_payment_2 / cruise_payment_3 are SCHEDULED amounts, never received money.
 * - Received money requires amount + receipt date (deposit, payment_*_received, final_payment_received).
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

function roundMoney(value) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function normalizeMoneyZero(value) {
  const n = parseMoney(value);
  if (n == null) return null;
  if (Math.abs(n) <= MONEY_EPS) return 0;
  return roundMoney(Math.max(0, n));
}

function readAuthoritativeBalance(booking = {}) {
  for (const key of ["to_be_paid", "balance_to_be_paid", "amount_to_be_paid"]) {
    const value = normalizeMoneyZero(booking[key]);
    if (value != null) return value;
  }
  return null;
}

function sumReceivedPayments(booking = {}) {
  let total = 0;
  let hasComponent = false;

  const depositAmount = parseMoney(booking.cruise_deposit ?? booking.deposit_amount);
  const depositPaidDate = parseDate(
    booking.cruise_deposit_date ?? booking.deposit_paid_date ?? booking.deposit_payment_date
  );
  if (depositAmount != null && depositAmount > MONEY_EPS && depositPaidDate) {
    total += depositAmount;
    hasComponent = true;
  }

  const receiptPairs = [
    ["payment_2_received_amount", "payment_2_received_date"],
    ["payment_3_received_amount", "payment_3_received_date"],
    ["final_payment_received_amount", "final_payment_received_date"],
    ["extra_payment_received_amount", "extra_payment_received_date"]
  ];
  for (const [amountKey, dateKey] of receiptPairs) {
    const amount = parseMoney(booking[amountKey]);
    const receiptDate = parseDate(booking[dateKey]);
    if (amount != null && amount > MONEY_EPS && receiptDate) {
      total += amount;
      hasComponent = true;
    }
  }

  if (!hasComponent) return null;
  return roundMoney(total);
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
  const fullyPaidDate = parseDate(booking.fully_paid_date ?? booking.fully_paid_date_normalised);
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

function resolveAmountReceived(booking, options = {}) {
  const {
    price,
    depositAmount,
    contradictory,
    legacySummedInstalments,
    totalReceivedFromReceipts
  } = options;

  if (contradictory && depositAmount != null && depositAmount > MONEY_EPS) {
    return depositAmount;
  }

  if (totalReceivedFromReceipts != null) {
    return totalReceivedFromReceipts;
  }

  const apiReceived = parseMoney(booking.amount_received);
  if (apiReceived != null && !contradictory) {
    return apiReceived;
  }

  if (legacySummedInstalments && depositAmount != null && depositAmount > MONEY_EPS) {
    return depositAmount;
  }

  if (depositAmount != null && depositAmount > MONEY_EPS && parseDate(booking.cruise_deposit_date ?? booking.deposit_paid_date)) {
    return depositAmount;
  }

  if (price != null && contradictory) return null;
  return null;
}

function derivePaymentStatus(balanceOwing, amountReceived) {
  if (balanceOwing === 0) return "fully_paid";
  if (balanceOwing != null && balanceOwing > MONEY_EPS) {
    return amountReceived != null && amountReceived > MONEY_EPS ? "partially_paid" : "payment_outstanding";
  }
  return "unknown";
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
  const rawFullyPaidDate = parseDate(booking.fully_paid_date ?? booking.fully_paid_date_normalised);
  const reminderFinal = parseDate(
    booking.reminder_final_payment_due ?? booking.final_payment_reminder_date
  );
  const authoritativeBalance = readAuthoritativeBalance(booking);
  const totalReceivedFromReceipts = sumReceivedPayments(booking);

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

  const finalPaymentDueDate = payment2DueDate || payment3DueDate || null;

  const legacyAmountPaid = parseMoney(booking.amount_paid);
  const scheduledSum =
    (depositAmount || 0) + (payment2Amount || 0) + (payment3Amount || 0);
  const legacySummedInstalments =
    legacyAmountPaid != null &&
    price != null &&
    nearlyEqual(legacyAmountPaid, scheduledSum) &&
    hasScheduledOutstanding &&
    !effectiveFullyPaidDate &&
    !independentReceipt;

  let amountReceived = resolveAmountReceived(booking, {
    price,
    depositAmount,
    contradictory,
    legacySummedInstalments,
    totalReceivedFromReceipts
  });

  let balanceOwing = null;

  if (contradictory && hasScheduledOutstanding) {
    balanceOwing = scheduledInstalments;
    if (depositAmount != null && depositAmount > MONEY_EPS) amountReceived = depositAmount;
  } else if (
    (independentReceipt && hasScheduledOutstanding) ||
    (totalReceivedFromReceipts != null && price != null && nearlyEqual(totalReceivedFromReceipts, price)) ||
    (effectiveFullyPaidDate && independentReceipt) ||
    (effectiveFullyPaidDate && !hasScheduledOutstanding)
  ) {
    balanceOwing = 0;
    amountReceived = amountReceived != null ? amountReceived : totalReceivedFromReceipts ?? price;
  } else if (totalReceivedFromReceipts != null && price != null) {
    balanceOwing = normalizeMoneyZero(price - totalReceivedFromReceipts);
    amountReceived = totalReceivedFromReceipts;
  } else if (authoritativeBalance != null) {
    balanceOwing = authoritativeBalance;
  } else if (hasScheduledOutstanding && !independentReceipt) {
    balanceOwing = scheduledInstalments;
  } else if (price != null && amountReceived != null) {
    balanceOwing = normalizeMoneyZero(price - amountReceived);
  } else {
    const rawBalance = normalizeMoneyZero(booking.balance_owing);
    const canTrustZeroBalance =
      rawBalance === 0 &&
      (independentReceipt || effectiveFullyPaidDate || (amountReceived != null && price != null && nearlyEqual(amountReceived, price)));
    if (rawBalance != null) {
      if (rawBalance !== 0 || canTrustZeroBalance || !hasScheduledOutstanding) {
        balanceOwing = rawBalance;
      }
    }
  }

  if (legacySummedInstalments && hasScheduledOutstanding && !independentReceipt) {
    balanceOwing = scheduledInstalments;
    if (depositAmount != null && depositAmount > MONEY_EPS) amountReceived = depositAmount;
  }

  let paymentStatus = derivePaymentStatus(balanceOwing, amountReceived);
  if (paymentStatus === "fully_paid") balanceOwing = 0;

  return {
    deposit_amount: depositAmount,
    deposit_paid_date: depositPaidDate,
    payment_2_amount: payment2Amount,
    payment_2_due_date: payment2DueDate,
    payment_3_amount: payment3Amount,
    payment_3_due_date: payment3DueDate,
    payment_2_received_amount: parseMoney(booking.payment_2_received_amount),
    payment_2_received_date: parseDate(booking.payment_2_received_date),
    payment_3_received_amount: parseMoney(booking.payment_3_received_amount),
    payment_3_received_date: parseDate(booking.payment_3_received_date),
    final_payment_received_amount: parseMoney(booking.final_payment_received_amount),
    final_payment_received_date: parseDate(booking.final_payment_received_date),
    final_payment_due_date: finalPaymentDueDate,
    final_payment_due_date_normalised: finalPaymentDueDate,
    final_payment_reminder_date: reminderFinal,
    amount_received: amountReceived,
    total_paid: amountReceived,
    balance_owing: balanceOwing,
    payment_status: paymentStatus,
    fully_paid_date: effectiveFullyPaidDate,
    fully_paid_date_normalised: effectiveFullyPaidDate,
    reminder_final_payment_due: reminderFinal,
    _meta: {
      contradictory_fully_paid_with_scheduled_instalment: Boolean(contradictory),
      legacy_summed_instalments_ignored: Boolean(legacySummedInstalments),
      independent_instalment_receipt_evidence: Boolean(independentReceipt && hasScheduledOutstanding),
      authoritative_balance_used: authoritativeBalance != null,
      total_received_from_receipts: totalReceivedFromReceipts
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
  roundMoney,
  normalizeMoneyZero,
  sumReceivedPayments,
  readAuthoritativeBalance,
  deriveBookingFinance,
  applyBookingFinance,
  derivePaymentStatus,
  isContradictoryFullyPaid,
  scheduledInstalmentsHaveIndependentReceipt
};
