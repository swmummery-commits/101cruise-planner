/**
 * Finalised Social Pack Offer (pricing) + CTA slides.
 * Pricing: one card per cabin — clear destination photo, translucent white pills,
 * strike brochure, angled cabin-type badge, slim includes strip. Public cruise prices only
 * (brochure + 101cruise) — never airline / airfare.
 * CTA: League Spartan + bundled Feeling Passionate script artwork PNG + email.
 */

const fs = require("fs");
const path = require("path");
const { escapeXml } = require("./social-pack-copy");
const { AIRLINE_STAFF_LINE, CLASSIC_PRICE_DISCLAIMER } = require("./social-pack-disclaimer");
const { FAMILY, FAMILY_CTA } = require("./social-pack-fonts");
const { cruiseLineLogo, FOOTER_H: MASTER_FOOTER_H, GREEN } = require("./social-pack-master-slide");

const W = 1080;
const H = 1350;
const WHITE = "#FFFFFF";
const RED = "#F80020";
const BLUE = "#1B3A6B";
const FOOTER_H = MASTER_FOOTER_H;
/** Shared white-pill fill — slightly translucent across all pills */
const PILL_FILL = WHITE;
const PILL_OPACITY = 0.82;

function frame(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${body}
</svg>`;
}

function greenFooter() {
  return `<rect x="0" y="${H - FOOTER_H}" width="${W}" height="${FOOTER_H}" fill="${GREEN}"/>`;
}

function loadGetYourCruiseOnDataUri() {
  const candidates = [
    path.join(__dirname, "../../../assets/social-pack/get-your-cruise-on.png"),
    path.join(process.cwd(), "assets/social-pack/get-your-cruise-on.png")
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const buf = fs.readFileSync(file);
        return `data:image/png;base64,${buf.toString("base64")}`;
      }
    } catch {
      /* continue */
    }
  }
  return null;
}

/** Clear photo with light readability shade only (no blur). */
function clearPricingBackground(model) {
  const href = model.backgroundDataUri || model.heroDataUri;
  if (!href) return `<rect width="${W}" height="${H}" fill="#1a2433"/>`;
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
      <clipPath id="priceClip"><rect width="${W}" height="${H}"/></clipPath>
    </defs>
    <g clip-path="url(#priceClip)">
      <image href="${href}" x="${dx}" y="${dy}" width="${dw}" height="${dh}" preserveAspectRatio="xMidYMid slice"/>
      <rect width="${W}" height="${H}" fill="#050814" fill-opacity="0.10"/>
    </g>`;
}

function displayPrice(label) {
  let s = String(label || "").trim();
  if (!s || s === "—") return "—";
  s = s.replace(/^US\s*/i, "");
  if (!s.startsWith("$")) s = `$${s}`;
  if (!/\*$/.test(s)) s = `${s}*`;
  return s;
}

/**
 * 3D scalloped gold seal — layered fills, rim highlight, drop shadow.
 * Text sized large for short single-item inclusions.
 */
