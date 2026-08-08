/**
 * Premium Dark Social Pack — main + offer slides.
 * Classic main/offer/CTA remain untouched in their own modules.
 */

const { escapeXml, buildRouteHeadline, stripPortLabel } = require("./social-pack-copy");
const { buildShipDisplay } = require("./social-pack-caption");
const { AIRLINE_STAFF_LINE, PREMIUM_DARK_PRICE_DISCLAIMER } = require("./social-pack-disclaimer");
const { FAMILY, FAMILY_CTA } = require("./social-pack-fonts");
const { GREEN } = require("./social-pack-svg");
const { displayPrice, loadGetYourCruiseOnDataUri } = require("./social-pack-offer-cta");
const {
  curatedPorts,
  masterBackground,
  greenFooter,
  FOOTER_H,
  WIDTH: W,
  HEIGHT: H
} = require("./social-pack-master-slide");

const WHITE = "#FFFFFF";
const RED = "#F80020";
const LIGHT_GREY = "#C8CDD4";
const DIVIDER_STROKE = "#DDE2E8";
const ROUTE_FONT_SIZE = 88;
const ROUTE_FONT_WEIGHT = 800;
const ROUTE_SIDE_MARGIN = 36;
const CRUISE_LINE_LOGO_H = 88;
const CRUISE_LINE_SHIELD_CLEARANCE = 150;
const BROCHURE_FONT_SIZE = 44;
const PANEL_FILL_OPACITY = 0.72;
const DISCLAIMER_TEXT = PREMIUM_DARK_PRICE_DISCLAIMER;

function benefitLabelSizeForRow(count) {
  const n = Number(count) || 0;
  return n >= 4 ? 16 : n === 3 ? 18 : 20;
}

function disclaimerLayoutForRows(rows) {
  const fontSize = (rows || []).reduce(
    (max, row) => Math.max(max, benefitLabelSizeForRow(row.length)),
    16
  );
  const lineGap = Math.round(fontSize * 1.15);
  const blockH = fontSize * 2 + lineGap + 18;
  return { fontSize, lineGap, blockH };
}

function frame(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${body}
</svg>`;
}

function premiumDarkBackground(model) {
  const href = model.backgroundDataUri || model.heroDataUri;
  if (!href) return `<rect width="${W}" height="${H}" fill="#0b1220"/>`;

  const imgW = Number(model.backgroundWidth || model.heroWidth) || W;
  const imgH = Number(model.backgroundHeight || model.heroHeight) || H;
  const boxRatio = W / H;
  const imgRatio = imgW / Math.max(1, imgH);
  let dw;
  let dh;
  if (imgRatio > boxRatio) {
    dh = H;
    dw = H * imgRatio;
  } else {
    dw = W;
    dh = W / imgRatio;
  }
  const dx = (W - dw) / 2;
  const dy = (H - dh) / 2;

  return `
    <defs>
      <clipPath id="pdClip"><rect width="${W}" height="${H}"/></clipPath>
      <linearGradient id="pdTopShade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#050814" stop-opacity="0.58"/>
        <stop offset="40%" stop-color="#050814" stop-opacity="0.22"/>
        <stop offset="100%" stop-color="#050814" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="pdBottomShade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#050814" stop-opacity="0"/>
        <stop offset="50%" stop-color="#050814" stop-opacity="0.18"/>
        <stop offset="100%" stop-color="#050814" stop-opacity="0.72"/>
      </linearGradient>
    </defs>
    <g clip-path="url(#pdClip)">
      <image href="${href}" x="${dx}" y="${dy}" width="${dw}" height="${dh}" preserveAspectRatio="xMidYMid slice"/>
      <rect width="${W}" height="${H}" fill="url(#pdTopShade)"/>
      <rect width="${W}" height="${H}" fill="url(#pdBottomShade)"/>
    </g>`;
}

function brandLogo(model, { y, size = 130 } = {}) {
  if (model.brandLogoDataUri) {
    return `<image href="${model.brandLogoDataUri}" x="${(W - size) / 2}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>`;
  }
  return `<rect x="${(W - size) / 2}" y="${y}" width="${size}" height="${size}" fill="${RED}"/>`;
}

function nineSquareMotif(cx, cy, { size = 30 } = {}) {
  const cell = size / 3;
  const gap = 1.2;
  const x0 = cx - size / 2;
  const y0 = cy - size / 2;
  const squares = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      squares.push(
        `<rect x="${x0 + col * cell + gap / 2}" y="${y0 + row * cell + gap / 2}" width="${cell - gap}" height="${cell - gap}" fill="${RED}"/>`
      );
    }
  }
  return `<g>${squares.join("")}</g>`;
}

