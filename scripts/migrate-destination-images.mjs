#!/usr/bin/env node
/**
 * Upload approved Cruise Finder destination heroes into Supabase Storage.
 *
 * Preserves approved creative sources (local PNGs + Wikimedia Commons URLs).
 * Skips upload when the object already exists. Does not invent replacements.
 *
 * Usage:
 *   node scripts/migrate-destination-images.mjs --dry-run
 *   node scripts/migrate-destination-images.mjs --apply
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LOCAL_DIR = path.join(ROOT, "public-tools/cruise-finder/images");
const BUCKET = "destination-images";

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

const APPLY = process.argv.includes("--apply");
const W = "https://upload.wikimedia.org/wikipedia/commons/thumb";
const thumb = (p, file, width = 1280) => `${W}/${p}/${file}/${width}px-${file}`;

/** Canonical slug → approved source (local file or remote URL). */
const SOURCES = [
  { slug: "alaska", object: "alaska-hero.png", local: "alaska-hero.png" },
  { slug: "japan", object: "japan-hero.png", local: "japan-hero.png" },
  {
    slug: "japan",
    object: "japan-cherry-blossoms.jpg",
    remote: thumb("9/94", "Miyagi-Landscape_of_cherry_blossoms_and_Matsushima_Bay-xl.jpg"),
    seasonal: "3,4"
  },
  {
    slug: "japan",
    object: "japan-autumn.jpg",
    remote: thumb("4/4a", "Eikan-do_Zenrin-ji%2C_November_2016_-03.jpg"),
    seasonal: "10,11"
  },
  { slug: "mediterranean", object: "mediterranean-hero.png", local: "mediterranean-hero.png" },
  { slug: "greek-islands", object: "greek-islands-hero.png", local: "greek-islands-hero.png" },
  {
    slug: "norwegian-fjords",
    object: "norwegian-fjords-hero.jpg",
    remote: thumb(
      "7/77",
      "Fiordo_de_Geiranger_desde_Flydalsjuvet%2C_Noruega%2C_2019-09-07%2C_DD_59.jpg"
    )
  },
  { slug: "british-isles", object: "british-isles-hero.png", local: "british-isles-hero.png" },
  { slug: "caribbean", object: "caribbean-hero.png", local: "caribbean-hero.png" },
  {
    slug: "south-pacific",
    object: "south-pacific-hero.jpg",
    remote: thumb("f/f8", "Boraboraluft.jpg")
  },
  {
    slug: "australia-new-zealand",
    object: "australia-new-zealand-hero.png",
    local: "australia-new-zealand-hero.png"
  },
  {
    slug: "antarctica",
    object: "antarctica-hero.jpg",
    remote: thumb(
      "0/03",
      "Chinstrap_penguins_on_a_striated_iceberg%2C_South_Shetland_Islands%2C_Antarctica.jpg"
    )
  },
  {
    slug: "canada-new-england",
    object: "canada-new-england-hero.jpg",
    remote: thumb(
      "4/45",
      "Lighthouse_DSC01066_-_Peggy%27s_Cove_Lighthouse_%287612052968%29.jpg"
    )
  },
  {
    slug: "canada-new-england",
    object: "canada-new-england-autumn.jpg",
    remote: thumb("7/75", "Lake_Willoughby_October_2021_003.jpg"),
    seasonal: "9,10"
  },
  { slug: "hawaii", object: "hawaii-hero.png", local: "hawaii-hero.png" }
];

function publicUrl(base, objectPath) {
  return `${base.replace(/\/$/, "")}/storage/v1/object/public/${BUCKET}/${objectPath}`;
}

