/**
 * Ship Spotlight copy must rebuild newsletter HTML from the latest ship facts.
 * A second copy after a statistic change must not reuse a stale in-memory
 * hosted-HTML cache or report "There is no hosted newsletter HTML to copy."
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);

const clipboardWrites = [];
const assets = require("../js/newsletter-mailchimp-assets.js");
assets.copyHostedHtml = async function copyHostedHtml(html) {
  const text = String(html || "");
  if (!text.trim()) {
    return { ok: false, error: "There is no hosted newsletter HTML to copy.", html: "" };
  }
  const safety = assets.assertNoSupabaseStorageUrls(text);
  if (!safety.ok) return { ok: false, error: safety.error, html: "" };
  clipboardWrites.push(text);
  return { ok: true, method: "test", html: text };
};

function decode(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function parseFields(html) {
  const fields = {};
  const inputRe = /<input\b([^>]*)>/gi;
  let match;
  while ((match = inputRe.exec(html))) {
    const attrs = match[1];
    const id = /id="([^"]+)"/.exec(attrs)?.[1];
    if (!id) continue;
    fields[id] = {
      value: decode(/value="([^"]*)"/.exec(attrs)?.[1] || ""),
      checked: /\bchecked\b/.test(attrs)
    };
  }
  const textareaRe = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi;
  while ((match = textareaRe.exec(html))) {
    const id = /id="([^"]+)"/.exec(match[1])?.[1];
    if (!id) continue;
    fields[id] = { value: decode(match[2]), checked: false };
  }
  const selectRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  while ((match = selectRe.exec(html))) {
    const id = /id="([^"]+)"/.exec(match[1])?.[1];
    if (!id) continue;
    const options = [...match[2].matchAll(/<option\b([^>]*)>/gi)];
    const selected = options.find((option) => /\bselected\b/.test(option[1])) || options[1] || options[0];
    fields[id] = {
      value: decode(selected ? (/value="([^"]*)"/.exec(selected[1])?.[1] || "") : ""),
      checked: false
    };
  }
  return fields;
}

function createDocument() {
  const byId = new Map();
  class El {
    constructor(tag) {
      this.tagName = String(tag || "").toUpperCase();
      this.className = "";
      this.hidden = false;
      this.textContent = "";
      this.style = {};
      this.dataset = {};
      this.children = [];
      this._html = "";
    }
    set id(value) {
      if (this._id) byId.delete(this._id);
      this._id = value;
      if (value) byId.set(value, this);
    }
    get id() {
      return this._id || "";
    }
    set innerHTML(value) {
      this._html = String(value || "");
    }
    get innerHTML() {
      return this._html;
    }
    appendChild(child) {
      this.children.push(child);
      child.parentElement = this;
      return child;
    }
    setAttribute(name, value) {
      if (name === "id") this.id = value;
    }
    removeAttribute(name) {
      if (name === "id" && this._id) {
        byId.delete(this._id);
        this._id = "";
      }
    }
    addEventListener() {}
    querySelector(selector) {
      if (typeof selector !== "string" || !selector.startsWith("#")) return null;
      return parseFields(this._html)[selector.slice(1)] || null;
    }
    querySelectorAll() {
      return [];
    }
  }

  const document = {
    head: new El("head"),
    body: new El("body"),
    documentElement: new El("html"),
    createElement(tag) {
      return new El(tag);
    },
    getElementById(id) {
      return byId.get(id) || null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {}
  };
  return document;
}

function cloneRows(rows) {
  return (rows || []).map((row) => JSON.parse(JSON.stringify(row)));
}

function createState() {
  return {
    failSave: false,
    failSaveError: "Choose a hero image before saving.",
    saves: [],
    assets: [],
    ships: [{
      id: "ship-sapphire",
      cruise_line_id: "line-princess",
      name: "Sapphire Princess",
      slug: "sapphire-princess",
      status: "active",
      ship_class: "Gem",
      year_built: 2004,
      year_refurbished: 2018,
      passenger_capacity: 2670,
      crew_count: 1100,
      deck_count: 13,
      stateroom_count: 1337,
      stateroom_breakdown: null,
      cabin_type_summary: null,
      gross_tonnage: 115875,
      length_metres: 290,
      beam_metres: 37.5,
      cruising_speed_knots: 22,
      facilities: { restaurants: 8, bars: 6, pools: 4, hot_tubs: 5, specialty_dining: 2 },
      hero_image_url: "https://images.example.com/sapphire-princess.jpg",
      image_gallery: [],
      active: true
    }],
    lines: [{
      id: "line-princess",
      name: "Princess Cruises",
      slug: "princess",
      logo_url: "https://images.example.com/princess-logo.png",
      active: true,
      sold_by_101cruise: true
    }],
    spotlights: [{
      id: "spot-sapphire",
      ship_id: "ship-sapphire",
      eyebrow: "SHIP SPOTLIGHT",
      newsletter_heading: "Sapphire Princess",
      editorial_intro: "A Grand-class ship with a long promenade.",
      highlights: [],
      stat_keys: ["passenger_capacity", "gross_tonnage"],
      hero_image_url: "https://images.example.com/sapphire-princess.jpg",
      supporting_image_urls: [],
      public_slug: "sapphire-princess",
      publication_status: "published",
      active: true,
      updated_at: "2026-10-01T00:00:00.000Z"
    }],
    media: [],
    research: []
  };
}

function rowsFor(state, table, filters) {
  const source = {
    ci_cruise_ships: state.ships,
    ci_cruise_lines: state.lines,
    ship_spotlights: state.spotlights,
    media_library: state.media,
    research_content: state.research
  }[table] || [];
  return cloneRows(source).filter((row) => filters.every(([column, value]) => row[column] === value));
}

function createClient(state) {
  return {
    from(table) {
      const filters = [];
      const builder = {
        select() { return builder; },
        eq(column, value) { filters.push([column, value]); return builder; },
        order() { return builder; },
        limit() { return builder; },
        maybeSingle() {
          const rows = rowsFor(state, table, filters);
          return Promise.resolve({ data: rows[0] || null, error: null });
        },
        then(resolve, reject) {
          return Promise.resolve({ data: rowsFor(state, table, filters), error: null }).then(resolve, reject);
        }
      };
      return builder;
    },
    auth: {
      async getUser() {
        return { data: { user: { id: "admin-user" } } };
      }
    }
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}

function loadScripts(sandbox, names) {
  for (const name of names) {
    const code = fs.readFileSync(new URL(name, root), "utf8");
    vm.runInNewContext(code, sandbox, { filename: name });
  }
}

function pageHtml(sandbox) {
  return sandbox.document.getElementById("shipSpotlightOverlay")?.innerHTML || "";
}

const state = createState();
const document = createDocument();
const sandbox = {
  console,
  document,
  navigator: { clipboard: { async writeText() {} } },
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  fetch: async (url, init = {}) => {
    const target = String(url || "");
    const body = init.body ? JSON.parse(init.body) : {};
    if (target.includes("admin-ship-spotlight-save")) {
      state.saves.push(body);
      if (state.failSave) return jsonResponse(400, { success: false, error: state.failSaveError });
      return jsonResponse(200, {
        success: true,
        spotlight: {
          id: "spot-sapphire",
          ...body,
          active: true,
          updated_at: new Date().toISOString()
        }
      });
    }
    if (target.includes("ship-spotlight-mailchimp-assets")) {
      state.assets.push(body);
      const label = body.assets?.[0]?.label || "image";
      return jsonResponse(200, {
        success: true,
        mappings: [{ mailchimp_file_url: `https://mailchimp.example/${encodeURIComponent(label)}.jpg` }]
      });
    }
    throw new Error(`Unexpected request ${target}`);
  },
  adminAuthHeaders: async (headers) => ({ ...(headers || {}), Authorization: "Bearer test" }),
  supabaseClient: createClient(state),
  NewsletterMailchimpAssets: assets,
  btoa: global.btoa,
  atob: global.atob,
  setTimeout,
  clearTimeout
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

loadScripts(sandbox, [
  "js/admin-ship-spotlight-v2.js",
  "js/admin-ship-spotlight-layout-fix.js",
  "js/admin-ship-spotlight-public-link-fix.js",
  "js/admin-ship-spotlight-content-preview-fix.js",
  "js/admin-ship-spotlight-pauls-tip.js"
]);

const api = sandbox.ShipSpotlightAdmin;
assert.equal(typeof api.copyNewsletterBlock, "function", "Ship Spotlight copy action is available");

const oldGuests = Number(2670).toLocaleString("en-AU");
const newGuests = Number(2888).toLocaleString("en-AU");
assert.notEqual(oldGuests, newGuests);

await api.open();
await api.selectShip("ship-sapphire");
await api.copyNewsletterBlock();

assert.equal(clipboardWrites.length, 1, "first copy writes HTML");
assert.match(clipboardWrites[0], /cr101-ss-wrapper/);
assert.match(clipboardWrites[0], /max-width:600px/);
assert.match(clipboardWrites[0], new RegExp(oldGuests.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.doesNotMatch(clipboardWrites[0], /supabase\.(co|in)\/storage/);
assert.doesNotMatch(pageHtml(sandbox), /There is no hosted newsletter HTML to copy/);
assert.match(pageHtml(sandbox), /Newsletter block copied/);
assert.equal(state.saves.at(-1)?.publication_status, "published");
assert.equal(state.saves.at(-1)?.ship_id, "ship-sapphire");
assert.match(pageHtml(sandbox), /copyNewsletterBlock\(\)/);
assert.doesNotMatch(pageHtml(sandbox), /copyAgainIfReady\(\)/);

state.ships[0].passenger_capacity = 2888;
const overlay = document.getElementById("shipSpotlightOverlay");
overlay.innerHTML = overlay.innerHTML.replace(
  "A Grand-class ship with a long promenade.",
  "Updated promenade description for the next send."
);
await api.copyAgainIfReady();

assert.equal(clipboardWrites.length, 2, "second copy writes fresh HTML");
assert.match(clipboardWrites[1], new RegExp(newGuests.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.doesNotMatch(clipboardWrites[1], new RegExp(oldGuests.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.match(clipboardWrites[1], /Updated promenade description for the next send/);
assert.match(pageHtml(sandbox), new RegExp(newGuests.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.match(clipboardWrites[1], /Sapphire Princess/);
assert.match(clipboardWrites[1], /max-width:600px/);
assert.doesNotMatch(pageHtml(sandbox), /There is no hosted newsletter HTML to copy/);
assert.match(pageHtml(sandbox), /Newsletter block copied/);
assert.ok(state.assets.length >= 2, "image hosting still runs for the rebuilt block");

state.failSave = true;
state.failSaveError = "Public slug is already used by another ship.";
await api.copyNewsletterBlock();

assert.equal(clipboardWrites.length, 2, "a failed rebuild does not copy an empty payload");
assert.match(pageHtml(sandbox), /Public slug is already used by another ship/);
assert.doesNotMatch(pageHtml(sandbox), /There is no hosted newsletter HTML to copy/);

const source = fs.readFileSync(new URL("js/admin-ship-spotlight-v2.js", root), "utf8");
assert.doesNotMatch(source, /if\s*\(\s*!saved\s*\)\s*return\s*""/);
assert.doesNotMatch(source, /copyAgainIfReady"\s*:\s*"copyNewsletterBlock"/);
assert.match(source, /\.ss-actions\{[^}]*flex-wrap:wrap/);
assert.match(source, /\.ss-actions \.ss-action-status\{[^}]*overflow-wrap:anywhere/);

const reliabilitySrc = fs.readFileSync(new URL("js/admin-ship-spotlight-reliability-fix.js", root), "utf8");
assert.match(reliabilitySrc, /className = "ss-action-status"/);

console.log("ship spotlight newsletter copy: ok");
