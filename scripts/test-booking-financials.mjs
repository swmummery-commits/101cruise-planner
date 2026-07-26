/**
 * Offline tests for Client Portal financial normaliser.
 * Covers corrected Base44 normalised fields + legacy safeguard.
 * Run: node scripts/test-booking-financials.mjs
 */

import { createRequire } from "module";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const Contract = require("../js/base44-booking-field-contract.js");
const {
  normaliseBookingFinancials,
  buildFinancialDisplayRows,
  formatFinancialUsd,
  hasCorrectedNormalisedContract
} = require("../js/booking-financials.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function moneyIncludes(value, amountText) {
  return String(value || "").includes(amountText);
}

const NOW = "2026-07-26T00:00:00.000Z";

/** Current legacy getBookingFor101Cruise payload for CD5Q25 (pre-refresh cache). */
const CD5Q25_LEGACY = {
  booking_reference: "CD5Q25",
  booking_status: "confirmed",
  cruise_price_usd: 1816.86,
  cruise_deposit: 349.86,
  cruise_payment_2: 1467,
  cruise_payment_3: null,
  amount_paid: 1816.86,
  balance_owing: 0,
  payment_status: "fully_paid",
  final_payment_due_date: "2026-08-30" // wrongly mapped from reminder
};

/**
 * Corrected Base44 normalised contract for CD5Q25 (post-refresh).
 * Legacy raw fields remain for compatibility.
 */
const CD5Q25_CORRECTED = {
  booking_reference: "CD5Q25",
  booking_status: "confirmed",
  cruise_price_usd: 1816.86,
  // Corrected normalised
  deposit_amount: 349.86,
  deposit_paid_date: "2026-07-25",
  payment_2_amount: 1467,
  payment_2_due_date: "2026-09-13",
  payment_3_amount: null,
  payment_3_due_date: null,
  final_payment_due_date_normalised: "2026-09-13",
  final_payment_reminder_date: "2026-08-30",
  amount_received: 349.86,
  balance_owing: 1467,
  payment_status: "partially_paid",
  fully_paid_date: null,
  // Legacy raw (may still be present / stale)
  cruise_deposit: 349.86,
  cruise_deposit_date: "2026-07-25",
  cruise_payment_2: 1467,
  cruise_payment_2_date: "2026-09-13",
  cruise_payment_3: null,
  cruise_payment_3_date: null,
  amount_paid: 1816.86,
  reminder_final_payment_due: "2026-08-30",
  final_payment_due_date: "2026-08-30"
};

const formatLongDate = iso => {
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
};

function assertCd5q25Display(f, { expectDepositDate, expectFinalDue }) {
  assert(f.cruise_price_amount === 1816.86, "CD5Q25 cruise price");
  assert(f.amount_received === 349.86, "CD5Q25 amount received is deposit only");
  assert(f.balance_owing === 1467, "CD5Q25 balance 1467");
  assert(f.deposit_status === "paid", "CD5Q25 deposit paid");
  assert(f.deposit_paid_amount === 349.86, "CD5Q25 deposit amount");
  assert(
    f.overall_payment_status_label === "Deposit paid — balance outstanding",
    "CD5Q25 status label"
  );
  assert(!/fully paid/i.test(f.overall_payment_status_label), "CD5Q25 not Fully paid");

  const rows = buildFinancialDisplayRows(f, {
    formatMoney: formatFinancialUsd,
    formatDate: formatLongDate
  });
  const byKey = Object.fromEntries(rows.map(r => [r.key, r]));
  assert(moneyIncludes(byKey.cruise_price?.value, "1,816.86"), "display cruise price");
  assert(moneyIncludes(byKey.deposit_paid?.value, "349.86"), "display deposit");
  assert(moneyIncludes(byKey.balance_owing?.value, "1,467.00"), "display balance");
  assert(byKey.payment_status?.value === "Deposit paid — balance outstanding", "display status");

  if (expectDepositDate) {
    assert(f.deposit_paid_date === "2026-07-25", "deposit paid date");
    assert(byKey.deposit_paid_on?.value === "25 July 2026", "display deposit paid on");
  }

  if (expectFinalDue) {
    assert(f.final_payment_due_date === "2026-09-13", "final due 13 Sep");
    assert(f.final_payment_due_unreliable !== true, "final due reliable");
    assert(byKey.final_payment_due?.value === "13 September 2026", "display final due");
    assert(f.final_payment_reminder_date === "2026-08-30", "reminder kept separate");
    assert(
      !rows.some(r => r.key === "final_payment_due" && String(r.value).includes("30 August")),
      "reminder not shown as due"
    );
  }

  return rows;
}

