/**
 * Fixed Hurtigruten approved-local-logo import configuration.
 *
 * Canonical UUID resolved read-only from Original project
 * (xikbibxyinttllxamgao) before hardcoding. Do not guess.
 *
 * Brand note: this asset is Hurtigruten coastal branding, not HX.
 */

export const LOGO_KEY = "hurtigruten";

/** Resolved read-only from Original: ci_cruise_lines where name = 'Hurtigruten'. */
export const HURTIGRUTEN_LINE_ID = "297df8d9-6d36-4855-993d-e30bbfaf29e0";

export const HURTIGRUTEN_LINE_NAME = "Hurtigruten";

export const HURTIGRUTEN_LOCAL_PATH =
  "/Users/stevemummery/Documents/101Cruise/MARKETING/LOGOS/Cruise Line Logos (500 x 500 px)/hurtigruten.png";

export const HURTIGRUTEN_CONFIRM_TOKEN = "IMPORT-HURTIGRUTEN-LOGO";

export const EXPECTED_FORMAT = "PNG";
export const EXPECTED_MIME = "image/png";
export const EXPECTED_WIDTH = 500;
export const EXPECTED_HEIGHT = 500;
export const ORIGINAL_FILENAME = "hurtigruten.png";
export const MEDIA_TITLE = "Hurtigruten logo";
export const IMPORT_SOURCE = "approved_local_logo";

/** Names that must never be selected or modified by this importer. */
export const FORBIDDEN_HX_NAME_PATTERNS = [
  /^hx$/i,
  /^hx\b/i,
  /\bhurtigruten\s+expeditions?\b/i,
  /\bhx\s+expeditions?\b/i
];

export function getHurtigrutenLogoConfig() {
  return {
    logo_key: LOGO_KEY,
    cruise_line_id: HURTIGRUTEN_LINE_ID,
    cruise_line_name: HURTIGRUTEN_LINE_NAME,
    local_path: HURTIGRUTEN_LOCAL_PATH,
    confirm_token: HURTIGRUTEN_CONFIRM_TOKEN,
    expected_format: EXPECTED_FORMAT,
    expected_mime: EXPECTED_MIME,
    expected_width: EXPECTED_WIDTH,
    expected_height: EXPECTED_HEIGHT,
    original_filename: ORIGINAL_FILENAME,
    media_title: MEDIA_TITLE,
    import_source: IMPORT_SOURCE,
    brand_note: "Hurtigruten coastal brand — not HX"
  };
}

export function isForbiddenHxName(name) {
  const n = String(name || "").trim();
  if (!n) return false;
  return FORBIDDEN_HX_NAME_PATTERNS.some((re) => re.test(n));
}

/**
 * Abort before network when CLI args are wrong.
 * Does not accept arbitrary file path, line UUID, or free-form confirm tokens.
 */
export function assertHurtigrutenCliGate({
  target,
  mode,
  logoKey,
  confirmToken,
  argv = []
}) {
  if (target !== "production") {
    throw Object.assign(
      new Error("REFUSED: require --target=production (DEV writes forbidden)"),
      { code: "approved_logo_target_invalid" }
    );
  }
  if (mode !== "dry-run" && mode !== "apply") {
    throw Object.assign(
      new Error("REFUSED: require --dry-run or --apply"),
      { code: "approved_logo_mode_invalid" }
    );
  }
  if (String(logoKey || "") !== LOGO_KEY) {
    throw Object.assign(
      new Error(`REFUSED: --logo must be exactly "${LOGO_KEY}" (HX cannot be selected)`),
      { code: "approved_logo_key_invalid" }
    );
  }
  if (String(confirmToken || "") !== HURTIGRUTEN_CONFIRM_TOKEN) {
    throw Object.assign(
      new Error(`REFUSED: require --confirm=${HURTIGRUTEN_CONFIRM_TOKEN}`),
      { code: "approved_logo_confirm_invalid" }
    );
  }

  const forbiddenArgs = [
    "--file",
    "--path",
    "--local-path",
    "--source",
    "--line-id",
    "--line-uuid",
    "--cruise-line-id",
    "--uuid"
  ];
  for (const flag of forbiddenArgs) {
    if (
      argv.some(
        (a) => a === flag || String(a).startsWith(`${flag}=`)
      )
    ) {
      throw Object.assign(
        new Error(
          `REFUSED: arbitrary ${flag} is not accepted; local path and UUID are fixed in configuration`
        ),
        { code: "approved_logo_arbitrary_path_or_uuid" }
      );
    }
  }

  if (String(logoKey || "").toLowerCase() === "hx" || isForbiddenHxName(logoKey)) {
    throw Object.assign(new Error("REFUSED: HX cannot be selected or modified"), {
      code: "approved_logo_hx_forbidden"
    });
  }

  return true;
}
