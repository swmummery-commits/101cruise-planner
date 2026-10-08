/**
 * Decide how to replace featured-cruise pricing without deleting the
 * current rows before the new rows are stored.
 *
 * Insert happens first. Previous row ids are deleted only after that insert
 * succeeds. An empty incoming list is a real clear on explicit save, and a
 * no-op when the caller asks to preserve existing rows (autosave).
 */

function cleanId(value) {
  const id = String(value || "").trim();
  return id || "";
}

function planPricingReplacement({ existingIds, incomingRows, preserveExistingIfEmpty = false } = {}) {
  const previousIds = [];
  const seen = new Set();
  for (const value of existingIds || []) {
    const id = cleanId(value && value.id != null ? value.id : value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    previousIds.push(id);
  }

  const insert = (Array.isArray(incomingRows) ? incomingRows : []).map((row) => {
    const copy = { ...(row && typeof row === "object" ? row : {}) };
    delete copy.id;
    return copy;
  });

  if (!insert.length && preserveExistingIfEmpty) {
    return { mode: "preserve", insert: [], deleteIds: [] };
  }

  return {
    mode: insert.length ? "replace" : "clear",
    insert,
    deleteIds: previousIds
  };
}

module.exports = { planPricingReplacement };
