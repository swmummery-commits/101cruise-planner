/**
 * Pure helpers for CI catalogue prod → DEV copy planning.
 * No network I/O. Used by CLI and offline tests.
 */

export const PRODUCTION_REF = "xikbibxyinttllxamgao";
export const DEV_REF = "vkheexbapykcdfbqcach";

export const TABLES = ["ci_cruise_lines", "ci_cruise_ships", "cruise_ship_aliases"];

/** Preferred column order for readability; intersection still drives copy. */
export const PREFERRED_COLUMNS = {
  ci_cruise_lines: [
    "id",
    "legacy_base44_id",
    "name",
    "slug",
    "code",
    "country",
    "website_url",
    "description",
    "logo_url",
    "hero_image_url",
    "brand_colour",
    "line_type",
    "market_segment",
    "active",
    "sold_by_101cruise",
    "needs_review",
    "review_notes",
    "source_name",
    "source_url",
    "last_verified_at",
    "created_at",
    "updated_at",
    "ship_naming_style"
  ],
  ci_cruise_ships: [
    "id",
    "cruise_line_id",
    "legacy_base44_id",
    "name",
    "slug",
    "status",
    "ship_class",
    "year_built",
    "year_refurbished",
    "passenger_capacity",
    "crew_count",
    "deck_count",
    "stateroom_count",
    "gross_tonnage",
    "length_metres",
    "stateroom_breakdown",
    "cabin_type_summary",
    "facilities",
    "hero_image_url",
    "image_gallery",
    "deck_plan_url",
    "official_ship_url",
    "active",
    "needs_review",
    "review_notes",
    "source_name",
    "source_url",
    "last_verified_at",
    "created_at",
    "updated_at"
  ],
  cruise_ship_aliases: [
    "id",
    "ship_id",
    "cruise_line_id",
    "raw_alias",
    "normalised_alias",
    "source",
    "active",
    "created_by",
    "created_at",
    "updated_at"
  ]
};

export function projectRefFromUrl(url) {
  try {
    return new URL(String(url).trim()).hostname.split(".")[0] || null;
  } catch {
    return null;
  }
}

/**
 * Validate source/destination project refs. Throws on unsafe configuration.
 */
export function assertCopyRefs(sourceRef, destRef) {
  if (!sourceRef || !destRef) {
    throw Object.assign(new Error("Source and destination project refs are required"), {
      code: "missing_refs"
    });
  }
  if (sourceRef === destRef) {
    throw Object.assign(new Error("Source and destination project refs must differ"), {
      code: "identical_refs"
    });
  }
  if (sourceRef === DEV_REF && destRef === PRODUCTION_REF) {
    throw Object.assign(new Error("Refs are reversed — refusing DEV→production copy"), {
      code: "reversed_refs"
    });
  }
  if (sourceRef !== PRODUCTION_REF) {
    throw Object.assign(
      new Error(`Source ref must be ${PRODUCTION_REF}, got ${sourceRef}`),
      { code: "unknown_source_ref" }
    );
  }
  if (destRef !== DEV_REF) {
    throw Object.assign(
      new Error(`Destination ref must be ${DEV_REF}, got ${destRef}`),
      { code: "unknown_dest_ref" }
    );
  }
  return true;
}

export function intersectColumns(sourceCols, destCols, preferred = []) {
  const sourceSet = new Set(sourceCols);
  const destSet = new Set(destCols);
  const preferredOrdered = preferred.filter((c) => sourceSet.has(c) && destSet.has(c));
  const extras = [...sourceSet]
    .filter((c) => destSet.has(c) && !preferredOrdered.includes(c))
    .sort();
  return [...preferredOrdered, ...extras];
}

export function schemaDiff(sourceCols, destCols) {
  const s = new Set(sourceCols);
  const d = new Set(destCols);
  return {
    production_only: [...s].filter((c) => !d.has(c)).sort(),
    dev_only: [...d].filter((c) => !s.has(c)).sort(),
    shared: [...s].filter((c) => d.has(c)).sort()
  };
}

