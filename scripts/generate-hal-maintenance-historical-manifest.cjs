#!/usr/bin/env node
/**
 * One-off auditable manifest for 60 HAL maintenance inserts on 2026-08-06 UTC.
 *   node scripts/generate-hal-maintenance-historical-manifest.cjs
 *   node scripts/generate-hal-maintenance-historical-manifest.cjs --persist
 */

const path = require("path");
const { createMaintenanceSupabase } = require(path.join(__dirname, "lib/supabase-rest.cjs"));
const {
  persistMaintenanceManifest
} = require(path.join(__dirname, "../netlify/functions/lib/cruise-discovery-maintenance-manifests"));

const BATCH_WINDOWS = [
  { key: "batch_090113_utc", label: "~09:01:13 UTC", from: "2026-08-06T09:01:00Z", to: "2026-08-06T09:02:00Z" },
  { key: "batch_091153_utc", label: "~09:11:53 UTC", from: "2026-08-06T09:11:00Z", to: "2026-08-06T09:12:30Z" },
  { key: "batch_092506_utc", label: "~09:25:06 UTC", from: "2026-08-06T09:25:00Z", to: "2026-08-06T09:26:30Z" }
];

async function main() {
  const persist = process.argv.includes("--persist");
  const root = path.join(__dirname, "..");
  const supabase = createMaintenanceSupabase(root);

  const halLine = (await supabase("ci_cruise_lines?slug=eq.holland-america-line&select=id,name,slug&limit=1"))?.[0];
  if (!halLine) throw new Error("HAL line not found");

  const allRows = await supabase(
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(halLine.id)}&created_at=gte.2026-08-06T08:50:00Z&created_at=lte.2026-08-06T09:30:00Z&select=id,created_at,official_sailing_id,departure_date,return_date,status,ship_id,raw_extract&order=created_at.asc`
  );

  const batches = {};
  const outside = [];

  for (const row of allRows || []) {
    const created = row.created_at;
    const window = BATCH_WINDOWS.find((w) => created >= w.from && created <= w.to);
    if (window) {
      if (!batches[window.key]) batches[window.key] = { ...window, records: [] };
      batches[window.key].records.push(row);
    } else {
      outside.push(row);
    }
  }

  const activeHal = await supabase(
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(halLine.id)}&status=eq.active&select=official_sailing_id,raw_extract&limit=5000`
  );
  const identityCounts = new Map();
  for (const row of activeHal || []) {
    const sid = row.official_sailing_id || row.raw_extract?.hal_product_key;
    if (!sid) continue;
    identityCounts.set(sid, (identityCounts.get(sid) || 0) + 1);
  }

  const manifest = {
    manifest_purpose: "historical_audit_hal_maintenance_inserts_2026_08_06",
    cruise_line_id: halLine.id,
    cruise_line_slug: halLine.slug,
    created_at: new Date().toISOString(),
    total_records: (allRows || []).length,
    batch_count: Object.keys(batches).length,
    records_outside_windows: outside.length,
    batches: Object.values(batches).map((b) => ({
      batch_key: b.key,
      batch_label: b.label,
      window_from: b.from,
      window_to: b.to,
      record_count: b.records.length,
      inserted_record_ids: b.records.map((r) => r.id),
      official_sailing_ids: b.records
        .map((r) => r.official_sailing_id || r.raw_extract?.hal_product_key || null)
        .filter(Boolean),
      records: b.records.map((r) => ({
        discovered_cruise_id: r.id,
        official_sailing_id: r.official_sailing_id || r.raw_extract?.hal_product_key || null,
        departure_date: r.departure_date,
        return_date: r.return_date,
        status: r.status,
        created_at: r.created_at
      }))
    })),
    validation: {
      all_have_official_identity: (allRows || []).every(
        (r) => r.official_sailing_id || r.raw_extract?.hal_product_key
      ),
      all_active: (allRows || []).every((r) => r.status === "active"),
      no_duplicate_active_identities_among_batches: (() => {
        const seen = new Set();
        for (const row of allRows || []) {
          const sid = row.official_sailing_id || row.raw_extract?.hal_product_key;
          if (!sid) return false;
          if (seen.has(sid)) return false;
          seen.add(sid);
        }
        return true;
      })(),
      no_conflicts_with_other_active_hal: (allRows || []).every((row) => {
        const sid = row.official_sailing_id || row.raw_extract?.hal_product_key;
        if (!sid) return false;
        return (identityCounts.get(sid) || 0) <= 1;
      })
    }
  };

  console.log(JSON.stringify(manifest, null, 2));

  if (outside.length) {
    console.error(`Warning: ${outside.length} records outside expected batch windows`);
  }
  for (const w of BATCH_WINDOWS) {
    const count = batches[w.key]?.records?.length || 0;
    if (count !== 20) console.error(`Expected 20 in ${w.label}, got ${count}`);
  }

  if (persist) {
    const row = await persistMaintenanceManifest(supabase, {
      manifestType: "historical_audit",
      manifest
    });
    console.error(`Persisted historical_audit manifest id=${row?.id || "unknown"}`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
