import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

global.document = {
  querySelectorAll() { return []; },
  addEventListener() {}
};

const featureAdmin = require("../js/ci-ship-feature-admin.js");

const listeners = [];
const root = {
  dataset: {},
  innerHTML: "",
  addEventListener(type, handler) {
    if (type === "click") listeners.push(handler);
  },
  querySelectorAll() { return []; }
};

let staleMoveCalls = 0;
let order = ["A", "B", "C", "D"];
let currentIndex = 1;

function bindCurrentMoveHandler() {
  featureAdmin.bindFeatureList(root, {
    onMove(index, delta) {
      const next = index + delta;
      if (index < 0 || index >= order.length || next < 0 || next >= order.length) return;
      [order[index], order[next]] = [order[next], order[index]];
      currentIndex = next;
    }
  });
}

featureAdmin.bindFeatureList(root, {
  onMove() { staleMoveCalls += 1; }
});

assert.equal(listeners.length, 1, "initial bind should attach exactly one click listener");
assert.equal(root.dataset.featureBound, "1");

for (let pass = 0; pass < 4; pass += 1) {
  featureAdmin.rebuildFeatureList(root, order.map((name) => ({
    name,
    description: "",
    icon_key: "sparkles"
  })), { sectionLabel: "Feature" });

  // admin.js clears this marker after editor renders. The shared editor must
  // still keep exactly one actual DOM click listener for this root.
  root.dataset.featureBound = "";
  bindCurrentMoveHandler();

  assert.equal(root.dataset.featureBound, "1", "rebind should restore the marker");
}

assert.equal(listeners.length, 1, "rebuilds and external marker resets must not stack click listeners");

function clickMove(action) {
  const card = {
    getAttribute(name) {
      return name === "data-index" ? String(currentIndex) : null;
    }
  };
  const actionButton = {
    closest(selector) {
      return selector === ".ci-ship-feature-card" ? card : null;
    },
    getAttribute(name) {
      return name === "data-action" ? action : null;
    }
  };
  const event = {
    target: {
      closest(selector) {
        if (selector === "[data-action]") return actionButton;
        return null;
      }
    },
    preventDefault() {},
    stopPropagation() {}
  };

  listeners[0](event);

  // Simulate the real editor render/rebind that happens after every move.
  featureAdmin.rebuildFeatureList(root, order.map((name) => ({
    name,
    description: "",
    icon_key: "sparkles"
  })), { sectionLabel: "Feature" });
  root.dataset.featureBound = "";
  bindCurrentMoveHandler();
}

// Exact regression: move the same unsaved item more than once, then return it
// to its original position, all before Save.
clickMove("move-down");
assert.deepEqual(order, ["A", "C", "B", "D"]);
clickMove("move-down");
assert.deepEqual(order, ["A", "C", "D", "B"]);
clickMove("move-up");
assert.deepEqual(order, ["A", "C", "B", "D"]);
clickMove("move-up");
assert.deepEqual(order, ["A", "B", "C", "D"]);

assert.equal(listeners.length, 1, "repeated moves must never add another root click listener");
assert.equal(staleMoveCalls, 0, "stale handlers must not fire after rebuilds");

console.log("Ship feature editor repeated reorder regression: PASS");
