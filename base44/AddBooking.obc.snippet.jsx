/**
 * Base44 Add Booking — On-board credit fields
 *
 * Live page (outside this repo): src/pages/AddBooking.jsx
 *
 * Edit Booking already has OBC #1 + #2 with currency selectors.
 * Add Booking currently only has a single "On Board Credit (USD)" amount.
 * Bring Add Booking into line with Edit Booking. Do NOT rename
 * on_board_credit_usd — existing CruiseBooking records depend on it.
 *
 * Currencies must match the CRM options: USD / AUD / EUR.
 */

// Payload helpers live in ./addBookingObc.js (require-able from tests).
const OBC_CURRENCY_OPTIONS = ["USD", "AUD", "EUR"];

/**
 * JSX to paste into AddBooking in place of the single
 * "On Board Credit (USD)" amount field.
 *
 * Align currency + amount on the same baseline (38px admin controls).
 */
export function AddBookingOnBoardCreditFields({ form, onChange }) {
  return (
    <div className="admin-obc-fields">
      <div className="featured-details-row" style={{ display: "grid", alignItems: "end", gap: 12 }}>
        <label className="admin-field">
          <span>On Board Credit #1 currency</span>
          <select
            name="on_board_credit_1_currency"
            value={form.on_board_credit_1_currency || "USD"}
            onChange={onChange}
          >
            {OBC_CURRENCY_OPTIONS.map((code) => (
              <option key={code} value={code}>{code}</option>
            ))}
          </select>
        </label>
        <label className="admin-field">
          <span>On Board Credit #1 amount</span>
          <input
            type="number"
            name="on_board_credit_usd"
            min="0"
            step="0.01"
            value={form.on_board_credit_usd}
            onChange={onChange}
          />
        </label>
      </div>
      <div className="featured-details-row" style={{ display: "grid", alignItems: "end", gap: 12 }}>
        <label className="admin-field">
          <span>On Board Credit #2 currency</span>
          <select
            name="on_board_credit_2_currency"
            value={form.on_board_credit_2_currency || "USD"}
            onChange={onChange}
          >
            {OBC_CURRENCY_OPTIONS.map((code) => (
              <option key={code} value={code}>{code}</option>
            ))}
          </select>
        </label>
        <label className="admin-field">
          <span>On Board Credit #2 amount</span>
          <input
            type="number"
            name="on_board_credit_2_amount"
            min="0"
            step="0.01"
            value={form.on_board_credit_2_amount}
            onChange={onChange}
          />
        </label>
      </div>
    </div>
  );
}
