/**
 * Base44 function snippet — pushBookingTo101Cruise
 *
 * Paste/adapt into the Base44 app function. Uses the same shared bookingFinance
 * helper as getBookingFor101Cruise so pull and push never diverge.
 *
 * Must not persist calculated amount_received / balance_owing / payment_status
 * back onto the CruiseBooking entity from this path.
 */

const { applyBookingFinance } = require("./bookingFinance");

function buildPushBookingPayload(rawBooking) {
  return applyBookingFinance(rawBooking || {});
}

module.exports = {
  buildPushBookingPayload
};
