/**
 * Destination-first Social Pack SVG templates (1080×1350 portrait).
 * Full-bleed destination photography with Clear / Soft / Strong treatment.
 * Never uses white document-page layouts.
 */

const { escapeXml } = require("./social-pack-copy");

const W = 1080;
const H = 1350;
const GREEN = "#8DD9BF";
const WHITE = "#FFFFFF";
const FOOTER_H = 42;
const RED = "#F80020";

const TREATMENTS = {
  clear: { blur: 0, scale: 1.02, overlay: 0.4, enlarge: 1.02 },
  soft: { blur: 12, scale: 1.12, overlay: 0.5, enlarge: 1.12 },
  strong: { blur: 20, scale: 1.18, overlay: 0.6, enlarge: 1.18 }
};

function treatmentConfig(name) {
  const key = String(name || "soft").toLowerCase();
  return TREATMENTS[key] || TREATMENTS.soft;
}

function greenFooter() {
  return `<rect x="0" y="${H - FOOTER_H}" width="${W}" height="${FOOTER_H}" fill="${GREEN}"/>`;
}

/**
 * Full-bleed cover-cropped background.
 * Expects a pre-treated (or clear) raster in backgroundDataUri — blur is applied
 * server-side before SVG assembly because resvg feGaussianBlur fails on large JPEGs.
 */
function destinationBackground(model, treatmentName) {
  const t = treatmentConfig(treatmentName);
  const href = model.backgroundDataUri || model.heroDataUri;
  if (!href) {
    return `<rect width="${W}" height="${H}" fill="#0b1220"/>`;
  }

  const imgW = Number(model.backgroundWidth || model.heroWidth) || W;
  const imgH = Number(model.backgroundHeight || model.heroHeight) || H;
  // Pre-treated rasters are already canvas-sized; still cover-crop safely.
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
      <clipPath id="canvasClip"><rect x="0" y="0" width="${W}" height="${H}"/></clipPath>
    </defs>
    <g clip-path="url(#canvasClip)">
      <image href="${href}" x="${dx}" y="${dy}" width="${dw}" height="${dh}" preserveAspectRatio="xMidYMid slice"/>
      <rect x="0" y="0" width="${W}" height="${H}" fill="#050814" fill-opacity="${t.overlay}"/>
    </g>
  `;
}

function cruiseLineLogoBlock(model) {
  if (model.cruiseLineLogoDataUri) {
    return `
      <g>
        <path d="M 340 0 L 740 0 L 700 118 L 380 118 Z" fill="${WHITE}" fill-opacity="0.96"/>
        <image href="${model.cruiseLineLogoDataUri}" x="430" y="18" width="220" height="82" preserveAspectRatio="xMidYMid meet"/>
      </g>`;
  }
  if (model.lineName) {
    return `
      <g>
        <path d="M 340 0 L 740 0 L 700 118 L 380 118 Z" fill="${WHITE}" fill-opacity="0.96"/>
        <text x="540" y="72" text-anchor="middle" fill="#111" font-family="Helvetica, Arial, sans-serif" font-size="28" font-weight="700">${escapeXml(
          String(model.lineName).toUpperCase()
        )}</text>
      </g>`;
  }
  return "";
}

function brandLogoFooter(model, { y = H - 150, size = 72 } = {}) {
  if (model.brandLogoDataUri) {
    return `
      <image href="${model.brandLogoDataUri}" x="${(W - size) / 2}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>
      <text x="540" y="${y + size + 28}" text-anchor="middle" fill="${WHITE}" font-family="Helvetica, Arial, sans-serif" font-size="18" letter-spacing="2">101CRUISE.COM.AU</text>
    `;
  }
  return `
    <rect x="${(W - size) / 2}" y="${y}" width="${size}" height="${size}" fill="${RED}"/>
    <text x="540" y="${y + size + 28}" text-anchor="middle" fill="${WHITE}" font-family="Helvetica, Arial, sans-serif" font-size="18" letter-spacing="2">101CRUISE.COM.AU</text>
  `;
}

function wrapPortsLine(ports, maxChars = 54) {
  const list = (ports || []).filter(Boolean);
  if (!list.length) return [];
  const lines = [];
  let current = "";
  for (let i = 0; i < list.length; i += 1) {
    const part = list[i];
    const next = current ? `${current} | ${part}` : part;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = part;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 4);
}

function frame(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${body}
</svg>`;
}

/** Slide 1 — Main cruise (approved Concept A master template) */
function renderMainCruiseSvg(model) {
  const { renderMasterConceptA } = require("./social-pack-master-slide");
  return renderMasterConceptA(model);
}