function stableStringify(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

export function projectRow(row, columns) {
  const out = {};
  for (const col of columns) {
    if (Object.prototype.hasOwnProperty.call(row, col)) {
      out[col] = row[col];
    }
  }
  return out;
}

export function rowsEqual(a, b, columns) {
  for (const col of columns) {
    if (stableStringify(a?.[col]) !== stableStringify(b?.[col])) return false;
  }
  return true;
}

/**
 * Plan upsert actions for one table. Never deletes extras on destination.
 */
export function planTableCopy({ table, columns, sourceRows, destRows, parentValidators }) {
  const destById = new Map((destRows || []).map((r) => [r.id, r]));
  const sourceIds = new Set();
  const creates = [];
  const updates = [];
  const identical = [];
  const invalid = [];
  const duplicateSourceIds = [];

  for (const raw of sourceRows || []) {
    if (!raw?.id) {
      invalid.push({ reason: "missing_id", row: projectRow(raw, columns) });
      continue;
    }
    if (sourceIds.has(raw.id)) {
      duplicateSourceIds.push(raw.id);
      continue;
    }
    sourceIds.add(raw.id);

    const projected = projectRow(raw, columns);
    if (parentValidators) {
      const parentError = parentValidators(projected);
      if (parentError) {
        invalid.push({ reason: parentError, id: raw.id });
        continue;
      }
    }

    const existing = destById.get(raw.id);
    if (!existing) {
      creates.push(projected);
      continue;
    }
    const destProjected = projectRow(existing, columns);
    if (rowsEqual(projected, destProjected, columns)) {
      identical.push(raw.id);
    } else {
      updates.push({ id: raw.id, from: destProjected, to: projected });
    }
  }

  const destExtras = [...destById.keys()].filter((id) => !sourceIds.has(id));

  return {
    table,
    columns,
    source_count: (sourceRows || []).length,
    dest_count: (destRows || []).length,
    create_count: creates.length,
    update_count: updates.length,
    identical_count: identical.length,
    invalid_count: invalid.length,
    duplicate_source_uuid_count: duplicateSourceIds.length,
    dest_extra_rows_retained: destExtras.length,
    creates,
    updates,
    identical_ids: identical,
    invalid,
    duplicate_source_ids: duplicateSourceIds,
    dest_extra_ids_sample: destExtras.slice(0, 20)
  };
}

export function validateShipParents(ship, lineIds) {
  if (!ship.cruise_line_id) return "missing_cruise_line_id";
  if (!lineIds.has(ship.cruise_line_id)) return "ship_references_missing_line";
  return null;
}

export function validateAliasParents(alias, lineIds, shipIds) {
  if (!alias.cruise_line_id) return "missing_cruise_line_id";
  if (!alias.ship_id) return "missing_ship_id";
  if (!lineIds.has(alias.cruise_line_id)) return "alias_references_missing_line";
  if (!shipIds.has(alias.ship_id)) return "alias_references_missing_ship";
  return null;
}

/**
 * Full dry-run plan across lines → ships → aliases.
 */
export function planCatalogueCopy({
  sourceLines,
  sourceShips,
  sourceAliases,
  destLines,
  destShips,
  destAliases,
  lineColumns,
  shipColumns,
  aliasColumns
}) {
  const linePlan = planTableCopy({
    table: "ci_cruise_lines",
    columns: lineColumns,
    sourceRows: sourceLines,
    destRows: destLines
  });

  // After lines would be applied: source line IDs are the parent set for ships
  const lineIds = new Set((sourceLines || []).map((r) => r.id));
  const shipPlan = planTableCopy({
    table: "ci_cruise_ships",
    columns: shipColumns,
    sourceRows: sourceShips,
    destRows: destShips,
    parentValidators: (row) => validateShipParents(row, lineIds)
  });

  const shipIds = new Set(
    (sourceShips || []).filter((s) => lineIds.has(s.cruise_line_id)).map((r) => r.id)
  );
  const aliasPlan = planTableCopy({
    table: "cruise_ship_aliases",
    columns: aliasColumns,
    sourceRows: sourceAliases,
    destRows: destAliases,
    parentValidators: (row) => validateAliasParents(row, lineIds, shipIds)
  });

  const estimatedBytes =
    estimatePayloadBytes(linePlan.creates, linePlan.updates) +
    estimatePayloadBytes(
      shipPlan.creates,
      shipPlan.updates.map((u) => u.to)
    ) +
    estimatePayloadBytes(
      aliasPlan.creates,
      aliasPlan.updates.map((u) => u.to)
    );

  return {
    order: TABLES.slice(),
    lines: linePlan,
    ships: shipPlan,
    aliases: aliasPlan,
    blocking_errors: [
      ...linePlan.invalid.map((i) => ({ table: "ci_cruise_lines", ...i })),
      ...shipPlan.invalid.map((i) => ({ table: "ci_cruise_ships", ...i })),
      ...aliasPlan.invalid.map((i) => ({ table: "cruise_ship_aliases", ...i })),
      ...linePlan.duplicate_source_ids.map((id) => ({
        table: "ci_cruise_lines",
        reason: "duplicate_uuid",
        id
      })),
      ...shipPlan.duplicate_source_ids.map((id) => ({
        table: "ci_cruise_ships",
        reason: "duplicate_uuid",
        id
      })),
      ...aliasPlan.duplicate_source_ids.map((id) => ({
        table: "cruise_ship_aliases",
        reason: "duplicate_uuid",
        id
      }))
    ],
    estimated_payload_bytes: estimatedBytes,
    would_delete_dev_rows: false
  };
}

function estimatePayloadBytes(creates, updatesOrRows) {
  const parts = [...(creates || []), ...(updatesOrRows || [])];
  try {
    return Buffer.byteLength(JSON.stringify(parts), "utf8");
  } catch {
    return 0;
  }
}

/** Apply order guard used by write path and tests. */
export function assertApplyOrder(completedTables, nextTable) {
  const idx = TABLES.indexOf(nextTable);
  if (idx < 0) throw new Error(`Unknown table ${nextTable}`);
  for (let i = 0; i < idx; i += 1) {
    if (!completedTables.has(TABLES[i])) {
      throw Object.assign(
        new Error(`Cannot copy ${nextTable} before ${TABLES[i]} completes`),
        { code: "order_violation" }
      );
    }
  }
}

/**
 * Write adapter contract: production adapter must throw on any write.
 */
export function createReadOnlyProductionGuard(label = "production") {
  return {
    label,
    async upsert() {
      throw Object.assign(new Error(`${label} is read-only — write refused`), {
        code: "production_write_forbidden"
      });
    },
    async delete() {
      throw Object.assign(new Error(`${label} is read-only — delete refused`), {
        code: "production_write_forbidden"
      });
    }
  };
}
