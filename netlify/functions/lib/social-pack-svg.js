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

/** Slide 1 — Main cruise */
function renderMainCruiseSvg(model) {
  const treatment = model.slideTreatments?.main || model.treatment || "soft";
  const route = model.routeHeadline || model.destinationStrip || "";
  const routeLines = String(route)
    .split(/\n/)
    .filter(Boolean);
  // Split "A TO B" onto two lines when long
  let headlineLines = routeLines;
  if (headlineLines.length === 1 && / TO /.test(headlineLines[0]) && headlineLines[0].length > 22) {
    headlineLines = headlineLines[0].split(/ TO /);
    headlineLines = [headlineLines[0] + " TO", headlineLines.slice(1).join(" TO ")];
  }

  const portLines = wrapPortsLine(model.ports || [], 52);
  let hy = 280;
  const headline = headlineLines
    .map((line, i) => {
      const y = hy + i * 64;
      return `<text x="540" y="${y}" text-anchor="middle" fill="${WHITE}" font-family="Helvetica, Arial, sans-serif" font-size="54" font-weight="700">${escapeXml(
        line
      )}</text>`;
    })
    .join("\n");
  hy += headlineLines.length * 64 + 18;

  const aboard = model.aboardLine
    ? `<text x="540" y="${hy}" text-anchor="middle" fill="${WHITE}" font-family="Helvetica, Arial, sans-serif" font-size="30" font-weight="600">${escapeXml(
        model.aboardLine
      )}</text>`
    : "";
  hy += model.aboardLine ? 70 : 20;

  const nights = model.nightsLabel
    ? `<text x="540" y="${hy}" text-anchor="middle" fill="${WHITE}" font-family="Helvetica, Arial, sans-serif" font-size="34" font-weight="700">${escapeXml(
        model.nightsLabel
      )}</text>`
    : "";
  hy += model.nightsLabel ? 48 : 0;

  const departing = model.departingLabel
    ? `<text x="540" y="${hy}" text-anchor="middle" fill="${WHITE}" font-family="Helvetica, Arial, sans-serif" font-size="28" font-weight="600">${escapeXml(
        model.departingLabel
      )}</text>`
    : "";
  hy += model.departingLabel ? 70 : 30;

  const portsBlock = portLines
    .map((line, i) => {
      return `<text x="540" y="${hy + i * 36}" text-anchor="middle" fill="${WHITE}" font-family="Helvetica, Arial, sans-serif" font-size="22">${escapeXml(
        line
      )}</text>`;
    })
    .join("\n");

  const body = `
    ${destinationBackground(model, treatment)}
    ${cruiseLineLogoBlock(model)}
    ${headline}
    ${aboard}
    ${nights}
    ${departing}
    ${portsBlock}
    ${brandLogoFooter(model, { y: H - FOOTER_H - 130, size: 64 })}
    ${greenFooter()}
  `;
  return frame(body);
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

/** Offer slide — one room */
function renderOfferSvg(model, offerIndex = 0) {
  const treatment = model.slideTreatments?.offer || "strong";
  const offer = (model.offers || [])[offerIndex] || model.offer;
  const inclusion = model.primaryInclusion || (model.inclusions || [])[0] || "";

  let panels = "";
  let seals = "";
  if (offer) {
    panels = `
      <rect x="70" y="250" width="620" height="110" rx="16" fill="${WHITE}" fill-opacity="0.95"/>
      <text x="96" y="292" fill="#333" font-family="Helvetica, Arial, sans-serif" font-size="18" letter-spacing="1">BROCHURE PRICE</text>
      <text x="96" y="340" fill="#111" font-family="Helvetica, Arial, sans-serif" font-size="42" font-weight="700">${escapeXml(
        offer.brochureLabel || "—"
      )}<tspan font-size="18" font-weight="500"> PP</tspan></text>

      <rect x="70" y="390" width="620" height="120" rx="16" fill="${WHITE}" fill-opacity="0.95"/>
      <text x="96" y="436" fill="#333" font-family="Helvetica, Arial, sans-serif" font-size="18" letter-spacing="1">101CRUISE PRICE</text>
      <text x="96" y="488" fill="${RED}" font-family="Helvetica, Arial, sans-serif" font-size="48" font-weight="700">${escapeXml(
        offer.priceLabel || ""
      )}<tspan font-size="18" font-weight="500" fill="#111"> PP</tspan></text>
    `;
    if (offer.saveLabel) {
      seals += softBurst(860, 360, offer.saveLabel.replace(/^SAVE\s+/i, "SAVE\n").slice(0, 18), {
        text: RED
      });
      // Multi-line save handled simply as single line truncated
      seals = `
        <g>
          <circle cx="860" cy="360" r="86" fill="#F5E6B8" fill-opacity="0.96"/>
          <circle cx="860" cy="360" r="78" fill="none" stroke="#D4B86A" stroke-width="2"/>
          <text x="860" y="352" text-anchor="middle" fill="${RED}" font-family="Helvetica, Arial, sans-serif" font-size="16" font-weight="700">SAVE</text>
          <text x="860" y="384" text-anchor="middle" fill="${RED}" font-family="Helvetica, Arial, sans-serif" font-size="22" font-weight="700">${escapeXml(
            (offer.saveLabel || "").replace(/^SAVE\s+/i, "")
          )}</text>
        </g>`;
    }
    if (inclusion) {
      seals += `
        <g>
          <circle cx="860" cy="560" r="86" fill="#F5E6B8" fill-opacity="0.96"/>
          <circle cx="860" cy="560" r="78" fill="none" stroke="#D4B86A" stroke-width="2"/>
          <text x="860" y="548" text-anchor="middle" fill="${RED}" font-family="Helvetica, Arial, sans-serif" font-size="15" font-weight="700">INCLUDES</text>
          <text x="860" y="576" text-anchor="middle" fill="${RED}" font-family="Helvetica, Arial, sans-serif" font-size="15" font-weight="700">${escapeXml(
            String(inclusion).slice(0, 22).toUpperCase()
          )}</text>
        </g>`;
    }
  } else {
    panels = `
      <rect x="70" y="320" width="940" height="180" rx="16" fill="${WHITE}" fill-opacity="0.95"/>
      <text x="540" y="400" text-anchor="middle" fill="#111" font-family="Helvetica, Arial, sans-serif" font-size="36" font-weight="700">ASK PAUL FOR HIS BEST PRICE</text>
      <text x="540" y="450" text-anchor="middle" fill="#444" font-family="Helvetica, Arial, sans-serif" font-size="22">Public pricing will appear when available</text>
    `;
  }

  const roomBadge = offer
    ? `
      <rect x="70" y="170" width="420" height="52" rx="26" fill="#1e3a5f" fill-opacity="0.92"/>
      <text x="280" y="204" text-anchor="middle" fill="${WHITE}" font-family="Helvetica, Arial, sans-serif" font-size="22" font-weight="700">${escapeXml(
        offer.roomLabelDisplay || offer.roomLabel || ""
      )}</text>
    `
    : "";

  const body = `
    ${destinationBackground(model, treatment)}
    ${cruiseLineLogoBlock(model)}
    ${roomBadge}
    ${panels}
    ${seals}
    <rect x="200" y="980" width="680" height="40" rx="20" fill="${WHITE}" fill-opacity="0.92"/>
    <text x="540" y="1006" text-anchor="middle" fill="#222" font-family="Helvetica, Arial, sans-serif" font-size="15">All prices are per person in USD and subject to availability</text>
    ${brandLogoFooter(model, { y: H - FOOTER_H - 120, size: 56 })}
    ${greenFooter()}
  `;
  return frame(body);
}

/** Final CTA */
function renderCtaSvg(model) {
  const treatment = model.slideTreatments?.cta || "strong";
  // Typographic compromise for "Get your cruise on" — no bundled script font.
  const scriptCompromise = true;
  const body = `
    ${destinationBackground(model, treatment)}
    <text x="540" y="340" text-anchor="middle" fill="${WHITE}" font-family="Helvetica, Arial, sans-serif" font-size="48" font-weight="700">TALK TO PAUL</text>
    <text x="540" y="410" text-anchor="middle" fill="${WHITE}" font-family="Helvetica, Arial, sans-serif" font-size="48" font-weight="700">TODAY</text>
    <text x="540" y="560" text-anchor="middle" fill="${WHITE}" font-family="Helvetica, Arial, sans-serif" font-size="56" font-style="italic" font-weight="500">Get your cruise on</text>
    <text x="540" y="680" text-anchor="middle" fill="${WHITE}" font-family="Helvetica, Arial, sans-serif" font-size="28" font-weight="700" letter-spacing="1">SIGN UP FOR WEEKLY CRUISE SPECIALS</text>
    ${brandLogoFooter(model, { y: 820, size: 110 })}
    ${greenFooter()}
    <!-- script_font_compromise=${scriptCompromise} -->
  `;
  return frame(body);
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
