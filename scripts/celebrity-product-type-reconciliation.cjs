#!/usr/bin/env node
/**
 * Celebrity ocean/river product-type reconciliation (CommonJS runner).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = path.join(__dirname, "..");
const DATE = "2026-08-06";

const SNAPSHOT_PATH = path.join(root, `reports/celebrity-classification-snapshot-${DATE}.json`);
const COMPARE_PATH = path.join(root, `reports/celebrity-classification-compare-${DATE}.json`);
const MANIFEST_PATH = path.join(root, `reports/celebrity-product-type-reconciliation-${DATE}.json`);
const BACKUP_PATH = path.join(root, `reports/celebrity-classification-pre-repair-backup-${DATE}.json`);
const ROLLBACK_PATH = path.join(root, `reports/celebrity-classification-rollback-${DATE}.json`);

const OUT_OF_SNAPSHOT = [
  "EC10U115_2026-10-09",
  "SI09W213_2028-02-24",
  "SL13K066_2026-11-22",
  "AX08U056_2027-05-28"
];

try {
  require("dotenv").config({ path: path.join(root, ".env") });
} catch {
  /* optional */
}

const { createSupabaseRest, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const {
  simulateCelebrityInventory,
  catalogueDestinations,
  isEligibleCelebrityCruise,
  classifyCelebrityProductType
} = require(path.join(root, "netlify/functions/lib/celebrity-discovery-adapter"));

function checksum(v) {
  return crypto.createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");
}

async function headCount(table, query = "") {
  const https = require("https");
  const { url, key } = getSupabaseConfig(root);
  return new Promise((resolve, reject) => {
    const u = new URL(`${url}/rest/v1/${table}?select=id${query ? `&${query}` : ""}`);
    https
      .request(
        u,
        { method: "HEAD", headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" } },
        (res) => {
          const range = res.headers["content-range"] || "";
          const m = range.match(/\/(\d+)/);
          resolve(m ? Number(m[1]) : 0);
        }
      )
      .on("error", reject)
      .end();
  });
}

async function fetchAllActive(sb, lineId) {
  const rows = [];
  let offset = 0;
  while (true) {
    const batch = await sb.get(
      `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(lineId)}&status=eq.active&select=id,ship_id,destination_id,departure_port,departure_date,official_sailing_id,official_url,raw_extract,updated_at&limit=1000&offset=${offset}`
    );
    if (!batch?.length) break;
    rows.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  return rows;
}

async function loadCtx(sb) {
  const line = (await sb.get("ci_cruise_lines?slug=eq.celebrity-cruises&select=id,name&limit=1"))?.[0];
  const halLine = (await sb.get("ci_cruise_lines?slug=eq.holland-america-line&select=id&limit=1"))?.[0];
  const ships = await sb.get(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&active=eq.true&select=id,name,cruise_line_id,official_line_ship_id,ship_class`
  );
  const destRows = await sb.get(
    "destinations?classification_enabled=eq.true&select=id,name,slug,status,classification_enabled"
  );
  const shipById = Object.fromEntries((ships || []).map((s) => [s.id, s]));
  const destById = Object.fromEntries((destRows || []).map((d) => [d.id, d]));
  const riverDest = (destRows || []).find((d) => d.slug === "european-river-cruises");
  return {
    line,
    halLine,
    ships: ships || [],
    shipById,
    destById,
    riverDestId: riverDest?.id || null,
    riverDestSlug: riverDest?.slug || "european-river-cruises",
    destinations: catalogueDestinations(destRows || [])
  };
}

function snapshotEntryFromProduct(p) {
  const cls = classifyCelebrityProductType(p.raw);
  return {
    official_sailing_id: p.official_product_key,
    official_group_id: p.raw?.group_id || p.raw?.itinerary_group_id,
    product_type: p.product_type,
    classification_reason: cls.reason || p.product_type,
    ship_name: p.raw?.ship_name,
    ship_code: p.raw?.ship_code,
    voyage_type: p.raw?.voyage_type,
    pre_tour_duration: p.raw?.pre_tour_duration ?? null,
    post_tour_duration: p.raw?.post_tour_duration ?? null,
    source_url: p.raw?.official_url,
    departure_date: p.candidate?.departure_date || p.raw?.departure_date,
    departure_port: p.candidate?.departure_port || p.raw?.departure_port,
    destination: p.destination_resolution?.destinationKey || null,
    river_name: p.candidate?.raw_extract?.river_name || p.raw?.river_name || null,
    complete_high_confidence: p.complete_high_confidence,
    eligible: p.complete_high_confidence && isEligibleCelebrityCruise(p.product_type)
  };
}

async function runSnapshot(ctx) {
  const today = new Date().toISOString().slice(0, 10);
  const simulation = await simulateCelebrityInventory({
    cruiseLine: ctx.line,
    ships: ctx.ships,
    destinations: ctx.destinations,
    today
  });
  const eligible = simulation.products.filter(
    (p) => p.complete_high_confidence && isEligibleCelebrityCruise(p.product_type)
  );
  const byType = { ocean_cruise: 0, river_cruise: 0, ocean_cruisetour: 0, river_cruisetour: 0, other: 0 };
  for (const p of simulation.products) {
    if (byType[p.product_type] != null) byType[p.product_type] += 1;
    else byType.other += 1;
  }
  const eligibleProducts = eligible.map(snapshotEntryFromProduct);
  const snapshot = {
    generated_at: new Date().toISOString(),
    pagination_requests: simulation.pagination_requests,
    page_log: simulation.page_log,
    official_reported_total: simulation.official_reported_total,
    product_type_counts: byType,
    eligible_count: eligible.length,
    eligible_ocean: eligible.filter((p) => p.product_type === "ocean_cruise").length,
    eligible_river: eligible.filter((p) => p.product_type === "river_cruise").length,
    eligible_products: eligibleProducts,
    checksum: checksum(eligibleProducts)
  };
  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
  return snapshot;
}

async function runCompare(ctx, sb, snapshot) {
  const activeRows = await fetchAllActive(sb, ctx.line.id);
  const eligibleById = new Map(snapshot.eligible_products.map((p) => [p.official_sailing_id, p]));
  const liveSim = await simulateCelebrityInventory({
    cruiseLine: ctx.line,
    ships: ctx.ships,
    destinations: ctx.destinations,
    today: new Date().toISOString().slice(0, 10)
  });
  const liveByKey = new Map(liveSim.products.map((p) => [p.official_product_key, p]));

  const mismatches = [];
  let oceanOcean = 0;
  let riverRiver = 0;

  for (const row of activeRows) {
    const sid = row.official_sailing_id || row.raw_extract?.celebrity_sailing_id;
    const dbType = row.raw_extract?.celebrity_product_type || null;
    const official = eligibleById.get(sid);
    if (!official) continue;
    if (dbType === official.product_type) {
      if (dbType === "ocean_cruise") oceanOcean += 1;
      if (dbType === "river_cruise") riverRiver += 1;
      continue;
    }
    const dest = ctx.destById[row.destination_id];
    mismatches.push({
      discovered_cruise_id: row.id,
      official_sailing_id: sid,
      official_product_type: official.product_type,
      database_product_type: dbType,
      official_ship_code: official.ship_code,
      database_ship_code: row.raw_extract?.ship_code || ctx.shipById[row.ship_id]?.official_line_ship_id,
      canonical_ship: ctx.shipById[row.ship_id]?.name || null,
      official_destination: official.destination,
      database_destination_slug: dest?.slug || null,
      official_voyage_type: official.voyage_type,
      pre_tour: official.pre_tour_duration,
      post_tour: official.post_tour_duration,
      river_evidence: official.river_name,
      classification_reason: official.classification_reason,
      updated_at: row.updated_at
    });
  }

  const activeEligible = activeRows.filter((r) => eligibleById.has(r.official_sailing_id || r.raw_extract?.celebrity_sailing_id));
  const activeOutOfSnapshot = activeRows.filter((r) => !eligibleById.has(r.official_sailing_id || r.raw_extract?.celebrity_sailing_id));

  const compare = {
    generated_at: new Date().toISOString(),
    snapshot_checksum: snapshot.checksum,
    official_eligible: {
      total: snapshot.eligible_count,
      ocean: snapshot.eligible_ocean,
      river: snapshot.eligible_river
    },
    production_active: {
      total: activeRows.length,
      ocean: activeRows.filter((r) => r.raw_extract?.celebrity_product_type === "ocean_cruise").length,
      river: activeRows.filter((r) => r.raw_extract?.celebrity_product_type === "river_cruise").length
    },
    eligible_in_production: {
      total: activeEligible.length,
      ocean_db: activeEligible.filter((r) => r.raw_extract?.celebrity_product_type === "ocean_cruise").length,
      river_db: activeEligible.filter((r) => r.raw_extract?.celebrity_product_type === "river_cruise").length
    },
    out_of_snapshot: {
      total: activeOutOfSnapshot.length,
      ocean: activeOutOfSnapshot.filter((r) => r.raw_extract?.celebrity_product_type === "ocean_cruise").length,
      river: activeOutOfSnapshot.filter((r) => r.raw_extract?.celebrity_product_type === "river_cruise").length,
      sailing_ids: activeOutOfSnapshot.map((r) => r.official_sailing_id || r.raw_extract?.celebrity_sailing_id)
    },
    matched_types: { ocean_ocean: oceanOcean, river_river: riverRiver },
    mismatch_counts: {
      total: mismatches.length,
      official_river_database_ocean: mismatches.filter((m) => m.official_product_type === "river_cruise" && m.database_product_type === "ocean_cruise").length,
      official_ocean_database_river: mismatches.filter((m) => m.official_product_type === "ocean_cruise" && m.database_product_type === "river_cruise").length
    },
    mismatches,
    official_river_database_ocean_ids: mismatches.filter((m) => m.official_product_type === "river_cruise" && m.database_product_type === "ocean_cruise").map((m) => m.official_sailing_id).sort(),
    official_ocean_database_river_ids: mismatches.filter((m) => m.official_product_type === "ocean_cruise" && m.database_product_type === "river_cruise").map((m) => m.official_sailing_id).sort(),
    out_of_snapshot_audit: OUT_OF_SNAPSHOT.map((sid) => {
      const row = activeRows.find((r) => (r.official_sailing_id || r.raw_extract?.celebrity_sailing_id) === sid);
      const live = liveByKey.get(sid);
      return {
        official_sailing_id: sid,
        discovered_cruise_id: row?.id || null,
        database_product_type: row?.raw_extract?.celebrity_product_type || null,
        database_ship_code: row?.raw_extract?.ship_code || ctx.shipById[row?.ship_id]?.official_line_ship_id,
        in_fresh_graphql: Boolean(live),
        in_eligible_snapshot: eligibleById.has(sid),
        fresh_official_product_type: live?.product_type || null,
        fresh_official_ship_code: live?.raw?.ship_code || null
      };
    })
  };

  fs.mkdirSync(path.dirname(COMPARE_PATH), { recursive: true });
  fs.writeFileSync(COMPARE_PATH, JSON.stringify(compare, null, 2));
  return compare;
}

function buildManifest(compare, snapshot, ctx) {
  const actions = [];
  for (const m of compare.mismatches) {
    const official = snapshot.eligible_products.find((p) => p.official_sailing_id === m.official_sailing_id);
    const needsDest = m.official_product_type === "river_cruise" && m.database_destination_slug !== ctx.riverDestSlug;
    if (m.official_product_type === "river_cruise" && m.database_product_type === "ocean_cruise") {
      actions.push({
        action: needsDest ? "update_product_type_and_destination" : "update_product_type",
        discovered_cruise_id: m.discovered_cruise_id,
        official_sailing_id: m.official_sailing_id,
        official_ship_code: m.official_ship_code,
        current_product_type: m.database_product_type,
        proposed_product_type: "river_cruise",
        proposed_destination_id: needsDest ? ctx.riverDestId : null,
        official_source_evidence: official,
        classification_rule: "celebrity_river_ship_code_or_voyage_type",
        before_values: { celebrity_product_type: m.database_product_type, destination_slug: m.database_destination_slug },
        rollback_values: { celebrity_product_type: m.database_product_type, destination_id: null }
      });
    } else if (m.official_product_type === "ocean_cruise" && m.database_product_type === "river_cruise") {
      actions.push({
        action: "update_product_type",
        discovered_cruise_id: m.discovered_cruise_id,
        official_sailing_id: m.official_sailing_id,
        current_product_type: m.database_product_type,
        proposed_product_type: "ocean_cruise",
        official_source_evidence: official,
        classification_rule: "official_graphql_ocean_cruise",
        before_values: { celebrity_product_type: m.database_product_type },
        rollback_values: { celebrity_product_type: m.database_product_type }
      });
    } else {
      actions.push({ action: "hold_for_evidence", discovered_cruise_id: m.discovered_cruise_id, official_sailing_id: m.official_sailing_id });
    }
  }
  for (const sid of compare.out_of_snapshot.sailing_ids) {
    actions.push({ action: "unchanged", official_sailing_id: sid, reason: "out_of_snapshot_documented" });
  }
  const manifest = {
    generated_at: new Date().toISOString(),
    source_snapshot_checksum: snapshot.checksum,
    actions,
    deterministic_action_count: actions.filter((a) => String(a.action).startsWith("update")).length,
    checksum: checksum(actions.filter((a) => String(a.action).startsWith("update")))
  };
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  return manifest;
}

async function captureCounts(lineId, halLineId) {
  const enc = encodeURIComponent(lineId);
  return {
    discovered_cruises: await headCount("discovered_cruises"),
    celebrity_total: await headCount("discovered_cruises", `cruise_line_id=eq.${enc}`),
    celebrity_active: await headCount("discovered_cruises", `cruise_line_id=eq.${enc}&status=eq.active`),
    celebrity_ocean: await headCount("discovered_cruises", `cruise_line_id=eq.${enc}&status=eq.active&raw_extract->>celebrity_product_type=eq.ocean_cruise`),
    celebrity_river: await headCount("discovered_cruises", `cruise_line_id=eq.${enc}&status=eq.active&raw_extract->>celebrity_product_type=eq.river_cruise`),
    hal_active: halLineId ? await headCount("discovered_cruises", `cruise_line_id=eq.${encodeURIComponent(halLineId)}&status=eq.active`) : 0,
    pending_reviews: await headCount("cruise_discovery_review_items", "status=eq.pending"),
    ship_aliases: await headCount("cruise_ship_aliases")
  };
}

async function recordClassificationRun(ctx, compare, snapshot, manifest) {
  const { supabase } = require(path.join(root, "netlify/functions/lib/cruise-discovery-ops"));
  const {
    buildCelebrityRunStats,
    createCelebrityDiscoveryRun,
    finalizeCelebrityDiscoveryRun,
    CELEBRITY_CLASSIFICATION_RUN_TYPE
  } = require(path.join(root, "netlify/functions/lib/celebrity-discovery-run-tracking"));

  const runId = `celebrity-classification-${DATE}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const dbRun = await createCelebrityDiscoveryRun(supabase, {
    cruiseLineId: ctx.line.id,
    runId,
    mode: "classification_reconciliation",
    runType: CELEBRITY_CLASSIFICATION_RUN_TYPE,
    writesEnabled: false
  });

  const stats = {
    ...buildCelebrityRunStats({
      runType: CELEBRITY_CLASSIFICATION_RUN_TYPE,
      mode: "classification_reconciliation",
      runId,
      writesEnabled: false,
      proposedWrites: manifest.deterministic_action_count,
      updated: 0,
      inserted: 0
    }),
    official_eligible_total: compare.official_eligible.total,
    official_eligible_ocean: compare.official_eligible.ocean,
    official_eligible_river: compare.official_eligible.river,
    eligible_in_production_total: compare.eligible_in_production.total,
    eligible_in_production_ocean: compare.eligible_in_production.ocean_db,
    eligible_in_production_river: compare.eligible_in_production.river_db,
    product_type_mismatches: compare.mismatch_counts.total,
    out_of_snapshot_active: compare.out_of_snapshot.total,
    out_of_snapshot_sailing_ids: compare.out_of_snapshot.sailing_ids,
    snapshot_checksum: snapshot.checksum,
    manifest_checksum: manifest.checksum,
    deterministic_actions: manifest.deterministic_action_count
  };

  await finalizeCelebrityDiscoveryRun(supabase, dbRun.id, {
    status: "completed",
    stats
  });

  return { run_id: runId, run_record_id: dbRun.id, stats };
}

async function runApply(ctx, manifest, snapshot) {
  if (String(process.env.CELEBRITY_DISCOVERY_WRITE_ENABLED || "").toLowerCase() !== "true") {
    throw new Error("Set CELEBRITY_DISCOVERY_WRITE_ENABLED=true temporarily for classification apply");
  }
  const { supabase } = require(path.join(root, "netlify/functions/lib/cruise-discovery-ops"));
  const {
    buildCelebrityRunStats,
    createCelebrityDiscoveryRun,
    finalizeCelebrityDiscoveryRun,
    CELEBRITY_CLASSIFICATION_RUN_TYPE
  } = require(path.join(root, "netlify/functions/lib/celebrity-discovery-run-tracking"));

  const toApply = manifest.actions.filter((a) => String(a.action).startsWith("update"));
  if (!toApply.length) return { applied: false, reason: "no_deterministic_actions" };

  const countsBefore = await captureCounts(ctx.line.id, ctx.halLine?.id);
  const backups = [];
  const runId = `celebrity-classification-apply-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const dbRun = await createCelebrityDiscoveryRun(supabase, {
    cruiseLineId: ctx.line.id,
    runId,
    mode: "classification_repair",
    runType: CELEBRITY_CLASSIFICATION_RUN_TYPE,
    writesEnabled: true
  });

  for (const action of toApply) {
    const rows = await supabase(`discovered_cruises?id=eq.${encodeURIComponent(action.discovered_cruise_id)}&select=*&limit=1`);
    const before = rows?.[0];
    if (!before) continue;
    backups.push({ id: before.id, official_sailing_id: before.official_sailing_id, destination_id: before.destination_id, raw_extract: before.raw_extract, updated_at: before.updated_at });
    const rawExtract = { ...(before.raw_extract || {}), celebrity_product_type: action.proposed_product_type };
    if (action.proposed_product_type === "river_cruise") {
      rawExtract.destination_key = ctx.riverDestSlug;
      rawExtract.river_name = rawExtract.river_name || action.official_source_evidence?.river_name || null;
    }
    const patch = { raw_extract: rawExtract, updated_at: new Date().toISOString() };
    if (action.proposed_destination_id) patch.destination_id = action.proposed_destination_id;
    await supabase(`discovered_cruises?id=eq.${encodeURIComponent(before.id)}`, { method: "PATCH", body: patch });
  }

  fs.writeFileSync(BACKUP_PATH, JSON.stringify({ counts_before: countsBefore, backups, manifest_checksum: manifest.checksum }, null, 2));
  fs.writeFileSync(ROLLBACK_PATH, JSON.stringify({ run_id: runId, backups, manifest_checksum: manifest.checksum, snapshot_checksum: snapshot.checksum }, null, 2));

  await finalizeCelebrityDiscoveryRun(supabase, dbRun.id, {
    status: "completed",
    stats: {
      ...buildCelebrityRunStats({
        runType: CELEBRITY_CLASSIFICATION_RUN_TYPE,
        mode: "classification_repair",
        runId,
        writesEnabled: true,
        proposedWrites: toApply.length,
        updated: toApply.length,
        rollbackManifest: path.basename(ROLLBACK_PATH)
      }),
      product_type_mismatches: 0,
      deterministic_actions: toApply.length
    }
  });

  return { applied: true, updated: toApply.length, counts_before: countsBefore, counts_after: await captureCounts(ctx.line.id, ctx.halLine?.id) };
}

async function main() {
  const args = {
    snapshot: process.argv.includes("--snapshot"),
    compare: process.argv.includes("--compare"),
    manifest: process.argv.includes("--manifest"),
    apply: process.argv.includes("--apply"),
    verify: process.argv.includes("--verify"),
    record: process.argv.includes("--record"),
    all: process.argv.includes("--all")
  };
  if (!Object.values(args).some(Boolean)) {
    console.error("Use --snapshot, --compare, --manifest, --apply, --verify, --record, or --all");
    process.exit(1);
  }

  const sb = createSupabaseRest(root);
  const ctx = await loadCtx(sb);
  let snapshot = args.snapshot || args.all ? await runSnapshot(ctx) : null;
  if (!snapshot && fs.existsSync(SNAPSHOT_PATH)) snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
  if ((args.compare || args.manifest || args.all) && !snapshot) throw new Error("Snapshot required");

  if (args.snapshot || args.all) {
    console.log("Snapshot eligible:", snapshot.eligible_count, "ocean:", snapshot.eligible_ocean, "river:", snapshot.eligible_river);
  }

  let compare = args.compare || args.manifest || args.all ? await runCompare(ctx, sb, snapshot) : null;
  if (!compare && fs.existsSync(COMPARE_PATH)) compare = JSON.parse(fs.readFileSync(COMPARE_PATH, "utf8"));

  if (args.compare || args.all) {
    console.log("Mismatches:", compare.mismatch_counts);
  }

  let manifest = null;
  if (args.manifest || args.all) {
    manifest = buildManifest(compare, snapshot, ctx);
    console.log("Manifest actions:", manifest.deterministic_action_count);
  }

  if (args.apply || args.all) {
    if (!manifest && fs.existsSync(MANIFEST_PATH)) manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    const applyResult = await runApply(ctx, manifest, snapshot);
    console.log("Apply:", JSON.stringify(applyResult, null, 2));
    compare = await runCompare(ctx, sb, snapshot);
  }

  if (args.verify || args.all) {
    console.log("Verify:", JSON.stringify({ official_eligible: compare?.official_eligible, eligible_in_production: compare?.eligible_in_production, out_of_snapshot: compare?.out_of_snapshot, mismatches: compare?.mismatch_counts }, null, 2));
  }

  if ((args.record || args.all) && compare && snapshot && manifest) {
    const record = await recordClassificationRun(ctx, compare, snapshot, manifest);
    console.log("Recorded classification run:", record.run_id);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