function goldSeal(cx, cy, lines, { r = 140 } = {}) {
  const lobes = 32;
  const outer = r;
  const inner = r * 0.84;
  const pts = [];
  for (let i = 0; i < lobes * 2; i += 1) {
    const ang = (Math.PI * i) / lobes - Math.PI / 2;
    const rad = i % 2 === 0 ? outer : inner;
    pts.push(`${cx + Math.cos(ang) * rad},${cy + Math.sin(ang) * rad}`);
  }
  const textLines = (lines || []).filter(Boolean).slice(0, 3);
  const isShort = textLines.join(" ").length <= 18;
  const fontSize = isShort ? 34 : textLines.length <= 2 ? 28 : 24;
  const lineGap = Math.round(fontSize * 1.15);
  const startY = cy - ((textLines.length - 1) * lineGap) / 2 + Math.round(fontSize * 0.35);
  const texts = textLines
    .map((line, i) => {
      return `<text x="${cx}" y="${startY + i * lineGap}" text-anchor="middle" fill="${RED}" font-family="${FAMILY}" font-size="${fontSize}" font-weight="800">${escapeXml(
        String(line).toUpperCase()
      )}</text>`;
    })
    .join("\n");

  return `
    <defs>
      <radialGradient id="goldFace" cx="38%" cy="32%" r="70%">
        <stop offset="0%" stop-color="#FFF4C2"/>
        <stop offset="42%" stop-color="#F0D45A"/>
        <stop offset="78%" stop-color="#D4A017"/>
        <stop offset="100%" stop-color="#A8790A"/>
      </radialGradient>
      <radialGradient id="goldInner" cx="42%" cy="36%" r="65%">
        <stop offset="0%" stop-color="#FFE99A"/>
        <stop offset="55%" stop-color="#E8C84A"/>
        <stop offset="100%" stop-color="#C9A227"/>
      </radialGradient>
      <linearGradient id="goldRim" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#FFF6D0"/>
        <stop offset="50%" stop-color="#C9A227"/>
        <stop offset="100%" stop-color="#7A5A08"/>
      </linearGradient>
      <filter id="sealShadow" x="-30%" y="-30%" width="160%" height="170%">
        <feDropShadow dx="4" dy="10" stdDeviation="8" flood-color="#000" flood-opacity="0.45"/>
      </filter>
    </defs>
    <g transform="rotate(-8 ${cx} ${cy})" filter="url(#sealShadow)">
      <polygon points="${pts.join(" ")}" fill="url(#goldFace)" stroke="url(#goldRim)" stroke-width="5"/>
      <circle cx="${cx}" cy="${cy}" r="${r * 0.70}" fill="url(#goldInner)" stroke="#F7E7A0" stroke-width="2" stroke-opacity="0.7"/>
      <ellipse cx="${cx - r * 0.18}" cy="${cy - r * 0.22}" rx="${r * 0.28}" ry="${r * 0.16}" fill="#FFFFFF" fill-opacity="0.28"/>
      ${texts}
    </g>`;
}

/**
 * Translucent price pill — fully centred type with even optical line spacing.
 * Price baseline is placed so the $ amount sits halfway between label and "per person".
 */