function brandDivider(y) {
  const lineW = 420;
  const cx = W / 2;
  const motifSize = 28;
  const gap = 10;
  const halfMotif = motifSize / 2;
  const x1 = cx - lineW / 2;
  const x2 = cx + lineW / 2;
  const leftEnd = cx - halfMotif - gap;
  const rightStart = cx + halfMotif + gap;
  return `
    <line x1="${x1}" y1="${y}" x2="${leftEnd}" y2="${y}" stroke="${DIVIDER_STROKE}" stroke-width="1.5" stroke-opacity="0.82"/>
    <line x1="${rightStart}" y1="${y}" x2="${x2}" y2="${y}" stroke="${DIVIDER_STROKE}" stroke-width="1.5" stroke-opacity="0.82"/>
    ${nineSquareMotif(cx, y, { size: motifSize })}
  `;
}

function resolvePremiumDarkRoute(model) {
  const fromPorts = buildRouteHeadline(model.departurePort, model.arrivalPort);
  if (fromPorts) return fromPorts;

  const ports = Array.isArray(model.ports) ? model.ports.filter(Boolean) : [];
  if (ports.length >= 2) {
    const origin = stripPortLabel(ports[0]);
    const destination = stripPortLabel(ports[ports.length - 1]);
    const fromItinerary = buildRouteHeadline(origin, destination);
    if (fromItinerary) return fromItinerary;
  }
  if (ports.length === 1) {
    return buildRouteHeadline(stripPortLabel(ports[0]), "");
  }

  const existing = String(model.routeHeadline || "").trim().toUpperCase();
  if (/\s+TO\s+/.test(existing)) return existing;
  return "";
}

function estimateMontserratWidth(text, fontSize) {
  let w = 0;
  for (const ch of String(text)) {
    if (ch === " " || ch === "-") w += fontSize * 0.3;
    else if ("iljtfI.,'".includes(ch)) w += fontSize * 0.3;
    else if ("mwMW@".includes(ch)) w += fontSize * 0.82;
    else if (ch >= "A" && ch <= "Z") w += fontSize * 0.66;
    else w += fontSize * 0.55;
  }
  return w;
}

function routeText(model) {
  const raw = resolvePremiumDarkRoute(model);
  if (!raw) return { text: "", fontSize: ROUTE_FONT_SIZE };
  let fontSize = ROUTE_FONT_SIZE;
  const maxW = W - ROUTE_SIDE_MARGIN * 2;
  while (fontSize >= 52 && estimateMontserratWidth(raw, fontSize) > maxW) {
    fontSize -= 2;
  }
  return { text: raw, fontSize, fontWeight: ROUTE_FONT_WEIGHT };
}

function threeLineRouteHeight(fontSize) {
  const lineGap = Math.round(fontSize * 1.02);
  return lineGap * 2 + Math.round(fontSize * 0.35);
}

function premiumDarkItineraryPorts(model) {
  return curatedPorts(model)
    .map((p) => stripPortLabel(String(p)).toUpperCase())
    .filter(Boolean);
}

function splitPortsForWidth(ports, fontSize, maxWidth) {
  const sep = " · ";
  for (let i = 1; i < ports.length; i += 1) {
    const line1 = ports.slice(0, i).join(sep);
    const line2 = ports.slice(i).join(sep);
    if (
      estimateMontserratWidth(line1, fontSize) <= maxWidth &&
      estimateMontserratWidth(line2, fontSize) <= maxWidth
    ) {
      return { line1, line2 };
    }
  }
  const mid = Math.ceil(ports.length / 2);
  return {
    line1: ports.slice(0, mid).join(sep),
    line2: ports.slice(mid).join(sep)
  };
}

function measurePortsBlock(ports, { maxWidth = W - 80, maxFontSize = 36, minFontSize = 20 } = {}) {
  const labels = (ports || []).filter(Boolean);
  if (!labels.length) return { lines: 0, fontSize: maxFontSize, height: 0 };
  const fullText = labels.join(" · ");
  for (let lineCount = 1; lineCount <= 2; lineCount += 1) {
    let fontSize = maxFontSize;
    while (fontSize >= minFontSize) {
      if (lineCount === 1 && estimateMontserratWidth(fullText, fontSize) <= maxWidth) {
        return { lines: 1, fontSize, height: fontSize };
      }
      if (lineCount === 2) {
        const { line1, line2 } = splitPortsForWidth(labels, fontSize, maxWidth);
        if (
          estimateMontserratWidth(line1, fontSize) <= maxWidth &&
          estimateMontserratWidth(line2, fontSize) <= maxWidth
        ) {
          return { lines: 2, fontSize, height: Math.round(fontSize * 2.28) };
        }
      }
      fontSize -= 1;
    }
  }
  return { lines: 2, fontSize: minFontSize, height: Math.round(minFontSize * 2.28) };
}

