#!/usr/bin/env node
/**
 * Generate Slide 1 + all cabin pricing cards + CTA review for Newsletter #77 Sirena.
 *
 *   node scripts/generate-social-pack-pricing-cta-review.mjs
 *
 * HOLD DEPLOY — review assets are gitignored.
 * Airline / airfare prices are never rendered.
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
  prepareTreatedBackground,
  svgToPngBuffer,
  WIDTH,
  HEIGHT
} = require("../netlify/functions/lib/social-pack-render.js");
const { renderMasterConceptA } = require("../netlify/functions/lib/social-pack-master-slide.js");
const { renderOfferSvg, renderCtaSvg } = require("../netlify/functions/lib/social-pack-offer-cta.js");
const {
  listAllSocialPackFontFiles,
  FAMILY,
  FAMILY_CTA,
  FAMILY_SCRIPT,
  SCRIPT_NOTE
} = require("../netlify/functions/lib/social-pack-fonts.js");

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
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function main() {
  loadEnv();
  const fonts = listAllSocialPackFontFiles();
  if (fonts.length < 6) throw new Error("Social Pack font bundle incomplete");

  const outDir = path.join(root, "generated-assets/social-pack-newsletter-77/pricing-cta-review");
  fs.mkdirSync(outDir, { recursive: true });

  const rows = await listIssueCruiseIds(77);
  const sirena =
    rows.find((r) => /sirena|istanbul|barcelona/i.test(String(r.headline || ""))) || rows[0];
  if (!sirena) throw new Error("Sirena cruise not found");

  let model = await loadFeaturedCruisePackModel(sirena.id, {
    index: Math.max(1, Number(sirena.display_order) || 1),
    treatment: "soft"
  });
  if (!model.backgroundUrl) throw new Error("No destination background resolved");
  model = await hydrateMedia(model);

  const masterBg = prepareMasterBackground(model);
  const clearBg = prepareTreatedBackground(model, "clear");
  const strongBg = prepareTreatedBackground(model, "strong");

  const clearModel = {
    ...model,
    backgroundDataUri: clearBg.dataUri,
    backgroundWidth: clearBg.width,
    backgroundHeight: clearBg.height
  };

  const jobs = [
    [
      "01-main-cruise.png",
      () =>
        renderMasterConceptA({
          ...model,
          backgroundDataUri: masterBg.dataUri,
          backgroundWidth: masterBg.width,
          backgroundHeight: masterBg.height
        })
    ]
  ];

  const offers = Array.isArray(model.offers) ? model.offers : model.offer ? [model.offer] : [];
  const usedSlugs = new Set();
  offers.forEach((offer, i) => {
    const n = String(i + 2).padStart(2, "0");
    let slug = offer.roomSlug || `room-${i + 1}`;
    if (usedSlugs.has(slug)) slug = `${slug}-${i + 1}`;
    usedSlugs.add(slug);
    jobs.push([`${n}-offer-${slug}.png`, () => renderOfferSvg(clearModel, i)]);
  });
  if (!offers.length) {
    // No pricing cards when no public rooms — Main + CTA only
  }

  jobs.push([
    "final-call-to-action.png",
    () =>
      renderCtaSvg({
        ...model,
        backgroundDataUri: strongBg.dataUri,
        backgroundWidth: strongBg.width,
        backgroundHeight: strongBg.height
      })
  ]);

  const report = {
    cruise_id: model.id,
    destination_key: model.backgroundDestinationKey,
    media_id: model.backgroundMediaId,
    offers: offers.map((o) => ({
      room_label: o.roomLabelDisplay || o.roomLabel,
      brochure: o.brochureLabel,
      cruise_101: o.priceLabel
    })),
    primary_inclusion: model.primaryInclusion || null,
    note: "Public brochure + 101cruise prices only — airline/airfare never used in social pack",
    fonts: {
      body: FAMILY,
      cta: FAMILY_CTA,
      script: FAMILY_SCRIPT,
      script_note: SCRIPT_NOTE,
      files: fonts.map((f) => path.relative(root, f))
    },
    files: []
  };

  for (const [name, render] of jobs) {
    const svg = render();
    if (/\bairline\b/i.test(svg) || /\bairfare\b/i.test(svg)) {
      throw new Error(`Airline reference leaked into ${name}`);
    }
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
  console.log("cabins", offers.length);
  console.log("out", outDir);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
