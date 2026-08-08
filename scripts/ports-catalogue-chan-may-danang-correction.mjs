#!/usr/bin/env node
/**
 * Targeted Chan May coordinate + Da Nang alias correction.
 *   node scripts/ports-catalogue-chan-may-danang-correction.mjs --apply
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const APPLY = process.argv.includes("--apply");
const CHAN_MAY_ID = "c22af43b-6716-4c2f-b36f-1a3f8bf109de";
const DA_NANG_ID = "58914173-9c3d-4d30-9ecb-c54ec21e54b5";

/** 16°20′00.4″N, 108°00′49.2″E — Chan May Port JSC / VPA */
const CHAN_MAY_LAT = 16.333444;
const CHAN_MAY_LON = 108.013667;

async function main() {
  const rest = createSupabaseRest(root);
  const beforeCm = (await rest.get(`ports?select=*&id=eq.${CHAN_MAY_ID}&limit=1`))[0];
  const beforeDn = (await rest.get(`ports?select=*&id=eq.${DA_NANG_ID}&limit=1`))[0];

  const chanMayPatch = {
    latitude: CHAN_MAY_LAT,
    longitude: CHAN_MAY_LON,
    aliases: ["Chan May Port"]
  };
  const daNangPatch = { aliases: ["Danang"] };

  if (APPLY) {
    await rest.request(`ports?id=eq.${encodeURIComponent(CHAN_MAY_ID)}`, {
      method: "PATCH",
      body: chanMayPatch,
      prefer: "return=representation"
    });
    await rest.request(`ports?id=eq.${encodeURIComponent(DA_NANG_ID)}`, {
      method: "PATCH",
      body: daNangPatch,
      prefer: "return=representation"
    });
  }

  const report = {
    mode: APPLY ? "apply" : "dry-run",
    coordinate_source:
      "Chan May Port JSC (chanmayport.com.vn) and Vietnam Seaports Association: 16°20′00.4″N, 108°00′49.2″E",
    chan_may: {
      before: {
        latitude: beforeCm?.latitude,
        longitude: beforeCm?.longitude,
        country: beforeCm?.country,
        region: beforeCm?.region,
        aliases: beforeCm?.aliases,
        image_status: beforeCm?.image_status
      },
      after: {
        ...chanMayPatch,
        country: beforeCm?.country,
        region: beforeCm?.region,
        image_status: beforeCm?.image_status
      }
    },
    da_nang: {
      before: { aliases: beforeDn?.aliases },
      after: daNangPatch
    }
  };

  const out = path.join(root, "reports/ports-catalogue-chan-may-danang-correction.json");
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
