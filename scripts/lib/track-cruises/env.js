/**
 * Sprint 15A — load TRACK_CRUISES_* from .env without exposing the key.
 */

const fs = require("fs");
const path = require("path");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") {
      process.env[key] = value;
    }
  }
}

/**
 * @param {string} [rootDir]
 * @returns {{ ok: true, host: string } | { ok: false, error: string }}
 */
function loadTrackCruisesCredentials(rootDir) {
  const root = rootDir || path.resolve(__dirname, "../../..");
  loadEnvFile(path.join(root, ".env"));

  const key = String(process.env.TRACK_CRUISES_RAPIDAPI_KEY || "").trim();
  const host = String(process.env.TRACK_CRUISES_RAPIDAPI_HOST || "").trim();

  if (!key) {
    return { ok: false, error: "TRACK_CRUISES_RAPIDAPI_KEY is not configured." };
  }
  if (!host) {
    return { ok: false, error: "TRACK_CRUISES_RAPIDAPI_HOST is not configured." };
  }

  return { ok: true, host, keyConfigured: true };
}

/** Safe status line — never includes the key. */
function credentialStatusLine() {
  const key = String(process.env.TRACK_CRUISES_RAPIDAPI_KEY || "").trim();
  return key ? "TRACK_CRUISES_RAPIDAPI_KEY: configured" : "TRACK_CRUISES_RAPIDAPI_KEY: MISSING";
}

module.exports = {
  loadEnvFile,
  loadTrackCruisesCredentials,
  credentialStatusLine
};
