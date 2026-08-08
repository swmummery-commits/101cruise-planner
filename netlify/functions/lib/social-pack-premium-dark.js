/**
 * Premium Dark Social Pack offer slide — Qantas-style layout with 101cruise branding.
 * Offer/pricing slides only (slides 2–4). Main and CTA remain Classic.
 */

const { escapeXml, buildRouteHeadline } = require("./social-pack-copy");
const { FAMILY } = require("./social-pack-fonts");
const { GREEN } = require("./social-pack-svg");
const { displayPrice } = require("./social-pack-offer-cta");

const W = 1080;
const H = 1350;
const WHITE = "#FFFFFF";
const RED = "#F80020";
const LIGHT_GREY = "#C8CDD4";
const DIVIDER_STROKE = "#DDE2E8";

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

function brandLogo(model, { y, size = 140 } = {}) {
  if (model.brandLogoDataUri) {
    return `<image href="${model.brandLogoDataUri}" x="${(W - size) / 2}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>`;
  }
  return `<rect x="${(W - size) / 2}" y="${y}" width="${size}" height="${size}" fill="${RED}"/>`;
}

/** Inline 3×3 nine-red-square brand motif for divider centre. */
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
  const x1 = cx - lineW / 2;
  const x2 = cx + lineW / 2;
  return `
    <line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${DIVIDER_STROKE}" stroke-width="1.5" stroke-opacity="0.82"/>
    ${nineSquareMotif(cx, y, { size: 28 })}
  `;
}

/**
 * Premium Dark route — always ORIGIN TO DESTINATION from itinerary endpoints.
 * Never uses marketing headline or destination_strip copy.
 */
