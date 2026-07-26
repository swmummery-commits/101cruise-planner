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

  /**
   * Legacy Base44 getBookingFor101Cruise falsely does:
   *   amount_paid = cruise_deposit + cruise_payment_2 + cruise_payment_3
   * cruise_payment_2/3 are scheduled instalments, not received money.
   */
  function normaliseBookingFinancials(booking = {}, options = {}) {
    const today = todayIso(options.now);
    const price = parseMoneyStrict(booking.cruise_price_usd ?? booking.total_price ?? booking.cruise_price_amount);
    const depositAmount = parseMoneyStrict(booking.cruise_deposit ?? booking.deposit_amount);
    const depositPaidDate = parseDateOnly(
      booking.cruise_deposit_date ?? booking.deposit_paid_date ?? booking.deposit_payment_date
    );
    const payment2 = parseMoneyStrict(booking.cruise_payment_2 ?? booking.payment_2_amount);
    const payment3 = parseMoneyStrict(booking.cruise_payment_3 ?? booking.payment_3_amount);
    const payment2Due = parseDateOnly(booking.cruise_payment_2_date ?? booking.payment_2_due_date);
    const payment3Due = parseDateOnly(booking.cruise_payment_3_date ?? booking.payment_3_due_date);
    const fullyPaidDate = parseDateOnly(booking.fully_paid_date);
    const reminderDeposit = parseDateOnly(booking.reminder_deposit_due);
    const reminderFinal = parseDateOnly(
      booking.reminder_final_payment_due ?? booking.final_payment_reminder_date
    );
    const depositDue = parseDateOnly(booking.deposit_due_date);
    const legacyFinalDue = parseDateOnly(booking.final_payment_due_date);

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
      amountPaidRaw != null &&
      price != null &&
      depositAmount != null &&
      nearlyEqual(amountPaidRaw, (depositAmount || 0) + (payment2 || 0) + (payment3 || 0)) &&
      hasScheduledOutstanding &&
      !fullyPaidDate;

    const notes = [];
    if (bookingStatus === "confirmed") notes.push("confirmed_status_ignored_for_payment");
    if (reminderDeposit) notes.push("reminder_date_ignored_as_payment_evidence");
    if (reminderFinal || (legacyFinalDue && !payment2Due)) {
      notes.push("legacy_reminder_not_shown_as_final_payment_due");
    }
    if (legacySummedInstalments) {
      notes.push("ignored_legacy_amount_paid_sum_of_scheduled_instalments");
    }

    // amount_received = deposit only — never include cruise_payment_2/3.
    let amountReceived = null;
    if (depositAmount != null && depositAmount > MONEY_EPS) {
      if (depositPaidDate || legacySummedInstalments || hasScheduledOutstanding) {
        // Legacy: cruise_deposit is the deposit received; payment_2/3 are schedule.
        amountReceived = depositAmount;
        notes.push("amount_received_is_cruise_deposit_only");
      }
    }

    let depositStatus = "unknown";
    let depositPaidAmount = null;
    let depositOwingAmount = null;
    let depositRemainingAmount = null;

    if (depositAmount != null && depositAmount > MONEY_EPS && amountReceived != null) {
      depositStatus = "paid";
      depositPaidAmount = depositAmount;
      if (!depositPaidDate) {
        notes.push("deposit_paid_without_api_deposit_date");
      }
    } else if (depositAmount != null && depositAmount > MONEY_EPS) {
      depositStatus = "unknown";
      notes.push("deposit_amount_without_payment_evidence");
    }

    // Final due: only authoritative instalment due dates. Never legacy reminder alias.
    let finalDue = payment2Due || payment3Due || null;
    let finalDueDisplay = finalDue;
    let finalDueUnreliable = false;
    if (!finalDue) {
      // Legacy API maps reminder_final_payment_due → final_payment_due_date.
      if (legacyFinalDue || reminderFinal) {
        finalDueUnreliable = true;
        finalDueDisplay = null;
        notes.push("final_payment_due_check_booking_confirmation");
      }
    }

    let balanceOwing = null;
    if (fullyPaidDate && !hasScheduledOutstanding) {
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
    // Never coerce null/blank to zero when unknown.

    if (hasScheduledOutstanding && (statusRaw === "fully_paid" || balanceRaw === 0 || legacySummedInstalments)) {
      balanceOwing = scheduledInstalments;
      notes.push("blocked_false_fully_paid_from_scheduled_instalments");
    }

    let overallPaymentStatus = "unknown";
    if (fullyPaidDate && !hasScheduledOutstanding) {
      overallPaymentStatus = "fully_paid";
      balanceOwing = 0;
    } else if (hasScheduledOutstanding) {
      overallPaymentStatus =
        depositStatus === "paid" ? "deposit_paid_balance_outstanding" : "payment_outstanding";
    } else if (
      balanceOwing === 0 &&
      amountReceived != null &&
      price != null &&
      nearlyEqual(amountReceived, price)
    ) {
      overallPaymentStatus = "fully_paid";
    } else if (depositStatus === "paid" && balanceOwing != null && balanceOwing > MONEY_EPS) {
      overallPaymentStatus = "deposit_paid_balance_outstanding";
    } else if (balanceOwing != null && balanceOwing > MONEY_EPS) {
      overallPaymentStatus = "payment_outstanding";
    } else if (statusRaw === "fully_paid" && !hasScheduledOutstanding && !fullyPaidDate) {
      if (amountReceived != null && price != null && nearlyEqual(amountReceived, price)) {
        overallPaymentStatus = "fully_paid";
        balanceOwing = 0;
      } else {
        overallPaymentStatus = "unknown";
        notes.push("fully_paid_date_null_blocks_unsupported_fully_paid");
      }
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
      // Only expose paid date when API actually provides cruise_deposit_date.
      deposit_paid_date: depositPaidDate,
      deposit_reminder_date: reminderDeposit,
      deposit_status: depositStatus,
      final_payment_amount: payment2 != null && payment2 > MONEY_EPS ? payment2 : null,
      final_payment_due_date: finalDue,
      final_payment_due_display: finalDueUnreliable
        ? "Check booking confirmation"
        : finalDueDisplay,
      final_payment_due_unreliable: finalDueUnreliable,
      final_payment_reminder_date: reminderFinal || (!payment2Due ? legacyFinalDue : null),
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
      confidence: hasScheduledOutstanding || depositPaidDate || fullyPaidDate ? "high" : "medium",
      notes,
      raw: {
        payment_status: booking.payment_status ?? null,
        balance_owing: booking.balance_owing ?? null,
        amount_paid: booking.amount_paid ?? null,
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
      // Only show paid-on when API provides cruise_deposit_date.
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
    MONEY_EPS
  };
});