function portsLine(ports, { y, maxWidth = W - 80, maxFontSize = 36, minFontSize = 20, maxLines = 2 } = {}) {
  const labels = (ports || []).filter(Boolean);
  if (!labels.length) return "";

  const sep = " · ";
  const fullText = labels.join(sep);
  const lineGap = (fontSize) => Math.round(fontSize * 1.28);

  for (let lines = 1; lines <= maxLines; lines += 1) {
    let fontSize = maxFontSize;
    while (fontSize >= minFontSize) {
      if (lines === 1 && estimateMontserratWidth(fullText, fontSize) <= maxWidth) {
        return `<text x="540" y="${y}" text-anchor="middle" fill="${WHITE}" font-family="${FAMILY}" font-size="${fontSize}" font-weight="500">${escapeXml(
          fullText
        )}</text>`;
      }
      if (lines === 2) {
        const { line1, line2 } = splitPortsForWidth(labels, fontSize, maxWidth);
        if (
          estimateMontserratWidth(line1, fontSize) <= maxWidth &&
          estimateMontserratWidth(line2, fontSize) <= maxWidth
        ) {
          const gap = lineGap(fontSize);
          return `
      <text x="540" y="${y}" text-anchor="middle" fill="${WHITE}" font-family="${FAMILY}" font-size="${fontSize}" font-weight="500">${escapeXml(
            line1
          )}</text>
      <text x="540" y="${y + gap}" text-anchor="middle" fill="${WHITE}" font-family="${FAMILY}" font-size="${fontSize}" font-weight="500">${escapeXml(
            line2
          )}</text>`;
        }
      }
      fontSize -= 1;
    }
  }

  const fontSize = minFontSize;
  const { line1, line2 } = splitPortsForWidth(labels, fontSize, maxWidth);
  const gap = lineGap(fontSize);
  return `
      <text x="540" y="${y}" text-anchor="middle" fill="${WHITE}" font-family="${FAMILY}" font-size="${fontSize}" font-weight="500">${escapeXml(
        line1
      )}</text>
      <text x="540" y="${y + gap}" text-anchor="middle" fill="${WHITE}" font-family="${FAMILY}" font-size="${fontSize}" font-weight="500">${escapeXml(
        line2
      )}</text>`;
}

function mainRouteHeadline(model, { x = 540, y = 280, size = ROUTE_FONT_SIZE } = {}) {
  const route = resolvePremiumDarkRoute(model) || String(model.routeHeadline || model.destinationStrip || "").trim();
  let from = "BARCELONA";
  let to = "ISTANBUL";
  if (/ TO /i.test(route)) {
    const parts = route.split(/\s+TO\s+/i);
    from = stripPortLabel(parts[0] || from).toUpperCase();
    to = stripPortLabel(parts[1] || to).toUpperCase();
  } else if (route) {
    from = route.toUpperCase();
    to = "";
  }
  const lineGap = Math.round(size * 1.02);
  if (!to) {
    return `<text x="${x}" y="${y}" text-anchor="middle" fill="${WHITE}" font-family="${FAMILY}" font-size="${size}" font-weight="${ROUTE_FONT_WEIGHT}">${escapeXml(
      from
    )}</text>`;
  }
  return `
    <text x="${x}" y="${y}" text-anchor="middle" fill="${WHITE}" font-family="${FAMILY}" font-size="${size}" font-weight="${ROUTE_FONT_WEIGHT}">${escapeXml(
      from
    )}</text>
    <text x="${x}" y="${y + lineGap}" text-anchor="middle" fill="${WHITE}" font-family="${FAMILY}" font-size="${size}" font-weight="${ROUTE_FONT_WEIGHT}">${escapeXml(
      "TO"
    )}</text>
    <text x="${x}" y="${y + lineGap * 2}" text-anchor="middle" fill="${WHITE}" font-family="${FAMILY}" font-size="${size}" font-weight="${ROUTE_FONT_WEIGHT}">${escapeXml(
      to
    )}</text>`;
}

function nightsDatesLine(model, { x = 540, y, size = 36 } = {}) {
  const nights = String(model.nightsLabel || "").toUpperCase() || "10 NIGHTS";
  const dates = String(model.dateRangeFull || model.dateRange || "").toUpperCase();
  const text = dates ? `${nights}  |  ${dates}` : nights;
  return `<text x="${x}" y="${y}" text-anchor="middle" fill="${WHITE}" font-family="${FAMILY}" font-size="${size}" font-weight="700">${escapeXml(
    text
  )}</text>`;
}

function shipLabel(model) {
  const display = buildShipDisplay(model.lineName, model.shipName);
  return String(display || model.shipName || "").toUpperCase();
}

function shipLine(model, { x = 540, y, size = 36 } = {}) {
  return `<text x="${x}" y="${y}" text-anchor="middle" fill="${WHITE}" font-family="${FAMILY}" font-size="${size}" font-weight="700">${escapeXml(
    shipLabel(model)
  )}</text>`;
}

