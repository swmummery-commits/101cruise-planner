/**
 * Bundled Social Pack fonts for deterministic resvg output.
 * Not exposed as a public download surface.
 *
 * - Montserrat — SIL OFL 1.1 (headings / body)
 * - League Spartan — SIL OFL 1.1 (CTA "TALK TO PAUL TODAY")
 * - Great Vibes — SIL OFL 1.1 (CTA script stand-in for Canva "Feeling Passionate",
 *   which is personal-use / commercial-licence only and must not be bundled)
 */

const fs = require("fs");
const path = require("path");

const MONTSERRAT_FILES = [
  "Montserrat-Regular.ttf",
  "Montserrat-Medium.ttf",
  "Montserrat-Bold.ttf",
  "Montserrat-ExtraBold.ttf"
];

function packRoot() {
  const candidates = [
    path.join(__dirname, "../../../assets/fonts/social-pack"),
    path.join(process.cwd(), "assets/fonts/social-pack")
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "montserrat", "Montserrat-ExtraBold.ttf"))) return dir;
  }
  return candidates[0];
}

function listFilesIn(subdir, names) {
  const dir = path.join(packRoot(), subdir);
  return names.map((name) => path.join(dir, name)).filter((file) => fs.existsSync(file));
}

function listMontserratFontFiles() {
  return listFilesIn("montserrat", MONTSERRAT_FILES);
}

function listLeagueSpartanFontFiles() {
  return listFilesIn("league-spartan", ["LeagueSpartan-Bold.ttf", "LeagueSpartan-Regular.ttf"]);
}

function listGreatVibesFontFiles() {
  return listFilesIn("great-vibes", ["GreatVibes-Regular.ttf"]);
}

function listAllSocialPackFontFiles() {
  return [
    ...listMontserratFontFiles(),
    ...listLeagueSpartanFontFiles(),
    ...listGreatVibesFontFiles()
  ];
}

function resvgFontOptions({ defaultFamily = "Montserrat" } = {}) {
  const fontFiles = listAllSocialPackFontFiles();
  if (listMontserratFontFiles().length < 4) {
    throw new Error("Social Pack Montserrat font files are missing.");
  }
  return {
    fontFiles,
    loadSystemFonts: false,
    defaultFontFamily: defaultFamily
  };
}

module.exports = {
  FAMILY: "Montserrat",
  FAMILY_CTA: "League Spartan",
  FAMILY_SCRIPT: "Great Vibes",
  SCRIPT_NOTE:
    "Great Vibes (SIL OFL 1.1) used as licensed stand-in for Canva Feeling Passionate (not redistributable)",
  WEIGHT_FILES: MONTSERRAT_FILES,
  fontsDir: () => path.join(packRoot(), "montserrat"),
  packRoot,
  listMontserratFontFiles,
  listLeagueSpartanFontFiles,
  listGreatVibesFontFiles,
  listAllSocialPackFontFiles,
  resvgFontOptions
};
