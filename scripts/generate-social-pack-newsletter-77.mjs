#!/usr/bin/env node
/**
 * Local Newsletter #77 Social Pack demo (no Netlify deploy).
 *
 *   node scripts/generate-social-pack-newsletter-77.mjs
 *
 * Writes into generated-assets/social-pack-newsletter-77/ (gitignored).
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
const { renderCruisePack } = require("../netlify/functions/lib/social-pack-render.js");
const { buildSocialPackZip } = require("../netlify/functions/lib/social-pack-zip.js");

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

async function main() {
  loadEnv();
  const outDir = path.join(root, "generated-assets/social-pack-newsletter-77");
  fs.mkdirSync(outDir, { recursive: true });

  const rows = await listIssueCruiseIds(77);
  if (!rows.length) throw new Error("No Featured Cruises found for newsletter_number=77");

  const sirena =
    rows.find((r) => /sirena|istanbul|barcelona/i.test(String(r.headline || ""))) || rows[0];

  console.log(
    JSON.stringify(
      {
        source: "live_read_only",
        newsletter_number: 77,
        cruise_count: rows.length,
        primary_id: sirena.id,
        primary_headline: sirena.headline
      },
      null,
      2
    )
  );

  const packs = [];
  for (let i = 0; i < rows.length; i += 1) {
    let model = await loadFeaturedCruisePackModel(rows[i].id, { index: i + 1 });
    if (model.readiness?.status === "blocked") {
      console.warn("skip", model.id, model.readiness.label);
      continue;
    }
    model = await hydrateMedia(model);
    const rendered = await renderCruisePack(model);
    packs.push({ ...model, slides: rendered.slides });

    if (rows[i].id === sirena.id) {
      const reviewDir = path.join(outDir, "sirena-review");
      fs.mkdirSync(reviewDir, { recursive: true });
      fs.writeFileSync(path.join(reviewDir, "01-hero.png"), rendered.slides["01-hero.png"]);
      fs.writeFileSync(path.join(reviewDir, "02-journey.png"), rendered.slides["02-journey.png"]);
      fs.writeFileSync(path.join(reviewDir, "03-offer.png"), rendered.slides["03-offer.png"]);
      fs.writeFileSync(path.join(reviewDir, "caption.txt"), model.caption || "");
      console.log("sirena_review", reviewDir);
      console.log("offer", model.offer?.priceLabel, model.offer?.roomLabel);
      console.log("readiness", model.readiness);
    }
  }

  const zip = await buildSocialPackZip({ newsletterNumber: 77, packs });
  const zipPath = path.join(outDir, zip.filename);
  fs.writeFileSync(zipPath, zip.buffer);
  console.log("zip", zipPath);
  console.log("manifest_cruises", zip.manifest.cruises.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
