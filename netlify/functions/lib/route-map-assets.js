/**
 * Sprint 13E Phase 4 — persist generated route-map SVG/PNG under generated-assets/.
 * No Media Library upload. No public-page wiring. HOLD DEPLOY.
 */

const fs = require("fs");
const path = require("path");

const ROUTE_MAP_RENDERER_VERSION = "13e-phase3c";
const DEFAULT_PNG_WIDTH = 2000;

function projectRoot() {
  // netlify/functions/lib → repo root
  return path.resolve(__dirname, "../../..");
}

function assetDirForCruise(featuredCruiseId, rootDir = projectRoot()) {
  const id = String(featuredCruiseId || "").trim();
  if (!id) throw new Error("featured_cruise_id is required");
  return path.join(rootDir, "generated-assets", id);
}

function relativeAssetPaths(featuredCruiseId) {
  const id = String(featuredCruiseId || "").trim();
  return {
    svg_path: `generated-assets/${id}/route-map.svg`,
    png_path: `generated-assets/${id}/route-map.png`,
    svg_url: `/generated-assets/${id}/route-map.svg`,
    png_url: `/generated-assets/${id}/route-map.png`
  };
}

/**
 * Rasterise SVG string to PNG buffer via @resvg/resvg-js.
 * @param {string} svg
 * @param {{ width?: number }} [options]
 * @returns {Buffer}
 */
function svgToPngBuffer(svg, options = {}) {
  let Resvg;
  try {
    ({ Resvg } = require("@resvg/resvg-js"));
  } catch (error) {
    const err = new Error(
      "PNG conversion is unavailable. Install @resvg/resvg-js (and the platform binary)."
    );
    err.code = "png_engine_unavailable";
    err.cause = error;
    throw err;
  }

  const width = Math.max(800, Math.min(2400, Number(options.width) || DEFAULT_PNG_WIDTH));
  const resvg = new Resvg(Buffer.from(String(svg || ""), "utf8"), {
    fitTo: { mode: "width", value: width },
    background: "transparent"
  });
  const rendered = resvg.render();
  return {
    buffer: Buffer.from(rendered.asPng()),
    width: rendered.width,
    height: rendered.height
  };
}

/**
 * Write SVG + PNG for a Featured Cruise. Overwrites only these two files.
 * @returns {{ svg_path, png_path, svg_abs, png_abs, width, height, svg_bytes, png_bytes, renderer_version }}
 */
function saveRouteMapAssets(featuredCruiseId, svg, options = {}) {
  const root = options.rootDir || projectRoot();
  const dir = assetDirForCruise(featuredCruiseId, root);
  fs.mkdirSync(dir, { recursive: true });

  const svgAbs = path.join(dir, "route-map.svg");
  const pngAbs = path.join(dir, "route-map.png");
  const svgText = String(svg || "");
  if (!svgText.startsWith("<svg")) {
    const err = new Error("Invalid SVG: expected a complete <svg> document.");
    err.code = "invalid_svg";
    throw err;
  }

  fs.writeFileSync(svgAbs, svgText, "utf8");

  const pngWidth = options.pngWidth || DEFAULT_PNG_WIDTH;
  const { buffer, width, height } = svgToPngBuffer(svgText, { width: pngWidth });
  fs.writeFileSync(pngAbs, buffer);

  const rel = relativeAssetPaths(featuredCruiseId);
  return {
    ...rel,
    svg_abs: svgAbs,
    png_abs: pngAbs,
    width,
    height,
    svg_bytes: Buffer.byteLength(svgText, "utf8"),
    png_bytes: buffer.length,
    renderer_version: options.rendererVersion || ROUTE_MAP_RENDERER_VERSION,
    generated_at: new Date().toISOString()
  };
}

function assetsExist(featuredCruiseId, rootDir = projectRoot()) {
  const dir = assetDirForCruise(featuredCruiseId, rootDir);
  return (
    fs.existsSync(path.join(dir, "route-map.svg")) && fs.existsSync(path.join(dir, "route-map.png"))
  );
}

module.exports = {
  ROUTE_MAP_RENDERER_VERSION,
  DEFAULT_PNG_WIDTH,
  projectRoot,
  assetDirForCruise,
  relativeAssetPaths,
  svgToPngBuffer,
  saveRouteMapAssets,
  assetsExist
};
