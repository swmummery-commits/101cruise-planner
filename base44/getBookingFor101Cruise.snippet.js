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
 *
 * This function must NOT write calculated finance fields back onto CruiseBooking.
 */

// Pseudo-structure for Base44 function authors:
//
// import { applyBookingFinance } from "./bookingFinance";
//
// export default async function getBookingFor101Cruise(req) {
//   const booking = await CruiseBooking.get(...);
//   const documents = await CruiseDocument.filter({ booking_id: booking.id });
//   const safeBooking = applyBookingFinance(booking);
//   return {
//     booking: {
//       ...pickCoreFields(safeBooking),
//       ...pickPaymentFields(safeBooking),
//       documents: documents.map(mapDocument)
//     }
//   };
// }

const { applyBookingFinance } = require("./bookingFinance");

function buildGetBookingResponse(rawBooking, documents = []) {
  const booking = applyBookingFinance(rawBooking || {});
  return {
    booking: {
      ...booking,
      documents
    }
  };
}

module.exports = {
  buildGetBookingResponse
};
