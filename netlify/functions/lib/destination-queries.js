/**
 * Shared destination query helpers — classification vs public publication.
 * Backward-compatible with pre-migration schema (no classification_enabled column).
 */

const {
  classificationDestinations,
  publicLivingDestinations,
  isInventoryDestination
} = require("./destination-classification");

const PG_UNDEFINED_COLUMN = "42703";

const CLASSIFICATION_SELECT_BASE = "id,name,slug,primary_region,status,display_order";
const CLASSIFICATION_SELECT = CLASSIFICATION_SELECT_BASE;
const CLASSIFICATION_SELECT_WITH_FLAG = `${CLASSIFICATION_SELECT_BASE},classification_enabled`;

const INVENTORY_SELECT_BASE = "id,name,slug,status";
const INVENTORY_SELECT = INVENTORY_SELECT_BASE;
const INVENTORY_SELECT_WITH_FLAG = `${INVENTORY_SELECT_BASE},classification_enabled`;

function isMissingClassificationEnabledColumnError(err) {
  if (!err) return false;
  const code = String(err.body?.code || err.code || "").trim();
  const msg = String(err.message || err.body?.message || "").toLowerCase();
  if (code === PG_UNDEFINED_COLUMN) {
    return msg.includes("classification_enabled");
  }
  return msg.includes("classification_enabled") && msg.includes("does not exist");
}

function normalizeDestinationRow(row, { schemaHasClassificationColumn = true } = {}) {
  if (!row || typeof row !== "object") return null;
  const out = { ...row };
  if (!schemaHasClassificationColumn && out.classification_enabled === undefined) {
    out.classification_enabled = true;
  }
  return out;
}

function normalizeDestinationRows(rows, options = {}) {
  return (rows || []).map((row) => normalizeDestinationRow(row, options)).filter(Boolean);
}

/**
 * Query destinations with classification_enabled when present; retry without column pre-migration.
 * @param {function(string): Promise<Array>} fetchFn - GET rest path
 * @param {string} pathWithFlag - select includes classification_enabled
 * @param {string} pathWithoutFlag - select omits classification_enabled
 */
async function queryDestinationsWithCompat(fetchFn, pathWithFlag, pathWithoutFlag) {
  try {
    const rows = await fetchFn(pathWithFlag);
    return {
      rows: normalizeDestinationRows(rows, { schemaHasClassificationColumn: true }),
      schemaHasClassificationColumn: true
    };
  } catch (err) {
    if (!isMissingClassificationEnabledColumnError(err)) throw err;
    const rows = await fetchFn(pathWithoutFlag);
    return {
      rows: normalizeDestinationRows(rows, { schemaHasClassificationColumn: false }),
      schemaHasClassificationColumn: false,
      usedPreMigrationFallback: true
    };
  }
}

async function loadClassificationDestinations(fetchFn) {
  const pathWithFlag = `destinations?select=${CLASSIFICATION_SELECT_WITH_FLAG}&order=display_order.asc,name.asc`;
  const pathWithoutFlag = `destinations?select=${CLASSIFICATION_SELECT_BASE}&order=display_order.asc,name.asc`;
  const result = await queryDestinationsWithCompat(fetchFn, pathWithFlag, pathWithoutFlag);
  return filterClassificationDestinations(result.rows);
}

async function loadInventoryDestinationBySlug(fetchFn, slug) {
  const needle = encodeURIComponent(String(slug || "").trim());
  const pathWithFlag = `destinations?slug=ilike.${needle}&select=${INVENTORY_SELECT_WITH_FLAG}&limit=1`;
  const pathWithoutFlag = `destinations?slug=ilike.${needle}&select=${INVENTORY_SELECT_BASE}&limit=1`;
  const result = await queryDestinationsWithCompat(fetchFn, pathWithFlag, pathWithoutFlag);
  return filterInventoryDestination(result.rows);
}

/** Load all destinations for classification (PostgREST; filter in code for backward compat). */
function classificationDestinationsQuery() {
  return `destinations?select=${CLASSIFICATION_SELECT}&order=display_order.asc,name.asc`;
}

/** Public Living Destination shells only. */
function publicDestinationsQuery() {
  return `destinations?status=eq.published&select=${CLASSIFICATION_SELECT}&order=display_order.asc,name.asc`;
}

/** Lookup by slug for Cruise Finder inventory (draft + published; not hidden). */
function inventoryDestinationBySlugQuery(slug) {
  return `destinations?slug=ilike.${encodeURIComponent(slug)}&select=${INVENTORY_SELECT}&limit=1`;
}

function filterClassificationDestinations(rows) {
  return classificationDestinations(rows || []);
}

function filterPublicDestinations(rows) {
  return publicLivingDestinations(rows || []);
}

/** Accept draft or published destinations for cruise inventory; reject hidden/archived/disabled. */
function filterInventoryDestination(row) {
  const dest = Array.isArray(row) ? row[0] : row;
  if (!dest?.id || !isInventoryDestination(dest)) return null;
  return {
    id: dest.id,
    name: dest.name,
    slug: dest.slug,
    status: dest.status,
    publicLivingPage: dest.status === "published"
  };
}

module.exports = {
  PG_UNDEFINED_COLUMN,
  CLASSIFICATION_SELECT,
  CLASSIFICATION_SELECT_BASE,
  CLASSIFICATION_SELECT_WITH_FLAG,
  INVENTORY_SELECT,
  INVENTORY_SELECT_BASE,
  INVENTORY_SELECT_WITH_FLAG,
  isMissingClassificationEnabledColumnError,
  normalizeDestinationRow,
  normalizeDestinationRows,
  queryDestinationsWithCompat,
  loadClassificationDestinations,
  loadInventoryDestinationBySlug,
  classificationDestinationsQuery,
  publicDestinationsQuery,
  inventoryDestinationBySlugQuery,
  filterClassificationDestinations,
  filterPublicDestinations,
  filterInventoryDestination
};