/** Bottom-anchored inverted white shield for the cruise-line logo. Overlaps the green footer band. */
function cruiseLineLogoBottom(model) {
  const tipH = 22;
  const padX = 40;
  const padTop = 16;
  const padBottom = 20;
  const lw = Number(model.cruiseLineLogoWidth) || 0;
  const lh = Number(model.cruiseLineLogoHeight) || 0;
  const aspect = lw > 0 && lh > 0 ? lw / lh : 3.1;
  const logoH = CRUISE_LINE_LOGO_H;
  const logoW = Math.min(460, Math.round(logoH * aspect));
  const bannerW = logoW + padX * 2;
  const bodyH = padTop + logoH + padBottom;
  const bannerH = bodyH + tipH;
  const x = (W - bannerW) / 2;
  const baseY = H;
  const path = [
    `M ${x} ${baseY}`,
    `L ${x + bannerW} ${baseY}`,
    `L ${x + bannerW} ${baseY - bodyH}`,
    `L ${x + bannerW / 2} ${baseY - bannerH}`,
    `L ${x} ${baseY - bodyH}`,
    "Z"
  ].join(" ");
  const logoY = baseY - bodyH + padTop;
  if (model.cruiseLineLogoDataUri) {
    return `
      <g>
        <path d="${path}" fill="${WHITE}"/>
        <image href="${model.cruiseLineLogoDataUri}" x="${x + padX}" y="${logoY}" width="${logoW}" height="${logoH}" preserveAspectRatio="xMidYMid meet"/>
      </g>`;
  }
  return `
    <g>
      <path d="${path}" fill="${WHITE}"/>
      <text x="540" y="${logoY + Math.round(logoH * 0.72)}" text-anchor="middle" fill="#111" font-family="${FAMILY}" font-size="24" font-weight="700">${escapeXml(
        String(model.lineName || "").toUpperCase()
      )}</text>
    </g>`;
}

function heroPriceFontSize(price) {
  const text = String(price);
  const approxChars = Math.max(5, text.length);
  const minHero = Math.round(BROCHURE_FONT_SIZE * 1.32);
  const maxHero = 200;
  let fontSize = Math.min(maxHero, Math.max(minHero, Math.round(1520 / approxChars)));
  const maxW = W - 64;
  while (fontSize > minHero && estimateMontserratWidth(text, fontSize) > maxW) {
    fontSize -= 2;
  }
  return fontSize;
}

function brochurePriceBlock(price, y) {
  const fontSize = BROCHURE_FONT_SIZE;
  const textW = estimateMontserratWidth(price, fontSize);
  const cx = W / 2;
  const strikeMid = y - Math.round(fontSize * 0.35);
  const strikeSlant = Math.round(fontSize * 0.32);
  return `
    <text x="${cx}" y="${y}" text-anchor="middle" fill="${WHITE}" font-family="${FAMILY}" font-size="${fontSize}" font-weight="600">${escapeXml(
      price
    )}</text>
    <line x1="${cx - textW / 2 - 8}" y1="${strikeMid - strikeSlant}" x2="${cx + textW / 2 + 8}" y2="${strikeMid + strikeSlant}" stroke="${RED}" stroke-width="3" stroke-linecap="round"/>
  `;
}

function cruise101PriceBlock(price, y, { fontSize = null } = {}) {
  const px = fontSize || heroPriceFontSize(price);
  const cx = W / 2;
  return `
    <text x="${cx}" y="${y}" text-anchor="middle" fill="${GREEN}" font-family="${FAMILY}" font-size="${px}" font-weight="800">${escapeXml(
      price
    )}</text>
  `;
}

