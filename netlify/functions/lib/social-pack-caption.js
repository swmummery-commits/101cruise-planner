/**
 * Caption text for social carousel posts.
 * Public room prices and inclusions only — never airline / category / internal URLs.
 */

const { formatAuDateRange, normaliseWhitespace } = require("./social-pack-copy");

function buildCaption(model) {
  const lines = [];
  const opening = normaliseWhitespace(
    model.journeyLine || model.destinationStrip || model.headlineShort || ""
  );
  if (opening) lines.push(opening, "");

  const shipLine = [model.lineName, model.shipName].filter(Boolean).join(" · ");
  if (shipLine) lines.push(shipLine);

  const dates = model.dateRange || formatAuDateRange(model.departureDate, model.returnDate);
  const duration = model.nights != null ? `${model.nights} nights` : model.durationLabel || "";
  const dateLine = [dates, duration].filter(Boolean).join(" · ");
  if (dateLine) lines.push(dateLine, "");

  if (model.ports?.length) {
    const highlight = model.ports.slice(0, 6).join(" · ");
    lines.push(`Itinerary highlights: ${highlight}${model.portsTruncated ? " …" : ""}`, "");
  }

  if (model.offers?.length) {
    for (const offer of model.offers) {
      const label = offer.roomLabelDisplay || offer.roomLabel || "Room";
      lines.push(`${label}: ${offer.priceLabelFrom || offer.priceLabel}`);
    }
    if (model.inclusions?.length) {
      lines.push(`Includes: ${model.inclusions.join(", ")}`);
    }
    lines.push("");
  } else {
    lines.push("Ask Paul for his best price.", "");
  }

  lines.push("Email Paul at paul@101cruise.com.au for details.");
  lines.push("101cruise.com.au");
  lines.push("");
  lines.push("All prices are per person in USD and subject to availability.");
  return lines.join("\n");
}

module.exports = { buildCaption };
