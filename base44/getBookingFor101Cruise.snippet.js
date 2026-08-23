/**
 * Base44 function snippet — getBookingFor101Cruise
 *
 * Paste/adapt into the Base44 app function. Requires shared bookingFinance helper
 * to be available in the Base44 function runtime (same app).
 *
 * Rules enforced by applyBookingFinance():
 * - amount_received = confirmed deposit only (unless independent later receipts)
 * - balance_owing = outstanding scheduled instalments when still owing
 * - payment_status = partially_paid (not fully_paid) while instalments remain
 * - fully_paid_date omitted/null when contradictory
 * - reminder dates never mapped into due-date fields
 * - on_board_credits is built from the four raw OBC fields (never summed)
 *
 * This function must NOT write calculated finance fields back onto CruiseBooking.
 *
 * Live function path (outside this repo):
 *   base44/functions/getBookingFor101Cruise/entry.ts
 *
 * The live response is an explicit whitelist. It MUST include:
 *   on_board_credit_usd
 *   on_board_credit_1_currency
 *   on_board_credit_2_amount
 *   on_board_credit_2_currency
 *   on_board_credits
 *
 * Do not spread the full CruiseBooking entity (passports, notes, commission stay out).
 */

// Pseudo-structure for Base44 function authors:
//
// import { applyBookingFinance, normalizeOnBoardCredits } from "./bookingFinance";
//
// const OBC_FIELDS = [
//   "on_board_credit_usd",
//   "on_board_credit_1_currency",
//   "on_board_credit_2_amount",
//   "on_board_credit_2_currency",
//   "on_board_credits"
// ];
//
// export default async function getBookingFor101Cruise(req) {
//   const booking = await CruiseBooking.get(...);
//   const documents = await CruiseDocument.filter({ booking_id: booking.id });
//   const safeBooking = applyBookingFinance(booking);
//   return {
//     booking: {
//       ...pickCoreFields(safeBooking),
//       ...pickPaymentFields(safeBooking),
//       on_board_credit_usd: safeBooking.on_board_credit_usd,
//       on_board_credit_1_currency: safeBooking.on_board_credit_1_currency,
//       on_board_credit_2_amount: safeBooking.on_board_credit_2_amount,
//       on_board_credit_2_currency: safeBooking.on_board_credit_2_currency,
//       on_board_credits: normalizeOnBoardCredits(safeBooking),
//       documents: documents.map(mapDocument)
//     }
//   };
// }

const { applyBookingFinance, normalizeOnBoardCredits } = require("./bookingFinance");
const Contract = require("../js/base44-booking-field-contract");

function buildGetBookingResponse(rawBooking, documents = []) {
  const financed = applyBookingFinance(rawBooking || {});
  const booking = Contract.buildPullPayload(financed, documents);
  booking.on_board_credits = normalizeOnBoardCredits(financed);
  return { booking };
}

module.exports = {
  buildGetBookingResponse
};
