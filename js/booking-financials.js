/**
 * Shared Base44 → Client Portal booking financial normaliser.
 * Display-only: never writes financial calculations back to Base44 or Supabase.
 *
 * Dual export: CommonJS (Node) + browser global BookingFinancials.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./base44-booking-field-contract.js"));
  } else {
    root.BookingFinancials = factory(root.Base44BookingFieldContract);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (Contract) {
  "use strict";

  const MONEY_EPS = (Contract && Contract.MONEY_EPS) || 0.02;

  function parseMoneyStrict(value) {
    if (Contract?.parseMoney) return Contract.parseMoney(value);
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const text = String(value).trim();
    if (!text) return null;
    const digits = text.replace(/[^0-9.-]/g, "");
    if (!digits || digits === "-" || digits === "." || digits === "-.") return null;
    const n = Number(digits);
    return Number.isFinite(n) ? n : null;
  }

  function parseDateOnly(value) {
    if (Contract?.parseDate) return Contract.parseDate(value);
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (!text) return null;
    const m = text.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!m) return null;
    const d = new Date(`${m[1]}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : m[1];
  }

  function firstMoney(...values) {
    for (const value of values) {
      const n = parseMoneyStrict(value);
      if (n != null) return n;
    }
    return null;
  }

  function firstDate(...values) {
    for (const value of values) {
      const d = parseDateOnly(value);
      if (d) return d;
    }
    return null;
  }

  function nearlyEqual(a, b) {
    if (a == null || b == null) return false;
    return Math.abs(a - b) <= MONEY_EPS;
  }

  function todayIso(now) {
    const d = now instanceof Date ? now : new Date(now || Date.now());
    return d.toISOString().slice(0, 10);
  }

  function formatUsd(amount) {
    if (amount == null || !Number.isFinite(Number(amount))) return null;
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(Number(amount));
  }

  function hasCorrectedNormalisedContract(booking) {
    return Boolean(
      parseMoneyStrict(booking.deposit_amount) != null ||
        parseDateOnly(booking.deposit_paid_date) ||
        parseMoneyStrict(booking.payment_2_amount) != null ||
        parseDateOnly(booking.payment_2_due_date) ||
        parseMoneyStrict(booking.payment_3_amount) != null ||
        parseDateOnly(booking.payment_3_due_date) ||
        parseDateOnly(booking.final_payment_due_date_normalised) ||
        parseDateOnly(booking.final_payment_reminder_date) ||
        parseMoneyStrict(booking.amount_received) != null
    );
  }

  /**
   * Prefer corrected Base44 normalised fields; fall back to legacy raw fields.
   * Keep legacy safeguard for old payloads that sum scheduled instalments into amount_paid.
   */
  function normaliseBookingFinancials(booking = {}, options = {}) {
    const today = todayIso(options.now);
    const corrected = hasCorrectedNormalisedContract(booking);

    const price = firstMoney(booking.cruise_price_usd, booking.total_price, booking.cruise_price_amount);
    const depositAmount = firstMoney(booking.deposit_amount, booking.cruise_deposit);
    const depositPaidDate = firstDate(
      booking.deposit_paid_date,
      booking.cruise_deposit_date,
      booking.deposit_payment_date
    );
    const payment2 = firstMoney(booking.payment_2_amount, booking.cruise_payment_2);
    const payment3 = firstMoney(booking.payment_3_amount, booking.cruise_payment_3);
    const payment2Due = firstDate(booking.payment_2_due_date, booking.cruise_payment_2_date);
    const payment3Due = firstDate(booking.payment_3_due_date, booking.cruise_payment_3_date);
    const fullyPaidDate = parseDateOnly(booking.fully_paid_date);
    const reminderDeposit = firstDate(booking.reminder_deposit_due, booking.deposit_reminder_date);
    const reminderFinal = firstDate(
      booking.final_payment_reminder_date,
      booking.reminder_final_payment_due
    );
    const depositDue = parseDateOnly(booking.deposit_due_date);
    const normalisedFinalDue = parseDateOnly(booking.final_payment_due_date_normalised);
    const legacyFinalDue = parseDateOnly(booking.final_payment_due_date);
    const apiAmountReceived = parseMoneyStrict(booking.amount_received);
    const amountPaidRaw = parseMoneyStrict(booking.amount_paid);
    const balanceRaw = parseMoneyStrict(booking.balance_owing);
    const statusRaw = String(booking.payment_status || "")
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    const bookingStatus = String(booking.booking_status || "").trim().toLowerCase();

    const scheduledInstalments =
      (payment2 != null && payment2 > MONEY_EPS ? payment2 : 0) +
      (payment3 != null && payment3 > MONEY_EPS ? payment3 : 0);
    const hasScheduledOutstanding = scheduledInstalments > MONEY_EPS;

    const legacySummedInstalments =
      !corrected &&
      amountPaidRaw != null &&
      price != null &&
      depositAmount != null &&
      nearlyEqual(amountPaidRaw, (depositAmount || 0) + (payment2 || 0) + (payment3 || 0)) &&
      hasScheduledOutstanding &&
      !fullyPaidDate;

    const notes = [];
    if (corrected) notes.push("using_corrected_normalised_contract");
    if (bookingStatus === "confirmed") notes.push("confirmed_status_ignored_for_payment");
    if (reminderDeposit) notes.push("reminder_date_ignored_as_payment_evidence");
    if (legacySummedInstalments) {
      notes.push("ignored_legacy_amount_paid_sum_of_scheduled_instalments");
    }

    // amount_received: never include payment_2 / payment_3.
    let amountReceived = null;
    if (apiAmountReceived != null) {
      amountReceived = apiAmountReceived;
      notes.push("amount_received_from_corrected_api");
    } else if (depositAmount != null && depositAmount > MONEY_EPS) {
      if (depositPaidDate || legacySummedInstalments || hasScheduledOutstanding) {
        amountReceived = depositAmount;
        notes.push("amount_received_is_cruise_deposit_only");
      }
    }

    let depositStatus = "unknown";
    let depositPaidAmount = null;
    let depositOwingAmount = null;
    let depositRemainingAmount = null;

    if (depositAmount != null && depositAmount > MONEY_EPS && amountReceived != null && amountReceived > MONEY_EPS) {
      if (amountReceived + MONEY_EPS < depositAmount) {
        depositStatus = "partially_paid";
        depositPaidAmount = amountReceived;
        depositRemainingAmount = depositAmount - amountReceived;
      } else {
        depositStatus = "paid";
        depositPaidAmount = depositAmount;
      }
      if (!depositPaidDate) notes.push("deposit_paid_without_api_deposit_date");
    } else if (statusRaw === "no_payment" && depositAmount != null && depositAmount > MONEY_EPS) {
      depositStatus = "outstanding";
      depositOwingAmount = depositAmount;
    } else if (depositAmount != null && depositAmount > MONEY_EPS) {
      depositStatus = "unknown";
      notes.push("deposit_amount_without_payment_evidence");
    }

    // Final due priority: normalised → payment_2 due → genuine final_payment_due_date
    // (never the old reminder alias).
    let finalDue = normalisedFinalDue || payment2Due || null;
    let finalDueUnreliable = false;
    if (!finalDue) {
      if (legacyFinalDue && reminderFinal && legacyFinalDue === reminderFinal) {
        finalDueUnreliable = true;
        notes.push("legacy_reminder_not_shown_as_final_payment_due");
        notes.push("final_payment_due_check_booking_confirmation");
      } else if (legacyFinalDue && !reminderFinal && !hasScheduledOutstanding) {
        finalDue = legacyFinalDue;
      } else if (legacyFinalDue || reminderFinal) {
        // Legacy payload: final_payment_due_date is commonly the reminder alias.
        finalDueUnreliable = true;
        notes.push("legacy_reminder_not_shown_as_final_payment_due");
        notes.push("final_payment_due_check_booking_confirmation");
      }
    } else if (reminderFinal && finalDue === reminderFinal && !normalisedFinalDue && !payment2Due) {
      finalDueUnreliable = true;
      finalDue = null;
      notes.push("final_payment_due_check_booking_confirmation");
    }

    if (reminderFinal) notes.push("final_payment_reminder_kept_separate");

    let balanceOwing = null;
    if (corrected && balanceRaw != null && !(statusRaw === "fully_paid" && balanceRaw === 0 && hasScheduledOutstanding && !fullyPaidDate)) {
      // Trust corrected balance_owing from normalised contract.
      balanceOwing = balanceRaw;
      notes.push("balance_from_corrected_api");
    } else if (fullyPaidDate && !hasScheduledOutstanding) {
      balanceOwing = 0;
      amountReceived = amountReceived != null ? amountReceived : price;
      if (depositAmount != null && depositAmount > MONEY_EPS) {
        depositStatus = "paid";
        depositPaidAmount = depositAmount;
      }
      notes.push("fully_paid_date_present");
    } else if (hasScheduledOutstanding) {
      balanceOwing = scheduledInstalments;
      notes.push("balance_from_scheduled_instalments");
    } else if (price != null && amountReceived != null) {
      balanceOwing = Math.max(0, price - amountReceived);
    } else if (balanceRaw != null && balanceRaw !== 0) {
      balanceOwing = balanceRaw;
    } else if (balanceRaw === 0 && statusRaw === "fully_paid" && !hasScheduledOutstanding) {
      balanceOwing = 0;
    }

    if (!corrected && hasScheduledOutstanding && (statusRaw === "fully_paid" || balanceRaw === 0 || legacySummedInstalments)) {
      balanceOwing = scheduledInstalments;
      notes.push("blocked_false_fully_paid_from_scheduled_instalments");
    }

    if (corrected && hasScheduledOutstanding && statusRaw === "fully_paid" && !fullyPaidDate) {
      balanceOwing = scheduledInstalments;
      notes.push("blocked_false_fully_paid_from_scheduled_instalments");
    }

    let overallPaymentStatus = "unknown";
    if (fullyPaidDate && !hasScheduledOutstanding) {
      overallPaymentStatus = "fully_paid";
      balanceOwing = 0;
    } else if (statusRaw === "fully_paid" && !hasScheduledOutstanding && (balanceOwing === 0 || balanceOwing == null)) {
      if (amountReceived != null && price != null && nearlyEqual(amountReceived, price)) {
        overallPaymentStatus = "fully_paid";
        balanceOwing = 0;
      } else if (balanceRaw === 0 && !hasScheduledOutstanding) {
        overallPaymentStatus = "fully_paid";
        balanceOwing = 0;
      } else {
        overallPaymentStatus = "unknown";
        notes.push("fully_paid_date_null_blocks_unsupported_fully_paid");
      }
    } else if (
      (statusRaw === "partially_paid" || hasScheduledOutstanding) &&
      depositStatus === "paid" &&
      balanceOwing != null &&
      balanceOwing > MONEY_EPS
    ) {
      overallPaymentStatus = "deposit_paid_balance_outstanding";
      notes.push("mapped_partially_paid_to_deposit_paid_balance_outstanding");
    } else if (statusRaw === "no_payment") {
      overallPaymentStatus = balanceOwing != null && balanceOwing > MONEY_EPS ? "payment_outstanding" : "unknown";
    } else if (statusRaw === "unknown") {
      overallPaymentStatus = "unknown";
    } else if (depositStatus === "paid" && balanceOwing != null && balanceOwing > MONEY_EPS) {
      overallPaymentStatus = "deposit_paid_balance_outstanding";
    } else if (balanceOwing != null && balanceOwing > MONEY_EPS) {
      overallPaymentStatus = "payment_outstanding";
    } else if (
      balanceOwing === 0 &&
      amountReceived != null &&
      price != null &&
      nearlyEqual(amountReceived, price)
    ) {
      overallPaymentStatus = "fully_paid";
    }

    if (balanceOwing != null && balanceOwing > MONEY_EPS && overallPaymentStatus === "fully_paid") {
      overallPaymentStatus =
        depositStatus === "paid" ? "deposit_paid_balance_outstanding" : "payment_outstanding";
      notes.push("blocked_fully_paid_with_positive_balance");
    }

    if (payment2Due && payment2Due > today) {
      notes.push("future_instalment_date_is_due_not_received");
    }

    const labels = {
      fully_paid: "Fully paid",
      payment_outstanding: "Balance outstanding",
      deposit_paid_balance_outstanding: "Deposit paid — balance outstanding",
      unknown: "Check booking confirmation"
    };

    return {
      cruise_price_amount: price,
      cruise_price_currency: "USD",
      deposit_amount: depositAmount,
      deposit_paid_amount: depositPaidAmount,
      deposit_owing_amount: depositOwingAmount,
      deposit_remaining_amount: depositRemainingAmount,
      deposit_due_date: depositDue,
      deposit_paid_date: depositPaidDate,
      deposit_reminder_date: reminderDeposit,
      deposit_status: depositStatus,
      final_payment_amount: payment2 != null && payment2 > MONEY_EPS ? payment2 : null,
      final_payment_due_date: finalDueUnreliable ? null : finalDue,
      final_payment_due_display: finalDueUnreliable ? "Check booking confirmation" : finalDue,
      final_payment_due_unreliable: finalDueUnreliable,
      final_payment_reminder_date: reminderFinal,
      payment_2_amount: payment2,
      payment_2_due_date: payment2Due,
      payment_3_amount: payment3,
      payment_3_due_date: payment3Due,
      fully_paid_date: fullyPaidDate,
      amount_paid: amountReceived,
      amount_received: amountReceived,
      balance_owing: balanceOwing,
      overall_payment_status: overallPaymentStatus,
      overall_payment_status_label: labels[overallPaymentStatus] || labels.unknown,
      confidence: corrected || hasScheduledOutstanding || depositPaidDate || fullyPaidDate ? "high" : "medium",
      notes,
      raw: {
        payment_status: booking.payment_status ?? null,
        balance_owing: booking.balance_owing ?? null,
        amount_paid: booking.amount_paid ?? null,
        amount_received: booking.amount_received ?? null,
        deposit_amount: booking.deposit_amount ?? null,
        deposit_paid_date: booking.deposit_paid_date ?? null,
        payment_2_amount: booking.payment_2_amount ?? null,
        payment_2_due_date: booking.payment_2_due_date ?? null,
        final_payment_due_date_normalised: booking.final_payment_due_date_normalised ?? null,
        final_payment_reminder_date: booking.final_payment_reminder_date ?? null,
        cruise_deposit: booking.cruise_deposit ?? null,
        cruise_deposit_date: booking.cruise_deposit_date ?? null,
        cruise_payment_2: booking.cruise_payment_2 ?? null,
        cruise_payment_2_date: booking.cruise_payment_2_date ?? null,
        cruise_payment_3: booking.cruise_payment_3 ?? null,
        fully_paid_date: booking.fully_paid_date ?? null,
        final_payment_due_date: booking.final_payment_due_date ?? null,
        reminder_final_payment_due: booking.reminder_final_payment_due ?? null
      }
    };
  }

  function buildFinancialDisplayRows(financials, options = {}) {
    const formatMoney = options.formatMoney || formatUsd;
    const formatDate = options.formatDate || (iso => iso);
    const rows = [];

    if (financials.cruise_price_amount != null) {
      rows.push({
        key: "cruise_price",
        label: "Cruise price",
        value: formatMoney(financials.cruise_price_amount)
      });
    }

    if (financials.deposit_status === "paid" && financials.deposit_paid_amount != null) {
      rows.push({
        key: "deposit_paid",
        label: "Deposit paid",
        value: formatMoney(financials.deposit_paid_amount)
      });
      if (financials.deposit_paid_date) {
        rows.push({
          key: "deposit_paid_on",
          label: "Deposit paid on",
          value: formatDate(financials.deposit_paid_date)
        });
      }
    } else if (financials.deposit_status === "outstanding" && financials.deposit_owing_amount != null) {
      rows.push({
        key: "deposit_owing",
        label: "Deposit owing",
        value: formatMoney(financials.deposit_owing_amount)
      });
    } else if (financials.deposit_status === "partially_paid") {
      if (financials.deposit_paid_amount != null) {
        rows.push({
          key: "deposit_paid",
          label: "Deposit paid",
          value: formatMoney(financials.deposit_paid_amount)
        });
      }
      if (financials.deposit_remaining_amount != null) {
        rows.push({
          key: "deposit_remaining",
          label: "Deposit remaining",
          value: formatMoney(financials.deposit_remaining_amount)
        });
      }
    } else if (
      financials.deposit_amount != null &&
      financials.deposit_amount > MONEY_EPS &&
      financials.deposit_status === "unknown"
    ) {
      rows.push({
        key: "deposit_amount",
        label: "Deposit amount",
        value: formatMoney(financials.deposit_amount)
      });
    }

    if (financials.balance_owing != null) {
      rows.push({
        key: "balance_owing",
        label: "Balance owing",
        value: formatMoney(financials.balance_owing)
      });
    }

    if (financials.final_payment_due_unreliable) {
      rows.push({
        key: "final_payment_due",
        label: "Final payment due",
        value: "Check booking confirmation"
      });
    } else if (financials.final_payment_due_date) {
      rows.push({
        key: "final_payment_due",
        label: "Final payment due",
        value: formatDate(financials.final_payment_due_date)
      });
    }

    rows.push({
      key: "payment_status",
      label: "Payment status",
      value: financials.overall_payment_status_label
    });

    return rows;
  }

  return {
    parseMoneyStrict,
    parseDateOnly,
    normaliseBookingFinancials,
    buildFinancialDisplayRows,
    formatFinancialUsd: formatUsd,
    hasCorrectedNormalisedContract,
    MONEY_EPS
  };
});
