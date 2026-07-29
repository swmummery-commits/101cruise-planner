/**
 * Bundled Social Pack fonts for deterministic resvg output.
 * Montserrat (SIL OFL 1.1) — not exposed as a public download surface.
 */

const fs = require("fs");
const path = require("path");

const WEIGHT_FILES = [
  "Montserrat-Regular.ttf",
  "Montserrat-Medium.ttf",
  "Montserrat-Bold.ttf",
  "Montserrat-ExtraBold.ttf"
];

function fontsDir() {
  const candidates = [
    path.join(__dirname, "../../../assets/fonts/social-pack/montserrat"),
    path.join(process.cwd(), "assets/fonts/social-pack/montserrat")
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "Montserrat-ExtraBold.ttf"))) return dir;
  }
  return candidates[0];
}

function listMontserratFontFiles() {
  const dir = fontsDir();
  return WEIGHT_FILES.map((name) => path.join(dir, name)).filter((file) => fs.existsSync(file));
}

function resvgFontOptions({ defaultFamily = "Montserrat" } = {}) {
  const fontFiles = listMontserratFontFiles();
  if (!fontFiles.length) {
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
  WEIGHT_FILES,
  fontsDir,
  listMontserratFontFiles,
  resvgFontOptions
};
