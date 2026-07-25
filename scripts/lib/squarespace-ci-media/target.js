/**
 * Explicit target resolution for Squarespace CI media migration.
 * Pure helpers — no network, no credential logging.
 */

export const DEV_REF = "vkheexbapykcdfbqcach";
export const PRODUCTION_REF = "xikbibxyinttllxamgao";

/**
 * Parse --target=dev|production or --target dev|production from argv.
 * @returns {"dev"|"production"|null}
 */
export function parseTargetArg(argv = process.argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--target") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) return null;
      return normaliseTarget(next);
    }
    if (arg.startsWith("--target=")) {
      return normaliseTarget(arg.slice("--target=".length));
    }
  }
  return null;
}

function normaliseTarget(raw) {
  const t = String(raw || "")
    .trim()
    .toLowerCase();
  if (t === "dev" || t === "development") return "dev";
  if (t === "production" || t === "prod") return "production";
  return null;
}

export function projectRefFromUrl(url) {
  try {
    return new URL(String(url).trim()).hostname.split(".")[0] || null;
  } catch {
    return null;
  }
}

/**
 * Resolve which env pair to use. Does not prefer DEV merely because it exists.
 *
 * Production --rollback: always refused here (broad restore not enabled).
 * Production --copy / --promote / --repair-logo: credentials resolve, but gated
 * writes require CLI confirmation + plan gates in the CLI.
 *
 * @param {{
 *   target: "dev"|"production"|null,
 *   mode: string,
 *   env?: Record<string, string|undefined>
 * }} opts
 */
export function resolveMigrationTarget({ target, mode, env = process.env }) {
  if (!target) {
    throw Object.assign(
      new Error(
        "Missing required --target. Use --target=dev or --target=production."
      ),
      { code: "missing_target" }
    );
  }
  if (target !== "dev" && target !== "production") {
    throw Object.assign(
      new Error(`Invalid --target "${target}". Use --target=dev or --target=production.`),
      { code: "invalid_target" }
    );
  }

  if (target === "production" && mode === "rollback") {
    throw Object.assign(
      new Error(
        "REFUSED: --rollback is not allowed with --target=production. Broad Original-project rollback remains blocked."
      ),
      { code: "production_write_forbidden" }
    );
  }

  if (target === "dev" && mode === "repair-logo") {
    throw Object.assign(
      new Error("REFUSED: --repair-logo is Original-project only. Use --target=production."),
      { code: "logo_repair_dev_forbidden" }
    );
  }

  if (target === "dev" && mode === "import-approved-line-logo") {
    throw Object.assign(
      new Error(
        "REFUSED: approved local logo import is Original-project only. Use --target=production."
      ),
      { code: "approved_logo_dev_forbidden" }
    );
  }

  if (target === "dev") {
    const url = String(env.SUPABASE_DEV_URL || "").replace(/\/$/, "");
    const key = String(env.SUPABASE_DEV_SERVICE_ROLE_KEY || "");
    if (!url || !key) {
      throw Object.assign(
        new Error("Missing SUPABASE_DEV_URL or SUPABASE_DEV_SERVICE_ROLE_KEY for --target=dev"),
        { code: "missing_dev_env" }
      );
    }
    const ref = projectRefFromUrl(url);
    if (ref !== DEV_REF) {
      throw Object.assign(
        new Error(`DEV project ref mismatch: expected ${DEV_REF}, got ${ref || "(unparsed)"}`),
        { code: "unexpected_dev_ref", project_ref: ref }
      );
    }
    return {
      target: "dev",
      label: "DEV",
      url,
      key,
      project_ref: ref,
      writes_allowed: mode === "copy" || mode === "promote" || mode === "rollback",
      production_copy_gated: false,
      production_promote_gated: false,
      production_logo_repair_gated: false,
      production_media_library_delete_gated: false,
      production_approved_logo_import_gated: false,
      env_keys_used: ["SUPABASE_DEV_URL", "SUPABASE_DEV_SERVICE_ROLE_KEY"]
    };
  }

  // production — ignore SUPABASE_DEV_* entirely
  const url = String(env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || "");
  if (!url || !key) {
    throw Object.assign(
      new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for --target=production"),
      { code: "missing_production_env" }
    );
  }
  const ref = projectRefFromUrl(url);
  if (ref !== PRODUCTION_REF) {
    throw Object.assign(
      new Error(
        `Production project ref mismatch: expected ${PRODUCTION_REF}, got ${ref || "(unparsed)"}`
      ),
      { code: "unexpected_production_ref", project_ref: ref }
    );
  }

  const gatedCopy = mode === "copy";
  const gatedPromote = mode === "promote";
  const gatedLogoRepair = mode === "repair-logo";
  const gatedMediaLibraryDelete = mode === "delete-media-row";
  const gatedApprovedLogoImport = mode === "import-approved-line-logo";
  return {
    target: "production",
    label:
      gatedCopy ||
      gatedPromote ||
      gatedLogoRepair ||
      gatedMediaLibraryDelete ||
      gatedApprovedLogoImport
        ? "ORIGINAL_PROJECT"
        : "PRODUCTION",
    url,
    key,
    project_ref: ref,
    // dry-run: no writes; copy/promote/repair/ml-delete/approved-logo: only after CLI + plan gates
    writes_allowed: false,
    production_copy_gated: gatedCopy,
    production_promote_gated: gatedPromote,
    production_logo_repair_gated: gatedLogoRepair,
    production_media_library_delete_gated: gatedMediaLibraryDelete,
    production_approved_logo_import_gated: gatedApprovedLogoImport,
    env_keys_used: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
  };
}

/**
 * Format a safe pre-flight banner (never includes credentials).
 */
export function formatTargetBanner(resolved, mode) {
  let writeNote = "no";
  if (resolved.production_copy_gated) {
    writeNote = "gated Original-project copy only (after confirmation + plan gates)";
  } else if (resolved.production_promote_gated) {
    writeNote = "gated Original-project promote only (after confirmation + plan gates)";
  } else if (resolved.production_logo_repair_gated) {
    writeNote = "gated Original-project logo repair only (after confirmation + plan gates)";
  } else if (resolved.production_media_library_delete_gated) {
    writeNote = "gated Original-project Media Library delete only";
  } else if (resolved.production_approved_logo_import_gated) {
    writeNote = "gated Original-project approved local logo import only (after confirmation)";
  } else if (resolved.writes_allowed) {
    writeNote = "yes (DEV)";
  }
  return [
    `Selected target: ${resolved.target}`,
    `Project ref: ${resolved.project_ref}`,
    `Mode: ${mode}`,
    `Host: ${new URL(resolved.url).host}`,
    `Writes: ${writeNote}`
  ].join("\n");
}
