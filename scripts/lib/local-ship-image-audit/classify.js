/**
 * Filename / path heuristics for Brand Imaging asset roles.
 * Objective keyword rules only — no ML / face detection.
 */

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".heic",
  ".tif",
  ".tiff"
]);

export function isImageExtension(ext) {
  return IMAGE_EXTENSIONS.has(String(ext || "").toLowerCase());
}

export function classifyImageRole({ filename, relativePath, lineFolderKind }) {
  const name = String(filename || "").toLowerCase();
  const path = String(relativePath || "").toLowerCase();
  const blob = `${path} ${name}`;

  if (lineFolderKind === "non_line" && /a-locations|locations/.test(path)) {
    return "destination_image";
  }

  if (/\b(logo|wordmark|brandmark)\b/.test(blob)) return "logo";
  if (/\b(deck[\s_-]?plan|deckplan|general arrangement|ga plan)\b/.test(blob)) {
    return "deck_plan";
  }
  if (
    /\b(cabin|stateroom|suite|minisuite|balcony room|interior cabin|owners suite|sky suite|penthouse|accommodations?)\b/.test(
      blob
    )
  ) {
    return "cabin_image";
  }
  if (
    /\b(interior|restaurant|dining|pizzeria|bar|lounge|spa|theatre|theater|casino|atrium|piazza|buffet|galley|kids|playroom|gym|fitness)\b/.test(
      blob
    )
  ) {
    return "interior_image";
  }
  if (
    /\b(map|itinerary|destination|port of|santorini|alaska|caribbean island)\b/.test(blob) ||
    /a-locations/.test(path)
  ) {
    return "destination_image";
  }
  if (
    /\b(exterior|exteriors|aerial|profile|at[\s_-]?sea|underway|seatrials|sea trials|hero|ship rendering|rendering)\b/.test(
      blob
    )
  ) {
    return "exterior_ship_hero";
  }
  // Generic "ship" photos often used as heroes when not otherwise tagged
  if (/\b(ship|vessel|cruise ship)\b/.test(blob) && !/\b(interior|cabin)\b/.test(blob)) {
    return "exterior_ship_hero";
  }

  return "unknown";
}

/**
 * Technical hero suitability score (higher is better). Pure / objective.
 */
export function scoreHeroCandidate(image) {
  if (!image || image.opens_successfully === false) {
    return { score: -1000, reasons: ["unreadable"], suitable: false };
  }

  const role = image.apparent_role;
  if (
    role === "logo" ||
    role === "deck_plan" ||
    role === "cabin_image" ||
    role === "interior_image" ||
    role === "destination_image"
  ) {
    return { score: -100, reasons: [`excluded_role:${role}`], suitable: false };
  }

  const w = Number(image.width) || 0;
  const h = Number(image.height) || 0;
  const reasons = [];
  let score = 0;

  const exterior = role === "exterior_ship_hero";
  if (exterior) {
    score += 40;
    reasons.push("exterior_keyword");
  } else if (role === "unknown") {
    score += 5;
    reasons.push("unknown_role");
  }

  if (w > 0 && h > 0 && w >= h) {
    score += 25;
    reasons.push("landscape");
  } else if (w > 0 && h > 0) {
    score -= 15;
    reasons.push("portrait");
  }

  const longSide = Math.max(w, h);
  if (longSide >= 2400) {
    score += 20;
    reasons.push("hi_res");
  } else if (longSide >= 1600) {
    score += 14;
    reasons.push("good_res");
  } else if (longSide >= 1200) {
    score += 8;
    reasons.push("adequate_res");
  } else if (longSide > 0 && longSide < 800) {
    score -= 25;
    reasons.push("low_res");
  }

  const ratio = w > 0 && h > 0 ? w / h : 0;
  if (ratio >= 1.3 && ratio <= 2.4) {
    score += 15;
    reasons.push("hero_aspect");
  } else if (ratio > 0 && (ratio < 1.05 || ratio > 3)) {
    score -= 10;
    reasons.push("awkward_aspect");
  }

  const fname = String(image.filename || "").toLowerCase();
  if (/\b(watermark|shutterstock|getty|istock|alamy|stock)\b/.test(fname)) {
    score -= 30;
    reasons.push("possible_stock_watermark");
  }
  if (/\b(overlay|text|graphic|collage|montage)\b/.test(fname)) {
    score -= 12;
    reasons.push("possible_text_overlay");
  }

  const suitable =
    score >= 25 &&
    longSide >= 1000 &&
    (exterior || role === "unknown") &&
    !(w > 0 && h > 0 && h > w * 1.15);

  return { score, reasons, suitable };
}

/**
 * Recommendation class from ranked suitable candidates.
 */
export function recommendFromCandidates(ranked) {
  const suitable = (ranked || []).filter((c) => c.suitable);
  if (suitable.length === 0) return { recommendation: "no_suitable_hero", top: null, alternatives: [] };
  if (suitable.length === 1) {
    return {
      recommendation: "clear_single_candidate",
      top: suitable[0],
      alternatives: []
    };
  }
  const [a, b, ...rest] = suitable;
  const gap = a.score - b.score;
  if (gap >= 12) {
    return {
      recommendation: "preferred_candidate_with_alternatives",
      top: a,
      alternatives: [b, ...rest]
    };
  }
  return {
    recommendation: "Steve_selection_required",
    top: null,
    alternatives: suitable
  };
}

export { IMAGE_EXTENSIONS };