function resolvePremiumDarkRoute(model) {
  const fromPorts = buildRouteHeadline(model.departurePort, model.arrivalPort);
  if (fromPorts) return fromPorts;

  const ports = Array.isArray(model.ports) ? model.ports.filter(Boolean) : [];
  if (ports.length >= 2) {
    const origin = String(ports[0]).replace(/,.*$/, "").trim();
    const destination = String(ports[ports.length - 1])
      .replace(/,.*$/, "")
      .trim();
    const fromItinerary = buildRouteHeadline(origin, destination);
    if (fromItinerary) return fromItinerary;
  }
  if (ports.length === 1) {
    return buildRouteHeadline(String(ports[0]).replace(/,.*$/, "").trim(), "");
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
  if (!raw) return { text: "", fontSize: 32 };
  let fontSize = 32;
  if (raw.length > 36) fontSize = 28;
  if (raw.length > 44) fontSize = 24;
  if (raw.length > 52) fontSize = 20;
  const maxW = W - 80;
  while (fontSize >= 18 && estimateMontserratWidth(raw, fontSize) > maxW) {
    fontSize -= 2;
  }
  return { text: raw, fontSize };
}

function brochurePriceBlock(price, y) {
  const fontSize = 44;
  const textW = estimateMontserratWidth(price, fontSize);
  const cx = W / 2;
  const strikeY = y - Math.round(fontSize * 0.35);
  return `
    <text x="${cx}" y="${y}" text-anchor="middle" fill="${WHITE}" font-family="${FAMILY}" font-size="${fontSize}" font-weight="600">${escapeXml(
      price
    )}</text>
    <line x1="${cx - textW / 2 - 8}" y1="${strikeY}" x2="${cx + textW / 2 + 8}" y2="${strikeY}" stroke="${RED}" stroke-width="3" stroke-linecap="round"/>
  `;
}

function cruise101PriceBlock(price, y) {
  const approxChars = Math.max(5, String(price).length);
  let fontSize = Math.min(108, Math.max(72, Math.round(560 / approxChars)));
  const cx = W / 2;
  return `
    <text x="${cx}" y="${y}" text-anchor="middle" fill="${GREEN}" font-family="${FAMILY}" font-size="${fontSize}" font-weight="800">${escapeXml(
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
  if (items.length) return items.slice(0, 4);
  if (model.primaryInclusion) return [String(model.primaryInclusion).trim()].filter(Boolean);
  return [];
}

function normaliseInclusionLabel(item) {
  return String(item || "")
    .replace(/^includes?\s+/i, "")
    .trim()
    .toUpperCase();
}

function inclusionIcon(label, cx, cy, size = 36) {
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
  // Generic checkmark fallback
  return `
    <g transform="translate(${x} ${y})">
      <circle cx="${half}" cy="${half}" r="${s * 0.32}" fill="none" stroke="${GREEN}" stroke-width="2.6"/>
      <path d="M${s * 0.32} ${half} L${s * 0.44} ${s * 0.62} L${s * 0.68} ${s * 0.36}" fill="none" stroke="${GREEN}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
    </g>`;
}

function benefitsPanel(items, { y, h = 220 } = {}) {
  const list = (items || []).filter(Boolean).slice(0, 4);
  if (!list.length) return "";

  const marginX = 56;
  const panelW = W - marginX * 2;
  const panelX = marginX;
  const panelY = y;
  const count = list.length;
  const colW = panelW / count;
  const iconY = panelY + 52;
  const labelSize = count >= 4 ? 17 : count === 3 ? 19 : 21;
  const labelY = panelY + 108;

  const separators = [];
  for (let i = 1; i < count; i += 1) {
    const sx = panelX + colW * i;
    separators.push(
      `<line x1="${sx}" y1="${panelY + 28}" x2="${sx}" y2="${panelY + h - 28}" stroke="${GREEN}" stroke-width="1.5" stroke-opacity="0.65"/>`
    );
  }

  const columns = list
    .map((item, i) => {
      const cx = panelX + colW * i + colW / 2;
      const label = normaliseInclusionLabel(item);
      let ls = labelSize;
      while (ls >= 14 && estimateMontserratWidth(label, ls) > colW - 16) ls -= 1;
      return `
        ${inclusionIcon(item, cx, iconY, 38)}
        <text x="${cx}" y="${labelY}" text-anchor="middle" fill="${WHITE}" font-family="${FAMILY}" font-size="${ls}" font-weight="700" letter-spacing="0.6">${escapeXml(
          label
        )}</text>`;
    })
    .join("\n");

  return `
    <rect x="${panelX}" y="${panelY}" width="${panelW}" height="${h}" rx="28" fill="#000000" fill-opacity="0.88" stroke="${GREEN}" stroke-width="2"/>
    ${separators.join("\n")}
    ${columns}
  `;
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

  const logoY = 36;
  const dividerY = 198;
  const route = routeText(model);
  let cursorY = dividerY + 52;

  let routeBlock = "";
  if (route.text) {
    routeBlock = `<text x="540" y="${cursorY}" text-anchor="middle" fill="${WHITE}" font-family="${FAMILY}" font-size="${route.fontSize}" font-weight="600" letter-spacing="1.6">${escapeXml(
      route.text
    )}</text>`;
    cursorY += 56;
  }

  let brochureBlock = "";
  if (showBrochure) {
    brochureBlock = brochurePriceBlock(brochure, cursorY + 36);
    cursorY += 88;
  }

  const priceY = cursorY + 72;
  const cabinY = priceY + 56;
  const panelH = 220;
  const panelY = H - panelH - 96;
  const benefitsBlock = benefitsPanel(includeItems, { y: panelY, h: panelH });
  const discY = panelY + panelH + (benefitsBlock ? 36 : 0);

  const body = `
    ${premiumDarkBackground(model)}
    ${brandLogo(model, { y: logoY, size: 130 })}
    ${brandDivider(dividerY)}
    ${routeBlock}
    ${brochureBlock}
    ${cruise101PriceBlock(price, priceY)}
    ${cabinPill(room, cabinY)}
    ${benefitsBlock}
    <text x="540" y="${discY}" text-anchor="middle" fill="${LIGHT_GREY}" font-family="${FAMILY}" font-size="14" font-weight="400">* Price in US dollars &amp; subject to availability.</text>
  `;
  return frame(body);
}

module.exports = {
  renderPremiumDarkOfferSvg,
  resolvePremiumDarkRoute,
  nineSquareMotif,
  premiumDarkBackground
};
