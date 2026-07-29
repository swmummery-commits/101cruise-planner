#!/usr/bin/env node
/**
 * Local Newsletter #77 Sirena destination-design Social Pack review.
 *
 *   node scripts/generate-social-pack-newsletter-77.mjs
 *
 * Writes into generated-assets/social-pack-newsletter-77/destination-design/
 * (gitignored). Does not push or deploy. Read-only against Supabase.
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
  const outDir = path.join(root, "generated-assets/social-pack-newsletter-77/destination-design");
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
        primary_id: sirena.id,
        primary_headline: sirena.headline,
        mode: "sirena_destination_design_only"
      },
      null,
      2
    )
  );

  let model = await loadFeaturedCruisePackModel(sirena.id, {
    index: Math.max(1, Number(sirena.display_order) || 1),
    treatment: "soft"
  });
  if (model.readiness?.status === "blocked") {
    throw new Error(model.readiness.label);
  }
  model = await hydrateMedia(model);
  const rendered = await renderCruisePack(model);

  const report = {
    destination_key: model.backgroundDestinationKey,
    candidate_count: model.backgroundCandidateCount,
    rotation_index: model.backgroundRotationIndex,
    media_id: model.backgroundMediaId,
    media_title: model.backgroundTitle,
    match_role: model.backgroundMatchRole,
    source: model.backgroundSource,
    treatment: model.treatment,
    brand_logo_path: model.brandLogoPath,
    cruise_line_logo_url: model.cruiseLineLogoUrl,
    offers: (model.offers || []).map((o) => ({
      room: o.roomLabel,
      display: o.roomLabelDisplay,
      public: o.cruise101Price,
      brochure: o.brochurePrice
    })),
    slide_order: rendered.plan.map((p) => p.key)
  };
  fs.writeFileSync(path.join(outDir, "resolution-report.json"), JSON.stringify(report, null, 2));
  console.log("resolution", JSON.stringify(report, null, 2));

  for (const [name, buf] of Object.entries(rendered.slides)) {
    fs.writeFileSync(path.join(outDir, name), buf);
  }
  fs.writeFileSync(path.join(outDir, "caption.txt"), model.caption || "");

  const zip = await buildSocialPackZip({
    newsletterNumber: 77,
    packs: [{ ...model, slides: rendered.slides }]
  });
  const zipPath = path.join(outDir, "newsletter-77-sirena-destination-design.zip");
  fs.writeFileSync(zipPath, zip.buffer);
  console.log("review_dir", outDir);
  console.log("zip", zipPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
