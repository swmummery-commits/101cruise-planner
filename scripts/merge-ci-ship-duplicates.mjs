/**
 * Merge CI ship duplicates according to ci_cruise_lines.ship_naming_style.
 *
 * Usage:
 *   node scripts/merge-ci-ship-duplicates.mjs           # dry-run
 *   node scripts/merge-ci-ship-duplicates.mjs --apply   # write changes
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env or .env
 */

import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const APPLY = process.argv.includes("--apply");

function loadEnv() {
  const envPath = path.join(root, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

loadEnv();

const URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
if (!URL || !KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

async function supabase(method, pathAndQuery, body) {
  const res = await fetch(`${URL}/rest/v1/${pathAndQuery}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      Prefer: method === "GET" ? "count=exact" : "return=representation"
    },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${pathAndQuery} -> ${res.status} ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : [];
}

function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function fold(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function brandKey(lineName) {
  return fold(lineName)
    .replace(/\b(cruises?|line|international|journeys|yacht collection|waterways|luxury|tours|expeditions?|ocean)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHonorific(folded) {
  return folded.replace(/^(ms|mv|m s|ss|s s|m\/s)\s+/, "").trim();
}

function coreKey(name, lineName, style) {
  const n = fold(name);
  const brand = brandKey(lineName);
  if (style === "short_vessel") {
    if (brand && n.startsWith(`${brand} `)) return n.slice(brand.length + 1).trim();
    const bw = brand.split(" ")[0];
    if (bw && n.startsWith(`${bw} `)) return n.slice(bw.length + 1).trim();
    return n;
  }
  if (style === "honorific_vessel") return stripHonorific(n);
  if (style === "branded_vessel") return n.replace(/[\-\']/g, " ").replace(/\s+/g, " ").trim();
  return n;
}

function accentBonus(raw) {
  // Prefer official accented spellings (Vesterålen, Boréal, Lapérouse).
  return /[àáâäãåæçèéêëìíîïñòóôöõøùúûüýÿœ]/iu.test(String(raw || "")) ? 3 : 0;
}

function preferredNameScore(name, lineName, style) {
  const raw = String(name || "");
  const n = fold(raw);
  const brand = brandKey(lineName);
  if (style === "short_vessel") {
    // Prefer names that do not start with the line brand.
    if (brand && n.startsWith(`${brand} `)) return 0 + accentBonus(raw);
    const bw = brand.split(" ")[0];
    if (bw && n.startsWith(`${bw} `)) return 0 + accentBonus(raw);
    return 10 + accentBonus(raw);
  }
  if (style === "honorific_vessel") {
    if (/^S\.S\./i.test(raw)) return 12 + accentBonus(raw);
    if (/^MS\s/i.test(raw)) return 11 + accentBonus(raw);
    if (/^ms\s/i.test(raw)) return 10 + accentBonus(raw);
    if (/^SS\s/i.test(raw)) return 4 + accentBonus(raw);
    if (/^m\/s\s/i.test(raw)) return 3 + accentBonus(raw);
    return 1 + accentBonus(raw);
  }
  if (style === "branded_vessel") {
    let score = 5 + accentBonus(raw);
    if (raw.includes("-")) score += 2;
    if (/^Le L'/i.test(raw)) score -= 5; // prefer L'Austral over Le L'Austral
    return score;
  }
  return 0;
}

function richness(ship) {
  let s = 0;
  if (ship.hero_image_url) s += 8;
  if (ship.deck_plan_status === "approved") s += 6;
  else if (ship.deck_plan_status === "needs_review") s += 2;
  if (ship.deck_plan_url || ship.deck_plan_pdf_url || ship.deck_plan_page_url) s += 3;
  if (ship.stateroom_count) s += Math.min(4, Number(ship.stateroom_count) > 0 ? 2 : 0);
  if (ship.stateroom_breakdown) s += 2;
  if (ship.passenger_capacity) s += 1;
  if (ship.active !== false) s += 1;
  return s;
}

function desiredShortName(name, lineName) {
  const brand = brandKey(lineName);
  const parts = String(name || "").trim().split(/\s+/);
  const foldedParts = parts.map((p) => fold(p));
  const brandParts = brand.split(" ").filter(Boolean);
  if (!brandParts.length) return String(name || "").trim();
  // Strip leading brand tokens from display name.
  let i = 0;
  while (i < foldedParts.length && i < brandParts.length && foldedParts[i] === brandParts[i]) i += 1;
  if (i === 0 && foldedParts[0] === brandParts[0]) i = 1;
  const rest = parts.slice(i).join(" ").trim();
  return rest || String(name || "").trim();
}

function desiredHonorificName(name, lineName) {
  const raw = String(name || "").trim();
  if (/uniworld/i.test(lineName)) {
    if (/^SS\s/i.test(raw)) return raw.replace(/^SS\s+/i, "S.S. ");
    return raw;
  }
  if (/paul gauguin/i.test(lineName)) {
    if (/^(m\/s|ms)\s+/i.test(raw) && !/^MS\s/.test(raw)) return `MS ${raw.replace(/^(m\/s|ms)\s+/i, "")}`;
    if (!/^(MS|m\/s|ms)\s/i.test(raw)) return `MS ${raw}`;
    return raw.replace(/^ms\s+/i, "MS ").replace(/^m\/s\s+/i, "MS ");
  }
  if (/holland america/i.test(lineName)) {
    if (/^ms\s/i.test(raw)) return raw;
    if (/^MS\s/.test(raw)) return raw.replace(/^MS\s/, "ms ");
    return `ms ${raw}`;
  }
  if (/hurtigruten/i.test(lineName)) {
    if (/^MS\s/.test(raw)) return raw;
    return `MS ${raw.replace(/^(ms|m\/s)\s+/i, "")}`;
  }
  return raw;
}

function desiredBrandedName(name, lineName) {
  // Prefer accented/hyphenated official forms when choosing keeper; solo rename is rare.
  return String(name || "").trim();
}

const FILL_FIELDS = [
  "hero_image_url",
  "deck_plan_url",
  "deck_plan_page_url",
  "deck_plan_pdf_url",
  "deck_plan_status",
  "deck_plan_source_type",
  "deck_plan_source_domain",
  "deck_plan_version",
  "deck_plan_effective_date",
  "deck_plan_notes",
  "stateroom_count",
  "stateroom_breakdown",
  "cabin_type_summary",
  "passenger_capacity",
  "crew_count",
  "deck_count",
  "gross_tonnage",
  "length_metres",
  "year_built",
  "year_refurbished",
  "ship_class",
  "facilities",
  "official_ship_url",
  "image_gallery"
];

async function listAll(table, select) {
  const out = [];
  let offset = 0;
  while (true) {
    const batch = await supabase(
      "GET",
      `${table}?select=${select}&order=name.asc&limit=200&offset=${offset}`
    );
    if (!Array.isArray(batch) || !batch.length) break;
    out.push(...batch);
    if (batch.length < 200) break;
    offset += 200;
  }
  return out;
}

async function reassignShipId(table, column, fromId, toId) {
  const rows = await supabase("GET", `${table}?${column}=eq.${fromId}&select=id`);
  if (!rows.length) return 0;
  if (!APPLY) return rows.length;
  await supabase("PATCH", `${table}?${column}=eq.${fromId}`, { [column]: toId });
  return rows.length;
}

async function ensureAlias(lineId, shipId, aliasName) {
  const normalised = fold(aliasName);
  if (!normalised) return false;
  const existing = await supabase(
    "GET",
    `cruise_ship_aliases?cruise_line_id=eq.${lineId}&normalised_alias=eq.${encodeURIComponent(normalised)}&select=id,ship_id,active&limit=1`
  );
  if (existing.length) {
    if (!APPLY) return true;
    if (existing[0].ship_id !== shipId || existing[0].active === false) {
      await supabase("PATCH", `cruise_ship_aliases?id=eq.${existing[0].id}`, {
        ship_id: shipId,
        raw_alias: aliasName,
        active: true,
        source: "merge-ci-ship-duplicates"
      });
    }
    return true;
  }
  if (!APPLY) return true;
  await supabase("POST", "cruise_ship_aliases", {
    ship_id: shipId,
    cruise_line_id: lineId,
    raw_alias: aliasName,
    normalised_alias: normalised,
    source: "merge-ci-ship-duplicates",
    active: true
  });
  return true;
}

async function uniqueSlug(base, excludeId) {
  let slug = slugify(base) || "ship";
  for (let n = 0; n < 50; n += 1) {
    const candidate = n === 0 ? slug : `${slug}-${n + 1}`;
    const hits = await supabase("GET", `ci_cruise_ships?slug=eq.${encodeURIComponent(candidate)}&select=id&limit=1`);
    if (!hits.length || hits[0].id === excludeId) return candidate;
  }
  return `${slug}-${Date.now()}`;
}

async function mergePair(keeper, loser, line, report) {
  const lineId = line.id;
  // Reassign FKs
  const fkMoves = [
    ["featured_cruises", "cruise_ship_id"],
    ["media_library", "ship_id"],
    ["discovered_cruises", "ship_id"],
    ["deck_plan_history", "ship_id"],
    ["cruise_ship_aliases", "ship_id"]
  ];
  for (const [table, col] of fkMoves) {
    try {
      const n = await reassignShipId(table, col, loser.id, keeper.id);
      if (n) report.fkMoves.push({ table, col, from: loser.name, to: keeper.name, count: n });
    } catch (e) {
      // table may not exist / column missing
      report.warnings.push(`${table}.${col}: ${e.message.slice(0, 120)}`);
    }
  }
  for (const col of ["match_ship_id", "related_ship_id", "resulting_ship_id"]) {
    try {
      const n = await reassignShipId("cruise_line_audit_findings", col, loser.id, keeper.id);
      if (n) report.fkMoves.push({ table: "cruise_line_audit_findings", col, count: n });
    } catch (e) {
      report.warnings.push(`audit.${col}: ${e.message.slice(0, 80)}`);
    }
  }

  // Fill blank keeper fields from loser
  const patch = {};
  for (const field of FILL_FIELDS) {
    const kv = keeper[field];
    const lv = loser[field];
    const empty =
      kv == null ||
      kv === "" ||
      (typeof kv === "object" && !Array.isArray(kv) && !Object.keys(kv || {}).length);
    if (empty && lv != null && lv !== "") patch[field] = lv;
  }

  await ensureAlias(lineId, keeper.id, loser.name);
  if (loser.name !== keeper.name) {
    // also alias any intermediate forms later via rename path
  }

  if (APPLY) {
    if (Object.keys(patch).length) {
      const updated = await supabase("PATCH", `ci_cruise_ships?id=eq.${keeper.id}`, patch);
      Object.assign(keeper, updated[0] || patch);
    }
    await supabase("PATCH", `ci_cruise_ships?id=eq.${loser.id}`, {
      active: false,
      needs_review: true,
      review_notes: `Merged into ${keeper.name} (${keeper.id}) by merge-ci-ship-duplicates`,
      status: loser.status === "under_construction" ? loser.status : "retired"
    });
  }

  report.merges.push({
    line: line.name,
    style: line.ship_naming_style,
    keeper: keeper.name,
    loser: loser.name,
    filled: Object.keys(patch)
  });
}

async function renameShip(ship, newName, line, report) {
  if (ship.name === newName) return;
  // conflict check
  const conflict = await supabase(
    "GET",
    `ci_cruise_ships?cruise_line_id=eq.${line.id}&name=eq.${encodeURIComponent(newName)}&select=id,name,active&limit=1`
  );
  if (conflict.length && conflict[0].id !== ship.id) {
    if (conflict[0].active !== false) {
      // merge into conflict instead
      await mergePair(conflict[0], ship, line, report);
      return;
    }
  }
  const oldName = ship.name;
  const slug = await uniqueSlug(newName, ship.id);
  if (APPLY) {
    await supabase("PATCH", `ci_cruise_ships?id=eq.${ship.id}`, { name: newName, slug });
  }
  await ensureAlias(line.id, ship.id, oldName);
  ship.name = newName;
  ship.slug = slug;
  report.renames.push({ line: line.name, from: oldName, to: newName });
}

async function main() {
  const report = { merges: [], renames: [], fkMoves: [], warnings: [], mode: APPLY ? "APPLY" : "DRY_RUN" };
  const lines = await supabase("GET", "ci_cruise_lines?select=id,name,ship_naming_style&order=name.asc");
  const ships = await listAll(
    "ci_cruise_ships",
    "id,name,slug,cruise_line_id,active,status,hero_image_url,stateroom_count,stateroom_breakdown,cabin_type_summary,passenger_capacity,crew_count,deck_count,gross_tonnage,length_metres,year_built,year_refurbished,ship_class,facilities,official_ship_url,image_gallery,deck_plan_url,deck_plan_page_url,deck_plan_pdf_url,deck_plan_status,deck_plan_source_type,deck_plan_source_domain,deck_plan_version,deck_plan_effective_date,deck_plan_notes,needs_review,review_notes"
  );
  const byLine = new Map();
  for (const s of ships) {
    if (!byLine.has(s.cruise_line_id)) byLine.set(s.cruise_line_id, []);
    byLine.get(s.cruise_line_id).push(s);
  }

  for (const line of lines) {
    const style = line.ship_naming_style || "undecided";
    if (style === "undecided") continue;
    const group = (byLine.get(line.id) || []).filter((s) => s.active !== false);
    const buckets = new Map();
    for (const ship of group) {
      const key = coreKey(ship.name, line.name, style);
      if (!key) continue;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(ship);
    }

    for (const [, members] of buckets) {
      if (members.length < 2) continue;
      members.sort((a, b) => {
        const ps =
          preferredNameScore(b.name, line.name, style) - preferredNameScore(a.name, line.name, style);
        if (ps) return ps;
        return richness(b) - richness(a);
      });
      const keeper = members[0];
      for (const loser of members.slice(1)) {
        await mergePair(keeper, loser, line, report);
      }
      // After merges, normalize keeper display name if needed
      let desired = keeper.name;
      if (style === "short_vessel") desired = desiredShortName(keeper.name, line.name);
      else if (style === "honorific_vessel") desired = desiredHonorificName(keeper.name, line.name);
      else if (style === "branded_vessel") desired = desiredBrandedName(keeper.name, line.name);
      if (desired && desired !== keeper.name) {
        await renameShip(keeper, desired, line, report);
      }
    }

    // Solo renames toward style
    const remaining = (byLine.get(line.id) || []).filter((s) => s.active !== false);
    // refresh names after merges — use current in-memory where updated
    for (const ship of remaining) {
      if (report.merges.some((m) => m.loser === ship.name && m.line === line.name)) continue;
      let desired = ship.name;
      if (style === "short_vessel") desired = desiredShortName(ship.name, line.name);
      else if (style === "honorific_vessel") desired = desiredHonorificName(ship.name, line.name);
      if (desired && desired !== ship.name) {
        // Don't rename branded_vessel solos (already official)
        if (style === "branded_vessel") continue;
        // Avoid silly short results
        if (style === "short_vessel" && desired.length <= 2) continue;
        await renameShip(ship, desired, line, report);
      }
    }
  }

  console.log(JSON.stringify(report, null, 2));
  console.log(
    `\n${report.mode}: ${report.merges.length} merges, ${report.renames.length} renames, ${report.fkMoves.length} fk move groups`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
