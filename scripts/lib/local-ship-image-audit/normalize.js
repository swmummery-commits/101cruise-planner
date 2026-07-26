/**
 * Name folding for Brand Imaging ↔ canonical catalogue matching.
 * Pure helpers — no I/O.
 */

const SHIP_PREFIX_RE =
  /^(m\.?\s*s\.?|m\.?\s*v\.?|s\.?\s*s\.?|r\.?\s*m\.?\s*s\.?|my|sy)\s+/i;

const YEAR_PAREN_RE = /\(\s*(?:19|20)\d{2}\s*\)/g;

/** Well-known local folder → preferred soft-key seed (canonical-ish). */
export const LINE_FOLDER_ALIASES = Object.freeze({
  "ama waterways": "ama waterways",
  "atlas ocean voyages": "atlas ocean voyages",
  aurora: "aurora expeditions",
  "avalon waterways": "avalon waterways",
  azamara: "azamara",
  carnival: "carnival cruise line",
  "celebrity x": "celebrity cruises",
  celebrity: "celebrity cruises",
  "celestyal cruises": "celestyal",
  crystal: "crystal",
  cunard: "cunard",
  "disney cruises": "disney cruise line",
  disney: "disney cruise line",
  "emerald cruises": "emerald cruises",
  "explora journeys": "explora journeys",
  "holland america": "holland america line",
  hurtigruten: "hurtigruten",
  msc: "msc cruises",
  "margaritaville at sea cruises": "margaritaville at sea",
  norwegian: "norwegian cruise line",
  ncl: "norwegian cruise line",
  oceania: "oceania cruises",
  "paul gauguin": "paul gauguin cruises",
  princess: "princess cruises",
  "regent seven seas": "regent seven seas cruises",
  "ritz carlton yacht collection": "ritz carlton yacht collection",
  "ritz carlton": "ritz carlton yacht collection",
  "royal caribbean": "royal caribbean international",
  scenic: "scenic",
  seabourn: "seabourn",
  silversea: "silversea cruises",
  uniworld: "uniworld boutique river cruises",
  viking: "viking",
  virgin: "virgin voyages",
  "windstar cruises": "windstar cruises"
});

/** Meta / non-fleet folders under Brand Imaging (not cruise-line catalogues).
 * Keys are foldKey() forms (punctuation → spaces).
 */
export const NON_LINE_FOLDER_NAMES = Object.freeze(
  new Set([
    "a locations",
    "a ship fact sheets",
    "z gay ships",
    "z royal caribbean own silversea and celebrity"
  ])
);

export function foldKey(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/['’`´]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripShipPrefix(name) {
  return String(name || "").replace(SHIP_PREFIX_RE, "").trim();
}

export function stripYearDecorations(name) {
  return String(name || "")
    .replace(YEAR_PAREN_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripThePrefix(name) {
  return String(name || "")
    .replace(/^\s*the\s+/i, "")
    .trim();
}

function dropGenericTokens(folded) {
  return String(folded || "")
    .replace(
      /\b(cruises?|line|international|journeys?|expeditions?|boutique|river|yacht|collection)\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Soft ship key: fold + strip year/prefix/The + drop generic suffixes.
 */
export function softShipKey(name) {
  const s = stripYearDecorations(stripShipPrefix(stripThePrefix(String(name || ""))));
  return dropGenericTokens(foldKey(s));
}

/**
 * Soft cruise-line key (applies local folder aliases first).
 */
export function softLineKey(name) {
  const folded = foldKey(name);
  const aliased = LINE_FOLDER_ALIASES[folded] || name;
  return dropGenericTokens(foldKey(aliased));
}

export function resolveLineFolderAlias(folderName) {
  const folded = foldKey(folderName);
  if (NON_LINE_FOLDER_NAMES.has(folded)) {
    return { kind: "non_line", folded };
  }
  return {
    kind: "line",
    folded,
    alias_hint: LINE_FOLDER_ALIASES[folded] || null,
    soft_key: softLineKey(folderName)
  };
}

/** Extract optional year from folder name for disambiguation. */
export function extractYearHint(name) {
  const m = String(name || "").match(/\(\s*((?:19|20)\d{2})\s*\)/);
  if (m) return Number(m[1]);
  return null;
}

const ROMAN = { i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7" };
const ARABIC = { 1: "i", 2: "ii", 3: "iii", 4: "iv", 5: "v", 6: "vi", 7: "vii" };

export function expandNumericVariants(softKey) {
  const key = String(softKey || "").trim();
  if (!key) return [];
  const out = new Set([key]);
  const parts = key.split(" ");
  const last = parts[parts.length - 1];
  if (ROMAN[last]) out.add([...parts.slice(0, -1), ROMAN[last]].join(" "));
  if (ARABIC[last]) out.add([...parts.slice(0, -1), ARABIC[last]].join(" "));
  return [...out];
}
