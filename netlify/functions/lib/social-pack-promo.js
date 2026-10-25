/**
 * Promotional Social Pack templates.
 * Square 1080×1080 and portrait 1080×1350, using the existing route-map renderer
 * and the existing social-pack raster/export path.
 */

const { escapeXml } = require("./social-pack-copy");
const { FAMILY } = require("./social-pack-fonts");
const { formatMoney } = require("./social-pack-pricing");
const { savingsLabel } = require("./social-pack-savings");
const { templateSlug } = require("./social-pack-template");
const { normaliseRouteMapStyle } = require("./route-map-style");
const { renderRouteMapSvg } = require("./route-map-svg");

const RED = "#F80020";
const GREEN = "#8DD9BF";
const INK = "#12181D";
const PAPER = "#F6F3EC";
const MUTED = "#5E6B74";
const WHITE = "#FFFFFF";

const FORMATS = {
  square: { width: 1080, height: 1080 },
  portrait: { width: 1080, height: 1350 }
};

function money(value) {
  if (value == null || !Number.isFinite(Number(value))) return "";
  return `$${formatMoney(value)}`;
}

function staffPrice(model) {
  return money(model.staffFare?.staffFare);
}

function retailPrice(model) {
  const retail = model.staffFare?.retailFare;
  const staff = model.staffFare?.staffFare;
  if (retail == null || staff == null || retail <= staff) return "";
  return money(retail);
}

function badgeLabel(model) {
  return savingsLabel(model.staffFare?.savings, model.savingsDisplay);
}

