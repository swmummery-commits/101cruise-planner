/**
 * Deterministic SVG templates for Social Pack slides (1080×1350).
 */

const { escapeXml } = require("./social-pack-copy");

const W = 1080;
const H = 1350;
const GREEN = "#8DD9BF";
const INK = "#111111";
const MUTED = "#4b5563";

function xmlLines(text, { x, y, lineHeight, className, anchor = "start", maxLines = 6 }) {
  const lines = String(text || "").split("\n").filter(Boolean).slice(0, maxLines);
  return lines
    .map((line, i) => {
      const yy = y + i * lineHeight;
      return `<text x="${x}" y="${yy}" text-anchor="${anchor}" class="${className}">${escapeXml(line)}</text>`;
    })
    .join("\n");
}

function brandMark(x, y) {
  return `<text x="${x}" y="${y}" class="brand">101cruise</text>`;
}

function cue(n, total = 3) {
  return `<text x="${W - 48}" y="${H - 36}" text-anchor="end" class="cue">${n} / ${total}</text>`;
}

function baseStyles() {
  return `
    <style>
      .serif { font-family: Georgia, 'Times New Roman', Times, serif; fill: ${INK}; }
      .sans { font-family: Helvetica, Arial, sans-serif; fill: ${INK}; }
      .dest { font-family: Helvetica, Arial, sans-serif; font-size: 22px; letter-spacing: 3px; fill: ${MUTED}; }
      .headline { font-family: Georgia, 'Times New Roman', Times, serif; font-size: 46px; }
      .meta { font-family: Helvetica, Arial, sans-serif; font-size: 22px; fill: ${MUTED}; }
      .brand { font-family: Helvetica, Arial, sans-serif; font-size: 18px; fill: ${MUTED}; }
      .cue { font-family: Helvetica, Arial, sans-serif; font-size: 18px; fill: ${MUTED}; }
      .section { font-family: Helvetica, Arial, sans-serif; font-size: 20px; letter-spacing: 4px; fill: ${MUTED}; }
      .title { font-family: Georgia, 'Times New Roman', Times, serif; font-size: 42px; }
      .price { font-family: Georgia, 'Times New Roman', Times, serif; font-size: 56px; }
      .save { font-family: Helvetica, Arial, sans-serif; font-size: 26px; fill: #245C4E; }
      .cta { font-family: Helvetica, Arial, sans-serif; font-size: 28px; }
      .small { font-family: Helvetica, Arial, sans-serif; font-size: 18px; fill: ${MUTED}; }
      .port { font-family: Helvetica, Arial, sans-serif; font-size: 24px; }
      .accent { fill: ${GREEN}; }
    </style>`;
}

