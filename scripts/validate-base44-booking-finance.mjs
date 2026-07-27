/**
 * In-memory validation of Base44 bookingFinance helper against CD5Q25.
 * Run: node scripts/validate-base44-booking-finance.mjs
 */

import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { applyBookingFinance } = require("../base44/bookingFinance.js");
const { derivePaymentFields } = require("../js/base44-booking-field-contract.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const CD5Q25_CONTRADICTORY = {
  booking_reference: "CD5Q25",
  booking_status: "confirmed",
  cruise_price_usd: 1816.86,
  cruise_deposit: 349.86,
  cruise_deposit_date: "2026-07-25",
  cruise_payment_2: 1467,
  cruise_payment_2_date: "2026-09-13",
  cruise_payment_3: null,
  fully_paid_date: "2026-07-27",
  deposit_amount: 349.86,
  deposit_paid_date: "2026-07-25",
  payment_2_amount: 1467,
  payment_2_due_date: "2026-09-13",
  final_payment_due_date_normalised: "2026-09-13",
  final_payment_reminder_date: "2026-08-30",
  reminder_final_payment_due: "2026-08-30",
  amount_received: 1816.86,
  balance_owing: 0,
  payment_status: "fully_paid"
};

const applied = applyBookingFinance(CD5Q25_CONTRADICTORY);
const derived = derivePaymentFields(CD5Q25_CONTRADICTORY);

for (const [label, result] of [
  ["base44/bookingFinance", applied],
  ["js/base44-booking-field-contract", derived]
]) {
  assert(result.amount_received === 349.86, `${label}: amount_received`);
  assert(result.balance_owing === 1467, `${label}: balance_owing`);
  assert(result.payment_status === "partially_paid", `${label}: payment_status`);
  assert(result.fully_paid_date == null, `${label}: fully_paid_date null`);
  assert(result.final_payment_due_date === "2026-09-13", `${label}: final due`);
  assert(
    result.final_payment_reminder_date === "2026-08-30" ||
      result.reminder_final_payment_due === "2026-08-30",
    `${label}: reminder`
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      amount_received: applied.amount_received,
      balance_owing: applied.balance_owing,
      payment_status: applied.payment_status,
      fully_paid_date: applied.fully_paid_date,
      final_payment_due_date: applied.final_payment_due_date,
      final_payment_reminder_date: applied.final_payment_reminder_date,
      meta: applied._meta
    },
    null,
    2
  )
);
console.log("validate-base44-booking-finance: ok");
