/**
 * Caption text for social carousel posts.
 */

const { formatAuDateRange, normaliseWhitespace } = require("./social-pack-copy");

function buildCaption(model) {
  const lines = [];
  const opening = normaliseWhitespace(model.shortEditorial || model.headlineShort || model.headline || "");
  if (opening) lines.push(opening, "");

  const facts = [
    [model.lineName, model.shipName].filter(Boolean).join(" · "),
    model.dateRange || formatAuDateRange(model.departureDate, model.returnDate),
    model.durationLabel ? `${model.nights} nights` : "",
    model.journeyLine || ""
  ].filter(Boolean);
  if (facts.length) {
    lines.push(...facts, "");
  }

  if (model.ports?.length) {
    const highlight = model.ports.slice(0, 6).join(" · ");
    lines.push(`Itinerary highlights: ${highlight}${model.portsTruncated ? " …" : ""}`, "");
  }

  if (model.offer) {
    lines.push(
      `${model.offer.roomLabel}: ${model.offer.priceLabel}${
        model.offer.saveLabel ? ` (${model.offer.saveLabel})` : ""
      }`
    );
    if (model.inclusions?.length) {
      lines.push(`Includes: ${model.inclusions.join(", ")}`);
    }
    lines.push("");
  } else {
    lines.push("Ask Paul for his best price.", "");
  }

  lines.push("Message Paul for details or visit 101cruise.com.au.", "");
  lines.push("All prices are per person in USD and subject to availability.");
  return lines.join("\n");
}

module.exports = { buildCaption };