async function ensureBucket(env) {
  const listRes = await fetch(`${env.url}/storage/v1/bucket`, {
    headers: { Authorization: `Bearer ${env.key}`, apikey: env.key }
  });
  const buckets = listRes.ok ? await listRes.json() : [];
  const exists = Array.isArray(buckets) && buckets.some((b) => b.name === BUCKET || b.id === BUCKET);
  if (exists) {
    console.log(`Bucket exists: ${BUCKET}`);
    return;
  }
  if (!APPLY) {
    console.log(`[dry-run] would create bucket ${BUCKET}`);
    return;
  }
  const createRes = await fetch(`${env.url}/storage/v1/bucket`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.key}`,
      apikey: env.key,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      id: BUCKET,
      name: BUCKET,
      public: true,
      file_size_limit: 8388608,
      allowed_mime_types: ["image/png", "image/webp", "image/jpeg", "image/jpg"]
    })
  });
  if (!createRes.ok) {
    const text = await createRes.text();
    throw new Error(`Create bucket failed: ${createRes.status} ${text}`);
  }
  console.log(`Created bucket: ${BUCKET}`);
}

async function objectExists(env, objectPath) {
  const res = await fetch(
    `${env.url}/storage/v1/object/info/public/${BUCKET}/${objectPath}`,
    { headers: { Authorization: `Bearer ${env.key}`, apikey: env.key } }
  );
  if (res.ok) return true;
  // Fallback list/head via authenticated object path
  const head = await fetch(`${env.url}/storage/v1/object/${BUCKET}/${objectPath}`, {
    method: "HEAD",
    headers: { Authorization: `Bearer ${env.key}`, apikey: env.key }
  });
  return head.ok;
}

async function downloadRemote(url, attempt = 1) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "101cruise-destination-image-migrate/1.0 (approved archive)",
      Accept: "image/*,*/*;q=0.8"
    }
  });
  if (res.status === 429 && attempt < 5) {
    const wait = attempt * 2500;
    console.log(`  429 for ${url} — retry in ${wait}ms`);
    await new Promise((r) => setTimeout(r, wait));
    return downloadRemote(url, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`Download failed ${res.status} ${url}`);
  }
  const ctype = res.headers.get("content-type") || "";
  const buf = Buffer.from(await res.arrayBuffer());
  if (!ctype.startsWith("image/") && buf[0] !== 0xff && buf[0] !== 0x89) {
    throw new Error(`Not an image response (${ctype}) for ${url}`);
  }
  return { buf, ctype: ctype.startsWith("image/") ? ctype : "image/jpeg" };
}

async function upload(env, objectPath, buf, contentType) {
  if (!APPLY) {
    console.log(`[dry-run] upload ${objectPath} (${buf.length} bytes, ${contentType})`);
    return publicUrl(env.url, objectPath);
  }
  const res = await fetch(`${env.url}/storage/v1/object/${BUCKET}/${objectPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.key}`,
      apikey: env.key,
      "Content-Type": contentType,
      "x-upsert": "false"
    },
    body: buf
  });
  if (res.status === 409 || res.status === 400) {
    // already exists
    const text = await res.text();
    if (/exists|Duplicate|already/i.test(text) || res.status === 409) {
      console.log(`  skip existing ${objectPath}`);
      return publicUrl(env.url, objectPath);
    }
    throw new Error(`Upload failed ${res.status}: ${text}`);
  }
  if (!res.ok) {
    throw new Error(`Upload failed ${res.status}: ${await res.text()}`);
  }
  console.log(`  uploaded ${objectPath}`);
  return publicUrl(env.url, objectPath);
}

async function main() {
  const env = {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY
  };
  if (!env.url || !env.key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  console.log(APPLY ? "APPLY mode" : "DRY-RUN mode");
  await ensureBucket(env);

  const results = [];
  const manual = [];

  for (const src of SOURCES) {
    console.log(`\n${src.slug} → ${src.object}`);
    try {
      if (await objectExists(env, src.object)) {
        console.log("  already in storage");
        results.push({
          ...src,
          status: "exists",
          url: publicUrl(env.url, src.object)
        });
        continue;
      }

      let buf;
      let ctype;
      if (src.local) {
        const filePath = path.join(LOCAL_DIR, src.local);
        if (!fs.existsSync(filePath)) {
          throw new Error(`Missing local file ${filePath}`);
        }
        buf = fs.readFileSync(filePath);
        ctype = src.local.endsWith(".png") ? "image/png" : "image/jpeg";
      } else if (src.remote) {
        const downloaded = await downloadRemote(src.remote);
        buf = downloaded.buf;
        ctype = downloaded.ctype;
        await new Promise((r) => setTimeout(r, 800));
      } else {
        throw new Error("No local or remote source");
      }

      const url = await upload(env, src.object, buf, ctype);
      results.push({ ...src, status: APPLY ? "uploaded" : "dry-run", url });
    } catch (error) {
      console.error(`  ERROR: ${error.message}`);
      manual.push({ slug: src.slug, object: src.object, error: error.message, remote: src.remote || null });
      results.push({ ...src, status: "error", error: error.message });
    }
  }

  console.log("\n=== PUBLIC URL MAP ===");
  for (const row of results.filter((r) => r.url)) {
    console.log(`${row.object}\t${row.url}`);
  }
  if (manual.length) {
    console.log("\n=== NEEDS MANUAL REPLACEMENT ===");
    for (const row of manual) {
      console.log(JSON.stringify(row));
    }
  }
  console.log(
    `\nDone. ok=${results.filter((r) => r.url).length} errors=${manual.length} mode=${APPLY ? "apply" : "dry-run"}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
