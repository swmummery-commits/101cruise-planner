/**
 * Sprint 16A — local development inventory database (SQLite).
 * NEVER connects to production Supabase.
 *
 * Path: tmp/dev-inventory/inventory.sqlite (gitignored via tmp/)
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const PRODUCTION_SUPABASE_REF = "xikbibxyinttllxamgao";

function defaultDbPath(root) {
  return path.join(root || process.cwd(), "tmp/dev-inventory/inventory.sqlite");
}

/**
 * Deterministic UUID from a stable string (for idempotent seeds).
 * @param {string} seed
 */
function uuidFromSeed(seed) {
  const hash = crypto.createHash("sha256").update(String(seed)).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function fingerprintPayload(obj) {
  const json = JSON.stringify(obj);
  return crypto.createHash("sha256").update(json).digest("hex");
}

/**
 * Hard safety: refuse production Supabase credentials for inventory writes.
 * @param {{ url?: string, target?: string }} options
 */
function assertDevInventoryTarget(options = {}) {
  const target = String(options.target || process.env.INVENTORY_DB_TARGET || "sqlite-dev").toLowerCase();
  const url = String(options.url || process.env.SUPABASE_DEV_URL || process.env.SUPABASE_URL || "");

  if (target === "production" || target === "prod") {
    throw new Error("INVENTORY_DB_TARGET=production is forbidden.");
  }

  if (url.includes(PRODUCTION_SUPABASE_REF)) {
    throw new Error(
      `Refusing inventory writes to production Supabase ref (${PRODUCTION_SUPABASE_REF}). ` +
        `Use local sqlite-dev (default) or set SUPABASE_DEV_URL to a dedicated non-production project.`
    );
  }

  if (target !== "sqlite-dev" && target !== "dev" && target !== "supabase-dev") {
    throw new Error(`Unsupported INVENTORY_DB_TARGET=${target}. Use sqlite-dev.`);
  }

  return { target: target === "dev" ? "sqlite-dev" : target, url };
}

/**
 * @param {{ root?: string, dbPath?: string, reset?: boolean }} options
 */
function openDevInventoryDb(options = {}) {
  assertDevInventoryTarget({ target: "sqlite-dev" });
  const dbPath = options.dbPath || defaultDbPath(options.root);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (options.reset && fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  return { db, dbPath };
}

module.exports = {
  PRODUCTION_SUPABASE_REF,
  defaultDbPath,
  uuidFromSeed,
  fingerprintPayload,
  assertDevInventoryTarget,
  openDevInventoryDb
};
