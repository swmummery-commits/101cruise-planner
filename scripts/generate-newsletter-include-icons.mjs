/**
 * Rasterise newsletter Includes icons to PNG for Mailchimp-safe <img> tags.
 * Run: node scripts/generate-newsletter-include-icons.mjs
 */

import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { Resvg } = require("@resvg/resvg-js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "..", "images", "newsletter-includes");

const PATHS = {
  alcohol_package: `<path d="M8 3h8l-1.2 7.2a4.8 4.8 0 1 1-5.6 0L8 3z"/><path d="M12 15v6"/><path d="M9.5 21h5"/>`,
  wifi: `<path d="M4.5 10.5a10 10 0 0 1 15 0"/><path d="M7.5 14a6 6 0 0 1 9 0"/><path d="M10.2 17.2a2.4 2.4 0 0 1 3.6 0"/><circle cx="12" cy="20" r="1.1" fill="#245C4E" stroke="none"/>`,
  gratuities: `<path d="M4 14h16"/><path d="M5 14a7 7 0 0 1 14 0"/><path d="M12 7V5"/><path d="M8 18h8"/>`,
  all_tours: `<path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11z"/><circle cx="12" cy="10" r="2.4"/>`,
  all_dining: `<path d="M5 3v7a2 2 0 0 0 2 2v9"/><path d="M5 3v4"/><path d="M8 3v4"/><path d="M11 3v4"/><path d="M17 3c2 0 3 1.5 3 3.5S19 10 17 10v11"/><path d="M17 3v7"/>`,
  laundry: `<path d="M8 4h8l2 3.5H6L8 4z"/><path d="M7 7.5v10.5a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V7.5"/><circle cx="12" cy="14" r="2.5"/>`,
  onboard_credit: `<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/><path d="M7 15h3"/>`,
  default: `<circle cx="12" cy="12" r="8"/><path d="M9 12l2 2 4-4"/>`
};

function svgFor(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#245C4E" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="0" y="0" width="24" height="24" fill="#ffffff" stroke="none"/>${inner}</svg>`;
}

mkdirSync(outDir, { recursive: true });
for (const [name, inner] of Object.entries(PATHS)) {
  const resvg = new Resvg(Buffer.from(svgFor(inner), "utf8"), {
    fitTo: { mode: "width", value: 44 }
  });
  const png = resvg.render().asPng();
  const file = path.join(outDir, `${name}.png`);
  writeFileSync(file, png);
  console.log("wrote", file, png.length);
}