function frame(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  ${baseStyles()}
  ${body}
</svg>`;
}

/**
 * Cover-crop image into a rect (centred).
 */
function coverImage({ href, x, y, width, height, imgW = 1600, imgH = 1200 }) {
  const boxRatio = width / height;
  const imgRatio = imgW / Math.max(1, imgH);
  let dw;
  let dh;
  if (imgRatio > boxRatio) {
    dh = height;
    dw = height * imgRatio;
  } else {
    dw = width;
    dh = width / imgRatio;
  }
  const dx = x + (width - dw) / 2;
  const dy = y + (height - dh) / 2;
  const clipId = `clip${Math.abs(Math.round(x + y + width))}`;
  return `
    <defs>
      <clipPath id="${clipId}"><rect x="${x}" y="${y}" width="${width}" height="${height}"/></clipPath>
    </defs>
    <image href="${href}" x="${dx}" y="${dy}" width="${dw}" height="${dh}" clip-path="url(#${clipId})" preserveAspectRatio="xMidYMid slice"/>
  `;
}

function renderHeroSvg(model) {
  const imageBlock = model.heroDataUri
    ? coverImage({
        href: model.heroDataUri,
        x: 48,
        y: 280,
        width: W - 96,
        height: 820,
        imgW: model.heroWidth || 1600,
        imgH: model.heroHeight || 1200
      })
    : `<rect x="48" y="280" width="${W - 96}" height="820" fill="#f3f4f6"/>`;

  const body = `
    <rect x="0" y="0" width="${W}" height="12" class="accent"/>
    <text x="54" y="72" class="dest">${escapeXml(model.destinationStrip || "")}</text>
    ${xmlLines(model.headlineShort || "", { x: 54, y: 140, lineHeight: 54, className: "headline" })}
    ${imageBlock}
    <text x="54" y="1160" class="meta">${escapeXml(model.dateRange || "")}</text>
    <text x="54" y="1200" class="meta">${escapeXml(
      [model.lineName, model.shipName].filter(Boolean).join(" · ").toUpperCase()
    )}</text>
    ${brandMark(54, H - 36)}
    ${cue(1)}
  `;
  return frame(body);
}

function renderJourneySvg(model) {
  const ports = model.ports || [];
  const portLines = ports.map((p, i) => `${i === 0 ? "•" : "•"} ${p}`).join("\n");
  const more =
    model.portsTruncated && model.portsOmitted
      ? `\n+ ${model.portsOmitted} more`
      : "";

  let media = "";
  if (model.routeMapDataUri) {
    media = coverImage({
      href: model.routeMapDataUri,
      x: 54,
      y: 220,
      width: W - 108,
      height: 620,
      imgW: model.routeMapWidth || 1600,
      imgH: model.routeMapHeight || 1000
    });
  } else {
    media = `
      <rect x="54" y="220" width="${W - 108}" height="420" fill="#f8faf9" stroke="${GREEN}" stroke-width="2"/>
      ${xmlLines(portLines + more, { x: 90, y: 290, lineHeight: 42, className: "port", maxLines: 9 })}
    `;
  }

  const listY = model.routeMapDataUri ? 880 : 680;
  const listBlock = model.routeMapDataUri
    ? xmlLines(portLines + more, { x: 54, y: listY, lineHeight: 36, className: "port", maxLines: 7 })
    : "";

  const body = `
    <rect x="0" y="0" width="${W}" height="12" class="accent"/>
    <text x="54" y="72" class="section">THE JOURNEY</text>
    <text x="54" y="130" class="title">${escapeXml(model.durationLabel || "")}</text>
    <text x="54" y="180" class="meta">${escapeXml(model.journeyLine || "")}</text>
    ${media}
    ${listBlock}
    <text x="54" y="1240" class="meta">${escapeXml(model.dateRange || "")}</text>
    ${brandMark(54, H - 36)}
    ${cue(2)}
  `;
  return frame(body);
}

function renderOfferSvg(model) {
  const offer = model.offer;
  let priceBlock = "";
  if (offer) {
    priceBlock = `
      <text x="54" y="280" class="meta">${escapeXml(offer.roomLabel || "")}</text>
      <text x="54" y="360" class="price">${escapeXml(offer.priceLabel || "")}</text>
      ${
        offer.greatDeal
          ? `<text x="54" y="420" class="save">GREAT DEAL${offer.percentLabel ? ` · ${escapeXml(offer.percentLabel)}` : ""}</text>`
          : offer.saveLabel
            ? `<text x="54" y="420" class="save">${escapeXml(offer.saveLabel)}${
                offer.percentLabel ? ` · ${escapeXml(offer.percentLabel)}` : ""
              }</text>`
            : ""
      }
      ${offer.perDayLabel ? `<text x="54" y="470" class="small">${escapeXml(offer.perDayLabel)}</text>` : ""}
    `;
  } else {
    priceBlock = `
      <text x="54" y="320" class="price">ASK PAUL FOR</text>
      <text x="54" y="400" class="price">HIS BEST PRICE</text>
    `;
  }

  const inclusions = (model.inclusions || []).slice(0, 4);
  const inclusionText = inclusions.map((i) => `• ${i}`).join("\n");
  const other = model.otherLine
    ? `<text x="54" y="780" class="small">${escapeXml(model.otherLine)}</text>`
    : "";

  const body = `
    <rect x="0" y="0" width="${W}" height="12" class="accent"/>
    <text x="54" y="72" class="section">THE OFFER</text>
    <text x="54" y="140" class="title">${escapeXml(model.destinationStrip || "")}</text>
    ${priceBlock}
    <text x="54" y="560" class="section">INCLUDES</text>
    ${xmlLines(inclusionText || "• Ask Paul for inclusions", { x: 54, y: 620, lineHeight: 40, className: "port", maxLines: 4 })}
    ${other}
    <rect x="54" y="860" width="${W - 108}" height="2" fill="${GREEN}"/>
    <text x="54" y="940" class="cta">Message Paul for details</text>
    <text x="54" y="990" class="meta">101cruise.com.au</text>
    <text x="54" y="1120" class="small">All prices are per person in USD and subject to availability</text>
    ${brandMark(54, H - 36)}
    ${cue(3)}
  `;
  return frame(body);
}

module.exports = {
  WIDTH: W,
  HEIGHT: H,
  renderHeroSvg,
  renderJourneySvg,
  renderOfferSvg
};
