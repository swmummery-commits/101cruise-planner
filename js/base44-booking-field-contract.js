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
    "inclusions",
    // OBC: on_board_credit_usd is a legacy amount name — currency is separate.
    "on_board_credit_usd",
    "on_board_credit_1_currency",
    "on_board_credit_2_amount",
    "on_board_credit_2_currency",
    "on_board_credits"
  ];

  /** Explicit OBC allow-list for pull/push audits and Base44 snippets. */
  const SAFE_OBC_FIELDS = [
    "on_board_credit_usd",
    "on_board_credit_1_currency",
    "on_board_credit_2_amount",
    "on_board_credit_2_currency",
    "on_board_credits"
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
    "payment_2_received_amount",
    "payment_2_received_date",
    "payment_3_received_amount",
    "payment_3_received_date",
    "final_payment_received_amount",
    "final_payment_received_date",
    "extra_payment_received_amount",
    "extra_payment_received_date",
    "to_be_paid",
    "fully_paid_date",
    "fully_paid_date_normalised",
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
    "payment_2_received_amount",
    "payment_2_received_date",
    "payment_3_received_amount",
    "payment_3_received_date",
    "final_payment_received_amount",
    "final_payment_received_date",
    "final_payment_due_date",
    "final_payment_due_date_normalised",
    "final_payment_reminder_date",
    "amount_received",
    "total_paid",
    "balance_owing",
    "payment_status",
    "fully_paid_date",
    "fully_paid_date_normalised"
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
    "payment_status",
    "on_board_credit_usd",
    "on_board_credit_1_currency",
    "on_board_credit_2_amount",
    "on_board_credit_2_currency",
    "on_board_credits"
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

  function derivePaymentStatus(balanceOwing, amountReceived) {
    if (balanceOwing === 0) return "fully_paid";
    if (balanceOwing != null && balanceOwing > MONEY_EPS) {
      return amountReceived != null && amountReceived > MONEY_EPS ? "partially_paid" : "payment_outstanding";
    }
    return "unknown";
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

  const DEFAULT_OBC_CURRENCY = "USD";

  /**
   * Currency for an OBC slot. Absent/blank → fallback (CRM default USD).
   * Do not infer USD merely because the legacy amount field is named *_usd.
   * Unknown future codes are preserved when they are a reasonable uppercase token.
   */
  function normalizeObcCurrency(value, fallback = DEFAULT_OBC_CURRENCY) {
    if (value === null || value === undefined) return fallback;
    const text = String(value).trim().toUpperCase();
    if (!text) return fallback;
    const cleaned = text.replace(/[^A-Z0-9]/g, "");
    return cleaned || fallback;
  }

  function parsePositiveObcAmount(value) {
    const n = parseMoney(value);
    if (n == null || n <= MONEY_EPS) return null;
    return roundMoney(n);
  }

  function normalizeObcEntry(amount, currency, fallbackCurrency) {
    const parsed = parsePositiveObcAmount(amount);
    if (parsed == null) return null;
    return {
      amount: parsed,
      currency: normalizeObcCurrency(currency, fallbackCurrency)
    };
  }

  function normalizeOnBoardCreditsFromArray(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const entry = normalizeObcEntry(item.amount, item.currency, DEFAULT_OBC_CURRENCY);
      if (entry) out.push(entry);
    }
    return out;
  }

  function normalizeOnBoardCreditsFromRawFields(booking = {}) {
    const credits = [];
    const first = normalizeObcEntry(
      booking.on_board_credit_usd,
      booking.on_board_credit_1_currency,
      DEFAULT_OBC_CURRENCY
    );
    if (first) credits.push(first);
    const second = normalizeObcEntry(
      booking.on_board_credit_2_amount,
      booking.on_board_credit_2_currency,
      DEFAULT_OBC_CURRENCY
    );
    if (second) credits.push(second);
    return credits;
  }

  /**
   * Canonical client-facing OBC list. Raw Base44 slots remain the source of
   * truth when present. Prefer a longer pre-built array so future 3+ credits
   * survive without a My Cruise UI redesign. Never sum or convert currencies.
   * Identical amount+currency pairs are kept as separate awards.
   */
  function normalizeOnBoardCredits(booking = {}) {
    try {
      const fromRaw = normalizeOnBoardCreditsFromRawFields(booking);
      const fromArray = normalizeOnBoardCreditsFromArray(booking.on_board_credits);
      if (fromArray.length > fromRaw.length) return fromArray;
      if (fromRaw.length) return fromRaw;
      return fromArray;
    } catch {
      return [];
    }
  }

  function formatOnBoardCreditLabel(credit) {
    if (!credit) return "";
    const amount = typeof credit.amount === "number" ? credit.amount : parseMoney(credit.amount);
    if (amount == null) return "";
    const currency = normalizeObcCurrency(credit.currency, "");
    if (!currency) return "";
    const formatted = amount.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    return `${currency} ${formatted}`;
  }

  function buildOnBoardCreditPdfRows(booking = {}) {
    const credits = normalizeOnBoardCredits(booking);
    return credits.map((credit, index) => [
      credits.length === 1 ? "On-board credit" : `On-board credit ${index + 1}`,
      formatOnBoardCreditLabel(credit)
    ]);
  }

  function defaultEscapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /**
   * Shared My Cruise OBC section. Dashboard and Booking page must call this
   * so the two surfaces cannot drift. Empty when no valid credit exists.
   */
  function renderOnBoardCreditsSectionHtml(booking = {}, options = {}) {
    const credits = normalizeOnBoardCredits(booking);
    if (!credits.length) return "";
    const headingTag = options.headingTag === "h4" ? "h4" : "h3";
    const extraClass = options.extraClass ? ` ${String(options.extraClass)}` : "";
    const escape = typeof options.escapeHtml === "function" ? options.escapeHtml : defaultEscapeHtml;
    const tags = credits
      .map((credit) => {
        const label = formatOnBoardCreditLabel(credit);
        return `<span class="dashboard-snapshot-extras-tag">${escape(label)}</span>`;
      })
      .join("");
    return `
    <section class="dashboard-snapshot-extras dashboard-snapshot-obc${extraClass}">
      <${headingTag} class="dashboard-snapshot-extras-title">On-board credit</${headingTag}>
      <div class="dashboard-snapshot-extras-tags">${tags}</div>
    </section>
  `;
  }

  /**
   * Explicit independent receipt fields for later instalments.
   * Scheduled due dates / reminder dates / raw fully_paid helper output are not evidence.
   */
  function scheduledInstalmentsHaveIndependentReceipt(payment2Amount, payment3Amount, booking = {}) {
    const need2 = payment2Amount != null && payment2Amount > MONEY_EPS;
    const need3 = payment3Amount != null && payment3Amount > MONEY_EPS;
    if (!need2 && !need3) return true;

    const p2Recv = parseMoney(booking.payment_2_received_amount);
    const p3Recv = parseMoney(booking.payment_3_received_amount);
    const finalRecv = parseMoney(booking.final_payment_received_amount);
    const scheduledTotal =
      (need2 ? payment2Amount : 0) + (need3 ? payment3Amount : 0);

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

  /**
   * Contradictory fully-paid: claims fully paid while unreceived scheduled instalments remain
   * and confirmed deposit is still less than the cruise price.
   */
  function isContradictoryFullyPaid(input = {}) {
    const price = parseMoney(input.price ?? input.cruise_price_usd);
    const depositAmount = parseMoney(
      input.depositAmount ?? input.deposit_amount ?? input.cruise_deposit
    );
    const payment2Amount = parseMoney(
      input.payment2Amount ?? input.payment_2_amount ?? input.cruise_payment_2
    );
    const payment3Amount = parseMoney(
      input.payment3Amount ?? input.payment_3_amount ?? input.cruise_payment_3
    );
    const fullyPaidDate = parseDate(input.fullyPaidDate ?? input.fully_paid_date);
    const statusRaw = String(input.statusRaw ?? input.payment_status ?? "")
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    const booking = input.booking || input;

    const claimsFullyPaid = Boolean(fullyPaidDate) || statusRaw === "fully_paid";
    const scheduledInstalments =
      (payment2Amount != null && payment2Amount > MONEY_EPS ? payment2Amount : 0) +
      (payment3Amount != null && payment3Amount > MONEY_EPS ? payment3Amount : 0);
    const hasScheduledOutstanding = scheduledInstalments > MONEY_EPS;
    const depositLessThanPrice =
      depositAmount != null && price != null && depositAmount + MONEY_EPS < price;

    if (!claimsFullyPaid || !hasScheduledOutstanding || !depositLessThanPrice) {
      return false;
    }
    if (scheduledInstalmentsHaveIndependentReceipt(payment2Amount, payment3Amount, booking)) {
      return false;
    }
    return true;
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
    const fullyPaidDate = parseDate(booking.fully_paid_date ?? booking.fully_paid_date_normalised);
    const depositDueDate = parseDate(booking.deposit_due_date);
    const storedFinalDue = parseDate(booking.final_payment_due_date);
    const reminderDeposit = parseDate(booking.reminder_deposit_due);
    const reminderFinal = parseDate(
      booking.reminder_final_payment_due ?? booking.final_payment_reminder_date
    );
    const authoritativeBalance = readAuthoritativeBalance(booking);
    const totalReceivedFromReceipts = sumReceivedPayments(booking);

    const scheduledInstalments =
      (payment2Amount != null && payment2Amount > MONEY_EPS ? payment2Amount : 0) +
      (payment3Amount != null && payment3Amount > MONEY_EPS ? payment3Amount : 0);
    const hasScheduledOutstanding = scheduledInstalments > MONEY_EPS;
    const contradictoryFullyPaid = isContradictoryFullyPaid({
      price,
      depositAmount,
      payment2Amount,
      payment3Amount,
      fullyPaidDate,
      statusRaw: String(booking.payment_status || "")
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_"),
      booking
    });
    const independentScheduledReceipt = scheduledInstalmentsHaveIndependentReceipt(
      payment2Amount,
      payment3Amount,
      booking
    );
    const effectiveFullyPaidDate = contradictoryFullyPaid ? null : fullyPaidDate;

    let finalPaymentDueDate = payment2DueDate || payment3DueDate || storedFinalDue || null;
    if (finalPaymentDueDate && reminderFinal && finalPaymentDueDate === reminderFinal && payment2DueDate) {
      finalPaymentDueDate = payment2DueDate;
    }
    if (
      !payment2DueDate &&
      storedFinalDue &&
      reminderFinal &&
      storedFinalDue === reminderFinal
    ) {
      finalPaymentDueDate = null;
    } else if (!payment2DueDate && storedFinalDue && !reminderFinal) {
      finalPaymentDueDate = storedFinalDue;
    } else if (payment2DueDate) {
      finalPaymentDueDate = payment2DueDate;
    }

    const legacyAmountPaid = parseMoney(booking.amount_paid);
    const scheduledSum =
      (depositAmount || 0) + (payment2Amount || 0) + (payment3Amount || 0);
    const legacySummedInstalments =
      legacyAmountPaid != null &&
      price != null &&
      nearlyEqual(legacyAmountPaid, scheduledSum) &&
      hasScheduledOutstanding &&
      !effectiveFullyPaidDate &&
      !independentScheduledReceipt;

    let amountReceived = null;
    if (contradictoryFullyPaid && depositAmount != null && depositAmount > MONEY_EPS) {
      amountReceived = depositAmount;
    } else if (totalReceivedFromReceipts != null) {
      amountReceived = totalReceivedFromReceipts;
    } else if (booking.amount_received != null && !contradictoryFullyPaid) {
      amountReceived = parseMoney(booking.amount_received);
    } else if (legacySummedInstalments && depositAmount != null && depositAmount > MONEY_EPS) {
      amountReceived = depositAmount;
    } else if (depositAmount != null && depositAmount > MONEY_EPS && depositPaidDate) {
      amountReceived = depositAmount;
    }

    let balanceOwing = null;
    if (contradictoryFullyPaid && hasScheduledOutstanding) {
      balanceOwing = scheduledInstalments;
      if (depositAmount != null && depositAmount > MONEY_EPS) amountReceived = depositAmount;
    } else if (
      (hasScheduledOutstanding && independentScheduledReceipt) ||
      (totalReceivedFromReceipts != null && price != null && nearlyEqual(totalReceivedFromReceipts, price)) ||
      (effectiveFullyPaidDate && independentScheduledReceipt) ||
      (effectiveFullyPaidDate && !hasScheduledOutstanding)
    ) {
      balanceOwing = 0;
      amountReceived = amountReceived != null ? amountReceived : totalReceivedFromReceipts ?? price;
    } else if (totalReceivedFromReceipts != null && price != null) {
      balanceOwing = normalizeMoneyZero(price - totalReceivedFromReceipts);
      amountReceived = totalReceivedFromReceipts;
    } else if (authoritativeBalance != null) {
      balanceOwing = authoritativeBalance;
    } else if (hasScheduledOutstanding && !independentScheduledReceipt) {
      balanceOwing = scheduledInstalments;
    } else if (price != null && amountReceived != null) {
      balanceOwing = normalizeMoneyZero(price - amountReceived);
    } else {
      const rawBalance = normalizeMoneyZero(booking.balance_owing);
      const canTrustZeroBalance =
        rawBalance === 0 &&
        (independentScheduledReceipt ||
          effectiveFullyPaidDate ||
          (amountReceived != null && price != null && nearlyEqual(amountReceived, price)));
      if (rawBalance != null) {
        if (rawBalance !== 0 || canTrustZeroBalance || !hasScheduledOutstanding) {
          balanceOwing = rawBalance;
        }
      }
    }

    if (legacySummedInstalments && hasScheduledOutstanding && !independentScheduledReceipt) {
      balanceOwing = scheduledInstalments;
      if (depositAmount != null && depositAmount > MONEY_EPS) amountReceived = depositAmount;
    }

    let paymentStatus = derivePaymentStatus(balanceOwing, amountReceived);
    if (paymentStatus === "fully_paid") balanceOwing = 0;

    return {
      cruise_price_usd: price,
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
      deposit_due_date: depositDueDate,
      reminder_deposit_due: reminderDeposit,
      fully_paid_date: effectiveFullyPaidDate,
      fully_paid_date_normalised: effectiveFullyPaidDate,
      amount_received: amountReceived,
      total_paid: amountReceived,
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
        reminder_not_used_as_due: Boolean(reminderFinal && finalPaymentDueDate !== reminderFinal),
        contradictory_fully_paid_with_scheduled_instalment: Boolean(contradictoryFullyPaid)
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
    payload.on_board_credits = normalizeOnBoardCredits(booking);
    for (const bad of FORBIDDEN_SENSITIVE_FIELDS) {
      delete payload[bad];
    }
    return payload;
  }

  function buildPushPayload(booking = {}) {
    const derived = derivePaymentFields(booking);
    const merged = {
      ...booking,
      ...derived,
      on_board_credits: normalizeOnBoardCredits(booking)
    };
    const payload = pick(merged, SAFE_PUSH_FIELDS);
    for (const bad of FORBIDDEN_SENSITIVE_FIELDS) {
      delete payload[bad];
    }
    return payload;
  }

  return {
    SAFE_BOOKING_CORE_FIELDS,
    SAFE_OBC_FIELDS,
    SAFE_PAYMENT_PULL_RAW_FIELDS,
    SAFE_PAYMENT_PULL_NORMALISED_FIELDS,
    SAFE_PUSH_FIELDS,
    FORBIDDEN_SENSITIVE_FIELDS,
    derivePaymentFields,
    buildPullPayload,
    buildPushPayload,
    scheduledInstalmentsHaveIndependentReceipt,
    isContradictoryFullyPaid,
    parseMoney,
    parseDate,
    MONEY_EPS,
    DEFAULT_OBC_CURRENCY,
    normalizeObcCurrency,
    normalizeOnBoardCredits,
    formatOnBoardCreditLabel,
    buildOnBoardCreditPdfRows,
    renderOnBoardCreditsSectionHtml
  };
});
