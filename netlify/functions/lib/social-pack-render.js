/**
 * Fetch remote images and rasterise Social Pack SVGs with @resvg/resvg-js.
 */

const { Resvg } = require("@resvg/resvg-js");
const {
  WIDTH,
  HEIGHT,
  renderJourneySvg,
  renderOfferSvg,
  renderCtaSvg
} = require("./social-pack-svg");

const MAX_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20000;

function sniffMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

async function fetchImageAsDataUri(url, { allowHttpLocalhost = false } = {}) {
  const href = String(url || "").trim();
  if (!href) throw Object.assign(new Error("Image URL missing."), { statusCode: 400, calm: true });
  const isHttp = /^https:\/\//i.test(href);
  const isLocal =
    allowHttpLocalhost && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(href);
  if (!isHttp && !isLocal) {
    throw Object.assign(new Error("Only HTTPS image URLs are allowed."), {
      statusCode: 400,
      calm: true
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(href, { signal: controller.signal, redirect: "follow" });
    if (!response.ok) {
      throw Object.assign(new Error("Could not download the cruise image."), {
        statusCode: 502,
        calm: true
      });
    }
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > MAX_BYTES) {
      throw Object.assign(new Error("Cruise image is too large to use."), {
        statusCode: 400,
        calm: true
      });
    }
    const mime = sniffMime(buf) || String(response.headers.get("content-type") || "").split(";")[0];
    if (!mime || !/^image\/(jpeg|jpg|png|webp)$/i.test(mime)) {
      throw Object.assign(new Error("Cruise image format is not supported."), {
        statusCode: 400,
        calm: true
      });
    }
    const normalised = mime === "image/jpg" ? "image/jpeg" : mime;
    return {
      dataUri: `data:${normalised};base64,${buf.toString("base64")}`,
      bytes: buf.length,
      mime: normalised
    };
  } catch (error) {
    if (error.calm) throw error;
    if (error.name === "AbortError") {
      throw Object.assign(new Error("Timed out downloading the cruise image."), {
        statusCode: 504,
        calm: true
      });
    }
    throw Object.assign(new Error("Could not download the cruise image."), {
      statusCode: 502,
      calm: true
    });
  } finally {
    clearTimeout(timer);
  }
}

function svgToPngBuffer(svg, { width = WIDTH, height = HEIGHT } = {}) {
  const { resvgFontOptions } = require("./social-pack-fonts");
  const resvg = new Resvg(Buffer.from(svg, "utf8"), {
    fitTo: { mode: "width", value: width },
    background: "rgba(0,0,0,0)",
    font: resvgFontOptions()
  });
  const rendered = resvg.render();
  const png = Buffer.from(rendered.asPng());
  return {
    png,
    width: rendered.width,
    height: rendered.height
  };
}

function coverCropSvg(href, { width, height, imgW, imgH, enlarge = 1 }) {
  const boxRatio = width / height;
  const imgRatio = (imgW || width) / Math.max(1, imgH || height);
  let dw;
  let dh;
  if (imgRatio > boxRatio) {
    dh = height * enlarge;
    dw = dh * imgRatio;
  } else {
    dw = width * enlarge;
    dh = dw / imgRatio;
  }
  const dx = (width - dw) / 2;
  const dy = (height - dh) / 2;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs><clipPath id="c"><rect width="${width}" height="${height}"/></clipPath></defs>
  <g clip-path="url(#c)">
    <image href="${href}" x="${dx}" y="${dy}" width="${dw}" height="${dh}" preserveAspectRatio="xMidYMid slice"/>
  </g>
</svg>`;
}

function pngDimensionsFromDataUri(dataUri) {
  const m = String(dataUri || "").match(/^data:image\/png;base64,(.+)$/i);
  if (!m) return null;
  try {
    const buf = Buffer.from(m[1], "base64");
    if (buf.length < 24 || buf[0] !== 0x89) return null;
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20)
    };
  } catch {
    return null;
  }
}

/**
 * Trim empty white padding from cruise-line logo artwork so the mark fills
 * a pointed banner (avoids a tiny logo square nested inside a white shape).
 * Does not alter Media Library originals — runtime crop of the fetched buffer only.
 */
function prepareCruiseLineLogoForBanner(dataUri) {
  const href = String(dataUri || "").trim();
  if (!href.startsWith("data:image/")) return null;

  const dims = pngDimensionsFromDataUri(href);
  const srcW = dims?.width || 512;
  const srcH = dims?.height || 512;
  const maxEdge = 640;
  const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
  const pw = Math.max(1, Math.round(srcW * scale));
  const ph = Math.max(1, Math.round(srcH * scale));

  const probeSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${pw}" height="${ph}">
  <image href="${href}" width="${pw}" height="${ph}" preserveAspectRatio="none"/>
</svg>`;
  const probe = new Resvg(Buffer.from(probeSvg), {
    fitTo: { mode: "width", value: pw },
    background: "rgba(255,255,255,0)"
  }).render();
  const pixels = probe.pixels;
  if (!pixels || pixels.length < pw * ph * 4) return { dataUri: href, width: srcW, height: srcH };

  const isEmpty = (i) => {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const a = pixels[i + 3];
    if (a < 12) return true;
    return r >= 236 && g >= 236 && b >= 228;
  };

  let minX = pw;
  let minY = ph;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const i = (y * pw + x) * 4;
      if (isEmpty(i)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return { dataUri: href, width: srcW, height: srcH };

  const pad = Math.max(4, Math.round(Math.max(maxX - minX, maxY - minY) * 0.05));
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(pw - 1, maxX + pad);
  maxY = Math.min(ph - 1, maxY + pad);
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;

  const cropSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${cw}" height="${ch}" viewBox="0 0 ${cw} ${ch}">
  <rect width="${cw}" height="${ch}" fill="#FFFFFF"/>
  <image href="${href}" x="${-minX}" y="${-minY}" width="${pw}" height="${ph}" preserveAspectRatio="none"/>
</svg>`;
  const cropped = svgToPngBuffer(cropSvg, { width: Math.max(cw, 2), height: Math.max(ch, 2) }).png;
  return {
    dataUri: `data:image/png;base64,${cropped.toString("base64")}`,
    width: cw,
    height: ch
  };
}

/**
 * Crop the 101cruise mark to the red grid only — drop the baked-in
 * 101CRUISE.COM.AU wordmark under the square so it is not shown twice.
 * Runtime crop only; does not alter assets/101cruise-logo.png on disk.
 */
function prepareBrandLogoMark(dataUri) {
  const href = String(dataUri || "").trim();
  if (!href.startsWith("data:image/png")) return null;

  const dims = pngDimensionsFromDataUri(href);
  const srcW = dims?.width || 512;
  const srcH = dims?.height || 512;
  const maxEdge = 720;
  const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
  const pw = Math.max(1, Math.round(srcW * scale));
  const ph = Math.max(1, Math.round(srcH * scale));

  const probeSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${pw}" height="${ph}">
  <image href="${href}" width="${pw}" height="${ph}" preserveAspectRatio="none"/>
</svg>`;
  const probe = new Resvg(Buffer.from(probeSvg), {
    fitTo: { mode: "width", value: pw },
    background: "rgba(0,0,0,0)"
  }).render();
  const pixels = probe.pixels;
  if (!pixels || pixels.length < pw * ph * 4) return { dataUri: href, width: srcW, height: srcH };

  let minX = pw;
  let minY = ph;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const i = (y * pw + x) * 4;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const a = pixels[i + 3];
      // Red grid cells (brand red)
      if (a < 40) continue;
      if (r < 170 || g > 90 || b > 90) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return { dataUri: href, width: srcW, height: srcH };

  const pad = Math.max(6, Math.round(Math.max(maxX - minX, maxY - minY) * 0.03));
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(pw - 1, maxX + pad);
  maxY = Math.min(ph - 1, maxY + pad);
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;

  const cropSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${cw}" height="${ch}" viewBox="0 0 ${cw} ${ch}">
  <image href="${href}" x="${-minX}" y="${-minY}" width="${pw}" height="${ph}" preserveAspectRatio="none"/>
</svg>`;
  const cropped = svgToPngBuffer(cropSvg, { width: Math.max(cw, 2), height: Math.max(ch, 2) }).png;
  return {
    dataUri: `data:image/png;base64,${cropped.toString("base64")}`,
    width: cw,
    height: ch
  };
}

/**
 * Mild master-slide background: cover crop + subtle blur only.
 * Darkening is applied as localised SVG overlays, not a flat veil.
 */
function prepareMasterBackground(model) {
  const href = model.backgroundDataUri || model.heroDataUri;
  if (!href) return null;

  const srcW = Number(model.backgroundWidth || model.heroWidth) || 1600;
  const srcH = Number(model.backgroundHeight || model.heroHeight) || 1200;

  const clearSvg = coverCropSvg(href, {
    width: WIDTH,
    height: HEIGHT,
    imgW: srcW,
    imgH: srcH,
    enlarge: 1.03
  });
  const clearPng = svgToPngBuffer(clearSvg, { width: WIDTH, height: HEIGHT }).png;

  const smallW = 540;
  const smallH = 675;
  const smallSvg = coverCropSvg(`data:image/png;base64,${clearPng.toString("base64")}`, {
    width: smallW,
    height: smallH,
    imgW: WIDTH,
    imgH: HEIGHT,
    enlarge: 1
  });
  const smallPng = svgToPngBuffer(smallSvg, { width: smallW, height: smallH }).png;
  const smallData = `data:image/png;base64,${smallPng.toString("base64")}`;
  // Subtle blur: enlarge slightly to hide soft edges; stdDeviation ~2.5
  const enlarge = 1.06;
  const dw = WIDTH * enlarge;
  const dh = HEIGHT * enlarge;
  const dx = (WIDTH - dw) / 2;
  const dy = (HEIGHT - dh) / 2;
  const blurSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <clipPath id="c"><rect width="${WIDTH}" height="${HEIGHT}"/></clipPath>
    <filter id="b" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="2.5"/>
    </filter>
  </defs>
  <g clip-path="url(#c)" filter="url(#b)">
    <image href="${smallData}" x="${dx}" y="${dy}" width="${dw}" height="${dh}" preserveAspectRatio="xMidYMid slice"/>
  </g>
</svg>`;
  const mild = svgToPngBuffer(blurSvg, { width: WIDTH, height: HEIGHT }).png;
  return {
    dataUri: `data:image/png;base64,${mild.toString("base64")}`,
    width: WIDTH,
    height: HEIGHT
  };
}

/**
 * Apply Clear / Soft / Strong treatment to a source image as a canvas-sized PNG data URI.
 * Soft/Strong: downscale → feGaussianBlur while upscaling (resvg cannot blur large JPEGs directly).
 */
function prepareTreatedBackground(model, treatmentName) {
  const { treatmentConfig } = require("./social-pack-svg");
  const t = treatmentConfig(treatmentName);
  const href = model.backgroundDataUri || model.heroDataUri;
  if (!href) return null;

  const srcW = Number(model.backgroundWidth || model.heroWidth) || 1600;
  const srcH = Number(model.backgroundHeight || model.heroHeight) || 1200;

  // Always produce a clean cover-cropped full-canvas raster first.
  const clearSvg = coverCropSvg(href, {
    width: WIDTH,
    height: HEIGHT,
    imgW: srcW,
    imgH: srcH,
    enlarge: 1.02
  });
  const clearPng = svgToPngBuffer(clearSvg, { width: WIDTH, height: HEIGHT }).png;

  if (!t.blur || t.blur <= 0) {
    return {
      dataUri: `data:image/png;base64,${clearPng.toString("base64")}`,
      width: WIDTH,
      height: HEIGHT
    };
  }

  // Downscale for reliable blur, then upscale with Gaussian blur.
  const smallW = 540;
  const smallH = 675;
  const smallSvg = coverCropSvg(`data:image/png;base64,${clearPng.toString("base64")}`, {
    width: smallW,
    height: smallH,
    imgW: WIDTH,
    imgH: HEIGHT,
    enlarge: 1
  });
  const smallPng = svgToPngBuffer(smallSvg, { width: smallW, height: smallH }).png;
  const smallData = `data:image/png;base64,${smallPng.toString("base64")}`;
  const enlarge = t.enlarge || 1.12;
  const dw = WIDTH * enlarge;
  const dh = HEIGHT * enlarge;
  const dx = (WIDTH - dw) / 2;
  const dy = (HEIGHT - dh) / 2;
  const std = Math.max(2, Math.round(t.blur / 2));
  const blurSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <clipPath id="c"><rect width="${WIDTH}" height="${HEIGHT}"/></clipPath>
    <filter id="b" x="-25%" y="-25%" width="150%" height="150%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="${std}"/>
    </filter>
  </defs>
  <g clip-path="url(#c)" filter="url(#b)">
    <image href="${smallData}" x="${dx}" y="${dy}" width="${dw}" height="${dh}" preserveAspectRatio="xMidYMid slice"/>
  </g>
</svg>`;
  const blurred = svgToPngBuffer(blurSvg, { width: WIDTH, height: HEIGHT }).png;
  return {
    dataUri: `data:image/png;base64,${blurred.toString("base64")}`,
    width: WIDTH,
    height: HEIGHT
  };
}

function assertPngSize(pngMeta, label, expectedWidth = WIDTH, expectedHeight = HEIGHT) {
  if (pngMeta.width !== expectedWidth || pngMeta.height !== expectedHeight) {
    throw new Error(
      `${label} rendered at ${pngMeta.width}×${pngMeta.height}, expected ${expectedWidth}×${expectedHeight}`
    );
  }
}

function buildSlidePlan(model) {
  // Approved weekly carousel: Main → one pricing card per selected room → CTA.
  // Journey/map slide is not generated by default.
  const offers = Array.isArray(model.offers)
    ? model.offers
    : model.offer
      ? [model.offer]
      : [];
  const plan = [{ key: "01-main-cruise.png", kind: "main" }];
  const usedSlugs = new Set();
  offers.forEach((offer, i) => {
    const n = String(i + 2).padStart(2, "0");
    let slug = offer.roomSlug || `room-${i + 1}`;
    if (usedSlugs.has(slug)) slug = `${slug}-${i + 1}`;
    usedSlugs.add(slug);
    plan.push({ key: `${n}-offer-${slug}.png`, kind: "offer", offerIndex: i });
  });
  plan.push({ key: "final-call-to-action.png", kind: "cta" });
  return plan;
}

/**
 * Render pack PNGs. Templates always use 1080×1350 SVG geometry; outputWidth/Height
 * scale the raster only (preview vs export).
 */
async function renderCruisePack(model, options = {}) {
  const plan = buildSlidePlan(model);
  const slides = {};
  const svgs = {};
  const joinedParts = [];
  const outputWidth = Number(options.outputWidth) > 0 ? Math.round(Number(options.outputWidth)) : WIDTH;
  const outputHeight = Number(options.outputHeight) > 0 ? Math.round(Number(options.outputHeight)) : HEIGHT;

  // Pre-treat backgrounds per slide strength so Soft/Strong actually show destination character.
  const treatedCache = new Map();
  function treatedFor(name) {
    const key = String(name || "soft");
    if (!treatedCache.has(key)) {
      const prepared = prepareTreatedBackground(model, key);
      treatedCache.set(key, prepared);
    }
    return treatedCache.get(key);
  }

  for (const item of plan) {
    let treatmentName = model.treatment || "soft";
    if (item.kind === "main") treatmentName = model.slideTreatments?.main || treatmentName;
    else if (item.kind === "journey") treatmentName = model.slideTreatments?.journey || treatmentName;
    else if (item.kind === "offer") treatmentName = model.slideTreatments?.offer || "clear";
    else treatmentName = model.slideTreatments?.cta || "strong";

    // Approved weekly pack:
    // Main → mild master soften (prepareMasterBackground)
    // Pricing → clear / sharp destination photo
    // CTA → strong blur
    let treated;
    if (item.kind === "main") {
      if (!treatedCache.has("__master__")) {
        treatedCache.set("__master__", prepareMasterBackground(model));
      }
      treated = treatedCache.get("__master__");
    } else if (item.kind === "offer") {
      treated = treatedFor("clear");
    } else if (item.kind === "cta") {
      treated = treatedFor("strong");
    } else {
      treated = treatedFor(treatmentName);
    }

    const slideModel = {
      ...model,
      backgroundDataUri: treated?.dataUri || model.backgroundDataUri,
      backgroundWidth: treated?.width || WIDTH,
      backgroundHeight: treated?.height || HEIGHT,
      heroDataUri: treated?.dataUri || model.heroDataUri,
      treatment: treatmentName,
      slideTreatments: {
        ...(model.slideTreatments || {}),
        main: treatmentName,
        journey: treatmentName,
        offer: treatmentName,
        cta: treatmentName
      }
    };

    let svg;
    if (item.kind === "main") {
      const { renderMasterConceptA } = require("./social-pack-master-slide");
      svg = renderMasterConceptA(slideModel);
    } else if (item.kind === "offer") {
      svg = renderOfferSvg(slideModel, item.offerIndex || 0);
    } else if (item.kind === "journey") {
      // Not part of the approved weekly pack; kept for optional/legacy use only.
      svg = renderJourneySvg(slideModel);
    } else {
      svg = renderCtaSvg(slideModel);
    }

    const rendered = svgToPngBuffer(svg, { width: outputWidth, height: outputHeight });
    assertPngSize(rendered, item.key, outputWidth, outputHeight);
    slides[item.key] = rendered.png;
    svgs[item.key] = svg;
    joinedParts.push(svg);
  }

  const joined = joinedParts.join("\n");
  if (options.forbiddenStrings?.length) {
    for (const bad of options.forbiddenStrings) {
      if (bad && joined.includes(String(bad))) {
        throw new Error("Confidential pricing leaked into social graphics.");
      }
    }
  }
  if (
    /\bairline(?:\s+staff|\s+prices?|_price)?\b/i.test(joined) ||
    /\bairfares?\b/i.test(joined) ||
    /\bairline_price\b/i.test(joined)
  ) {
    throw new Error("Airline pricing leaked into social graphics.");
  }

  return {
    slides,
    svgs,
    plan,
    dimensions: { width: outputWidth, height: outputHeight },
    exportDimensions: { width: WIDTH, height: HEIGHT }
  };
}

/** Preview raster size — same 1080×1350 aspect (0.4×). */
const PREVIEW_WIDTH = 432;
const PREVIEW_HEIGHT = 540;

module.exports = {
  WIDTH,
  HEIGHT,
  PREVIEW_WIDTH,
  PREVIEW_HEIGHT,
  fetchImageAsDataUri,
  svgToPngBuffer,
  prepareTreatedBackground,
  prepareMasterBackground,
  prepareCruiseLineLogoForBanner,
  prepareBrandLogoMark,
  renderCruisePack,
  buildSlidePlan,
  sniffMime
};
