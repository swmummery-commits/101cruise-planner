/**
 * Caption text for social carousel posts.
 * Cruise details and inclusions only — no room prices, airline, category, or internal URLs.
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

  if (model.inclusions?.length) {
    lines.push(`Includes: ${model.inclusions.join(", ")}`, "");
  }

  lines.push("Email Paul at paul@101cruise.com.au for details.");
  lines.push("101cruise.com.au");
  return lines.join("\n");
}

module.exports = { buildCaption };