function lineShip(model, max = 36) {
  const text = [model.lineName, model.shipName].filter(Boolean).join("  ·  ");
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

function journeyText(model) {
  const from = String(model.departurePort || "").trim();
  const to = String(model.arrivalPort || "").trim();
  if (from && to) return `${from}  →  ${to}`;
  return model.journeyArrow || model.destinationStrip || model.headlineShort || "";
}

function portNames(model) {
  const list = Array.isArray(model.ports) ? model.ports.map((p) => String(p || "").trim()).filter(Boolean) : [];
  return list;
}

/**
 * Wrap port names onto a limited number of lines and shrink long itineraries
 * instead of letting them collide.
 */
function portLines(ports, { maxLines = 4, maxChars = 42, omitted = 0 } = {}) {
  const list = Array.isArray(ports) ? ports.filter(Boolean) : [];
  if (!list.length) return [];
  const lines = [];
  let current = "";
  for (let i = 0; i < list.length; i += 1) {
    const next = current ? `${current}  ·  ${list[i]}` : list[i];
    if (current && next.length > maxChars) {
      lines.push(current);
      if (lines.length === maxLines - 1) {
        const rest = list.length - i + omitted;
        let last = list[i];
        if (rest > 1) last = `${last}  +${rest - 1} more`;
        if (last.length > maxChars) last = `${last.slice(0, Math.max(1, maxChars - 1))}…`;
        lines.push(last);
        return lines;
      }
      current = list[i];
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, maxLines);
}

function textBlock(lines, x, y, size, { fill = INK, weight = 700, anchor = "start", gap = 8, family = FAMILY } = {}) {
  const step = size + gap;
  return (lines || [])
    .map(
      (line, i) =>
        `<text x="${x}" y="${y + i * step}" text-anchor="${anchor}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}">${escapeXml(line)}</text>`
    )
    .join("");
}

function wrapWords(text, maxChars, maxLines) {
  const words = String(text || "")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let current = "";
  for (let i = 0; i < words.length; i += 1) {
    const next = current ? `${current} ${words[i]}` : words[i];
    if (current && next.length > maxChars) {
      lines.push(current);
      if (lines.length === maxLines - 1) {
        let last = words.slice(i).join(" ");
        if (last.length > maxChars) last = `${last.slice(0, Math.max(1, maxChars - 1))}…`;
        lines.push(last);
        return lines;
      }
      current = words[i];
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, maxLines);
}

function coverImage(href, x, y, w, h, imgW, imgH) {
  if (!href) return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#1B2832"/>`;
  const boxRatio = w / h;
  const srcW = Number(imgW) > 0 ? Number(imgW) : w;
  const srcH = Number(imgH) > 0 ? Number(imgH) : h;
  const imgRatio = srcW / Math.max(1, srcH);
  let dw;
  let dh;
  if (imgRatio > boxRatio) {
    dh = h;
    dw = h * imgRatio;
  } else {
    dw = w;
    dh = w / imgRatio;
  }
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;
  return `<image href="${href}" x="${dx}" y="${dy}" width="${dw}" height="${dh}" preserveAspectRatio="xMidYMid slice"/>`;
}

function savingsBadge(x, y, label, { align = "start", fill = RED } = {}) {
  if (!label) return "";
  const size = label.length > 12 ? 26 : 30;
  const w = Math.round(label.length * size * 0.62 + 52);
  const h = 68;
  const bx = align === "end" ? x - w : align === "middle" ? x - w / 2 : x;
  return `
    <rect x="${bx}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}"/>
    <text x="${bx + w / 2}" y="${y + 44}" text-anchor="middle" font-family="${FAMILY}" font-size="${size}" font-weight="800" fill="${WHITE}">${escapeXml(label)}</text>
  `;
}

function struck(x, y, label, size, { fill = "#8B939A", anchor = "start" } = {}) {
  if (!label) return "";
  const w = label.length * size * 0.56;
  const x1 = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
  return `
    <text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${FAMILY}" font-size="${size}" font-weight="600" fill="${fill}">${escapeXml(label)}</text>
    <line x1="${x1}" y1="${y - size * 0.32}" x2="${x1 + w}" y2="${y - size * 0.32}" stroke="${fill}" stroke-width="2.5"/>
  `;
}

function brandLockup(x, y, size, { fill = RED, anchor = "start" } = {}) {
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${FAMILY}" font-size="${size}" font-weight="800" letter-spacing="1.4" fill="${fill}">101 CRUISE</text>`;
}

function greenBar(width, height) {
  return `<rect x="0" y="${height - 42}" width="${width}" height="42" fill="${GREEN}"/>`;
}

function svgOpen(width, height, label) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(label)}">`;
}

async function mapDataUri(model, width, height) {
  const route = model.routeObject;
  const hasRoute = route && Array.isArray(route.stops) && route.stops.length >= 2 && Array.isArray(route.legs);
  if (hasRoute) {
    try {
      const rendered = renderRouteMapSvg(route, {
        style: normaliseRouteMapStyle(model.routeMapStyle),
        width,
        height,
        presentation: "inset",
        branding: { lineName: model.lineName, shipName: model.shipName }
      });
      if (rendered.ok && rendered.svg) {
        const { svgToPngBuffer } = require("./route-map-assets");
        const png = await svgToPngBuffer(rendered.svg, { width: Math.max(800, Math.round(width)) });
        if (png?.buffer) return `data:image/png;base64,${png.buffer.toString("base64")}`;
      }
    } catch {
      /* fall through to a stored map image */
    }
  }
  return model.routeMapDataUri || "";
}

function mapFrame(href, x, y, w, h, { radius = 28 } = {}) {
  const clip = `map-${x}-${y}`;
  const inner = href
    ? `<image href="${href}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/>`
    : `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#D5E3EA"/>
       <text x="${x + w / 2}" y="${y + h / 2}" text-anchor="middle" font-family="${FAMILY}" font-size="22" fill="#5E6B74">Route map appears when the itinerary has mapped ports</text>`;
  const stroke = radius > 0 ? ` stroke="#E4DDD2" stroke-width="2"` : "";
  return `
    <clipPath id="${clip}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}"/></clipPath>
    <g clip-path="url(#${clip})">${inner}</g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="none"${stroke}/>
  `;
}

function fareBlock(model, x, y, { priceSize = 72, align = "start" } = {}) {
  const price = staffPrice(model);
  const retail = retailPrice(model);
  const badge = badgeLabel(model);
  const parts = [];
  parts.push(
    `<text x="${x}" y="${y}" text-anchor="${align}" font-family="${FAMILY}" font-size="18" font-weight="700" letter-spacing="1.2" fill="${MUTED}">AIRLINE STAFF FARE</text>`
  );
  if (retail) parts.push(struck(x, y + 36, retail, 26, { anchor: align }));
  if (price) {
    parts.push(
      `<text x="${x}" y="${y + (retail ? 108 : 78)}" text-anchor="${align}" font-family="${FAMILY}" font-size="${priceSize}" font-weight="800" fill="${INK}">${escapeXml(price)}</text>`
    );
  }
  return { svg: parts.join(""), badge, priceBottom: y + (retail ? 120 : 90) };
}

function routeSentence(model) {
  const from = String(model.departurePort || "").trim();
  const to = String(model.arrivalPort || "").trim();
  if (from && to) return `${from} to ${to}`;
  return model.destinationStrip || model.journeyArrow || "";
}

function dateNightsLine(model) {
  const date = String(model.departingLabel || "")
    .replace(/^DEPARTING\s+/i, "")
    .trim();
  const nights = String(model.nightsLabel || "")
    .toLowerCase()
    .trim();
  return [date, nights].filter(Boolean).join("   |   ");
}

function cruiseLineChip(x, y, label) {
  const text = String(label || "").trim();
  if (!text) return "";
  const shown = text.length > 22 ? `${text.slice(0, 21)}…` : text;
  const size = 15;
  const w = Math.round(shown.length * size * 0.62 + 36);
  const h = 36;
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="#173246"/>
    <text x="${x + w / 2}" y="${y + 24}" text-anchor="middle" font-family="${FAMILY}" font-size="${size}" font-weight="700" letter-spacing="0.6" fill="${WHITE}">${escapeXml(shown.toUpperCase())}</text>
  `;
}

function renderRouteDealSvg(model, format, mapHref) {
  const { width, height } = FORMATS[format];
  const square = format === "square";
  const pad = 56;
  const mapH = square ? 560 : 760;
  const ship = model.shipName || "Cruise";
  const shipSize = ship.length > 22 ? (square ? 40 : 48) : square ? 52 : 64;
  const shipLines = wrapWords(ship, square ? 18 : 20, 2);
  const route = wrapWords(routeSentence(model), square ? 32 : 36, 2);
  const routeSize = (route[0] || "").length > 28 ? 28 : square ? 30 : 34;
  const panelTop = mapH;
  const shipY = panelTop + (square ? 72 : 86);
  const routeY = shipY + shipLines.length * (shipSize + 4) + (square ? 16 : 22);
  const metaY = routeY + Math.max(1, route.length) * (routeSize + 6) + 8;
  const priceSize = square ? 64 : 78;
  const price = staffPrice(model);
  const retail = retailPrice(model);
  const badge = badgeLabel(model);
  const priceY = Math.min(height - 156, metaY + (square ? 108 : 124));
  const priceWidth = price ? price.length * priceSize * 0.56 : 0;
  const retailX = pad + priceWidth + 28;
  return `${svgOpen(width, height, "Route Deal")}
    <rect width="${width}" height="${height}" fill="${WHITE}"/>
    ${mapFrame(mapHref, 0, 0, width, mapH, { radius: 0 })}
    ${savingsBadge(width - 28, 28, badge, { align: "end", fill: "#173246" })}
    ${cruiseLineChip(28, mapH - 64, model.lineName)}
    ${textBlock(shipLines, pad, shipY, shipSize, { weight: 800, gap: 2 })}
    ${textBlock(route, pad, routeY, routeSize, { weight: 600, fill: "#243140", gap: 4 })}
    <text x="${pad}" y="${metaY}" font-family="${FAMILY}" font-size="${square ? 22 : 26}" font-weight="500" fill="${MUTED}">${escapeXml(dateNightsLine(model))}</text>
    ${
      price
        ? `<text x="${pad}" y="${priceY - priceSize - 8}" font-family="${FAMILY}" font-size="22" font-weight="600" fill="${MUTED}">from</text>
           <text x="${pad}" y="${priceY}" font-family="${FAMILY}" font-size="${priceSize}" font-weight="800" fill="#173246">${escapeXml(price)}</text>`
        : ""
    }
    ${
      retail
        ? `<text x="${retailX}" y="${priceY - 36}" font-family="${FAMILY}" font-size="16" font-weight="600" fill="${MUTED}">Retail</text>
           ${struck(retailX, priceY - 6, retail, 26, { fill: "#8B939A" })}`
        : ""
    }
    ${brandLockup(pad, height - 58, square ? 28 : 32)}
    <rect x="0" y="${height - 10}" width="${width}" height="10" fill="${GREEN}"/>
  </svg>`;
}

function renderPriceShockSvg(model, format) {
  const { width, height } = FORMATS[format];
  const square = format === "square";
  const pad = 64;
  const price = staffPrice(model) || "—";
  const priceSize = price.length > 8 ? (square ? 92 : 112) : square ? 120 : 156;
  const retail = retailPrice(model);
  const badge = badgeLabel(model);
  const ports = portLines(portNames(model), {
    maxLines: square ? 3 : 4,
    maxChars: square ? 36 : 42,
    omitted: model.portsOmitted || 0
  });
  const portSize = ports.some((line) => line.length > 34) ? 22 : square ? 24 : 28;
  const priceY = square ? 430 : 520;
  const summary = model.itinerarySummary
    ? wrapWords(String(model.itinerarySummary).replace(/\|/g, " · "), square ? 40 : 46, 2)
    : [];
  const portY = square ? 760 : 980;
  return `${svgOpen(width, height, "Price Shock")}
    <rect width="${width}" height="${height}" fill="${INK}"/>
    ${brandLockup(pad, square ? 78 : 92, square ? 26 : 30, { fill: GREEN })}
    <text x="${width - pad}" y="${square ? 74 : 88}" text-anchor="end" font-family="${FAMILY}" font-size="18" font-weight="600" fill="#C5CED4">${escapeXml(lineShip(model))}</text>
    <text x="${width / 2}" y="${priceY - priceSize - 24}" text-anchor="middle" font-family="${FAMILY}" font-size="20" font-weight="700" letter-spacing="2" fill="${GREEN}">AIRLINE STAFF FARE</text>
    <text x="${width / 2}" y="${priceY}" text-anchor="middle" font-family="${FAMILY}" font-size="${priceSize}" font-weight="800" fill="${WHITE}">${escapeXml(price)}</text>
    ${struck(width / 2, priceY + 54, retail, 32, { anchor: "middle", fill: "#9AA6AE" })}
    ${savingsBadge(width / 2, priceY + (retail ? 100 : 48), badge, { align: "middle", fill: RED })}
    <text x="${pad}" y="${portY - 48}" font-family="${FAMILY}" font-size="16" font-weight="700" letter-spacing="1.6" fill="${GREEN}">${escapeXml(journeyText(model))}</text>
    ${textBlock(ports.length ? ports : summary, pad, portY, portSize, { fill: WHITE, weight: 600, gap: 10 })}
    ${greenBar(width, height)}
  </svg>`;
}

function renderDestinationJourneySvg(model, format) {
  const { width, height } = FORMATS[format];
  const square = format === "square";
  const pad = 60;
  const href = model.backgroundDataUri || model.heroDataUri || "";
  const headline = wrapWords(model.destinationStrip || journeyText(model) || model.headlineShort, square ? 18 : 16, 2);
  const headSize = (headline[0] || "").length > 18 ? (square ? 40 : 48) : square ? 50 : 62;
  const textTop = square ? 620 : 820;
  const portSize = 24;
  const portsY = textTop + Math.max(1, headline.length) * (headSize + 6) + 24;
  const room = height - 250 - portsY;
  const maxLines = Math.max(2, Math.min(square ? 3 : 4, Math.floor(room / (portSize + 10))));
  const ports = portLines(portNames(model), {
    maxLines,
    maxChars: square ? 34 : 40,
    omitted: model.portsOmitted || 0
  });
  const price = staffPrice(model);
  const retail = retailPrice(model);
  const badge = badgeLabel(model);
  return `${svgOpen(width, height, "Destination Journey")}
    <defs>
      <linearGradient id="dj-fade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0.28" stop-color="#081018" stop-opacity="0.05"/>
        <stop offset="0.62" stop-color="#081018" stop-opacity="0.55"/>
        <stop offset="1" stop-color="#081018" stop-opacity="0.88"/>
      </linearGradient>
      <clipPath id="dj-clip"><rect width="${width}" height="${height}"/></clipPath>
    </defs>
    <g clip-path="url(#dj-clip)">
      ${coverImage(href, 0, 0, width, height, model.backgroundWidth || model.heroWidth, model.backgroundHeight || model.heroHeight)}
      <rect width="${width}" height="${height}" fill="url(#dj-fade)"/>
    </g>
    ${brandLockup(pad, 78, 28, { fill: WHITE })}
    <text x="${width - pad}" y="74" text-anchor="end" font-family="${FAMILY}" font-size="18" font-weight="600" fill="#E7EEF2">${escapeXml(lineShip(model))}</text>
    ${textBlock(headline, pad, textTop, headSize, { fill: WHITE, weight: 800, gap: 4 })}
    ${textBlock(ports, pad, portsY, portSize, { fill: "#F4F7F8", weight: 600, gap: 8 })}
    <text x="${pad}" y="${height - 210}" font-family="${FAMILY}" font-size="16" font-weight="700" letter-spacing="1.4" fill="${GREEN}">AIRLINE STAFF FARE</text>
    ${struck(pad, height - 168, retail, 24, { fill: "#D5DDE2" })}
    <text x="${pad}" y="${height - (retail ? 96 : 120)}" font-family="${FAMILY}" font-size="${square ? 52 : 60}" font-weight="800" fill="${WHITE}">${escapeXml(price)}</text>
    ${savingsBadge(width - pad, height - 168, badge, { align: "end" })}
    ${greenBar(width, height)}
  </svg>`;
}

function renderShipJourneySvg(model, format, mapHref) {
  const { width, height } = FORMATS[format];
  const square = format === "square";
  const pad = 52;
  const photoH = square ? 360 : 480;
  const href = model.shipHeroDataUri || model.backgroundDataUri || model.heroDataUri || "";
  const mapY = photoH + (square ? 100 : 118);
  const mapH = square ? 200 : 250;
  const mapW = width - pad * 2;
  const ports = portLines(portNames(model), {
    maxLines: square ? 2 : 3,
    maxChars: square ? 40 : 46,
    omitted: model.portsOmitted || 0
  });
  const portY = mapY + mapH + (square ? 44 : 52);
  const priceY = height - 118;
  const price = staffPrice(model);
  const retail = retailPrice(model);
  const badge = badgeLabel(model);
  const ship = model.shipName || "Ship";
  const shipSize = ship.length > 22 ? 36 : 46;
  return `${svgOpen(width, height, "Ship and Journey")}
    <rect width="${width}" height="${height}" fill="${PAPER}"/>
    <clipPath id="ship-photo"><rect width="${width}" height="${photoH}"/></clipPath>
    <g clip-path="url(#ship-photo)">
      ${coverImage(href, 0, 0, width, photoH, model.shipHeroWidth || model.backgroundWidth, model.shipHeroHeight || model.backgroundHeight)}
      <rect width="${width}" height="${photoH}" fill="#081018" fill-opacity="0.18"/>
    </g>
    ${brandLockup(pad, 64, 26, { fill: WHITE })}
    <text x="${pad}" y="${photoH + (square ? 58 : 68)}" font-family="${FAMILY}" font-size="${shipSize}" font-weight="800" fill="${INK}">${escapeXml(ship)}</text>
    <text x="${pad}" y="${photoH + (square ? 92 : 108)}" font-family="${FAMILY}" font-size="20" font-weight="600" fill="${MUTED}">${escapeXml(model.lineName || "")}</text>
    ${mapFrame(mapHref, pad, mapY, mapW, mapH)}
    ${textBlock(ports, pad, portY, square ? 22 : 26, { weight: 650, gap: 8 })}
    <text x="${pad}" y="${priceY - 70}" font-family="${FAMILY}" font-size="15" font-weight="700" letter-spacing="1.3" fill="${MUTED}">AIRLINE STAFF FARE</text>
    ${struck(pad, priceY - 36, retail, 20)}
    <text x="${pad}" y="${priceY}" font-family="${FAMILY}" font-size="${square ? 42 : 50}" font-weight="800" fill="${INK}">${escapeXml(price)}</text>
    ${savingsBadge(width - pad, priceY - 50, badge, { align: "end" })}
    ${greenBar(width, height)}
  </svg>`;
}

async function renderFormatSvg(model, format) {
  const template = model.template;
  const { width, height } = FORMATS[format];
  if (template === "route_deal") {
    const box = format === "square" ? { w: width, h: 560 } : { w: width, h: 760 };
    const href = await mapDataUri(model, box.w, box.h);
    return renderRouteDealSvg(model, format, href);
  }
  if (template === "price_shock") return renderPriceShockSvg(model, format);
  if (template === "destination_journey") return renderDestinationJourneySvg(model, format);
  const box = format === "square" ? { w: width - 104, h: 210 } : { w: width - 104, h: 280 };
  const href = await mapDataUri(model, box.w, box.h);
  return renderShipJourneySvg(model, format, href);
}

async function renderPromoPack(model, options = {}) {
  const slug = templateSlug(model.template);
  const plan = [
    { key: `square-${slug}.png`, format: "square" },
    { key: `portrait-${slug}.png`, format: "portrait" }
  ];
  const scale =
    Number(options.outputWidth) > 0 && Number(options.outputWidth) < 1000
      ? Number(options.outputWidth) / FORMATS.portrait.width
      : 1;
  const { svgToPngBuffer } = require("./social-pack-render");
  const slides = {};
  const svgs = {};
  const joined = [];

  for (const item of plan) {
    const svg = await renderFormatSvg(model, item.format);
    const native = FORMATS[item.format];
    const width = Math.max(2, Math.round(native.width * scale));
    const height = Math.max(2, Math.round(native.height * scale));
    const rendered = svgToPngBuffer(svg, { width, height });
    if (rendered.width !== width || rendered.height !== height) {
      throw new Error(
        `${item.key} rendered at ${rendered.width}×${rendered.height}, expected ${width}×${height}`
      );
    }
    slides[item.key] = rendered.png;
    svgs[item.key] = svg;
    joined.push(svg);
  }

  const joinedSvg = joined.join("\n");
  if (
    /\bairline_price\b/i.test(joinedSvg) ||
    /\bairfares?\b/i.test(joinedSvg) ||
    /\bairline\s+prices?\b/i.test(joinedSvg)
  ) {
    throw new Error("Airline pricing leaked into social graphics.");
  }

  return {
    slides,
    svgs,
    plan,
    dimensions: {
      width: Math.round(FORMATS.portrait.width * scale),
      height: Math.round(FORMATS.portrait.height * scale)
    },
    exportDimensions: { width: FORMATS.portrait.width, height: FORMATS.portrait.height },
    formats: {
      square: FORMATS.square,
      portrait: FORMATS.portrait
    }
  };
}

module.exports = {
  FORMATS,
  portLines,
  renderRouteDealSvg,
  renderPriceShockSvg,
  renderDestinationJourneySvg,
  renderShipJourneySvg,
  renderPromoPack
};
