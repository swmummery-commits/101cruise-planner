#!/usr/bin/env node
/**
 * One-way CI catalogue copy: production → DEV.
 *
 * Tables: ci_cruise_lines → ci_cruise_ships → cruise_ship_aliases
 *
 * Default: DRY RUN (zero writes).
 * Real DEV writes require: --apply
 *
 * Env:
 *   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY   (production, read-only)
 *   SUPABASE_DEV_URL + SUPABASE_DEV_SERVICE_ROLE_KEY
 *
 * Refs hard-locked:
 *   source xikbibxyinttllxamgao → dest vkheexbapykcdfbqcach
 *
 * HOLD DEPLOY. Do not run --apply unless explicitly approved.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRODUCTION_REF,
  DEV_REF,
  TABLES,
  PREFERRED_COLUMNS,
  projectRefFromUrl,
  assertCopyRefs,
  intersectColumns,
  schemaDiff,
  planCatalogueCopy,
  assertApplyOrder,
  createReadOnlyProductionGuard
} from "./lib/copy-ci-catalogue/plan.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function loadEnvFile() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
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
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile();

function scrub(s) {
  return String(s || "")
    .replace(/eyJ[\w.-]+/g, "[redacted]")
    .replace(/sb_[a-z]+_[A-Za-z0-9_-]+/g, "[redacted]");
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function createClient(url, key, { allowWrites }) {
  const base = url.replace(/\/$/, "");
  const headersBase = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json"
  };

  async function request(method, pathSuffix, { body, headers = {}, prefer } = {}) {
    if (!allowWrites && method !== "GET" && method !== "HEAD") {
      throw Object.assign(new Error("Write refused on read-only client"), {
        code: "write_refused"
      });
    }
    const res = await fetch(`${base}${pathSuffix}`, {
      method,
      headers: {
        ...headersBase,
        ...(prefer ? { Prefer: prefer } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const msg = scrub(data?.message || data?.error || data?.msg || text || `HTTP ${res.status}`);
      const err = new Error(msg);
      err.status = res.status;
      err.code = data?.code || null;
      throw err;
    }
    return { res, data };
  }

  return {
    url: base,
    allowWrites: Boolean(allowWrites),
    async ping() {
      const { res } = await request("GET", "/rest/v1/", {
        headers: { Accept: "application/openapi+json" }
      });
      return res.status;
    },
    async tableExists(table) {
      try {
        await request("GET", `/rest/v1/${table}?select=id&limit=1`, {
          prefer: "count=exact"
        });
        return true;
      } catch (e) {
        if (e.status === 404 || e.code === "PGRST205") return false;
        const msg = String(e.message || "").toLowerCase();
        if (msg.includes("could not find the table") || msg.includes("does not exist")) {
          return false;
        }
        throw e;
      }
    },
    async listColumns(table) {
      // OpenAPI definitions
      const { data } = await request("GET", "/rest/v1/", {
        headers: { Accept: "application/openapi+json" }
      });
      const props = data?.definitions?.[table]?.properties;
      if (props && typeof props === "object") {
        return Object.keys(props).sort();
      }
      // Fallback: sample row
      const sample = await request("GET", `/rest/v1/${table}?select=*&limit=1`);
      const row = Array.isArray(sample.data) ? sample.data[0] : null;
      if (row) return Object.keys(row).sort();
      // Empty table — probe preferred columns
      const preferred = PREFERRED_COLUMNS[table] || ["id"];
      const present = [];
      for (const col of preferred) {
        try {
          await request("GET", `/rest/v1/${table}?select=${encodeURIComponent(col)}&limit=1`);
          present.push(col);
        } catch {
          /* column missing */
        }
      }
      return present;
    },
    async listAll(table, columns) {
      const select = columns.join(",");
      const pageSize = 500;
      let offset = 0;
      const all = [];
      while (offset < 100000) {
        const { data } = await request(
          "GET",
          `/rest/v1/${table}?select=${encodeURIComponent(select)}&order=id.asc&limit=${pageSize}&offset=${offset}`
        );
        const list = Array.isArray(data) ? data : [];
        all.push(...list);
        if (list.length < pageSize) break;
        offset += pageSize;
      }
      return all;
    },
    async count(table) {
      const { res } = await request("GET", `/rest/v1/${table}?select=id&limit=1`, {
        prefer: "count=exact"
      });
      const cr = res.headers.get("content-range");
      if (cr && cr.includes("/")) {
        const p = cr.split("/")[1];
        return p === "*" ? null : Number(p);
      }
      return null;
    },
    async upsertBatch(table, rows, columns) {
      if (!allowWrites) {
        throw Object.assign(new Error("Write refused on read-only client"), {
          code: "write_refused"
        });
      }
      if (!rows.length) return { upserted: 0 };
      const payload = rows.map((r) => {
        const out = {};
        for (const c of columns) {
          if (Object.prototype.hasOwnProperty.call(r, c)) out[c] = r[c];
        }
        return out;
      });
      const batchSize = 100;
      let upserted = 0;
      for (let i = 0; i < payload.length; i += batchSize) {
        const chunk = payload.slice(i, i + batchSize);
        await request("POST", `/rest/v1/${table}`, {
          body: chunk,
          prefer: "resolution=merge-duplicates,return=minimal"
        });
        upserted += chunk.length;
      }
      return { upserted };
    }
  };
}

