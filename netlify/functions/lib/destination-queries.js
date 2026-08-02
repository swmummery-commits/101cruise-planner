/**
 * Shared destination query helpers — classification vs public publication.
 */

const { classificationDestinations, publicLivingDestinations, isInventoryDestination } = require("./destination-classification");

const CLASSIFICATION_SELECT = "id,name,slug,primary_region,status,display_order";
const INVENTORY_SELECT = "id,name,slug,status";

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
  CLASSIFICATION_SELECT,
  INVENTORY_SELECT,
  classificationDestinationsQuery,
  publicDestinationsQuery,
  inventoryDestinationBySlugQuery,
  filterClassificationDestinations,
  filterPublicDestinations,
  filterInventoryDestination
};
