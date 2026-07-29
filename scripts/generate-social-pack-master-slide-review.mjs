#!/usr/bin/env node
/**
 * Generate three Master Slide 1 concepts for Newsletter #77 Sirena.
 *
 *   node scripts/generate-social-pack-master-slide-review.mjs
 *
 * HOLD DEPLOY — review assets are gitignored.
 */

import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const {
  loadFeaturedCruisePackModel,
  hydrateMedia,
  listIssueCruiseIds
} = require("../netlify/functions/lib/social-pack-data.js");
const {
  prepareMasterBackground,
  svgToPngBuffer,
  WIDTH,
  HEIGHT
} = require("../netlify/functions/lib/social-pack-render.js");
const {
  renderMasterConceptA,
  renderMasterConceptB,
  renderMasterConceptC
} = require("../netlify/functions/lib/social-pack-master-slide.js");
const { listMontserratFontFiles, FAMILY } = require("../netlify/functions/lib/social-pack-fonts.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function loadEnv() {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]]) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    process.env[m[1]] = v;
  }
}

function pngDims(buf) {
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20)
  };
}

async function main() {
  loadEnv();
  const fonts = listMontserratFontFiles();
  if (fonts.length < 4) throw new Error("Montserrat font bundle incomplete");

  const outDir = path.join(root, "generated-assets/social-pack-newsletter-77/master-slide-review");
  fs.mkdirSync(outDir, { recursive: true });

  const rows = await listIssueCruiseIds(77);
  const sirena =
    rows.find((r) => /sirena|istanbul|barcelona/i.test(String(r.headline || ""))) || rows[0];
  if (!sirena) throw new Error("Sirena cruise not found");

  let model = await loadFeaturedCruisePackModel(sirena.id, {
    index: Math.max(1, Number(sirena.display_order) || 1),
    treatment: "soft"
  });
  // Force the same Barcelona media used previously if present
  if (!model.backgroundUrl) throw new Error("No destination background resolved");
  model = await hydrateMedia(model);

  const masterBg = prepareMasterBackground(model);
  const slideModel = {
    ...model,
    backgroundDataUri: masterBg.dataUri,
    backgroundWidth: masterBg.width,
    backgroundHeight: masterBg.height,
    heroDataUri: masterBg.dataUri
  };

  const concepts = [
    ["concept-a.png", renderMasterConceptA],
    ["concept-b.png", renderMasterConceptB],
    ["concept-c.png", renderMasterConceptC]
  ];

  const report = {
    cruise_id: model.id,
    destination_key: model.backgroundDestinationKey,
    media_id: model.backgroundMediaId,
    media_title: model.backgroundTitle,
    fonts: {
      family: FAMILY,
      files: fonts.map((f) => path.relative(root, f)),
      licence: "SIL Open Font License 1.1"
    },
    treatment:
      "full-bleed cover crop; mild blur stdDeviation 2.5; ~8–12% base darken + localised vertical/lower-panel gradient overlays (peak ~22%); destination colour retained; no flat grey veil",
    dimensions: { width: WIDTH, height: HEIGHT },
    files: []
  };

  for (const [name, render] of concepts) {
    const svg = render(slideModel);
    const rendered = svgToPngBuffer(svg);
    const dims = pngDims(rendered.png);
    if (dims.width !== WIDTH || dims.height !== HEIGHT) {
      throw new Error(`${name} bad size ${dims.width}x${dims.height}`);
    }
    fs.writeFileSync(path.join(outDir, name), rendered.png);
    report.files.push({ name, bytes: rendered.png.length });
    console.log("wrote", name, rendered.png.length);
  }

  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  console.log("out", outDir);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
