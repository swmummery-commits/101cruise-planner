/**
 * Master Main Cruise slide — Concept A is the approved Slide 1 production template.
 * Concepts B/C remain for review only.
 */

const { escapeXml } = require("./social-pack-copy");
const { FAMILY } = require("./social-pack-fonts");

const W = 1080;
const H = 1350;
const GREEN = "#8DD9BF";
const WHITE = "#FFFFFF";
const FOOTER_H = 64;

function frame(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${body}
</svg>`;
}

/**
 * Full-bleed image + localised readability overlays (no flat grey veil).
 */
function masterBackground(model, { concept = "a" } = {}) {
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

  // Soft overall lift (~12–15%) plus a mid-canvas vertical band for type.
  let overlays = `
    <rect width="${W}" height="${H}" fill="#071018" fill-opacity="0.12"/>
    <rect width="${W}" height="${H}" fill="url(#readabilityBand)" />
  `;
  if (concept === "c") {
    overlays = `
      <rect width="${W}" height="${H}" fill="#071018" fill-opacity="0.08"/>
      <rect x="0" y="560" width="${W}" height="720" fill="url(#lowerPanelShade)"/>
    `;
  }

  return `
    <defs>
      <clipPath id="canvasClip"><rect width="${W}" height="${H}"/></clipPath>
      <linearGradient id="readabilityBand" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#050814" stop-opacity="0.02"/>
        <stop offset="16%" stop-color="#050814" stop-opacity="0.16"/>
        <stop offset="48%" stop-color="#050814" stop-opacity="0.22"/>
        <stop offset="72%" stop-color="#050814" stop-opacity="0.12"/>
        <stop offset="100%" stop-color="#050814" stop-opacity="0.04"/>
      </linearGradient>
      <linearGradient id="lowerPanelShade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#050814" stop-opacity="0"/>
        <stop offset="22%" stop-color="#050814" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="#050814" stop-opacity="0.40"/>
      </linearGradient>
    </defs>
    <g clip-path="url(#canvasClip)">
      <image href="${href}" x="${dx}" y="${dy}" width="${dw}" height="${dh}" preserveAspectRatio="xMidYMid slice"/>
      ${overlays}
    </g>
  `;
}

function greenFooter() {
  return `<rect x="0" y="${H - FOOTER_H}" width="${W}" height="${FOOTER_H}" fill="${GREEN}"/>`;
}

/**
 * Top-edge pointed banner for the cruise-line logo (Princess-style integrated tab).
 * Hangs from y=0 — not a floating rounded card. Trimmed logo artwork fills the
 * banner so there is no nested white square inside a second white container.
 */
function cruiseLineLogo(model) {
  const tipH = 20;
  const padX = 36;
  const padTop = 18;
  const padBottom = 14;
  // Size banner from trimmed logo aspect when available (Oceania is wide).
  const lw = Number(model.cruiseLineLogoWidth) || 0;
  const lh = Number(model.cruiseLineLogoHeight) || 0;
  const aspect = lw > 0 && lh > 0 ? lw / lh : 3.1;
  const logoH = 72;
  const logoW = Math.min(420, Math.round(logoH * aspect));
  const bannerW = logoW + padX * 2;
  const bodyH = padTop + logoH + padBottom;
  const bannerH = bodyH + tipH;
  const x = (W - bannerW) / 2;
  const path = [
    `M ${x} 0`,
    `L ${x + bannerW} 0`,
    `L ${x + bannerW} ${bodyH}`,
    `L ${x + bannerW / 2} ${bannerH}`,
    `L ${x} ${bodyH}`,
    "Z"
  ].join(" ");
  if (model.cruiseLineLogoDataUri) {
    return `
      <g>
        <path d="${path}" fill="${WHITE}"/>
        <image href="${model.cruiseLineLogoDataUri}" x="${x + padX}" y="${padTop}" width="${logoW}" height="${logoH}" preserveAspectRatio="xMidYMid meet"/>
      </g>`;
  }
  return `
    <g>
      <path d="${path}" fill="${WHITE}"/>
      <text x="540" y="${Math.round(bodyH * 0.62)}" text-anchor="middle" fill="#111" font-family="${FAMILY}" font-size="24" font-weight="700">${escapeXml(
        String(model.lineName || "").toUpperCase()
      )}</text>
    </g>`;
}

function brandLockup(model, { y, size = 200 } = {}) {
  // Logo only — URL is already in the mark; do not repeat 101CRUISE.COM.AU as text.
  if (model.brandLogoDataUri) {
    return `
      <g>
        <image href="${model.brandLogoDataUri}" x="${(W - size) / 2}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>
      </g>`;
  }
  return `
    <g>
      <rect x="${(W - size) / 2}" y="${y}" width="${size}" height="${size}" fill="#F80020"/>
    </g>`;
}

function curatedPorts(model) {
  const raw = (model.ports || []).map((p) =>
    String(p || "")
      .replace(/,.*$/, "")
      .replace(/\s*\([^)]*\)\s*/g, "")
      .trim()
  );
  const preferred = ["Barcelona", "Palermo", "Paros", "Athens", "Kusadasi", "Istanbul"];
  const byKey = new Map(
    raw.map((p) => [p.toLowerCase().replace(/\s+/g, " "), p])
  );
  // Map common aliases into preferred names
  if (byKey.has("piraeus") && !byKey.has("athens")) byKey.set("athens", "Athens");

  const picks = [];
  for (const name of preferred) {
    const key = name.toLowerCase();
    const hit =
      [...byKey.entries()].find(([k]) => k === key || k.includes(key) || key.includes(k)) || null;
    if (hit) picks.push(name.toUpperCase());
  }
  if (picks.length >= 4) return picks.slice(0, 6);

  // Fallback: first, spaced middles, last
  let fallback = [];
  if (raw.length <= 6) fallback = raw;
  else {
    fallback = [
      raw[0],
      raw[1],
      raw[Math.floor(raw.length / 3)],
      raw[Math.floor((2 * raw.length) / 3)],
      raw[raw.length - 2],
      raw[raw.length - 1]
    ];
  }
  const seen = new Set();
  const unique = [];
  for (const p of fallback) {
    const u = String(p || "").toUpperCase();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    unique.push(u);
  }
  return unique.slice(0, 6);
}

function portsLine(ports, { y, maxWidth = 920, fontSize = 34, anchorX = 540, anchor = "middle" } = {}) {
  const text = ports.join(" · ");
  const lineGap = Math.round(fontSize * 1.28);
  // Soft wrap into two lines if long
  if (text.length > 42) {
    const mid = Math.ceil(ports.length / 2);
    const line1 = ports.slice(0, mid).join(" · ");
    const line2 = ports.slice(mid).join(" · ");
    return `
      <text x="${anchorX}" y="${y}" text-anchor="${anchor}" fill="${WHITE}" font-family="${FAMILY}" font-size="${fontSize}" font-weight="500">${escapeXml(
        line1
      )}</text>
      <text x="${anchorX}" y="${y + lineGap}" text-anchor="${anchor}" fill="${WHITE}" font-family="${FAMILY}" font-size="${fontSize}" font-weight="500">${escapeXml(
        line2
      )}</text>`;
  }
  return `<text x="${anchorX}" y="${y}" text-anchor="${anchor}" fill="${WHITE}" font-family="${FAMILY}" font-size="${fontSize}" font-weight="500">${escapeXml(
    text
  )}</text>`;
}

function routeHeadline(model, { x = 540, y = 280, anchor = "middle", size = 88 } = {}) {
  const route = String(model.routeHeadline || model.destinationStrip || "").trim();
  let from = "BARCELONA";
  let to = "ISTANBUL";
  if (/ TO /i.test(route)) {
    const parts = route.split(/\s+TO\s+/i);
    from = (parts[0] || from).toUpperCase();
    to = (parts[1] || to).toUpperCase();
  } else if (route.includes("\n")) {
    const parts = route.split("\n").map((s) => s.trim());
    from = (parts[0] || from).replace(/^TO\s+/i, "").toUpperCase();
    to = (parts[parts.length - 1] || to).replace(/^TO\s+/i, "").toUpperCase();
  } else if (route) {
    from = route.toUpperCase();
  }
  const lineGap = Math.round(size * 1.02);
  return `
    <text x="${x}" y="${y}" text-anchor="${anchor}" fill="${WHITE}" font-family="${FAMILY}" font-size="${size}" font-weight="800">${escapeXml(
      from
    )}</text>
    <text x="${x}" y="${y + lineGap}" text-anchor="${anchor}" fill="${WHITE}" font-family="${FAMILY}" font-size="${size}" font-weight="800">${escapeXml(
      "TO"
    )}</text>
    <text x="${x}" y="${y + lineGap * 2}" text-anchor="${anchor}" fill="${WHITE}" font-family="${FAMILY}" font-size="${size}" font-weight="800">${escapeXml(
      to
    )}</text>`;
}

function aboardLine(model, { x = 540, y, anchor = "middle", size = 38 } = {}) {
  const text = model.aboardLine || `ABOARD ${String(model.shipName || "").toUpperCase()}`;
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" fill="${WHITE}" font-family="${FAMILY}" font-size="${size}" font-weight="600">${escapeXml(
    text
  )}</text>`;
}