// --- CD5Q25 legacy safeguard (pre-refresh cache) ---
{
  assert(!hasCorrectedNormalisedContract(CD5Q25_LEGACY), "legacy not corrected contract");
  const f = normaliseBookingFinancials(CD5Q25_LEGACY, { now: NOW });
  assert(f.deposit_paid_date == null, "no deposit date until API exposes it");
  assert(f.final_payment_due_unreliable === true, "legacy due unreliable");
  assert(f.notes.includes("blocked_false_fully_paid_from_scheduled_instalments"), "false fully_paid blocked");
  const rows = assertCd5q25Display(f, { expectDepositDate: false, expectFinalDue: false });
  const byKey = Object.fromEntries(rows.map(r => [r.key, r]));
  assert(byKey.final_payment_due?.value === "Check booking confirmation", "due safeguard");
  assert(!rows.some(r => String(r.value).includes("30 August") || String(r.value).includes("2026-08-30")), "no reminder as due");
}

// --- CD5Q25 corrected normalised contract (post-refresh) ---
{
  assert(hasCorrectedNormalisedContract(CD5Q25_CORRECTED), "corrected contract detected");
  const f = normaliseBookingFinancials(CD5Q25_CORRECTED, { now: NOW });
  assert(f.notes.includes("using_corrected_normalised_contract"), "corrected note");
  assert(f.notes.includes("amount_received_from_corrected_api"), "consumes amount_received");
  assert(f.notes.includes("balance_from_corrected_api"), "consumes balance_owing");
  assert(f.notes.includes("mapped_partially_paid_to_deposit_paid_balance_outstanding"), "partially_paid mapped");
  assert(f.amount_received !== 1816.86, "payment_2 not in amount received");
  assertCd5q25Display(f, { expectDepositDate: true, expectFinalDue: true });
}

// --- normalised fields take priority over conflicting legacy raw ---
{
  const f = normaliseBookingFinancials(
    {
      cruise_price_usd: 2000,
      deposit_amount: 100,
      cruise_deposit: 999,
      deposit_paid_date: "2026-01-10",
      cruise_deposit_date: "2026-01-01",
      payment_2_amount: 900,
      cruise_payment_2: 1,
      payment_2_due_date: "2026-09-13",
      cruise_payment_2_date: "2026-01-02",
      payment_3_amount: 50,
      cruise_payment_3: 2,
      payment_3_due_date: "2026-10-01",
      cruise_payment_3_date: "2026-01-03",
      final_payment_due_date_normalised: "2026-09-13",
      final_payment_due_date: "2026-08-30",
      final_payment_reminder_date: "2026-08-30",
      reminder_final_payment_due: "2026-08-01",
      amount_received: 100,
      amount_paid: 2000,
      balance_owing: 950,
      payment_status: "partially_paid"
    },
    { now: NOW }
  );
  assert(f.deposit_amount === 100, "prefer deposit_amount");
  assert(f.deposit_paid_date === "2026-01-10", "prefer deposit_paid_date");
  assert(f.payment_2_amount === 900, "prefer payment_2_amount");
  assert(f.payment_2_due_date === "2026-09-13", "prefer payment_2_due_date");
  assert(f.payment_3_amount === 50, "prefer payment_3_amount");
  assert(f.payment_3_due_date === "2026-10-01", "prefer payment_3_due_date");
  assert(f.final_payment_due_date === "2026-09-13", "prefer final_payment_due_date_normalised");
  assert(f.final_payment_reminder_date === "2026-08-30", "prefer final_payment_reminder_date");
  assert(f.amount_received === 100, "prefer amount_received");
  assert(f.balance_owing === 950, "prefer corrected balance_owing");
  assert(f.overall_payment_status_label === "Deposit paid — balance outstanding", "partially_paid label");
}

// --- final_payment_due_date_normalised recognised ---
{
  const f = normaliseBookingFinancials(
    {
      cruise_price_usd: 1816.86,
      deposit_amount: 349.86,
      deposit_paid_date: "2026-07-25",
      payment_2_amount: 1467,
      amount_received: 349.86,
      balance_owing: 1467,
      payment_status: "partially_paid",
      final_payment_due_date_normalised: "2026-09-13",
      final_payment_due_date: "2026-08-30",
      final_payment_reminder_date: "2026-08-30"
    },
    { now: NOW }
  );
  assert(f.final_payment_due_date === "2026-09-13", "normalised final due");
  assert(f.final_payment_reminder_date === "2026-08-30", "reminder separate");
}

// --- amount_received consumed; payment_2 / payment_3 never counted ---
{
  const f = normaliseBookingFinancials(
    {
      cruise_price_usd: 3000,
      deposit_amount: 500,
      deposit_paid_date: "2026-01-01",
      payment_2_amount: 1000,
      payment_3_amount: 1500,
      payment_2_due_date: "2026-09-01",
      payment_3_due_date: "2026-10-01",
      amount_received: 500,
      amount_paid: 3000,
      balance_owing: 2500,
      payment_status: "partially_paid"
    },
    { now: NOW }
  );
  assert(f.amount_received === 500, "api amount_received");
  assert(f.amount_received !== 3000, "payment_2/3 not received");
  assert(f.balance_owing === 2500, "balance excludes counting instalments as paid");
}

// --- payment_2 / payment_3 never in amount received (legacy) ---
{
  const f = normaliseBookingFinancials(
    {
      cruise_price_usd: 3000,
      cruise_deposit: 500,
      cruise_payment_2: 1000,
      cruise_payment_3: 1500,
      amount_paid: 3000,
      balance_owing: 0,
      payment_status: "fully_paid"
    },
    { now: NOW }
  );
  assert(f.amount_received === 500, "deposit only");
  assert(f.balance_owing === 2500, "both instalments outstanding");
  assert(f.overall_payment_status !== "fully_paid", "not fully paid");
}

