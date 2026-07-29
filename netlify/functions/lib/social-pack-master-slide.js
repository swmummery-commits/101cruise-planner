/**
 * Master Main Cruise slide — three art-direction concepts.
 * Does not replace Journey / Offer / CTA templates.
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

/** Refined Oceania logo holding panel — ~270px wide, logo fills the panel. */
function cruiseLineLogo(model) {
  const panelW = 270;
  const panelH = 100;
  const x = (W - panelW) / 2;
  const y = 32;
  if (model.cruiseLineLogoDataUri) {
    return `
      <g>
        <rect x="${x}" y="${y}" width="${panelW}" height="${panelH}" rx="16" fill="${WHITE}" fill-opacity="0.95"/>
        <image href="${model.cruiseLineLogoDataUri}" x="${x + 14}" y="${y + 10}" width="${panelW - 28}" height="${panelH - 20}" preserveAspectRatio="xMidYMid meet"/>
      </g>`;
  }
  return `
    <g>
      <rect x="${x}" y="${y}" width="${panelW}" height="${panelH}" rx="16" fill="${WHITE}" fill-opacity="0.95"/>
      <text x="540" y="${y + 60}" text-anchor="middle" fill="#111" font-family="${FAMILY}" font-size="24" font-weight="700">${escapeXml(
        String(model.lineName || "").toUpperCase()
      )}</text>
    </g>`;
}

function brandLockup(model, { y, size = 148 } = {}) {
  const logoY = y;
  const urlY = logoY + size + 36;
  if (model.brandLogoDataUri) {
    return `
      <g>
        <image href="${model.brandLogoDataUri}" x="${(W - size) / 2}" y="${logoY}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>
        <text x="540" y="${urlY}" text-anchor="middle" fill="${WHITE}" font-family="${FAMILY}" font-size="32" font-weight="600" letter-spacing="2.8">101CRUISE.COM.AU</text>
      </g>`;
  }
  return `
    <g>
      <rect x="${(W - size) / 2}" y="${logoY}" width="${size}" height="${size}" fill="#F80020"/>
      <text x="540" y="${urlY}" text-anchor="middle" fill="${WHITE}" font-family="${FAMILY}" font-size="32" font-weight="600" letter-spacing="2.8">101CRUISE.COM.AU</text>
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

function portsLine(ports, { y, maxWidth = 920, fontSize = 26, anchorX = 540, anchor = "middle" } = {}) {
  const text = ports.join(" · ");
  // Soft wrap into two lines if long
  if (text.length > 48) {
    const mid = Math.ceil(ports.length / 2);
    const line1 = ports.slice(0, mid).join(" · ");
    const line2 = ports.slice(mid).join(" · ");
    return `
      <text x="${anchorX}" y="${y}" text-anchor="${anchor}" fill="${WHITE}" font-family="${FAMILY}" font-size="${fontSize}" font-weight="500">${escapeXml(
        line1
      )}</text>
      <text x="${anchorX}" y="${y + 36}" text-anchor="${anchor}" fill="${WHITE}" font-family="${FAMILY}" font-size="${fontSize}" font-weight="500">${escapeXml(
        line2
      )}</text>`;
  }
  return `<text x="${anchorX}" y="${y}" text-anchor="${anchor}" fill="${WHITE}" font-family="${FAMILY}" font-size="${fontSize}" font-weight="500">${escapeXml(
    text
  )}</text>`;
}

function routeHeadline(model, { x = 540, y = 280, anchor = "middle", size = 88 } = {}) {
  const route = String(model.routeHeadline || model.destinationStrip || "")
    .replace(/\s+TO\s+/i, "\nTO ")
    .trim();
  let line1 = "BARCELONA";
  let line2 = "TO ISTANBUL";
  if (route.includes("\n")) {
    const parts = route.split("\n").map((s) => s.trim());
    line1 = parts[0] || line1;
    line2 = parts[1] || line2;
  } else if (/ TO /i.test(route)) {
    const parts = route.split(/\s+TO\s+/i);
    line1 = (parts[0] || line1).toUpperCase();
    line2 = `TO ${(parts[1] || "ISTANBUL").toUpperCase()}`;
  }
  return `
    <text x="${x}" y="${y}" text-anchor="${anchor}" fill="${WHITE}" font-family="${FAMILY}" font-size="${size}" font-weight="800">${escapeXml(
      line1
    )}</text>
    <text x="${x}" y="${y + Math.round(size * 1.02)}" text-anchor="${anchor}" fill="${WHITE}" font-family="${FAMILY}" font-size="${size}" font-weight="800">${escapeXml(
      line2
    )}</text>`;
}

function aboardLine(model, { x = 540, y, anchor = "middle", size = 38 } = {}) {
  const text = model.aboardLine || `ABOARD ${String(model.shipName || "").toUpperCase()}`;
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" fill="${WHITE}" font-family="${FAMILY}" font-size="${size}" font-weight="600">${escapeXml(
    text
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

/** Concept A — centred, bright destination, refined logo panel */
function renderMasterConceptA(model) {
  const ports = curatedPorts(model);
  const body = `
    ${masterBackground(model, { concept: "a" })}
    ${cruiseLineLogo(model)}
    ${routeHeadline(model, { y: 300, size: 92 })}
    ${aboardLine(model, { y: 520, size: 40 })}
    ${factsBlock(model, { y: 620 })}
    ${portsLine(ports, { y: 760, fontSize: 28 })}
    ${brandLockup(model, { y: H - FOOTER_H - 230, size: 148 })}
    ${greenFooter()}
  `;
  return frame(body);
}

/** Concept B — editorial asymmetry; headline left in safe area; logo centred */
function renderMasterConceptB(model) {
  const ports = curatedPorts(model);
  const left = 88;
  const body = `
    ${masterBackground(model, { concept: "b" })}
    ${cruiseLineLogo(model)}
    <rect x="72" y="250" width="6" height="420" rx="3" fill="${GREEN}" fill-opacity="0.85"/>
    ${routeHeadline(model, { x: left + 24, y: 310, anchor: "start", size: 86 })}
    ${aboardLine(model, { x: left + 24, y: 530, anchor: "start", size: 36 })}
    ${factsBlock(model, { x: left + 24, y: 630, anchor: "start" })}
    ${portsLine(ports, { y: 780, fontSize: 26, anchorX: left + 24, anchor: "start" })}
    ${brandLockup(model, { y: H - FOOTER_H - 230, size: 148 })}
    ${greenFooter()}
  `;
  return frame(body);
}

/** Concept C — lower content panel; image remains dominant above */
function renderMasterConceptC(model) {
  const ports = curatedPorts(model);
  const body = `
    ${masterBackground(model, { concept: "c" })}
    ${cruiseLineLogo(model)}
    <rect x="64" y="620" width="952" height="430" rx="28" fill="#071018" fill-opacity="0.38"/>
    ${routeHeadline(model, { y: 720, size: 80 })}
    ${aboardLine(model, { y: 890, size: 34 })}
    ${factsBlock(model, { y: 970 })}
    ${portsLine(ports, { y: 1050, fontSize: 24 })}
    ${brandLockup(model, { y: H - FOOTER_H - 185, size: 132 })}
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
  renderMasterConceptA,
  renderMasterConceptB,
  renderMasterConceptC
};
