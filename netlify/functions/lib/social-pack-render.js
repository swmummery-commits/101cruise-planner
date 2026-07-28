/**
 * Fetch remote images and rasterise Social Pack SVGs with @resvg/resvg-js.
 */

const { Resvg } = require("@resvg/resvg-js");
const { WIDTH, HEIGHT, renderHeroSvg, renderJourneySvg, renderOfferSvg } = require("./social-pack-svg");

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
      throw Object.assign(new Error("Could not download the cruise hero image."), {
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
    throw Object.assign(new Error("Could not download the cruise hero image."), {
      statusCode: 502,
      calm: true
    });
  } finally {
    clearTimeout(timer);
  }
}

function svgToPngBuffer(svg, { width = WIDTH, height = HEIGHT } = {}) {
  const resvg = new Resvg(Buffer.from(svg, "utf8"), {
    fitTo: { mode: "width", value: width },
    background: "#ffffff",
    font: {
      loadSystemFonts: true,
      defaultFontFamily: "Helvetica"
    }
  });
  const rendered = resvg.render();
  const png = Buffer.from(rendered.asPng());
  return {
    png,
    width: rendered.width,
    height: rendered.height
  };
}

function assertPngSize(pngMeta, label) {
  if (pngMeta.width !== WIDTH || pngMeta.height !== HEIGHT) {
    throw new Error(`${label} rendered at ${pngMeta.width}×${pngMeta.height}, expected ${WIDTH}×${HEIGHT}`);
  }
}

async function renderCruisePack(model, options = {}) {
  const heroSvg = renderHeroSvg(model);
  const journeySvg = renderJourneySvg(model);
  const offerSvg = renderOfferSvg(model);

  const hero = svgToPngBuffer(heroSvg);
  const journey = svgToPngBuffer(journeySvg);
  const offer = svgToPngBuffer(offerSvg);

  assertPngSize(hero, "Slide 1");
  assertPngSize(journey, "Slide 2");
  assertPngSize(offer, "Slide 3");

  // Guard: airline / category must never appear in SVG source
  const joined = `${heroSvg}\n${journeySvg}\n${offerSvg}`;
  if (options.forbiddenStrings?.length) {
    for (const bad of options.forbiddenStrings) {
      if (bad && joined.includes(String(bad))) {
        throw new Error("Confidential pricing leaked into social graphics.");
      }
    }
  }

  return {
    slides: {
      "01-hero.png": hero.png,
      "02-journey.png": journey.png,
      "03-offer.png": offer.png
    },
    svgs: { hero: heroSvg, journey: journeySvg, offer: offerSvg },
    dimensions: { width: WIDTH, height: HEIGHT }
  };
}

module.exports = {
  WIDTH,
  HEIGHT,
  fetchImageAsDataUri,
  svgToPngBuffer,
  renderCruisePack,
  sniffMime
};
