/**
 * Static source tests for portal-loading.js overlay behaviour.
 * Run: node scripts/test-portal-loading.mjs
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const src = readFileSync(path.join(root, "js/portal-loading.js"), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(/const refs = new Map\(\)/.test(src), "reference counting map exists");
assert(/function show\(/.test(src) && /function hide\(/.test(src), "show/hide helpers exist");
assert(/activeCount/.test(src), "global activeCount reference tracking exists");
assert(/delayMs\)\s*:\s*250/.test(src), "withLoading default delay is 250ms");
assert(/setTimeout\(startUi,\s*delayMs\)/.test(src), "withLoading delays button busy state");
assert(/aria-live="polite"/.test(src), "overlay message uses aria-live polite");
assert(
  src.includes("Give me a few seconds — I'm loading the information."),
  "initial loading message present"
);
assert(
  src.includes("Still loading — this is taking a little longer than usual."),
  "slow loading message present"
);
assert(/setTimeout\(function \(\) \{\s*setMessage\(SLOW_MESSAGE\)/.test(src) || /4000/.test(src), "slow message after 4 seconds");
assert(/function fail\(/.test(src), "fail helper exists");
assert(/2500/.test(src), "fail path auto-hides after 2.5 seconds");
assert(/prefers-reduced-motion/.test(src), "prefers-reduced-motion respected");
assert(/portal-loading-reduced-motion/.test(src), "reduced motion CSS class applied");
assert(/root\.PortalLoading/.test(src), "PortalLoading global export exists");
assert(/async function withLoading/.test(src), "withLoading wrapper exported");

console.log("test-portal-loading: ok");
