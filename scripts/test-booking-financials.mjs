/**
 * Offline tests for Client Portal financial safeguard (legacy Base44 payload).
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
  formatFinancialUsd
} = require("../js/booking-financials.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function moneyIncludes(value, amountText) {
  return String(value || "").includes(amountText);
}

const NOW = "2026-07-26T00:00:00.000Z";

/** Current legacy getBookingFor101Cruise payload for CD5Q25. */
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

const formatLongDate = iso => {
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
};

// --- CD5Q25 legacy safeguard display ---
{
  const f = normaliseBookingFinancials(CD5Q25_LEGACY, { now: NOW });
  assert(f.cruise_price_amount === 1816.86, "cents retained");
  assert(f.amount_received === 349.86, "amount received is deposit only");
  assert(f.amount_received !== 1816.86, "payment_2 not in amount received");
  assert(f.balance_owing === 1467, "balance 1467");
  assert(f.deposit_status === "paid", "deposit paid from cruise_deposit");
  assert(f.deposit_paid_amount === 349.86, "deposit 349.86");
  assert(f.deposit_paid_date == null, "no deposit date until API exposes it");
  assert(f.final_payment_due_unreliable === true, "legacy due unreliable");
  assert(
    f.overall_payment_status_label === "Deposit paid — balance outstanding",
    "status"
  );
  assert(!/fully paid/i.test(f.overall_payment_status_label), "not Fully paid");

  const rows = buildFinancialDisplayRows(f, {
    formatMoney: formatFinancialUsd,
    formatDate: formatLongDate
  });
  const byKey = Object.fromEntries(rows.map(r => [r.key, r]));
  assert(moneyIncludes(byKey.cruise_price?.value, "1,816.86"), "cruise price");
  assert(moneyIncludes(byKey.deposit_paid?.value, "349.86"), "deposit paid");
  assert(!byKey.deposit_paid_on, "no deposit paid on without API date");
  assert(moneyIncludes(byKey.balance_owing?.value, "1,467.00"), "balance");
  assert(byKey.final_payment_due?.value === "Check booking confirmation", "due safeguard");
  assert(!rows.some(r => String(r.value).includes("30 August") || String(r.value).includes("2026-08-30")), "no reminder as due");
  assert(byKey.payment_status?.value === "Deposit paid — balance outstanding", "status row");
}

// --- payment_2 / payment_3 never in amount received ---
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

// --- when cruise_deposit_date present, show paid on ---
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

// --- shared normaliser wiring ---
{
  const f = normaliseBookingFinancials(CD5Q25_LEGACY, { now: NOW });
  const a = buildFinancialDisplayRows(f, { formatMoney: formatFinancialUsd });
  const b = buildFinancialDisplayRows(f, { formatMoney: formatFinancialUsd });
  assert(JSON.stringify(a) === JSON.stringify(b), "identical rows");
  const plannerSrc = readFileSync(path.join(root, "js/planner.js"), "utf8");
  const indexSrc = readFileSync(path.join(root, "index.html"), "utf8");
  assert(/booking-financials\.js/.test(indexSrc), "index loads financials");
  assert(/base44-booking-field-contract\.js/.test(indexSrc), "index loads contract");
  assert(/renderSharedFinancialRows/.test(plannerSrc), "shared renderer");
  assert(/renderDashboardSnapshot[\s\S]*renderSharedFinancialRows/.test(plannerSrc), "snapshot");
  assert(/renderBookingCruiseSection[\s\S]*renderSharedFinancialRows/.test(plannerSrc), "booking");
  assert(!/cacheBookingInSupabase/.test(plannerSrc), "no financial write on page load");
}

console.log("test-booking-financials: all assertions passed");
