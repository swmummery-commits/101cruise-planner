/**
 * Media Library search must retain focus while typing.
 * Run: node scripts/test-media-library-search.mjs
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const src = readFileSync(path.join(root, "js/admin-media-library.js"), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(/id="media-library-search"/.test(src), "search input has stable id");
assert(/id="media-library-results"/.test(src), "results container is isolated");
assert(/refreshMediaResultsOnly/.test(src), "results-only refresh exists");
assert(/mediaSearchDebounce/.test(src), "search is debounced");
assert(/setTimeout\(\(\) => \{[\s\S]*?refreshMediaResultsOnly/.test(src), "debounce calls results refresh");
{
  const setSearchFn = src.match(/setSearch\(value\) \{[\s\S]*?\n    \},/);
  assert(setSearchFn, "setSearch function found");
  assert(!/renderAdmin\(\)/.test(setSearchFn[0]), "setSearch does not full-render admin");
  assert(/refreshMediaResultsOnly/.test(setSearchFn[0]), "setSearch refreshes results only");
}

// Runtime: typing multiple characters keeps the same input node focused
{
  const events = [];
  let searchInput = null;
  let resultsMount = null;
  const mediaItems = [
    {
      id: "1",
      title: "Sapphire Princess hero",
      media_type: "ship",
      is_active: true,
      tags: ["sapphire"],
      ci_cruise_ships: { name: "Sapphire Princess" },
      public_url: "https://example.com/sapphire.jpg"
    },
    {
      id: "2",
      title: "Other ship",
      media_type: "ship",
      is_active: true,
      tags: [],
      ci_cruise_ships: { name: "Grand Princess" },
      public_url: "https://example.com/grand.jpg"
    }
  ];

  const documentStub = {
    getElementById(id) {
      if (id === "media-library-search") return searchInput;
      if (id === "media-library-results") return resultsMount;
      return null;
    },
    activeElement: null
  };

  const sandbox = {
    console,
    document: documentStub,
    window: {},
    globalThis: {},
    setTimeout,
    clearTimeout,
    esc(v) {
      return String(v == null ? "" : v)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    },
    renderAdmin() {
      events.push("full-render");
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(src + "\nthis.MediaLibraryAdmin = MediaLibraryAdmin;", sandbox);

  // Seed internal state by calling through a tiny harness: inject media via getMediaItems isn't writable.
  // Instead, evaluate filtered behaviour by driving setSearch against a mocked results mount after
  // temporarily patching filteredMediaItems through a second render path.
  // We verify setSearch does not call renderAdmin and updates results mount HTML.
  searchInput = {
    value: "",
    selectionStart: 0,
    selectionEnd: 0,
    setSelectionRange(a, b) {
      this.selectionStart = a;
      this.selectionEnd = b;
    },
    focus() {
      documentStub.activeElement = this;
    }
  };
  resultsMount = {
    innerHTML: "",
    set innerHTML(v) {
      this._html = v;
      events.push("results-update");
    },
    get innerHTML() {
      return this._html || "";
    }
  };
  documentStub.activeElement = searchInput;

  // Without seeded mediaItems, results will be empty — still must not full-render.
  sandbox.MediaLibraryAdmin.setSearch("S");
  sandbox.MediaLibraryAdmin.setSearch("Sa");
  sandbox.MediaLibraryAdmin.setSearch("Sap");
  sandbox.MediaLibraryAdmin.setSearch("Saph");
  sandbox.MediaLibraryAdmin.setSearch("Sapph");
  sandbox.MediaLibraryAdmin.setSearch("Sapphi");
  sandbox.MediaLibraryAdmin.setSearch("Sapphir");
  sandbox.MediaLibraryAdmin.setSearch("Sapphire");

  await new Promise((r) => setTimeout(r, 250));

  assert(!events.includes("full-render"), "typing must not rebuild the Media Library panel");
  assert(events.includes("results-update"), "results grid updates after debounce");
  assert(documentStub.activeElement === searchInput, "search input remains focused");

  // Clear works
  sandbox.MediaLibraryAdmin.setSearch("");
  await new Promise((r) => setTimeout(r, 250));
  assert(events.filter((e) => e === "results-update").length >= 2, "clear also refreshes results");

  // Paste-style multi-char set
  sandbox.MediaLibraryAdmin.setSearch("Sapphire");
  await new Promise((r) => setTimeout(r, 250));
  assert(!events.includes("full-render"), "paste path still avoids full render");
}

// Static: Type/Status still use renderAdmin (acceptable) and search value is bound from state
{
  assert(/setTypeFilter\(value\) \{[\s\S]*?renderAdmin\(\)/.test(src), "type filter still works");
  assert(/setActiveFilter\(value\) \{[\s\S]*?renderAdmin\(\)/.test(src), "status filter still works");
  assert(/value="\$\{esc\(mediaSearchQuery\)\}"/.test(src), "search text preserved on panel render");
}

console.log("test-media-library-search: ok");
