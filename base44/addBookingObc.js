/**
 * Add Booking OBC payload helpers.
 * Paste the matching fields into src/pages/AddBooking.jsx (lives in Base44).
 * Do not rename on_board_credit_usd — it is a legacy amount field.
 */

const OBC_CURRENCY_OPTIONS = ["USD", "AUD", "EUR"];

const OBC_FORM_DEFAULTS = {
  on_board_credit_usd: "",
  on_board_credit_1_currency: "USD",
  on_board_credit_2_amount: "",
  on_board_credit_2_currency: "USD"
};

function parseSubmittedObcAmount(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

function normalizeSubmittedObcCurrency(value) {
  const text = String(value || "").trim().toUpperCase();
  return text || "USD";
}

function buildAddBookingObcPayload(form = {}) {
  return {
    on_board_credit_usd: parseSubmittedObcAmount(form.on_board_credit_usd),
    on_board_credit_1_currency: normalizeSubmittedObcCurrency(form.on_board_credit_1_currency),
    on_board_credit_2_amount: parseSubmittedObcAmount(form.on_board_credit_2_amount),
    on_board_credit_2_currency: normalizeSubmittedObcCurrency(form.on_board_credit_2_currency)
  };
}

module.exports = {
  OBC_CURRENCY_OPTIONS,
  OBC_FORM_DEFAULTS,
  parseSubmittedObcAmount,
  buildAddBookingObcPayload
};
