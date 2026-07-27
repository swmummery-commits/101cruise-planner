# Base44 booking finance source fix

This folder is the **canonical corrected finance helper** for Base44 integration functions:

- `bookingFinance.js` — shared derive/apply helper
- `getBookingFor101Cruise.snippet.js` — pull response adapter
- `pushBookingTo101Cruise.snippet.js` — push payload adapter

## Business rules

| Field | Meaning |
|---|---|
| `cruise_price_usd` | Total cruise price |
| `cruise_deposit` / `deposit_amount` | Confirmed deposit received |
| `cruise_deposit_date` / `deposit_paid_date` | Deposit receipt date |
| `cruise_payment_2` / `payment_2_amount` | Scheduled instalment amount |
| `cruise_payment_2_date` / `payment_2_due_date` | Scheduled due date (not received) |
| `reminder_*` | Reminder only — never a due date |

Scheduled instalments must never be counted as received merely because amount + date are populated.

## Fully-paid rule

Do **not** auto-stamp `fully_paid_date` from:

- `cruise_deposit + cruise_payment_2 + cruise_payment_3`
- `booking_status = confirmed`
- scheduled due dates
- reminder dates

Fully paid requires independent receipt evidence such as:

- `payment_2_received_amount` / `payment_2_received_date`
- `payment_3_received_amount` / `payment_3_received_date`
- `final_payment_received_amount` / `final_payment_received_date`

Those receipt fields are **not present** on current CruiseBooking payloads. Until they exist in Base44 CRM, keep outstanding balances and never auto-stamp fully paid from the schedule.

## Deploy into Base44

1. Copy `bookingFinance.js` into the Base44 app as a shared function/module.
2. Update `getBookingFor101Cruise` to call `applyBookingFinance(booking)` before returning.
3. Update `pushBookingTo101Cruise` to use the same helper.
4. Disable / rewrite any CruiseBooking create/update automation that stamps `fully_paid_date` from deposit + scheduled instalments.
5. Do **not** bulk-clear existing `fully_paid_date` values in this deploy.

## Validate CD5Q25 in memory

```bash
node scripts/validate-base44-booking-finance.mjs
```

Expected:

- `amount_received = 349.86`
- `balance_owing = 1467`
- `payment_status = partially_paid`
- `fully_paid_date = null`
- final due `2026-09-13`
- reminder `2026-08-30`
