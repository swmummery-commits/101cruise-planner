#!/usr/bin/env node
/**
 * Build Steve's local hero-selection review pack (no uploads / no DB writes).
 *
 *   node scripts/build-hero-selection-review.mjs
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const AUDIT_DIR = path.join(ROOT, "tmp", "ship-image-audit-external");
const OUT_DIR = path.join(AUDIT_DIR, "hero-selection-review");
const THUMB_DIR = path.join(OUT_DIR, "thumbnails");
const MAX_LONG_EDGE = 1200;
const MAX_CANDIDATES_PER_SHIP = 12;

const STEVE_SHIP_IDS_ORDER = null; // filled from plan

const IDENTITY_WARNINGS = {
  "Scenic Eclipse II":
    "Candidate set may include images branded Scenic Eclipse (not Eclipse II). Confirm hull/funnel identity before approving.",
  Odyssey:
    "Large Seabourn Odyssey photo library — confirm exterior shows Odyssey specifically, not another Seabourn vessel.",
  "Crystal Symphony":
    "Large Crystal Symphony library — confirm vessel identity and avoid interiors/lifestyle shots."
};

const GLOBAL_EXCLUSION_NOTES = [
  "Brilliant Lady / Valiant Lady naming conflict remains excluded from this review (not among the 29).",
  "Celebrity Apex Instagram dump remains excluded.",
  "Star of the Seas CGI remains excluded.",
  "Majestic Princess lido-deck image remains excluded.",
  "Silver Dawn generic/uncertain image remains excluded."
];

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function writeText(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

function softTokens(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !["cruise", "cruises", "line", "the", "of"].includes(t));
}

function filenameIdentityRisk(shipName, filename, absolutePath) {
  const blob = `${filename} ${absolutePath}`.toLowerCase();
  const warnings = [];
  if (/watermark|shutterstock|getty|istock|alamy|screenshot|screen.?shot/i.test(blob)) {
    warnings.push("filename_suggests_watermark_or_screenshot");
  }
  if (/\b(cabin|stateroom|interior|restaurant|spa|deck plan|lido-deck)\b/i.test(blob)) {
    warnings.push("filename_suggests_interior_or_deck");
  }
  if (/\bcgi\b|\brender\b/i.test(blob)) {
    warnings.push("filename_suggests_cgi_or_render");
  }
  if (shipName === "Scenic Eclipse II") {
    const nameOnly = String(filename || "").toLowerCase();
    const clearlyIi = /eclipse[\s_-]*ii|eclipse[\s_-]*2|eclipseii/i.test(nameOnly);
    const mentionsEclipse =
      /scenic[\s_-]*eclipse|scenic-eclipse|heli-hero|sceniceclipse/i.test(nameOnly) ||
      /eclipse/i.test(nameOnly);
    if (mentionsEclipse && !clearlyIi) {
      warnings.push("may_be_branded_scenic_eclipse_not_ii");
    }
  }
  if (/valiant/i.test(blob) && /resilient|brilliant/i.test(shipName)) {
    warnings.push("filename_mentions_different_virgin_ship");
  }
  // Cross-ship name tokens in filename that conflict with this ship
  const tokens = softTokens(shipName);
  const primary = tokens[tokens.length - 1] || tokens[0];
  if (primary && !blob.includes(primary) && tokens.length) {
    // Not necessarily wrong — many files omit ship name
  }
  return warnings;
}

function isCredibleCandidate(img) {
  if (!img) return false;
  if (img.opens_successfully === false) return false;
  const qc = img.quality_class || "";
  if (
    [
      "corrupt_or_unreadable",
      "unsuitable",
      "placeholder_or_stock_placeholder",
      "duplicate_or_near_duplicate"
    ].includes(qc)
  ) {
    return false;
  }
  // Prefer excellent; allow strong secondary only if marked suitable exterior-ish
  if (qc === "excellent_hero_candidate") return true;
  if (qc === "suitable_secondary_gallery" && (img.score || 0) >= 55) return true;
  // From hero-candidates.json rows may lack quality_class but have suitable/score
  if (img.quality_class == null && img.suitable === true && (img.score || 0) >= 55) return true;
  if (img.quality_class == null && img.quality_class === undefined && (img.score || 0) >= 59) {
    return true;
  }
  return false;
}

function makeThumbId(shipId, contentHash, filename) {
  const hash = (contentHash || crypto.createHash("sha1").update(filename).digest("hex")).slice(0, 12);
  const safe = String(filename || "image")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .slice(0, 60);
  return `${String(shipId).slice(0, 8)}-${hash}-${safe}.jpg`;
}

function generateThumbnail(sourcePath, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  // sips resizes in place copy: create via sips --resampleHeightWidthMax
  const tmp = `${destPath}.tmp.jpg`;
  const copy = spawnSync("cp", [sourcePath, tmp], { encoding: "utf8" });
  if (copy.status !== 0) {
    throw new Error(`cp failed: ${copy.stderr || copy.error}`);
  }
  const res = spawnSync(
    "sips",
    ["--resampleHeightWidthMax", String(MAX_LONG_EDGE), "-s", "format", "jpeg", tmp, "--out", destPath],
    { encoding: "utf8" }
  );
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  if (res.status !== 0 || !fs.existsSync(destPath)) {
    throw new Error(`sips failed for ${sourcePath}: ${res.stderr || res.stdout || res.error}`);
  }
}

function recommendCandidate(shipName, candidates, shipIdentityWarnings = []) {
  // Prefer no identity warning, highest score, landscape, exterior keywords
  const scored = candidates.map((c) => {
    let r = Number(c.score) || 0;
    if ((c.identity_warnings || []).length) r -= 40;
    if (/exterior|ship|at.?sea|open.?water|hero/i.test(c.filename)) r += 8;
    if (shipName === "Scenic Eclipse II" && /eclipse[\s_-]*ii|eclipseii/i.test(c.filename)) {
      r += 20;
    }
    if (c.width >= c.height) r += 5;
    const longSide = Math.max(c.width || 0, c.height || 0);
    if (longSide >= 1920) r += 4;
    return { c, r };
  });
  scored.sort((a, b) => b.r - a.r);
  const safe = scored.find((s) => !(s.c.identity_warnings || []).length);
  if (!safe) {
    return {
      candidate_id: null,
      note: "No automatic recommendation — all remaining candidates have identity doubts. Steve must choose or mark investigate."
    };
  }
  if (shipName === "Scenic Eclipse II" || (shipIdentityWarnings || []).length) {
    // Still recommend only a safe candidate; keep note cautious.
    return {
      candidate_id: safe.c.candidate_id,
      note:
        shipName === "Scenic Eclipse II"
          ? "Tentative recommendation only if this file clearly shows Eclipse II — verify hull marking before approving."
          : "Recommended pending Steve’s visual identity confirmation (ship-level warning present)."
    };
  }
  return {
    candidate_id: safe.c.candidate_id,
    note: "Recommended for identity, exterior framing, resolution and crop suitability (not file size alone)."
  };
}

function buildHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Steve — Ship Hero Selection Review</title>
  <style>
    :root {
      --ink: #142033;
      --muted: #5b677a;
      --line: #d7dde8;
      --bg: #f3f6fb;
      --card: #ffffff;
      --accent: #0b6e99;
      --warn: #9a5b00;
      --danger: #8b1e1e;
      --ok: #176b3a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Avenir Next", "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(1200px 600px at 10% -10%, #dceaf7 0%, transparent 55%),
        radial-gradient(900px 500px at 100% 0%, #e8f0e8 0%, transparent 50%),
        var(--bg);
    }
    header {
      position: sticky; top: 0; z-index: 20;
      backdrop-filter: blur(10px);
      background: rgba(243,246,251,0.92);
      border-bottom: 1px solid var(--line);
      padding: 14px 20px;
      display: flex; gap: 16px; flex-wrap: wrap; align-items: center; justify-content: space-between;
    }
    h1 { font-size: 1.15rem; margin: 0; letter-spacing: 0.01em; }
    .meta { color: var(--muted); font-size: 0.92rem; }
    button, .btn {
      appearance: none; border: 1px solid var(--line); background: #fff;
      border-radius: 10px; padding: 10px 14px; font: inherit; cursor: pointer;
    }
    button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    main { max-width: 1180px; margin: 0 auto; padding: 18px 16px 80px; }
    .ship {
      background: var(--card); border: 1px solid var(--line); border-radius: 18px;
      padding: 18px; margin: 0 0 18px; box-shadow: 0 10px 30px rgba(20,32,51,0.04);
    }
    .ship h2 { margin: 0 0 4px; font-size: 1.25rem; }
    .ship .line { color: var(--muted); margin-bottom: 10px; }
    .warn-box {
      background: #fff7e8; border: 1px solid #f0d7a4; color: var(--warn);
      border-radius: 12px; padding: 10px 12px; margin: 8px 0 14px; font-size: 0.92rem;
    }
    .grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px;
    }
    .card {
      border: 2px solid var(--line); border-radius: 14px; overflow: hidden; background: #fff;
      display: flex; flex-direction: column;
    }
    .card.recommended { border-color: #7eb6d4; box-shadow: 0 0 0 3px rgba(11,110,153,0.12); }
    .card.selected { border-color: var(--ok); box-shadow: 0 0 0 3px rgba(23,107,58,0.15); }
    .card img {
      width: 100%; aspect-ratio: 16/10; object-fit: cover; background: #e9eef5; display: block;
    }
    .card .body { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 6px; flex: 1; }
    .card .fname { font-size: 0.86rem; word-break: break-all; }
    .card .stats { color: var(--muted); font-size: 0.82rem; }
    .badge {
      display: inline-block; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em;
      padding: 3px 7px; border-radius: 999px; background: #e8f3fa; color: var(--accent);
    }
    .badge.warn { background: #fff1d6; color: var(--warn); }
    .badge.danger { background: #f8e3e3; color: var(--danger); }
    .path { font-size: 0.75rem; color: var(--muted); word-break: break-all; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    .actions label {
      display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line);
      border-radius: 999px; padding: 7px 10px; font-size: 0.86rem; cursor: pointer; background: #fafbfd;
    }
    .actions input { accent-color: var(--accent); }
    .ship-decision {
      margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line);
      display: grid; gap: 10px;
    }
    .decision-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .decision-row label {
      display: inline-flex; gap: 6px; align-items: center; padding: 8px 12px;
      border: 1px solid var(--line); border-radius: 10px; background: #f8fafc; cursor: pointer;
    }
    textarea {
      width: 100%; min-height: 64px; border-radius: 10px; border: 1px solid var(--line);
      padding: 10px; font: inherit; resize: vertical;
    }
    .empty { color: var(--muted); font-style: italic; padding: 8px 0; }
    .progress { font-variant-numeric: tabular-nums; }
    footer { color: var(--muted); font-size: 0.85rem; padding: 8px 4px 24px; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Ship hero selection — Steve review</h1>
      <div class="meta progress" id="progress">Loading…</div>
    </div>
    <div style="display:flex; gap:8px; flex-wrap:wrap;">
      <button type="button" id="btn-save-local">Save progress locally</button>
      <button type="button" class="primary" id="btn-export">Export selections</button>
    </div>
  </header>
  <main id="app"></main>
  <footer>
    Local review only. No uploads. Originals remain on the external drive. Export
    <code>steve-hero-selections.json</code> into <code>tmp/ship-image-audit-external/</code>.
  </footer>
  <script>
    const STORAGE_KEY = "steve-hero-selection-review-v1";

    async function loadData() {
      const res = await fetch("./review-data.json");
      if (!res.ok) throw new Error("Could not load review-data.json");
      return res.json();
    }

    function loadState() {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); }
      catch { return {}; }
    }
    function saveState(state) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }

    function ensureShipState(state, ship) {
      if (!state[ship.ship_id]) {
        state[ship.ship_id] = {
          decision: "",
          selected_candidate_id: ship.recommendation?.candidate_id || "",
          note: "",
          identity_warning_acknowledged: false
        };
      }
      return state[ship.ship_id];
    }

    function countDone(data, state) {
      let n = 0;
      for (const ship of data.ships) {
        const s = state[ship.ship_id];
        if (!s || !s.decision) continue;
        if (s.decision === "approved" && !s.selected_candidate_id) continue;
        if ((ship.identity_warnings || []).length && s.decision === "approved" && !s.identity_warning_acknowledged) continue;
        n += 1;
      }
      return n;
    }

    function render(data, state) {
      const app = document.getElementById("app");
      const done = countDone(data, state);
      document.getElementById("progress").textContent =
        done + " of " + data.ships.length + " ships decided · " + data.candidate_count + " candidates";

      app.innerHTML = data.global_exclusion_notes.map(n =>
        '<div class="warn-box">' + escapeHtml(n) + "</div>"
      ).join("") + data.ships.map(ship => renderShip(ship, ensureShipState(state, ship))).join("");

      app.querySelectorAll("[data-action]").forEach(el => {
        el.addEventListener("change", (ev) => {
          const shipId = el.getAttribute("data-ship");
          const action = el.getAttribute("data-action");
          const st = state[shipId] || (state[shipId] = {});
          if (action === "decision") {
            st.decision = el.value;
            if (st.decision !== "approved") st.selected_candidate_id = "";
          } else if (action === "candidate") {
            st.selected_candidate_id = el.value;
            st.decision = "approved";
          } else if (action === "ack") {
            st.identity_warning_acknowledged = el.checked;
          } else if (action === "note") {
            st.note = el.value;
          }
          saveState(state);
          render(data, state);
        });
      });
    }

    function renderShip(ship, st) {
      const warnings = (ship.identity_warnings || []).concat(ship.notes || []);
      const warnHtml = warnings.length
        ? '<div class="warn-box"><strong>Identity / quality warning</strong><br>' +
          warnings.map(escapeHtml).join("<br>") + "</div>"
        : "";
      const rec = ship.recommendation;
      const recNote = rec?.note
        ? '<div class="meta" style="margin-bottom:10px">Cursor recommendation: ' + escapeHtml(rec.note) + "</div>"
        : "";

      let cards;
      if (!ship.candidates.length) {
        cards = '<p class="empty">No credible excellent exterior candidates remaining after filters. Choose “No suitable image” or “Needs further investigation”.</p>';
      } else {
        cards = '<div class="grid">' + ship.candidates.map(c => {
          const selected = st.decision === "approved" && st.selected_candidate_id === c.candidate_id;
          const recommended = rec?.candidate_id === c.candidate_id;
          const badges = [];
          if (recommended) badges.push('<span class="badge">Recommended</span>');
          (c.identity_warnings || []).forEach(w => badges.push('<span class="badge danger">' + escapeHtml(w) + "</span>"));
          if (c.quality_class) badges.push('<span class="badge">' + escapeHtml(c.quality_class) + "</span>");
          return (
            '<article class="card' + (selected ? " selected" : "") + (recommended ? " recommended" : "") + '">' +
              '<img src="' + escapeAttr(c.thumbnail) + '" alt="' + escapeAttr(c.filename) + '" loading="lazy" />' +
              '<div class="body">' +
                '<div>' + badges.join(" ") + "</div>" +
                '<div class="fname">' + escapeHtml(c.filename) + "</div>" +
                '<div class="stats">' + escapeHtml(c.dimensions) + " · " + escapeHtml(c.file_size_label) +
                  " · score " + escapeHtml(String(c.score ?? "—")) + "</div>" +
                '<div class="path">Source: ' + escapeHtml(c.source_pathname) + "</div>" +
                '<div class="actions">' +
                  '<label><input type="radio" name="cand-' + escapeAttr(ship.ship_id) + '" data-action="candidate" data-ship="' +
                    escapeAttr(ship.ship_id) + '" value="' + escapeAttr(c.candidate_id) + '"' +
                    (selected ? " checked" : "") + '> Select as hero</label>' +
                "</div>" +
              "</div>" +
            "</article>"
          );
        }).join("") + "</div>";
      }

      const ack = (ship.identity_warnings || []).length
        ? '<label><input type="checkbox" data-action="ack" data-ship="' + escapeAttr(ship.ship_id) + '"' +
          (st.identity_warning_acknowledged ? " checked" : "") +
          '> I acknowledge the identity warning before approving</label>'
        : "";

      return (
        '<section class="ship" id="ship-' + escapeAttr(ship.ship_id) + '">' +
          "<h2>" + escapeHtml(ship.ship_name) + "</h2>" +
          '<div class="line">' + escapeHtml(ship.cruise_line_name) + "</div>" +
          warnHtml + recNote + cards +
          '<div class="ship-decision">' +
            '<div class="decision-row">' +
              '<label><input type="radio" name="dec-' + escapeAttr(ship.ship_id) + '" data-action="decision" data-ship="' +
                escapeAttr(ship.ship_id) + '" value="approved"' + (st.decision === "approved" ? " checked" : "") +
                "> Approved (image selected above)</label>" +
              '<label><input type="radio" name="dec-' + escapeAttr(ship.ship_id) + '" data-action="decision" data-ship="' +
                escapeAttr(ship.ship_id) + '" value="no_suitable_image"' + (st.decision === "no_suitable_image" ? " checked" : "") +
                "> No suitable image</label>" +
              '<label><input type="radio" name="dec-' + escapeAttr(ship.ship_id) + '" data-action="decision" data-ship="' +
                escapeAttr(ship.ship_id) + '" value="investigate"' + (st.decision === "investigate" ? " checked" : "") +
                "> Needs further investigation</label>" +
            "</div>" +
            ack +
            '<textarea data-action="note" data-ship="' + escapeAttr(ship.ship_id) +
              '" placeholder="Optional note">' + escapeHtml(st.note || "") + "</textarea>" +
          "</div>" +
        "</section>"
      );
    }

    function escapeHtml(s) {
      return String(s ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      })[ch]);
    }
    function escapeAttr(s) { return escapeHtml(s); }

    function exportSelections(data, state) {
      const ships = data.ships.map((ship) => {
        const st = ensureShipState(state, ship);
        const decision = st.decision || "investigate";
        let selected = null;
        if (decision === "approved" && st.selected_candidate_id) {
          selected = ship.candidates.find((c) => c.candidate_id === st.selected_candidate_id) || null;
        }
        return {
          ship_id: ship.ship_id,
          ship_name: ship.ship_name,
          cruise_line_id: ship.cruise_line_id,
          cruise_line: ship.cruise_line_name,
          decision,
          selected_source_pathname: selected?.source_pathname || null,
          selected_filename: selected?.filename || null,
          dimensions: selected?.dimensions || null,
          width: selected?.width ?? null,
          height: selected?.height ?? null,
          file_size_bytes: selected?.file_size_bytes ?? null,
          content_hash: selected?.content_hash || null,
          candidate_id: selected?.candidate_id || null,
          note: st.note || "",
          identity_warnings: ship.identity_warnings || [],
          identity_warning_acknowledgement:
            (ship.identity_warnings || []).length
              ? Boolean(st.identity_warning_acknowledged)
              : null,
          cursor_recommended_candidate_id: ship.recommendation?.candidate_id || null
        };
      });

      const missing = ships.filter((s) => !s.decision);
      if (missing.length) {
        alert("Please decide all ships before export (" + missing.length + " remaining).");
        return;
      }
      const incomplete = ships.filter(
        (s) =>
          s.decision === "approved" &&
          !s.selected_source_pathname
      );
      if (incomplete.length) {
        alert("Approved ships must have a selected image (" + incomplete.length + ").");
        return;
      }
      const unacked = ships.filter(
        (s) =>
          s.decision === "approved" &&
          (s.identity_warnings || []).length &&
          !s.identity_warning_acknowledgement
      );
      if (unacked.length) {
        alert("Acknowledge identity warnings for approved ships (" + unacked.length + ").");
        return;
      }

      const payload = {
        exported_at: new Date().toISOString(),
        review_pack: "hero-selection-review",
        ship_count: ships.length,
        ships
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "steve-hero-selections.json";
      a.click();
      URL.revokeObjectURL(a.href);
    }

    (async function main() {
      const data = await loadData();
      const state = loadState();
      for (const ship of data.ships) ensureShipState(state, ship);
      render(data, state);
      document.getElementById("btn-save-local").onclick = () => {
        saveState(state);
        alert("Progress saved in this browser.");
      };
      document.getElementById("btn-export").onclick = () => exportSelections(data, state);
    })().catch((err) => {
      document.getElementById("progress").textContent = String(err.message || err);
    });
  </script>
</body>
</html>
`;
}

function main() {
  const plan = readJson(path.join(AUDIT_DIR, "proposed-upload-plan.json"));
  const heroes = readJson(path.join(AUDIT_DIR, "ship-hero-candidates.json"));
  const audit = readJson(path.join(AUDIT_DIR, "ship-image-audit-external.json"));

  const steveItems = (plan.new_ship_heroes?.items || []).filter(
    (i) => i.recommendation === "Steve_selection_required"
  );
  if (steveItems.length !== 29) {
    console.warn(`Expected 29 Steve-selection ships, found ${steveItems.length}`);
  }

  const steveIds = new Set(steveItems.map((i) => i.ship_id));
  const imagesByShip = new Map();

  for (const h of heroes) {
    if (!steveIds.has(h.ship_id)) continue;
    if (!imagesByShip.has(h.ship_id)) imagesByShip.set(h.ship_id, []);
    imagesByShip.get(h.ship_id).push({
      ...h,
      quality_class: h.quality_class || "excellent_hero_candidate",
      opens_successfully: true
    });
  }

  for (const row of audit.ship_folders || []) {
    if (!steveIds.has(row.ship_id)) continue;
    if (!imagesByShip.has(row.ship_id)) imagesByShip.set(row.ship_id, []);
    for (const img of row.images || []) {
      imagesByShip.get(row.ship_id).push(img);
    }
  }

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(THUMB_DIR, { recursive: true });

  const shipsOut = [];
  let thumbCount = 0;
  let shipsOneCandidate = 0;
  let shipsNoCandidate = 0;
  const shipsWithWarnings = [];

  for (const item of steveItems) {
    const raw = imagesByShip.get(item.ship_id) || [];
    const byHash = new Map();
    for (const img of raw) {
      if (!isCredibleCandidate(img)) continue;
      const key = img.content_hash || img.absolute_path;
      if (!key || !img.absolute_path) continue;
      if (!fs.existsSync(img.absolute_path)) continue;
      const existing = byHash.get(key);
      if (!existing || (img.score || 0) > (existing.score || 0)) byHash.set(key, img);
    }

    let list = [...byHash.values()].sort((a, b) => (b.score || 0) - (a.score || 0));
    const totalCredible = list.length;
    if (list.length > MAX_CANDIDATES_PER_SHIP) {
      list = list.slice(0, MAX_CANDIDATES_PER_SHIP);
    }

    const identityWarnings = [];
    if (IDENTITY_WARNINGS[item.ship_name]) {
      identityWarnings.push(IDENTITY_WARNINGS[item.ship_name]);
    }

    const candidates = [];
    for (const img of list) {
      const filename = path.basename(img.absolute_path);
      const idWarnings = filenameIdentityRisk(item.ship_name, filename, img.absolute_path);
      const thumbName = makeThumbId(item.ship_id, img.content_hash, filename);
      const thumbAbs = path.join(THUMB_DIR, thumbName);
      try {
        generateThumbnail(img.absolute_path, thumbAbs);
        thumbCount += 1;
      } catch (error) {
        console.warn(`Thumbnail failed ${img.absolute_path}: ${error.message}`);
        continue;
      }
      const bytes = img.file_size_bytes || fs.statSync(img.absolute_path).size;
      candidates.push({
        candidate_id: `${item.ship_id}:${img.content_hash || thumbName}`,
        filename,
        source_pathname: img.absolute_path,
        thumbnail: `thumbnails/${thumbName}`,
        width: img.width,
        height: img.height,
        dimensions: img.width && img.height ? `${img.width}x${img.height}` : "",
        file_size_bytes: bytes,
        file_size_label: bytes >= 1e6 ? `${(bytes / 1e6).toFixed(2)} MB` : `${Math.round(bytes / 1024)} KB`,
        content_hash: img.content_hash || null,
        score: img.score ?? null,
        quality_class: img.quality_class || null,
        apparent_role: img.apparent_role || null,
        identity_warnings: idWarnings
      });
    }

    // Elevate ship-level warning if any candidate flagged Scenic Eclipse naming
    if (
      item.ship_name === "Scenic Eclipse II" &&
      candidates.some((c) => (c.identity_warnings || []).includes("may_be_branded_scenic_eclipse_not_ii"))
    ) {
      if (!identityWarnings.some((w) => /Scenic Eclipse/i.test(w))) {
        identityWarnings.push(
          "At least one shown candidate may be branded Scenic Eclipse rather than Eclipse II."
        );
      }
    }

    const recommendation = recommendCandidate(
      item.ship_name,
      candidates,
      identityWarnings
    );
    if (candidates.length === 1) shipsOneCandidate += 1;
    if (candidates.length === 0) shipsNoCandidate += 1;
    if (identityWarnings.length) shipsWithWarnings.push(item.ship_name);

    shipsOut.push({
      ship_id: item.ship_id,
      ship_name: item.ship_name,
      cruise_line_id: item.cruise_line_id,
      cruise_line_name: item.cruise_line_name,
      match_class: item.match_class,
      identity_warnings: identityWarnings,
      notes:
        totalCredible > candidates.length
          ? [
              `Showing top ${candidates.length} of ${totalCredible} credible candidates by audit score.`
            ]
          : [],
      recommendation,
      candidates
    });
  }

  const reviewData = {
    generated_at: new Date().toISOString(),
    source_root: "/Volumes/4T My Music for Mac 4TB/BRAND IMAGING",
    ship_count: shipsOut.length,
    candidate_count: thumbCount,
    max_candidates_per_ship: MAX_CANDIDATES_PER_SHIP,
    global_exclusion_notes: GLOBAL_EXCLUSION_NOTES,
    ships: shipsOut
  };

  writeJson(path.join(OUT_DIR, "review-data.json"), reviewData);
  writeText(path.join(OUT_DIR, "index.html"), buildHtml());
  writeText(
    path.join(OUT_DIR, "README.txt"),
    `Steve — Ship Hero Selection Review
=================================

1. Open this file in Finder:
   ${path.join(OUT_DIR, "index.html")}

2. Open index.html in Safari or Chrome
   (File → Open, or drag onto the browser).
   No build step and no internet required for the page itself.
   Thumbnails load from the local thumbnails/ folder.

3. For each of the 29 ships:
   • Review the candidate images (large thumbnails).
   • Read any identity / quality warnings.
   • Either:
       - select one image as the approved hero, or
       - choose “No suitable image”, or
       - choose “Needs further investigation”.
   • Only one decision may be active per ship.
   • If a ship has an identity warning and you approve an image,
     tick the acknowledgement checkbox.

4. Optional: click “Save progress locally” to keep choices in this browser.

5. Click “Export selections”.
   This downloads: steve-hero-selections.json

6. Move/save that file into:
   ${AUDIT_DIR}/
   (same folder that already holds the audit manifests)

Important
---------
• This pack does not upload anything.
• Originals stay on the external drive; only small JPEG review thumbnails
  were generated locally under thumbnails/.
• Do not approve Scenic Eclipse II without confirming the vessel is Eclipse II.
• Brilliant Lady/Valiant Lady, Apex Instagram dump, Star of the Seas CGI,
  Majestic lido-deck, and Silver Dawn generic image remain excluded from upload
  workflows and are not part of this 29-ship review list.
`
  );

  // size summary
  let totalBytes = 0;
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else totalBytes += fs.statSync(p).size;
    }
  }
  walk(OUT_DIR);

  const summary = {
    out_dir: OUT_DIR,
    index_html: path.join(OUT_DIR, "index.html"),
    ship_count: shipsOut.length,
    thumbnail_count: thumbCount,
    total_bytes: totalBytes,
    ships_with_identity_warnings: shipsWithWarnings,
    ships_with_one_candidate: shipsOneCandidate,
    ships_with_no_candidate: shipsNoCandidate,
    ships_no_candidate_names: shipsOut.filter((s) => s.candidates.length === 0).map((s) => s.ship_name)
  };
  writeJson(path.join(OUT_DIR, "pack-summary.json"), summary);
  console.log(JSON.stringify(summary, null, 2));
}

main();