function pricePill({ x, y, w, h, label, price, priceColor = "#111", strike = false } = {}) {
  const cx = x + w / 2;
  const labelSize = 26;
  const ppSize = 24;
  const approxChars = String(price).length;
  const pricePx = Math.min(96, Math.max(72, Math.round(520 / Math.max(5, approxChars))));
  const priceBlockW = Math.round(approxChars * pricePx * 0.70);

  // Equal padding from pill edges to outer baselines
  const inset = Math.round(h * 0.22);
  const labelY = y + inset;
  const ppY = y + h - inset;
  // Optical mid of the $ amount sits halfway between the two outer baselines
  const midOptical = (labelY + ppY) / 2;
  const priceY = Math.round(midOptical + pricePx * 0.28);
  const strikeMid = priceY - Math.round(pricePx * 0.32);
  const strikeSlant = Math.round(pricePx * 0.28);

  return `
    <g filter="url(#pillShadow)">
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${PILL_FILL}" fill-opacity="${PILL_OPACITY}"/>
    </g>
    <text x="${cx}" y="${labelY}" text-anchor="middle" fill="#222" font-family="${FAMILY}" font-size="${labelSize}" font-weight="700" letter-spacing="1.4">${escapeXml(
      label
    )}</text>
    <text x="${cx}" y="${priceY}" text-anchor="middle" fill="${priceColor}" font-family="${FAMILY}" font-size="${pricePx}" font-weight="800">${escapeXml(
      price
    )}</text>
    ${
      strike
        ? `<line x1="${cx - priceBlockW / 2}" y1="${strikeMid - strikeSlant}" x2="${
            cx + priceBlockW / 2
          }" y2="${strikeMid + strikeSlant}" stroke="#111" stroke-width="7" stroke-linecap="round"/>`
        : ""
    }
    <text x="${cx}" y="${ppY}" text-anchor="middle" fill="#222" font-family="${FAMILY}" font-size="${ppSize}" font-weight="600">per person</text>
  `;
}

function measurePricePillWidth(price) {
  const approxChars = Math.max(5, String(price).length);
  const pricePx = Math.min(96, Math.max(72, Math.round(520 / approxChars)));
  const priceBlockW = Math.round(approxChars * pricePx * 0.70);
  return Math.max(priceBlockW + 120, 420);
}

function listInclusionItems(model) {
  const raw = Array.isArray(model.inclusions) ? model.inclusions : [];
  const items = raw.map((s) => String(s || "").trim()).filter(Boolean);
  if (items.length) return items.slice(0, 6);
  if (model.primaryInclusion) return [String(model.primaryInclusion).trim()].filter(Boolean);
  return [];
}

/** Rough advance width for Montserrat semi/bold — good enough to centre tick+label pairs. */
function estimateMontserratWidth(text, fontSize, { letterSpacing = 0 } = {}) {
  let w = 0;
  for (const ch of String(text)) {
    if (ch === " " || ch === "-") w += fontSize * 0.3;
    else if ("iljtfI.,'".includes(ch)) w += fontSize * 0.3;
    else if ("mwMW@".includes(ch)) w += fontSize * 0.82;
    else if (ch >= "A" && ch <= "Z") w += fontSize * 0.66;
    else w += fontSize * 0.55;
  }
  return w + Math.max(0, String(text).length - 1) * letterSpacing;
}

function measureIncludesItemWidth(item, itemSize, tickSize, tickGap) {
  return tickSize + tickGap + estimateMontserratWidth(item, itemSize) * 1.1;
}

function layoutIncludesRows(list, { headerSize, itemSize, tickSize, tickGap, afterHeader, betweenItems, maxInnerW }) {
  const headerW = estimateMontserratWidth("INCLUDES", headerSize, { letterSpacing: 1.4 });
  const itemWidths = list.map((item) => measureIncludesItemWidth(item, itemSize, tickSize, tickGap));

  let singleW = headerW + afterHeader;
  for (let i = 0; i < list.length; i += 1) {
    singleW += itemWidths[i];
    if (i < list.length - 1) singleW += betweenItems;
  }
  if (singleW <= maxInnerW) {
    return {
      rows: [
        {
          withHeader: true,
          items: list.map((item, i) => ({ item, width: itemWidths[i] }))
        }
      ],
      innerW: singleW
    };
  }

  const row1 = [];
  let row1W = headerW + afterHeader;
  let idx = 0;
  for (; idx < list.length; idx += 1) {
    const gap = row1.length > 0 ? betweenItems : 0;
    const nextW = row1W + gap + itemWidths[idx];
    if (row1.length > 0 && nextW > maxInnerW) break;
    row1W = nextW;
    row1.push({ item: list[idx], width: itemWidths[idx] });
  }

  const row2 = list.slice(idx).map((item, i) => ({ item, width: itemWidths[idx + i] }));
  let row2W = 0;
  for (let i = 0; i < row2.length; i += 1) {
    row2W += row2[i].width;
    if (i < row2.length - 1) row2W += betweenItems;
  }

  const rows = [{ withHeader: true, items: row1 }];
  if (row2.length) rows.push({ withHeader: false, items: row2 });
  return { rows, innerW: Math.max(row1W, row2W) };
}

function renderIncludesRow(row, { startX, baselineY, headerSize, itemSize, tickSize, tickGap, afterHeader, betweenItems }) {
  let cursorX = startX;
  const parts = [];

  if (row.withHeader) {
    parts.push(
      `<text x="${cursorX}" y="${baselineY}" text-anchor="start" fill="#222" font-family="${FAMILY}" font-size="${headerSize}" font-weight="800" letter-spacing="1.4">INCLUDES</text>`
    );
    cursorX +=
      estimateMontserratWidth("INCLUDES", headerSize, { letterSpacing: 1.4 }) + afterHeader;
  }

  row.items.forEach(({ item }, i) => {
    const tickX = cursorX + tickSize / 2;
    const textX = cursorX + tickSize + tickGap;
    parts.push(greenTick(tickX, baselineY - 6, tickSize));
    parts.push(
      `<text x="${textX}" y="${baselineY}" text-anchor="start" fill="#222" font-family="${FAMILY}" font-size="${itemSize}" font-weight="600">${escapeXml(
        item
      )}</text>`
    );
    cursorX += measureIncludesItemWidth(item, itemSize, tickSize, tickGap);
    if (i < row.items.length - 1) cursorX += betweenItems;
  });

  return parts.join("\n");
}

function greenTick(cx, cy, size = 20) {
  return `
    <path d="M ${cx - size * 0.28} ${cy + size * 0.02} L ${cx - size * 0.05} ${cy + size * 0.28} L ${cx + size * 0.34} ${cy - size * 0.28}"
      fill="none" stroke="#1FAE7A" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/>
  `;
}

/**
 * Slim includes strip — one capsule, expanding to fit all items on-slide.
 * Wraps to a second row when the full list would exceed the safe width.
 */
function includesStrip({ y, items = [] } = {}) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return "";

  const headerSize = 20;
  const itemSize = 20;
  const tickSize = 16;
  const tickGap = 8;
  const afterHeader = 22;
  const betweenItems = 22;
  const padX = 28;
  const rowH = 48;
  const rowGap = 8;
  const maxStripW = W - 72;

  const layout = layoutIncludesRows(list, {
    headerSize,
    itemSize,
    tickSize,
    tickGap,
    afterHeader,
    betweenItems,
    maxInnerW: maxStripW - padX * 2
  });
  const stripW = Math.min(maxStripW, layout.innerW + padX * 2);
  const stripX = (W - stripW) / 2;
  const h = layout.rows.length === 1 ? rowH : rowH * 2 + rowGap;
  const firstBaselineY = y + Math.round(rowH * 0.64);
  const secondBaselineY = y + rowH + rowGap + Math.round(rowH * 0.64);

  const rowSvgs = layout.rows
    .map((row, i) => {
      let rowW = 0;
      if (row.withHeader) {
        rowW += estimateMontserratWidth("INCLUDES", headerSize, { letterSpacing: 1.4 }) + afterHeader;
      }
      row.items.forEach(({ width }, j) => {
        rowW += width;
        if (j < row.items.length - 1) rowW += betweenItems;
      });
      const startX = stripX + padX + Math.max(0, (stripW - padX * 2 - rowW) / 2);
      return renderIncludesRow(row, {
        startX,
        baselineY: i === 0 ? firstBaselineY : secondBaselineY,
        headerSize,
        itemSize,
        tickSize,
        tickGap,
        afterHeader,
        betweenItems
      });
    })
    .join("\n");

  return `
    <g filter="url(#pillShadow)">
      <rect x="${stripX}" y="${y}" width="${stripW}" height="${h}" rx="${h / 2}" fill="${PILL_FILL}" fill-opacity="${PILL_OPACITY}"/>
    </g>
    ${rowSvgs}
  `;
}

function angledRoomPill(label, { x = null, y = 210 } = {}) {
  const text = String(label || "ROOM")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
  const words = text.split(" ").filter(Boolean);
  let lines;
  if (text.length <= 18 || words.length <= 1) {
    lines = [text];
  } else {
    // Prefer a balanced two-line split; never more than two lines.
    let best = null;
    for (let i = 1; i < words.length; i += 1) {
      const a = words.slice(0, i).join(" ");
      const b = words.slice(i).join(" ");
      const score = Math.abs(a.length - b.length) + Math.max(a.length, b.length) * 0.15;
      if (!best || score < best.score) best = { a, b, score };
    }
    lines = best ? [best.a, best.b] : [text];
  }

  const longest = Math.max(...lines.map((l) => l.length));
  let fontSize = 28;
  if (longest > 16) fontSize = 24;
  if (longest > 22) fontSize = 22;
  if (longest > 28) fontSize = 20;
  if (longest > 34) fontSize = 18;

  const lineH = Math.round(fontSize * 1.15);
  const h = lines.length === 1 ? 68 : Math.max(78, 28 + lines.length * lineH);
  const w = Math.min(520, Math.max(240, Math.round(longest * fontSize * 0.72 + 72)));
  const px = x == null ? Math.round((W - w) / 2) : x;
  const firstBaseline = y + (lines.length === 1 ? 44 : 32);
  const texts = lines
    .map((line, i) => {
      const ty = firstBaseline + i * lineH;
      return `<text x="${px + w / 2}" y="${ty}" text-anchor="middle" fill="${BLUE}" font-family="${FAMILY}" font-size="${fontSize}" font-weight="800">${escapeXml(
        line
      )}</text>`;
    })
    .join("\n");

  return `
    <g transform="rotate(-6 ${px + w / 2} ${y + h / 2})" filter="url(#pillShadow)">
      <rect x="${px}" y="${y}" width="${w}" height="${h}" rx="${Math.min(h / 2, 40)}" fill="${PILL_FILL}" fill-opacity="${PILL_OPACITY}"/>
      ${texts}
    </g>`;
}

function brandLockupFull(model, { y, size = 200 } = {}) {
  if (model.brandLogoDataUri) {
    return `<image href="${model.brandLogoDataUri}" x="${(W - size) / 2}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>`;
  }
  return `<rect x="${(W - size) / 2}" y="${y}" width="${size}" height="${size}" fill="${RED}"/>`;
}

