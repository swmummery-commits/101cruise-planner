/**
 * Base44 function snippet — pushBookingTo101Cruise
 *
 * Paste/adapt into the Base44 app function. Uses the same shared bookingFinance
 * helper as getBookingFor101Cruise so pull and push never diverge.
 *
 * Must not persist calculated amount_received / balance_owing / payment_status
 * back onto the CruiseBooking entity from this path.
 *
 * Live function path (outside this repo):
 *   base44/functions/pushBookingTo101Cruise/entry.ts
 *
 * The outbound payload MUST preserve:
 *   on_board_credit_usd
 *   on_board_credit_1_currency
 *   on_board_credit_2_amount
 *   on_board_credit_2_currency
 *   on_board_credits
 *
 * so create/update pushes cannot cache a booking that is missing OBC.
 */

const { applyBookingFinance, normalizeOnBoardCredits } = require("./bookingFinance");
const Contract = require("../js/base44-booking-field-contract");

function buildPushBookingPayload(rawBooking) {
  const financed = applyBookingFinance(rawBooking || {});
  const payload = Contract.buildPushPayload(financed);
  payload.on_board_credits = normalizeOnBoardCredits(financed);
  return payload;
}

module.exports = {
  buildPushBookingPayload
};
