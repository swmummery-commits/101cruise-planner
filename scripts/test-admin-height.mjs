/**
 * Smoke tests for Admin Squarespace iframe height bridge.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const heightSrc = fs.readFileSync(path.join(root, "js/admin-height.js"), "utf8");
const embedSrc = fs.readFileSync(path.join(root, "js/admin-squarespace-embed.js"), "utf8");
const pasteSrc = fs.readFileSync(path.join(root, "squarespace-admin-embed.html"), "utf8");
const adminHtml = fs.readFileSync(path.join(root, "admin.html"), "utf8");
const adminCss = fs.readFileSync(path.join(root, "css/admin.css"), "utf8");

assert(/admin-height\.js/.test(adminHtml), "admin.html loads admin-height.js");
assert(/101cruise-admin-height/.test(heightSrc), "child posts admin height message");
assert(/101cruise-admin-height/.test(embedSrc), "parent listens for admin height");
assert(/id="101cruise-admin"/.test(pasteSrc), "paste includes iframe id");
assert(/admin-squarespace-embed\.js/.test(pasteSrc), "paste includes parent script");
assert(/html\.is-embedded/.test(adminCss), "embedded overflow CSS present");
assert(/max-height:\s*none/.test(adminCss.match(/\.mailchimp-poc-preview\s*\{[^}]+\}/)?.[0] || ""), "preview not max-height clipped");

{
  const posts = [];
  const rootEl = {
    scrollHeight: 2400,
    offsetHeight: 2400
  };
  const sandbox = {
    window: {
      parent: {
        postMessage(payload, origin) {
          posts.push({ payload, origin });
        }
      },
      addEventListener() {},
      setTimeout() {},
      requestAnimationFrame(cb) {
        cb();
        return 1;
      },
      cancelAnimationFrame() {}
    },
    document: {
      documentElement: { classList: { add() {} } },
      body: { classList: { add() {} } },
      getElementById(id) {
        return id === "cruise-admin-app" ? rootEl : null;
      },
      addEventListener() {}
    },
    globalThis: null,
    MutationObserver: undefined,
    ResizeObserver: undefined
  };
  sandbox.window.parent !== sandbox.window; // keep parent distinct
  // Force embedded: parent !== window
  Object.defineProperty(sandbox.window, "parent", {
    value: {
      postMessage(payload, origin) {
        posts.push({ payload, origin });
      }
    }
  });
  sandbox.globalThis = sandbox;
  vm.runInNewContext(heightSrc, sandbox);
  assert(sandbox.AdminHeight, "AdminHeight exported");
  assert.equal(sandbox.AdminHeight.measureHeight(), 2424, "measures app height + pad");
  sandbox.AdminHeight.postNow();
  assert(
    posts.some((p) => p.payload.type === "101cruise-admin-height" && p.payload.height === 2424),
    "posts height to parent"
  );
  assert(
    posts.every((p) => p.origin === "https://www.101cruise.com.au" || p.origin === "https://101cruise.com.au"),
    "never posts to wildcard origin"
  );
}

console.log("test-admin-height: ok");
