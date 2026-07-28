/**
 * Offline tests for AU date auto-advance helpers.
 * Run: node scripts/test-au-date-input.mjs
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const src = readFileSync(path.join(root, "js/au-date-input.js"), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Load module into a sandbox to exercise pure helpers via exported API
const sandbox = {
  window: {},
  globalThis: {},
  document: {
    readyState: "complete",
    documentElement: {},
    addEventListener() {},
    querySelectorAll() {
      return [];
    }
  },
  HTMLInputElement: class {},
  MutationObserver: null,
  Event: class {
    constructor(type) {
      this.type = type;
    }
  },
  requestAnimationFrame(cb) {
    cb();
  }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.runInNewContext(src, sandbox);

const api = sandbox.AuDateInput;
assert(api, "AuDateInput exported");
assert(api.toIso("28", "7", "2026") === "2026-07-28", "toIso pads month");
assert(api.toIso("31", "02", "2026") === "", "rejects invalid day");
assert(api.parseLooseDate("28/07/2026").y === "2026", "parse dmy");
assert(api.parseLooseDate("2026-07-28").d === "28", "parse iso");
assert(api.parseLooseDate("28072026").m === "07", "parse digits dmy");

const indexHtml = readFileSync(path.join(root, "index.html"), "utf8");
const adminHtml = readFileSync(path.join(root, "admin.html"), "utf8");
assert(/au-date-input\.js/.test(indexHtml), "portal loads script");
assert(/au-date-input\.css/.test(indexHtml), "portal loads css");
assert(/au-date-input\.js/.test(adminHtml), "admin loads script");
assert(/au-date-input\.css/.test(adminHtml), "admin loads css");
assert(/auto-advance|auto-advance|maxLength = 2|focusPart/.test(src), "auto advance present");
assert(/dataset\.auPart === "d".*value\.length === 2|part === "d" && value\.length === 2/.test(src), "day advances at 2");

console.log("test-au-date-input: ok");