// --- null / blank not coerced to zero ---
{
  assert(normaliseBookingFinancials({ cruise_price_usd: 1000, balance_owing: null }).balance_owing == null, "null");
  assert(normaliseBookingFinancials({ cruise_price_usd: 1000, balance_owing: "" }).balance_owing == null, "blank");
}

// --- genuine fully paid without scheduled instalments ---
{
  const f = normaliseBookingFinancials(
    {
      cruise_price_usd: 3640,
      cruise_deposit: 3640,
      cruise_payment_2: null,
      cruise_payment_3: null,
      amount_paid: 3640,
      balance_owing: 0,
      payment_status: "fully_paid",
      fully_paid_date: "2026-02-01"
    },
    { now: NOW }
  );
  assert(f.overall_payment_status === "fully_paid", "genuine fully paid");
  assert(f.balance_owing === 0, "zero balance");
}

// --- confirmed alone never fully paid ---
{
  const f = normaliseBookingFinancials(
    { booking_status: "confirmed", cruise_price_usd: 1000 },
    { now: NOW }
  );
  assert(f.overall_payment_status !== "fully_paid", "confirmed ignored");
}

// --- when cruise_deposit_date present on legacy, show paid on + payment_2 due ---
{
  const f = normaliseBookingFinancials(
    {
      ...CD5Q25_LEGACY,
      cruise_deposit_date: "2026-07-25",
      cruise_payment_2_date: "2026-09-13",
      final_payment_due_date: null
    },
    { now: NOW }
  );
  assert(f.deposit_paid_date === "2026-07-25", "date from API");
  assert(f.final_payment_due_date === "2026-09-13", "authoritative due");
  assert(f.final_payment_due_unreliable !== true, "due reliable");
  const rows = buildFinancialDisplayRows(f, {
    formatMoney: formatFinancialUsd,
    formatDate: formatLongDate
  });
  assert(rows.some(r => r.label === "Deposit paid on" && r.value === "25 July 2026"), "paid on");
  assert(rows.some(r => r.label === "Final payment due" && r.value === "13 September 2026"), "due date");
}

// --- CD5Q25 balance identical before and after refresh ---
{
  const legacy = normaliseBookingFinancials(CD5Q25_LEGACY, { now: NOW });
  const corrected = normaliseBookingFinancials(CD5Q25_CORRECTED, { now: NOW });
  assert(legacy.balance_owing === 1467, "pre-refresh 1467");
  assert(corrected.balance_owing === 1467, "post-refresh 1467");
  assert(legacy.balance_owing === corrected.balance_owing, "balance stable across refresh");
}

// --- dashboard and Booking page remain identical (shared rows) ---
{
  for (const payload of [CD5Q25_LEGACY, CD5Q25_CORRECTED]) {
    const f = normaliseBookingFinancials(payload, { now: NOW });
    const a = buildFinancialDisplayRows(f, { formatMoney: formatFinancialUsd, formatDate: formatLongDate });
    const b = buildFinancialDisplayRows(f, { formatMoney: formatFinancialUsd, formatDate: formatLongDate });
    assert(JSON.stringify(a) === JSON.stringify(b), "identical rows for payload");
  }
  const plannerSrc = readFileSync(path.join(root, "js/planner.js"), "utf8");
  const indexSrc = readFileSync(path.join(root, "index.html"), "utf8");
  assert(/booking-financials\.js/.test(indexSrc), "index loads financials");
  assert(/base44-booking-field-contract\.js/.test(indexSrc), "index loads contract");
  assert(/renderSharedFinancialRows/.test(plannerSrc), "shared renderer");
  assert(/renderDashboardSnapshot[\s\S]*renderSharedFinancialRows/.test(plannerSrc), "snapshot");
  assert(/renderBookingCruiseSection[\s\S]*renderSharedFinancialRows/.test(plannerSrc), "booking");
  assert(!/cacheBookingInSupabase/.test(plannerSrc), "no financial write on page load");
}

// --- push/pull contract still exposes safe fields ---
{
  assert(Contract.SAFE_PAYMENT_PULL_RAW_FIELDS.includes("cruise_deposit_date"), "pull whitelist");
  assert(Contract.SAFE_PUSH_FIELDS.includes("cruise_payment_2_date"), "push whitelist");
  const pull = Contract.buildPullPayload({
    ...CD5Q25_LEGACY,
    cruise_deposit_date: "2026-07-25",
    cruise_payment_2_date: "2026-09-13",
    fully_paid_date: null,
    reminder_final_payment_due: "2026-08-30",
    final_payment_due_date: null
  });
  assert(pull.amount_received === 349.86, "contract amount_received");
  assert(pull.balance_owing === 1467, "contract balance");
  assert(!("passenger1_passport" in pull), "no passport");
}

console.log("test-booking-financials: all assertions passed");
