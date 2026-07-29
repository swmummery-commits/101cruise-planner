#!/usr/bin/env node
/**
 * Generate the complete Newsletter #77 Social Pack (all cruises).
 * Read-only against production data. HOLD DEPLOY until inspected.
 *
 *   node scripts/generate-social-pack-newsletter-77.mjs
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
const NEWSLETTER = 77;

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
  const outRoot = path.join(root, "generated-assets/social-pack-newsletter-77/full-pack");
  fs.mkdirSync(outRoot, { recursive: true });

  const rows = await listIssueCruiseIds(NEWSLETTER);
  if (!rows.length) throw new Error("No cruises for newsletter 77");

  const packs = [];
  const report = { newsletter: NEWSLETTER, cruises: [], generated_at: new Date().toISOString() };

  for (let i = 0; i < rows.length; i += 1) {
    let model = await loadFeaturedCruisePackModel(rows[i].id, {
      index: i + 1,
      treatment: "soft"
    });
    model = await hydrateMedia(model);
    const rendered = await renderCruisePack(model);
    const folder = path.join(outRoot, model.folderSlug);
    fs.mkdirSync(folder, { recursive: true });

    for (const [name, buf] of Object.entries(rendered.slides)) {
      fs.writeFileSync(path.join(folder, name), buf);
    }
    fs.writeFileSync(path.join(folder, "caption.txt"), model.caption || "");

    const joined = Object.values(rendered.svgs).join("\n");
    if (/\bairline\b/i.test(joined) || /\bairfare\b/i.test(joined)) {
      throw new Error(`Airline leak in ${model.folderSlug}`);
    }
    if (rendered.plan.some((p) => p.kind === "journey")) {
      throw new Error(`Journey slide present in ${model.folderSlug}`);
    }

    packs.push({ ...model, slides: rendered.slides });

    const cruiseReport = {
      id: model.id,
      folder: model.folderSlug,
      destination_match: model.backgroundMatchRole,
      destination_key: model.backgroundDestinationKey,
      selected_image: model.backgroundTitle || model.backgroundMediaId,
      media_id: model.backgroundMediaId,
      candidate_count: model.backgroundCandidateCount,
      rotation_index: model.backgroundRotationIndex,
      rooms_found: (model.offers || []).map((o) => ({
        room: o.roomLabelDisplay || o.roomLabel,
        price: o.priceLabel,
        brochure: o.brochureLabel
      })),
      room_slides: rendered.plan.filter((p) => p.kind === "offer").map((p) => p.key),
      files: Object.keys(rendered.slides),
      warnings: model.readiness?.warnings || [],
      readiness: model.readiness?.label || null
    };
    report.cruises.push(cruiseReport);
    console.log(
      `${model.folderSlug}: ${cruiseReport.room_slides.length} rooms · ${cruiseReport.candidate_count} images · ${cruiseReport.destination_match}`
    );
  }

  const zip = await buildSocialPackZip({ newsletterNumber: NEWSLETTER, packs });
  fs.writeFileSync(path.join(outRoot, zip.filename), zip.buffer);
  fs.writeFileSync(path.join(outRoot, "report.json"), JSON.stringify(report, null, 2));
  console.log("zip", zip.filename, zip.buffer.length);
  console.log("out", outRoot);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
