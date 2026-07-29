/**
 * Caption text for social carousel posts.
 * Cruise description and details only — no prices, contact lines, airline, or category.
 */

const { formatAuDateRange, normaliseWhitespace } = require("./social-pack-copy");

function buildCaption(model) {
  const lines = [];

  const description = normaliseWhitespace(model.shortEditorial || model.headline || "");
  if (description) lines.push(description, "");

  const route = normaliseWhitespace(model.journeyLine || model.destinationStrip || "");
  if (route) lines.push(route);

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
    lines.push(`Includes: ${model.inclusions.join(", ")}`);
  }

  return lines.join("\n").trim();
}

module.exports = { buildCaption };
