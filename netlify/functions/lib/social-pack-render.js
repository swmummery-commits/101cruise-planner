/**
 * Fetch remote images and rasterise Social Pack SVGs with @resvg/resvg-js.
 */

const { Resvg } = require("@resvg/resvg-js");
const {
  WIDTH,
  HEIGHT,
  renderMainCruiseSvg,
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

function assertPngSize(pngMeta, label) {
  if (pngMeta.width !== WIDTH || pngMeta.height !== HEIGHT) {
    throw new Error(`${label} rendered at ${pngMeta.width}×${pngMeta.height}, expected ${WIDTH}×${HEIGHT}`);
  }
}

function buildSlidePlan(model) {
  const offers = Array.isArray(model.offers) ? model.offers.slice(0, 3) : model.offer ? [model.offer] : [];
  const plan = [
    { key: "01-main-cruise.png", kind: "main" },
    { key: "02-journey.png", kind: "journey" }
  ];
  offers.forEach((offer, i) => {
    const n = String(i + 3).padStart(2, "0");
    const slug = offer.roomSlug || `room-${i + 1}`;
    plan.push({ key: `${n}-offer-${slug}.png`, kind: "offer", offerIndex: i });
  });
  if (!offers.length) {
    plan.push({ key: "03-offer-enquiry.png", kind: "offer", offerIndex: 0 });
  }
  plan.push({ key: "final-call-to-action.png", kind: "cta" });
  return plan;
}

async function renderCruisePack(model, options = {}) {
  const plan = buildSlidePlan(model);
  const slides = {};
  const svgs = {};
  const joinedParts = [];

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
    else if (item.kind === "offer") treatmentName = model.slideTreatments?.offer || "strong";
    else treatmentName = model.slideTreatments?.cta || "strong";

    const treated = treatedFor(treatmentName);
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
    if (item.kind === "main") svg = renderMainCruiseSvg(slideModel);
    else if (item.kind === "journey") svg = renderJourneySvg(slideModel);
    else if (item.kind === "offer") svg = renderOfferSvg(slideModel, item.offerIndex || 0);
    else svg = renderCtaSvg(slideModel);

    const rendered = svgToPngBuffer(svg);
    assertPngSize(rendered, item.key);
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
  if (/\bairline\s+staff\b/i.test(joined) || /\bairline_price\b/i.test(joined)) {
    throw new Error("Airline pricing leaked into social graphics.");
  }

  return {
    slides,
    svgs,
    plan,
    dimensions: { width: WIDTH, height: HEIGHT }
  };
}

module.exports = {
  WIDTH,
  HEIGHT,
  fetchImageAsDataUri,
  svgToPngBuffer,
  prepareTreatedBackground,
  prepareMasterBackground,
  renderCruisePack,
  buildSlidePlan,
  sniffMime
};
