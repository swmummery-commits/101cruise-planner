/**
 * Airline-staff savings for promotional Social Pack templates.
 * Dollar and percentage are both calculated. The admin chooses which one to show.
 */

const { parsePrice, formatMoney, sortPricingRows } = require("./social-pack-pricing");

function normaliseSavingsDisplay(value) {
  const key = String(value || "percentage")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (key === "dollar" || key === "dollars" || key === "dollar_saving" || key === "amount") {
    return "dollar";
  }
  return "percentage";
}

/**
 * Retail fare and airline staff fare must both be present.
 * Percentage is rounded to the nearest whole number.
 */
function computeFareSavings(retail, staff) {
  const retailFare = parsePrice(retail);
  const staffFare = parsePrice(staff);
  const base = {
    available: false,
    retailFare,
    staffFare,
    dollarSaving: null,
    percentSaving: null,
    percentLabel: "",
    dollarLabel: ""
  };
  if (retailFare == null || staffFare == null || retailFare <= 0) return base;
  const dollarSaving = retailFare - staffFare;
  const percentSaving = Math.round((dollarSaving / retailFare) * 100);
  return {
    available: true,
    retailFare,
    staffFare,
    dollarSaving,
    percentSaving,
    percentLabel: `SAVE ${percentSaving}%`,
    dollarLabel: `SAVE $${formatMoney(dollarSaving)}`
  };
}

function savingsLabel(savings, display) {
  if (!savings?.available) return "";
  if (savings.dollarSaving == null || savings.dollarSaving <= 0) return "";
  return normaliseSavingsDisplay(display) === "dollar" ? savings.dollarLabel : savings.percentLabel;
}

/** First priced cabin (display order) that has an airline staff fare. */
function selectStaffFare(rows) {
  const sorted = sortPricingRows(rows);
  for (const row of sorted) {
    const staffFare = parsePrice(row.airline_price);
    if (staffFare == null) continue;
    const retailFare = parsePrice(row.brochure_price);
    return {
      roomLabel: String(row.room_label || "").trim(),
      retailFare,
      staffFare,
      savings: computeFareSavings(retailFare, staffFare)
    };
  }
  return null;
}

module.exports = {
  normaliseSavingsDisplay,
  computeFareSavings,
  savingsLabel,
  selectStaffFare
};