/** Slide 2 — Journey with route map panel */
function renderJourneySvg(model) {
  const treatment = model.slideTreatments?.journey || model.treatment || "soft";
  const arrow = model.journeyArrow || model.journeyLine || "";
  const ports = model.ports || [];
  const primary = ports.slice(0, 6);
  const extra = ports.slice(6);

  let mapBlock = "";
  if (model.routeMapDataUri) {
    mapBlock = `
      <rect x="90" y="300" width="900" height="420" rx="18" fill="${WHITE}" fill-opacity="0.12" stroke="${WHITE}" stroke-opacity="0.35" stroke-width="2"/>
      <image href="${model.routeMapDataUri}" x="110" y="318" width="860" height="384" preserveAspectRatio="xMidYMid meet"/>
    `;
  } else {
    mapBlock = `
      <rect x="90" y="300" width="900" height="280" rx="18" fill="${WHITE}" fill-opacity="0.12" stroke="${WHITE}" stroke-opacity="0.35" stroke-width="2"/>
      <text x="540" y="450" text-anchor="middle" fill="${WHITE}" font-family="Helvetica, Arial, sans-serif" font-size="28">${escapeXml(
        arrow
      )}</text>
    `;
  }

  const highlightY = model.routeMapDataUri ? 780 : 640;
  const highlights = primary
    .map((p, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const x = 160 + col * 280;
      const y = highlightY + row * 42;
      return `<text x="${x}" y="${y}" text-anchor="middle" fill="${WHITE}" font-family="Helvetica, Arial, sans-serif" font-size="22">${escapeXml(
        p
      )}</text>`;
    })
    .join("\n");

  const plus =
    extra.length > 0
      ? `<text x="540" y="${highlightY + 110}" text-anchor="middle" fill="${WHITE}" font-family="Helvetica, Arial, sans-serif" font-size="20">Plus ${escapeXml(
          extra.join(", ")
        )}</text>`
      : "";

  const body = `
    ${destinationBackground(model, treatment)}
    ${cruiseLineLogoBlock(model)}
    <text x="540" y="190" text-anchor="middle" fill="${WHITE}" font-family="Helvetica, Arial, sans-serif" font-size="42" font-weight="700">${escapeXml(
      arrow
    )}</text>
    <text x="540" y="250" text-anchor="middle" fill="${WHITE}" font-family="Helvetica, Arial, sans-serif" font-size="26" font-weight="600">${escapeXml(
      [model.nightsLabel, model.dateRangeFull].filter(Boolean).join(" · ")
    )}</text>
    ${mapBlock}
    <text x="540" y="${highlightY - 36}" text-anchor="middle" fill="${WHITE}" font-family="Helvetica, Arial, sans-serif" font-size="18" letter-spacing="4">HIGHLIGHTS</text>
    ${highlights}
    ${plus}
    ${brandLogoFooter(model, { y: H - FOOTER_H - 120, size: 56 })}
    ${greenFooter()}
  `;
  return frame(body);
}

function softBurst(cx, cy, label, { fill = "#F5E6B8", text = "#111" } = {}) {
  const r = 78;
  // Softened seal — rounded hex-ish circle, not jagged supermarket sticker
  return `
    <g>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" fill-opacity="0.95"/>
      <circle cx="${cx}" cy="${cy}" r="${r - 6}" fill="none" stroke="#D4B86A" stroke-width="2" stroke-opacity="0.7"/>
      <text x="${cx}" y="${cy + 8}" text-anchor="middle" fill="${text}" font-family="Helvetica, Arial, sans-serif" font-size="18" font-weight="700">${escapeXml(
        label
      )}</text>
    </g>`;
}

/** Offer slide — Canva pill pricing layout (clear destination photo) */
function renderOfferSvg(model, offerIndex = 0) {
  return require("./social-pack-offer-cta").renderOfferSvg(model, offerIndex);
}

/** Final CTA — League Spartan + Great Vibes script */
function renderCtaSvg(model) {
  return require("./social-pack-offer-cta").renderCtaSvg(model);
}

// Back-compat alias used by older tests
function renderHeroSvg(model) {
  return renderMainCruiseSvg(model);
}

module.exports = {
  WIDTH: W,
  HEIGHT: H,
  GREEN,
  TREATMENTS,
  treatmentConfig,
  destinationBackground,
  renderMainCruiseSvg,
  renderHeroSvg,
  renderJourneySvg,
  renderOfferSvg,
  renderCtaSvg
};