function shipLabel(model) {
  const ship = String(model.shipName || "OCEANIA SIRENA").toUpperCase();
  return /oceania/i.test(ship) ? ship : `OCEANIA ${ship}`.replace(/\s+/g, " ").trim();
}

/** "10 NIGHTS  |  17–27 AUGUST 2026" — nights and dates share the same type treatment */
function nightsDatesLine(model, { x = 540, y, anchor = "middle", size = 36 } = {}) {
  const nights = String(model.nightsLabel || "").toUpperCase() || "10 NIGHTS";
  const dates = String(model.dateRangeFull || model.dateRange || "").toUpperCase();
  const text = dates ? `${nights}  |  ${dates}` : nights;
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" fill="${WHITE}" font-family="${FAMILY}" font-size="${size}" font-weight="700">${escapeXml(
    text
  )}</text>`;
}

function shipLine(model, { x = 540, y, anchor = "middle", size = 36 } = {}) {
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" fill="${WHITE}" font-family="${FAMILY}" font-size="${size}" font-weight="700">${escapeXml(
    shipLabel(model)
  )}</text>`;
}

function factsBlock(model, { x = 540, y, anchor = "middle", panel = false } = {}) {
  const nights = model.nightsLabel || "";
  const dates = model.dateRangeFull || model.dateRange || "";
  if (panel) {
    return `
      <rect x="${x - 220}" y="${y - 48}" width="440" height="110" rx="16" fill="${WHITE}" fill-opacity="0.14"/>
      <text x="${x}" y="${y}" text-anchor="${anchor}" fill="${WHITE}" font-family="${FAMILY}" font-size="34" font-weight="700">${escapeXml(
        nights
      )}</text>
      <text x="${x}" y="${y + 42}" text-anchor="${anchor}" fill="${WHITE}" font-family="${FAMILY}" font-size="26" font-weight="500">${escapeXml(
        dates
      )}</text>`;
  }
  return `
    <text x="${x}" y="${y}" text-anchor="${anchor}" fill="${WHITE}" font-family="${FAMILY}" font-size="36" font-weight="700">${escapeXml(
      nights
    )}</text>
    <text x="${x}" y="${y + 44}" text-anchor="${anchor}" fill="${WHITE}" font-family="${FAMILY}" font-size="28" font-weight="500">${escapeXml(
      dates
    )}</text>`;
}

