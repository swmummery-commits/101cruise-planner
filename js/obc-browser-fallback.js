/*
 * My Cruise OBC browser compatibility layer.
 *
 * The normal renderer lives in base44-booking-field-contract.js. This file
 * deliberately does one thing only: if that renderer is unavailable or
 * returns an empty string even though the booking payload contains valid OBC,
 * render the OBC section directly from the canonical array/raw CRM fields.
 *
 * Never sums or converts currencies. Never changes booking finance.
 */
(function (root, factory) {
  "use strict";

  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
    return;
  }

  const contract = root.Base44BookingFieldContract || {};
  const originalRenderer =
    typeof contract.renderOnBoardCreditsSectionHtml === "function"
      ? contract.renderOnBoardCreditsSectionHtml.bind(contract)
      : null;

  contract.renderOnBoardCreditsSectionHtml = function (booking, options) {
    if (originalRenderer) {
      try {
        const html = originalRenderer(booking, options);
        if (html) return html;
      } catch (error) {
        console.warn("Primary OBC renderer failed; using browser fallback", error);
      }
    }
    return api.renderOnBoardCreditsSectionHtml(booking, options);
  };

  if (typeof contract.normalizeOnBoardCredits !== "function") {
    contract.normalizeOnBoardCredits = api.normalizeOnBoardCredits;
  }
  if (typeof contract.formatOnBoardCreditLabel !== "function") {
    contract.formatOnBoardCreditLabel = api.formatOnBoardCreditLabel;
  }

  root.Base44BookingFieldContract = contract;
  root.MyCruiseObcBrowserFallback = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const EPSILON = 0.02;

  function parsePositiveAmount(value) {
    if (value === null || value === undefined) return null;
    const text = typeof value === "number"
      ? String(value)
      : String(value).trim().replace(/,/g, "").replace(/[^0-9.-]/g, "");
    if (!text) return null;
    const amount = Number(text);
    if (!Number.isFinite(amount) || amount <= EPSILON) return null;
    return Math.round(amount * 100) / 100;
  }

  function normalizeCurrency(value, fallback = "USD") {
    const text = String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    return text || fallback;
  }

  function normalizeEntry(amount, currency) {
    const parsed = parsePositiveAmount(amount);
    if (parsed === null) return null;
    return { amount: parsed, currency: normalizeCurrency(currency) };
  }

  function normalizeOnBoardCredits(booking) {
    const source = booking && typeof booking === "object" ? booking : {};

    if (Array.isArray(source.on_board_credits)) {
      const fromArray = source.on_board_credits
        .map((item) => item && typeof item === "object" ? normalizeEntry(item.amount, item.currency) : null)
        .filter(Boolean);
      if (fromArray.length) return fromArray;
    }

    const credits = [];
    const first = normalizeEntry(source.on_board_credit_usd, source.on_board_credit_1_currency);
    const second = normalizeEntry(source.on_board_credit_2_amount, source.on_board_credit_2_currency);
    if (first) credits.push(first);
    if (second) credits.push(second);
    return credits;
  }

  function formatOnBoardCreditLabel(credit) {
    if (!credit) return "";
    const amount = parsePositiveAmount(credit.amount);
    if (amount === null) return "";
    const currency = normalizeCurrency(credit.currency, "");
    if (!currency) return "";
    return `${currency} ${amount.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })}`;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderOnBoardCreditsSectionHtml(booking, options) {
    const credits = normalizeOnBoardCredits(booking);
    if (!credits.length) return "";

    const opts = options && typeof options === "object" ? options : {};
    const headingTag = opts.headingTag === "h4" ? "h4" : "h3";
    const extraClass = opts.extraClass ? ` ${String(opts.extraClass)}` : "";
    const escape = typeof opts.escapeHtml === "function" ? opts.escapeHtml : escapeHtml;
    const tags = credits
      .map((credit) => `<span class="dashboard-snapshot-extras-tag">${escape(formatOnBoardCreditLabel(credit))}</span>`)
      .join("");

    return `
    <section class="dashboard-snapshot-extras dashboard-snapshot-obc${extraClass}" data-obc-renderer="browser-fallback">
      <${headingTag} class="dashboard-snapshot-extras-title">On-board credit</${headingTag}>
      <div class="dashboard-snapshot-extras-tags">${tags}</div>
    </section>
  `;
  }

  return {
    normalizeOnBoardCredits,
    formatOnBoardCreditLabel,
    renderOnBoardCreditsSectionHtml
  };
});