function cabinPill(label, y) {
  const text = String(label || "ROOM")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
  let fontSize = 26;
  if (text.length > 18) fontSize = 22;
  if (text.length > 26) fontSize = 20;
  const textW = estimateMontserratWidth(text, fontSize);
  const padX = 36;
  const w = Math.min(720, Math.max(200, Math.round(textW + padX * 2)));
  const h = 52;
  const x = (W - w) / 2;
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="#000000" fill-opacity="0.82" stroke="${GREEN}" stroke-width="1.5"/>
    <text x="${W / 2}" y="${y + Math.round(h * 0.68)}" text-anchor="middle" fill="${WHITE}" font-family="${FAMILY}" font-size="${fontSize}" font-weight="700" letter-spacing="1.2">${escapeXml(
      text
    )}</text>
  `;
}

function listInclusionItems(model) {
  const raw = Array.isArray(model.inclusions) ? model.inclusions : [];
  const items = raw.map((s) => String(s || "").trim()).filter(Boolean);
  if (items.length) return items.slice(0, 8);
  if (model.primaryInclusion) return [String(model.primaryInclusion).trim()].filter(Boolean);
  return [];
}

function normaliseInclusionLabel(item) {
  return String(item || "")
    .replace(/^includes?\s+/i, "")
    .trim()
    .toUpperCase();
}

/**
 * Distribute N benefits into row counts (max 4 per row).
 * 1–4 → one row; 5→3+2; 6→3+3; 7→4+3; 8→4+4
 */
function distributeBenefitRows(count) {
  const n = Math.max(0, Math.min(8, Math.trunc(Number(count) || 0)));
  if (n <= 4) return [n];
  if (n === 5) return [3, 2];
  if (n === 6) return [3, 3];
  if (n === 7) return [4, 3];
  return [4, 4];
}

function inclusionIcon(label, cx, cy, size = 34) {
  const key = String(label || "").toLowerCase();
  const s = size;
  const half = s / 2;
  const x = cx - half;
  const y = cy - half;

  if (/wi-?fi|wifi|internet/.test(key)) {
    return `
      <g transform="translate(${x} ${y})">
        <path d="M${half} ${s * 0.15} C${s * 0.25} ${s * 0.35}, ${s * 0.75} ${s * 0.35}, ${s * 0.85} ${s * 0.15}" fill="none" stroke="${GREEN}" stroke-width="2.8" stroke-linecap="round"/>
        <path d="M${half} ${s * 0.38} C${s * 0.38} ${s * 0.52}, ${s * 0.62} ${s * 0.52}, ${s * 0.62} ${s * 0.38}" fill="none" stroke="${GREEN}" stroke-width="2.8" stroke-linecap="round"/>
        <circle cx="${half}" cy="${s * 0.72}" r="3.2" fill="${GREEN}"/>
      </g>`;
  }
  if (/gratuit|service|staff/.test(key)) {
    return `
      <g transform="translate(${x} ${y})">
        <path d="M${s * 0.22} ${s * 0.55} L${s * 0.22} ${s * 0.82} L${s * 0.78} ${s * 0.82} L${s * 0.78} ${s * 0.55} Z" fill="none" stroke="${GREEN}" stroke-width="2.6" stroke-linejoin="round"/>
        <path d="M${s * 0.18} ${s * 0.55} L${half} ${s * 0.28} L${s * 0.82} ${s * 0.55}" fill="none" stroke="${GREEN}" stroke-width="2.6" stroke-linejoin="round"/>
        <line x1="${half}" y1="${s * 0.28}" x2="${half}" y2="${s * 0.18}" stroke="${GREEN}" stroke-width="2.6" stroke-linecap="round"/>
      </g>`;
  }
  if (/drink|beverage|alcohol|wine|beer|bar/.test(key)) {
    return `
      <g transform="translate(${x} ${y})">
        <path d="M${s * 0.32} ${s * 0.22} L${s * 0.42} ${s * 0.62} L${s * 0.58} ${s * 0.62} L${s * 0.68} ${s * 0.22} Z" fill="none" stroke="${GREEN}" stroke-width="2.6" stroke-linejoin="round"/>
        <line x1="${s * 0.28}" y1="${s * 0.22}" x2="${s * 0.72}" y2="${s * 0.22}" stroke="${GREEN}" stroke-width="2.6" stroke-linecap="round"/>
        <line x1="${half}" y1="${s * 0.62}" x2="${half}" y2="${s * 0.78}" stroke="${GREEN}" stroke-width="2.6" stroke-linecap="round"/>
      </g>`;
  }
  if (/dining|dinner|lunch|specialty|restaurant|food/.test(key)) {
    return `
      <g transform="translate(${x} ${y})">
        <line x1="${s * 0.28}" y1="${s * 0.25}" x2="${s * 0.28}" y2="${s * 0.78}" stroke="${GREEN}" stroke-width="2.6" stroke-linecap="round"/>
        <line x1="${s * 0.72}" y1="${s * 0.25}" x2="${s * 0.72}" y2="${s * 0.78}" stroke="${GREEN}" stroke-width="2.6" stroke-linecap="round"/>
        <path d="M${s * 0.22} ${s * 0.25} Q${s * 0.28} ${s * 0.42}, ${s * 0.28} ${s * 0.25}" fill="none" stroke="${GREEN}" stroke-width="2.4"/>
        <path d="M${s * 0.78} ${s * 0.25} Q${s * 0.72} ${s * 0.42}, ${s * 0.72} ${s * 0.25}" fill="none" stroke="${GREEN}" stroke-width="2.4"/>
      </g>`;
  }
  if (/credit|obc|onboard|on board|shore excursion|excursion|tour/.test(key)) {
    return `
      <g transform="translate(${x} ${y})">
        <circle cx="${half}" cy="${half}" r="${s * 0.32}" fill="none" stroke="${GREEN}" stroke-width="2.6"/>
        <text x="${half}" y="${half + 6}" text-anchor="middle" fill="${GREEN}" font-family="${FAMILY}" font-size="${Math.round(s * 0.38)}" font-weight="700">$</text>
      </g>`;
  }
  if (/laundry/.test(key)) {
    return `
      <g transform="translate(${x} ${y})">
        <rect x="${s * 0.28}" y="${s * 0.22}" width="${s * 0.44}" height="${s * 0.56}" rx="4" fill="none" stroke="${GREEN}" stroke-width="2.6"/>
        <circle cx="${half}" cy="${half}" r="${s * 0.12}" fill="none" stroke="${GREEN}" stroke-width="2.4"/>
      </g>`;
  }
  return `
    <g transform="translate(${x} ${y})">
      <circle cx="${half}" cy="${half}" r="${s * 0.32}" fill="none" stroke="${GREEN}" stroke-width="2.6"/>
      <path d="M${s * 0.32} ${half} L${s * 0.44} ${s * 0.62} L${s * 0.68} ${s * 0.36}" fill="none" stroke="${GREEN}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
    </g>`;
}

function measureBenefitsPanel(items) {
  const list = (items || []).filter(Boolean).slice(0, 8);
  if (!list.length) return { height: 0, rows: [] };

  const rowCounts = distributeBenefitRows(list.length);
  const rows = [];
  let idx = 0;
  for (const count of rowCounts) {
    rows.push(list.slice(idx, idx + count));
    idx += count;
  }

  const padTop = 22;
  const rowBlockH = 78;
  const rowGap = 16;
  const disclaimerBlockH = disclaimerLayoutForRows(rows).blockH;
  const height =
    padTop + rows.length * rowBlockH + Math.max(0, rows.length - 1) * rowGap + disclaimerBlockH;

  return { height, rows, padTop, rowBlockH, rowGap, disclaimerBlockH, disclaimerLayout: disclaimerLayoutForRows(rows) };
}

function benefitsPanel(items, { y } = {}) {
  const layout = measureBenefitsPanel(items);
  if (!layout.rows.length) return { svg: "", height: 0, y };

  const marginX = 56;
  const panelW = W - marginX * 2;
  const panelX = marginX;
  const panelY = y;
  const maxCols = 4;
  const colW = panelW / maxCols;
  const iconSize = 34;

  const rowParts = [];
  let rowY = panelY + layout.padTop;
  for (const rowItems of layout.rows) {
    const n = rowItems.length;
    const rowSpanW = colW * n;
    const rowStartX = panelX + (panelW - rowSpanW) / 2;
    const labelSize = benefitLabelSizeForRow(n);
    const iconY = rowY + 18;
    const labelY = rowY + 58;

    const separators = [];
    for (let i = 1; i < n; i += 1) {
      const sx = rowStartX + colW * i;
      separators.push(
        `<line x1="${sx}" y1="${rowY - 4}" x2="${sx}" y2="${rowY + 66}" stroke="${GREEN}" stroke-width="1.5" stroke-opacity="0.55"/>`
      );
    }

    const cols = rowItems
      .map((item, i) => {
        const cx = rowStartX + colW * i + colW / 2;
        const label = normaliseInclusionLabel(item);
        let ls = benefitLabelSizeForRow(n);
        while (ls >= 13 && estimateMontserratWidth(label, ls) > colW - 14) ls -= 1;
        return `
          ${inclusionIcon(item, cx, iconY, iconSize)}
          <text x="${cx}" y="${labelY}" text-anchor="middle" fill="${WHITE}" font-family="${FAMILY}" font-size="${ls}" font-weight="700" letter-spacing="0.5">${escapeXml(
            label
          )}</text>`;
      })
      .join("\n");

    rowParts.push(`${separators.join("\n")}${cols}`);
    rowY += layout.rowBlockH + layout.rowGap;
  }

  const disclaimerLayout = layout.disclaimerLayout || disclaimerLayoutForRows(layout.rows);
  const disclaimerFontSize = disclaimerLayout.fontSize;
  const disclaimerY = panelY + layout.height - 20;
  const airlineStaffY = disclaimerY - disclaimerLayout.lineGap;
  const separatorY = panelY + layout.height - layout.disclaimerBlockH + 6;

  const svg = `
    <rect x="${panelX}" y="${panelY}" width="${panelW}" height="${layout.height}" rx="24" fill="#000000" fill-opacity="${PANEL_FILL_OPACITY}" stroke="${GREEN}" stroke-width="2"/>
    ${rowParts.join("\n")}
    <line x1="${panelX + 24}" y1="${separatorY}" x2="${panelX + panelW - 24}" y2="${separatorY}" stroke="${GREEN}" stroke-width="1" stroke-opacity="0.35"/>
    <text x="${W / 2}" y="${airlineStaffY}" text-anchor="middle" fill="${LIGHT_GREY}" font-family="${FAMILY}" font-size="${disclaimerFontSize}" font-weight="500">${escapeXml(
      AIRLINE_STAFF_LINE
    )}</text>
    <text x="${W / 2}" y="${disclaimerY}" text-anchor="middle" fill="${LIGHT_GREY}" font-family="${FAMILY}" font-size="${disclaimerFontSize}" font-weight="500">${escapeXml(
      DISCLAIMER_TEXT
    )}</text>
  `;

  return { svg, height: layout.height, y: panelY };
}

/** Centre the main slide route/meta block between header and bottom shield. */
function layoutMainTextGroup(model) {
  const ports = premiumDarkItineraryPorts(model);
  const portsMeasure = measurePortsBlock(ports);
  const routeLineGap = Math.round(ROUTE_FONT_SIZE * 1.02);
  const routeBlockH = routeLineGap * 2;
  const metaGap = 72;
  const nightsSize = 36;
  const shipSize = 36;
  const portsBlockH = portsMeasure.height || 36;
  const groupH = routeBlockH + metaGap + nightsSize + metaGap + shipSize + metaGap + portsBlockH;
  const zoneTop = 232;
  const zoneBottom = H - FOOTER_H - CRUISE_LINE_SHIELD_CLEARANCE;
  const headlineY = Math.round((zoneTop + zoneBottom - groupH) / 2);
  return {
    headlineY,
    nightsDatesY: headlineY + routeBlockH + metaGap,
    shipY: headlineY + routeBlockH + metaGap + metaGap + Math.round(nightsSize * 0.72),
    portsY: headlineY + routeBlockH + metaGap * 2 + Math.round(nightsSize * 0.72) + metaGap + Math.round(shipSize * 0.72)
  };
}

/** Centre the offer content stack between header and benefits panel. */
function layoutOfferStack({ route, showBrochure, price, panelY }) {
  const routeH = threeLineRouteHeight(route.fontSize);
  const brochureBlockH = showBrochure ? 68 : 0;
  const heroPx = heroPriceFontSize(price);
  const heroH = Math.round(heroPx * 0.82);
  const cabinH = 52;
  const gapRouteBrochure = showBrochure ? 32 : 0;
  const gapBrochureHero = showBrochure ? 28 : 38;
  const gapHeroCabin = 24;
  const stackH = routeH + brochureBlockH + heroH + cabinH + gapRouteBrochure + gapBrochureHero + gapHeroCabin;
  const zoneTop = 228;
  const zoneBottom = Math.max(zoneTop + stackH, panelY - 20);
  const routeY = Math.round((zoneTop + zoneBottom - stackH) / 2 + route.fontSize * 0.32);
  let cursor = routeY + routeH + gapRouteBrochure;
  const brochureY = showBrochure ? cursor + 34 : null;
  if (showBrochure) cursor += brochureBlockH + gapBrochureHero;
  const priceY = cursor + Math.round(heroPx * 0.72);
  const cabinY = priceY + gapHeroCabin + Math.round(heroPx * 0.12);
  return { routeY, brochureY, priceY, cabinY, heroPx };
}

/** Premium Dark main slide — 101cruise top, cruise line bottom tab. */
function renderPremiumDarkMainSvg(model) {
  const ports = premiumDarkItineraryPorts(model);
  const layout = layoutMainTextGroup(model);

  const body = `
    ${masterBackground(model, { concept: "a" })}
    ${brandLogo(model, { y: 36, size: 130 })}
    ${brandDivider(198)}
    ${mainRouteHeadline(model, { y: layout.headlineY, size: ROUTE_FONT_SIZE })}
    ${nightsDatesLine(model, { y: layout.nightsDatesY, size: 36 })}
    ${shipLine(model, { y: layout.shipY, size: 36 })}
    ${portsLine(ports, { y: layout.portsY })}
    ${greenFooter()}
    ${cruiseLineLogoBottom(model)}
  `;
  return frame(body);
}

/** Premium Dark offer / pricing slide */
function renderPremiumDarkOfferSvg(model, offerIndex = 0) {
  const offer = (model.offers || [])[offerIndex] || model.offer;

  if (!offer) {
    const body = `
      ${premiumDarkBackground(model)}
      ${brandLogo(model, { y: 48, size: 130 })}
      ${brandDivider(210)}
      <text x="540" y="480" text-anchor="middle" fill="${WHITE}" font-family="${FAMILY}" font-size="36" font-weight="700">ASK PAUL FOR HIS BEST PRICE</text>
      <text x="540" y="540" text-anchor="middle" fill="${LIGHT_GREY}" font-family="${FAMILY}" font-size="22" font-weight="500">Public pricing will appear when available</text>
      ${greenFooter()}
      ${cruiseLineLogoBottom(model)}
    `;
    return frame(body);
  }

  const showBrochure =
    offer.showBrochure === true ||
    (offer.brochureLabel &&
      offer.brochurePrice != null &&
      offer.cruise101Price != null &&
      Number(offer.brochurePrice) > Number(offer.cruise101Price));
  const brochure = showBrochure ? displayPrice(offer.brochureLabel) : "";
  const price = displayPrice(offer.priceLabel);
  const room = offer.roomLabelDisplay || offer.roomLabel || "";
  const includeItems = listInclusionItems(model);

  const panelBottomMargin = FOOTER_H + CRUISE_LINE_SHIELD_CLEARANCE + 12;
  const panelLayout = measureBenefitsPanel(includeItems);
  const panelY = panelLayout.height
    ? H - panelBottomMargin - panelLayout.height
    : H - panelBottomMargin;
  const benefits = benefitsPanel(includeItems, { y: panelY });

  const logoY = 36;
  const dividerY = 198;
  const route = routeText(model);
  const stack = layoutOfferStack({
    route,
    showBrochure,
    price,
    panelY
  });

  let routeBlock = "";
  if (route.text) {
    routeBlock = mainRouteHeadline(model, { y: stack.routeY, size: route.fontSize });
  }

  let brochureBlock = "";
  if (showBrochure && stack.brochureY != null) {
    brochureBlock = brochurePriceBlock(brochure, stack.brochureY);
  }

  const body = `
    ${premiumDarkBackground(model)}
    ${brandLogo(model, { y: logoY, size: 130 })}
    ${brandDivider(dividerY)}
    ${routeBlock}
    ${brochureBlock}
    ${cruise101PriceBlock(price, stack.priceY, { fontSize: stack.heroPx })}
    ${cabinPill(room, stack.cabinY)}
    ${benefits.svg}
    ${greenFooter()}
    ${cruiseLineLogoBottom(model)}
  `;
  return frame(body);
}

/** Premium Dark CTA — three-line headline, script, email, 101cruise logo in lower third. */
function renderPremiumDarkCtaSvg(model) {
  const href = model.backgroundDataUri || model.heroDataUri;
  let bg = `<rect width="${W}" height="${H}" fill="#0b1220"/>`;
  if (href) {
    const imgW = Number(model.backgroundWidth || model.heroWidth) || W;
    const imgH = Number(model.backgroundHeight || model.heroHeight) || H;
    const boxRatio = W / H;
    const imgRatio = imgW / Math.max(1, imgH);
    let dw;
    let dh;
    if (imgRatio > boxRatio) {
      dh = H;
      dw = H * imgRatio;
    } else {
      dw = W;
      dh = W / imgRatio;
    }
    const dx = (W - dw) / 2;
    const dy = (H - dh) / 2;
    bg = `
      <defs><clipPath id="ctaClip"><rect width="${W}" height="${H}"/></clipPath></defs>
      <g clip-path="url(#ctaClip)">
        <image href="${href}" x="${dx}" y="${dy}" width="${dw}" height="${dh}" preserveAspectRatio="xMidYMid slice"/>
        <rect width="${W}" height="${H}" fill="#050814" fill-opacity="0.48"/>
      </g>`;
  }

  const headlineSize = 96;
  const headlineGap = Math.round(headlineSize * 1.18);
  const headlineY = 220;
  const scriptY = headlineY + headlineGap * 3 + 48;
  const scriptH = 148;
  const scriptUri = loadGetYourCruiseOnDataUri();
  const scriptBlock = scriptUri
    ? `<image href="${scriptUri}" x="${(W - 820) / 2}" y="${scriptY}" width="820" height="${scriptH}" preserveAspectRatio="xMidYMid meet"/>`
    : `<text x="540" y="${scriptY + 80}" text-anchor="middle" fill="${WHITE}" font-family="Great Vibes" font-size="92">Get your cruise on!</text>`;

  const brandSize = 200;
  const bottomThirdTop = Math.round(H * (2 / 3));
  const brandY = bottomThirdTop + Math.round((H / 3 - FOOTER_H - brandSize) / 2);
  const emailSize = 52;
  const emailY = brandY - 64;

  const body = `
    ${bg}
    <defs>
      <filter id="pdCtaHeadlineShadow" x="-20%" y="-20%" width="140%" height="160%">
        <feDropShadow dx="0" dy="6" stdDeviation="7" flood-color="#000" flood-opacity="0.55"/>
      </filter>
    </defs>
    <g filter="url(#pdCtaHeadlineShadow)">
      <text x="540" y="${headlineY}" text-anchor="middle" fill="${WHITE}" font-family="${FAMILY_CTA}" font-size="${headlineSize}" font-weight="700" letter-spacing="1.5">TALK TO</text>
      <text x="540" y="${headlineY + headlineGap}" text-anchor="middle" fill="${WHITE}" font-family="${FAMILY_CTA}" font-size="${headlineSize}" font-weight="700" letter-spacing="1.5">PAUL</text>
      <text x="540" y="${headlineY + headlineGap * 2}" text-anchor="middle" fill="${WHITE}" font-family="${FAMILY_CTA}" font-size="${headlineSize}" font-weight="700" letter-spacing="1.5">TODAY</text>
    </g>
    ${scriptBlock}
    <text x="540" y="${emailY}" text-anchor="middle" fill="${WHITE}" font-family="${FAMILY}" font-size="${emailSize}" font-weight="400">paul@101cruise.com.au</text>
    ${brandLogo(model, { y: brandY, size: brandSize })}
    ${greenFooter()}
  `;
  return frame(body);
}

module.exports = {
  renderPremiumDarkMainSvg,
  renderPremiumDarkOfferSvg,
  renderPremiumDarkCtaSvg,
  resolvePremiumDarkRoute,
  distributeBenefitRows,
  measureBenefitsPanel,
  heroPriceFontSize,
  routeText,
  measurePortsBlock,
  premiumDarkItineraryPorts,
  threeLineRouteHeight,
  shipLabel,
  CRUISE_LINE_SHIELD_CLEARANCE,
  CRUISE_LINE_LOGO_H,
  layoutMainTextGroup,
  layoutOfferStack,
  DISCLAIMER_TEXT,
  PANEL_FILL_OPACITY,
  nineSquareMotif,
  premiumDarkBackground
};
