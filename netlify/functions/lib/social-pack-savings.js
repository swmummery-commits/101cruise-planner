/**
 * Public 101 Cruise savings for promotional Social Pack templates.
 * Dollar and percentage are both calculated from brochure/retail price versus
 * the public 101 Cruise price. Airline/staff pricing must never be used here.
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

/** First priced cabin (display order) that has a public 101 Cruise fare. */
function selectPromoFare(rows) {
  const sorted = sortPricingRows(rows);
  for (const row of sorted) {
    const cruise101Fare = parsePrice(row.cruise_101_price);
    if (cruise101Fare == null) continue;
    const retailFare = parsePrice(row.brochure_price);
    return {
      roomLabel: String(row.room_label || "").trim(),
      retailFare,
      cruise101Fare,
      savings: computeFareSavings(retailFare, cruise101Fare)
    };
  }
  return null;
}

module.exports = {
  normaliseSavingsDisplay,
  computeFareSavings,
  savingsLabel,
  selectPromoFare
};