function inclusionSealLines(inclusion) {
  const raw = String(inclusion || "")
    .replace(/^includes?\s+/i, "")
    .trim()
    .toUpperCase();
  if (!raw) return null;
  // Prefer two lines: INCLUDES + item (large type for short single extras)
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length === 1) return ["INCLUDES", words[0]];
  if (words.length === 2) return ["INCLUDES", words.join(" ")];
  return ["INCLUDES", words.slice(0, 2).join(" "), words.slice(2).join(" ")];
}

/** Offer / pricing slide — approved pill layout, clear destination photo */
function renderOfferSvg(model, offerIndex = 0) {
  const offer = (model.offers || [])[offerIndex] || model.offer;

  const defs = `
    <defs>
      <filter id="pillShadow" x="-20%" y="-20%" width="140%" height="160%">
        <feDropShadow dx="0" dy="7" stdDeviation="8" flood-color="#000" flood-opacity="0.32"/>
      </filter>
    </defs>`;

  let content = "";
  if (offer) {
    const showBrochure =
      offer.showBrochure === true ||
      (offer.brochureLabel &&
        offer.brochurePrice != null &&
        offer.cruise101Price != null &&
        Number(offer.brochurePrice) > Number(offer.cruise101Price));
    const brochure = showBrochure ? displayPrice(offer.brochureLabel) : "";
    const price = displayPrice(offer.priceLabel);
    const room = offer.roomLabelDisplay || offer.roomLabel || "";
    const pillW = Math.max(
      showBrochure ? measurePricePillWidth(brochure) : 0,
      measurePricePillWidth(price),
      420
    );
    const pillX = Math.round((W - pillW) / 2);
    const brochureH = 190;
    const fareH = 200;
    // Rebalance when brochure panel is omitted
    const brochureY = 300;
    const fareY = showBrochure ? 520 : 340;
    const includeItems = listInclusionItems(model);
    const includesY = fareY + fareH + 28;
    const discW = 520;
    const discH = 58;
    const discX = Math.round((W - discW) / 2);
    const discY = H - FOOTER_H - discH - 12;
    const roomX = pillX - 36;
    const roomY = (showBrochure ? brochureY : fareY) - 72;
    content = `
      ${
        showBrochure
          ? pricePill({
              x: pillX,
              y: brochureY,
              w: pillW,
              h: brochureH,
              label: "BROCHURE PRICE",
              price: brochure,
              priceColor: "#111",
              strike: true
            })
          : ""
      }
      ${angledRoomPill(room, { x: roomX, y: roomY })}
      ${pricePill({
        x: pillX,
        y: fareY,
        w: pillW,
        h: fareH,
        label: "101CRUISE PRICE",
        price: price,
        priceColor: RED,
        strike: false
      })}
      ${includesStrip({ y: includesY, items: includeItems })}
      <g filter="url(#pillShadow)">
        <rect x="${discX}" y="${discY}" width="${discW}" height="${discH}" rx="20" fill="${PILL_FILL}" fill-opacity="${PILL_OPACITY}"/>
      </g>
      <text x="540" y="${discY + 22}" text-anchor="middle" fill="#222" font-family="${FAMILY}" font-size="15" font-weight="400">${escapeXml(
        AIRLINE_STAFF_LINE
      )}</text>
      <text x="540" y="${discY + 42}" text-anchor="middle" fill="#222" font-family="${FAMILY}" font-size="15" font-weight="400">${escapeXml(
        CLASSIC_PRICE_DISCLAIMER
      )}</text>
    `;
  } else {
    // No public room prices — Main + CTA still generate; pricing cards are omitted from the plan.
    content = `
      <g filter="url(#pillShadow)">
        <rect x="160" y="420" width="760" height="180" rx="90" fill="${PILL_FILL}" fill-opacity="${PILL_OPACITY}"/>
      </g>
      <text x="540" y="500" text-anchor="middle" fill="#111" font-family="${FAMILY}" font-size="34" font-weight="800">ASK PAUL FOR HIS BEST PRICE</text>
      <text x="540" y="555" text-anchor="middle" fill="#444" font-family="${FAMILY}" font-size="22" font-weight="500">Public pricing will appear when available</text>
    `;
  }

  const body = `
    ${defs}
    ${clearPricingBackground(model)}
    ${cruiseLineLogo(model)}
    ${content}
    ${greenFooter()}
  `;
  return frame(body);
}

