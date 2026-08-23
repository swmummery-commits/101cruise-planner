/**
 * Base44 generateBookingPdf — multi-currency OBC
 *
 * Live function (outside this repo):
 *   base44/functions/generateBookingPdf/entry.ts
 *
 * Current (wrong) behaviour:
 *   ['Onboard Credit', formatCurrency(booking.on_board_credit_usd)]
 *   formatCurrency() always emits `$`, ignores OBC #2, and can print `$0.00`.
 *
 * Replace that single row with buildOnBoardCreditPdfRows() from bookingFinance
 * (copied into the Base44 app). Cruise price / commission stay USD unless
 * their established schema already says otherwise.
 */

const { buildOnBoardCreditPdfRows, formatOnBoardCreditLabel } = require("./bookingFinance");

/**
 * Exact replacement for the OBC row(s) in the PDF details table.
 *
 * Before:
 *   ['Onboard Credit', formatCurrency(booking.on_board_credit_usd)]
 *
 * After — splice these rows in. Empty when no genuine positive OBC exists.
 */
function getOnBoardCreditPdfRows(booking = {}) {
  return buildOnBoardCreditPdfRows(booking);
}

module.exports = {
  getOnBoardCreditPdfRows,
  formatOnBoardCreditLabel,
  buildOnBoardCreditPdfRows
};