/**
 * Concept A — approved Slide 1 (Main Cruise) production template.
 * banner → route → nights|dates → ship → ports (mid) → brand logo → footer
 */
function renderMasterConceptA(model) {
  const ports = curatedPorts(model);
  const headlineY = 240;
  const headlineSize = 92;
  const headlineLineGap = Math.round(headlineSize * 1.02);
  const headlineEnd = headlineY + headlineLineGap * 2;
  const portsY = 740;
  // Nights/dates + ship sit halfway between route headline and ports
  const midGap = (headlineEnd + portsY) / 2;
  const nightsDatesY = Math.round(midGap - 24);
  const shipY = nightsDatesY + 48;
  const brandSize = 200;
  const brandY = H - FOOTER_H - brandSize - 48;
  const body = `
    ${masterBackground(model, { concept: "a" })}
    ${cruiseLineLogo(model)}
    ${routeHeadline(model, { y: headlineY, size: headlineSize })}
    ${nightsDatesLine(model, { y: nightsDatesY, size: 36 })}
    ${shipLine(model, { y: shipY, size: 36 })}
    ${portsLine(ports, { y: portsY, fontSize: 40 })}
    ${brandLockup(model, { y: brandY, size: brandSize })}
    ${greenFooter()}
  `;
  return frame(body);
}

/** Concept B — editorial asymmetry; headline left in safe area; logo centred */
function renderMasterConceptB(model) {
  const ports = curatedPorts(model);
  const left = 88;
  const brandSize = 200;
  const brandY = H - FOOTER_H - brandSize - 20;
  const body = `
    ${masterBackground(model, { concept: "b" })}
    ${cruiseLineLogo(model)}
    <rect x="72" y="250" width="6" height="360" rx="3" fill="${GREEN}" fill-opacity="0.85"/>
    ${routeHeadline(model, { x: left + 24, y: 310, anchor: "start", size: 86 })}
    ${nightsDatesLine(model, { x: left + 24, y: 520, anchor: "start", size: 34 })}
    ${shipLine(model, { x: left + 24, y: 568, anchor: "start", size: 34 })}
    ${portsLine(ports, { y: 700, fontSize: 34, anchorX: left + 24, anchor: "start" })}
    ${brandLockup(model, { y: brandY, size: brandSize })}
    ${greenFooter()}
  `;
  return frame(body);
}

/** Concept C — lower content panel; image remains dominant above */
function renderMasterConceptC(model) {
  const ports = curatedPorts(model);
  const brandSize = 180;
  const brandY = H - FOOTER_H - brandSize - 20;
  const body = `
    ${masterBackground(model, { concept: "c" })}
    ${cruiseLineLogo(model)}
    <rect x="64" y="620" width="952" height="380" rx="28" fill="#071018" fill-opacity="0.38"/>
    ${routeHeadline(model, { y: 720, size: 80 })}
    ${nightsDatesLine(model, { y: 880, size: 32 })}
    ${shipLine(model, { y: 924, size: 32 })}
    ${portsLine(ports, { y: 1000, fontSize: 32 })}
    ${brandLockup(model, { y: brandY, size: brandSize })}
    ${greenFooter()}
  `;
  return frame(body);
}

module.exports = {
  WIDTH: W,
  HEIGHT: H,
  GREEN,
  FOOTER_H,
  curatedPorts,
  cruiseLineLogo,
  masterBackground,
  greenFooter,
  renderMasterConceptA,
  renderMasterConceptB,
  renderMasterConceptC
};