/** Final CTA — League Spartan + Feeling Passionate script artwork */
function renderCtaSvg(model) {
  const brandSize = 220;
  const brandY = H - FOOTER_H - brandSize - 36;
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
        <rect width="${W}" height="${H}" fill="#050814" fill-opacity="0.42"/>
      </g>`;
  }

  const scriptY = 520;
  const scriptH = 148;
  const scriptUri = loadGetYourCruiseOnDataUri();
  const scriptBlock = scriptUri
    ? `<image href="${scriptUri}" x="${(W - 820) / 2}" y="${scriptY}" width="820" height="${scriptH}" preserveAspectRatio="xMidYMid meet"/>`
    : `<text x="540" y="${scriptY + 80}" text-anchor="middle" fill="${WHITE}" font-family="Great Vibes" font-size="92">Get your cruise on</text>`;

  // Evenly space email between script ink and logo mark (optical, not box edges)
  const scriptInkBottom = scriptY + 118; // Feeling Passionate PNG ink ends above the image box
  const logoInkTop = brandY + 9;
  const emailSize = 52;
  const gap = logoInkTop - scriptInkBottom;
  const emailTop = scriptInkBottom + (gap - emailSize) / 2;
  const emailY = Math.round(emailTop + emailSize * 0.8);

  const body = `
    ${bg}
    <defs>
      <filter id="ctaHeadlineShadow" x="-20%" y="-20%" width="140%" height="160%">
        <feDropShadow dx="0" dy="6" stdDeviation="7" flood-color="#000" flood-opacity="0.55"/>
      </filter>
    </defs>
    <g filter="url(#ctaHeadlineShadow)">
      <text x="540" y="280" text-anchor="middle" fill="${WHITE}" font-family="${FAMILY_CTA}" font-size="78" font-weight="700" letter-spacing="1.5">TALK TO PAUL</text>
      <text x="540" y="370" text-anchor="middle" fill="${WHITE}" font-family="${FAMILY_CTA}" font-size="78" font-weight="700" letter-spacing="1.5">TODAY</text>
    </g>
    ${scriptBlock}
    <text x="540" y="${emailY}" text-anchor="middle" fill="${WHITE}" font-family="${FAMILY}" font-size="${emailSize}" font-weight="400">paul@101cruise.com.au</text>
    ${brandLockupFull(model, { y: brandY, size: brandSize })}
    ${greenFooter()}
    <!-- feeling_passionate_artwork=assets/social-pack/get-your-cruise-on.png -->
  `;
  return frame(body);
}

module.exports = {
  renderOfferSvg,
  renderCtaSvg,
  FOOTER_H,
  GREEN,
  displayPrice,
  loadGetYourCruiseOnDataUri
};