async function main() {
  const apply = hasFlag("--apply");
  const mode = apply ? "apply" : "dry-run";

  const prodUrl = process.env.SUPABASE_URL || "";
  const prodKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const devUrl = process.env.SUPABASE_DEV_URL || "";
  const devKey = process.env.SUPABASE_DEV_SERVICE_ROLE_KEY || "";

  if (!prodUrl || !prodKey || !devUrl || !devKey) {
    console.error(
      "Missing env. Need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DEV_URL, SUPABASE_DEV_SERVICE_ROLE_KEY"
    );
    process.exit(1);
  }

  const sourceRef = projectRefFromUrl(prodUrl);
  const destRef = projectRefFromUrl(devUrl);
  assertCopyRefs(sourceRef, destRef);

  // Production client is ALWAYS read-only in this script.
  const production = createClient(prodUrl, prodKey, { allowWrites: false });
  const productionWriteGuard = createReadOnlyProductionGuard("production");
  // DEV writes only when --apply
  const dev = createClient(devUrl, devKey, { allowWrites: apply });

  console.log(`\n=== CI catalogue copy (${mode}) ===`);
  console.log(`Source (production): ${sourceRef}`);
  console.log(`Destination (DEV):   ${destRef}`);
  console.log(`Writes enabled:      ${apply ? "DEV only" : "NONE (dry-run)"}`);

  // Auth ping
  const [prodStatus, devStatus] = await Promise.all([production.ping(), dev.ping()]);
  if (prodStatus === 401 || prodStatus === 403) {
    throw new Error("Production authentication failed");
  }
  if (devStatus === 401 || devStatus === 403) {
    throw new Error("DEV authentication failed");
  }

  for (const table of TABLES) {
    const [srcExists, destExists] = await Promise.all([
      production.tableExists(table),
      dev.tableExists(table)
    ]);
    if (!srcExists) throw new Error(`Source table missing: ${table}`);
    if (!destExists) throw new Error(`DEV table missing: ${table}`);
  }

  const [prodLineCols, prodShipCols, prodAliasCols, devLineCols, devShipCols, devAliasCols] =
    await Promise.all([
      production.listColumns("ci_cruise_lines"),
      production.listColumns("ci_cruise_ships"),
      production.listColumns("cruise_ship_aliases"),
      dev.listColumns("ci_cruise_lines"),
      dev.listColumns("ci_cruise_ships"),
      dev.listColumns("cruise_ship_aliases")
    ]);

  const lineColumns = intersectColumns(
    prodLineCols,
    devLineCols,
    PREFERRED_COLUMNS.ci_cruise_lines
  );
  const shipColumns = intersectColumns(
    prodShipCols,
    devShipCols,
    PREFERRED_COLUMNS.ci_cruise_ships
  );
  const aliasColumns = intersectColumns(
    prodAliasCols,
    devAliasCols,
    PREFERRED_COLUMNS.cruise_ship_aliases
  );

  if (!lineColumns.includes("id") || !shipColumns.includes("id") || !aliasColumns.includes("id")) {
    throw new Error("id column must exist on all three tables in both environments");
  }
  if (!shipColumns.includes("cruise_line_id")) {
    throw new Error("ci_cruise_ships.cruise_line_id missing from shared columns");
  }
  if (!aliasColumns.includes("ship_id") || !aliasColumns.includes("cruise_line_id")) {
    throw new Error("cruise_ship_aliases ship_id/cruise_line_id missing from shared columns");
  }

  const schema = {
    ci_cruise_lines: schemaDiff(prodLineCols, devLineCols),
    ci_cruise_ships: schemaDiff(prodShipCols, devShipCols),
    cruise_ship_aliases: schemaDiff(prodAliasCols, devAliasCols)
  };

  const [
    sourceLines,
    sourceShips,
    sourceAliases,
    destLines,
    destShips,
    destAliases,
    prodLineCount,
    prodShipCount,
    prodAliasCount,
    devLineCount,
    devShipCount,
    devAliasCount
  ] = await Promise.all([
    production.listAll("ci_cruise_lines", lineColumns),
    production.listAll("ci_cruise_ships", shipColumns),
    production.listAll("cruise_ship_aliases", aliasColumns),
    dev.listAll("ci_cruise_lines", lineColumns),
    dev.listAll("ci_cruise_ships", shipColumns),
    dev.listAll("cruise_ship_aliases", aliasColumns),
    production.count("ci_cruise_lines"),
    production.count("ci_cruise_ships"),
    production.count("cruise_ship_aliases"),
    dev.count("ci_cruise_lines"),
    dev.count("ci_cruise_ships"),
    dev.count("cruise_ship_aliases")
  ]);

  const plan = planCatalogueCopy({
    sourceLines,
    sourceShips,
    sourceAliases,
    destLines,
    destShips,
    destAliases,
    lineColumns,
    shipColumns,
    aliasColumns
  });

  const summary = {
    mode,
    source_ref: sourceRef,
    destination_ref: destRef,
    production_counts: {
      ci_cruise_lines: prodLineCount,
      ci_cruise_ships: prodShipCount,
      cruise_ship_aliases: prodAliasCount
    },
    dev_counts_before: {
      ci_cruise_lines: devLineCount,
      ci_cruise_ships: devShipCount,
      cruise_ship_aliases: devAliasCount
    },
    shared_columns: {
      ci_cruise_lines: lineColumns,
      ci_cruise_ships: shipColumns,
      cruise_ship_aliases: aliasColumns
    },
    schema_differences: schema,
    proposed: {
      lines_create: plan.lines.create_count,
      lines_update: plan.lines.update_count,
      lines_identical: plan.lines.identical_count,
      ships_create: plan.ships.create_count,
      ships_update: plan.ships.update_count,
      ships_identical: plan.ships.identical_count,
      aliases_create: plan.aliases.create_count,
      aliases_update: plan.aliases.update_count,
      aliases_identical: plan.aliases.identical_count
    },
    foreign_key_validation: {
      invalid_ships: plan.ships.invalid,
      invalid_aliases: plan.aliases.invalid,
      duplicate_uuids: plan.blocking_errors.filter((e) => e.reason === "duplicate_uuid")
    },
    dest_extra_rows_retained: {
      lines: plan.lines.dest_extra_rows_retained,
      ships: plan.ships.dest_extra_rows_retained,
      aliases: plan.aliases.dest_extra_rows_retained
    },
    estimated_payload_bytes: plan.estimated_payload_bytes,
    would_delete_dev_rows: false,
    production_writes: 0,
    dev_writes: 0,
    media_library_copied: false,
    storage_copied: false
  };

  const outDir = path.join(ROOT, "tmp", "ci-catalogue-copy");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = Date.now();
  const reportPath = path.join(outDir, `${mode}-${stamp}.json`);

  // Abort apply if referential integrity issues
  const hardBlocks = plan.blocking_errors.filter((e) =>
    [
      "ship_references_missing_line",
      "alias_references_missing_line",
      "alias_references_missing_ship",
      "duplicate_uuid",
      "missing_id",
      "missing_cruise_line_id",
      "missing_ship_id"
    ].includes(e.reason)
  );

  if (apply) {
    if (hardBlocks.length) {
      summary.apply_aborted = true;
      summary.apply_abort_reason = "referential_integrity";
      summary.blocking_errors = hardBlocks;
      fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2));
      console.error("APPLY ABORTED: referential integrity errors");
      console.error(JSON.stringify(hardBlocks.slice(0, 20), null, 2));
      process.exit(4);
    }

    // Prove production write path is impossible
    try {
      await productionWriteGuard.upsert();
    } catch (e) {
      if (e.code !== "production_write_forbidden") throw e;
    }

    const completed = new Set();
    const applyResult = { lines: null, ships: null, aliases: null };

    try {
      assertApplyOrder(completed, "ci_cruise_lines");
      const lineRows = [
        ...plan.lines.creates,
        ...plan.lines.updates.map((u) => u.to)
      ];
      applyResult.lines = await dev.upsertBatch("ci_cruise_lines", lineRows, lineColumns);
      summary.dev_writes += applyResult.lines.upserted;
      completed.add("ci_cruise_lines");

      assertApplyOrder(completed, "ci_cruise_ships");
      const shipRows = [
        ...plan.ships.creates,
        ...plan.ships.updates.map((u) => u.to)
      ];
      applyResult.ships = await dev.upsertBatch("ci_cruise_ships", shipRows, shipColumns);
      summary.dev_writes += applyResult.ships.upserted;
      completed.add("ci_cruise_ships");

      assertApplyOrder(completed, "cruise_ship_aliases");
      const aliasRows = [
        ...plan.aliases.creates,
        ...plan.aliases.updates.map((u) => u.to)
      ];
      applyResult.aliases = await dev.upsertBatch(
        "cruise_ship_aliases",
        aliasRows,
        aliasColumns
      );
      summary.dev_writes += applyResult.aliases.upserted;
      completed.add("cruise_ship_aliases");

      summary.apply_result = applyResult;
    } catch (e) {
      summary.partial_failure = {
        completed: [...completed],
        failed_at: TABLES.find((t) => !completed.has(t)) || "unknown",
        error: scrub(e.message)
      };
      fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2));
      console.error("PARTIAL FAILURE:", summary.partial_failure);
      process.exit(5);
    }
  } else {
    summary.dry_run_zero_writes = true;
    summary.dev_writes = 0;
    summary.production_writes = 0;
  }

  fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2));

  console.log("\nProduction counts:", summary.production_counts);
  console.log("DEV counts (before):", summary.dev_counts_before);
  console.log("Proposed:", summary.proposed);
  console.log(
    "Schema production-only columns:",
    Object.fromEntries(
      Object.entries(schema).map(([k, v]) => [k, v.production_only])
    )
  );
  console.log(
    "Schema DEV-only columns:",
    Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, v.dev_only]))
  );
  console.log("FK invalid ships:", plan.ships.invalid_count);
  console.log("FK invalid aliases:", plan.aliases.invalid_count);
  console.log("Estimated payload bytes:", plan.estimated_payload_bytes);
  console.log(`DEV writes this run: ${summary.dev_writes}`);
  console.log(`Production writes this run: ${summary.production_writes}`);
  console.log(`Report: ${reportPath}`);

  if (!apply) {
    console.log("\nDry-run complete — zero writes.");
    console.log(
      "Later approved apply (DO NOT run unless approved):\n  node scripts/copy-ci-catalogue-to-dev.mjs --apply"
    );
  }
}

main().catch((err) => {
  console.error(scrub(err.message || err));
  process.exit(1);
});
